// 小队集合：每个人按自己的位置和难度规划到集合点的路线，自动选集合点，生成发给每个人的话
import test from 'node:test';
import assert from 'node:assert/strict';
import { resort } from './helpers.mjs';
import { planGather, chooseMeetingPoint, gatherMessages, parseGather, routeBrief } from '../nav/gather.js';

const R = resort('demo-fictional');
const ids = (m) => m.route.edges.map((e) => e.id);
const byId = (plan, id) => plan.members.find((m) => m.id === id);

// 五人小队（演示雪场）：
//   A 队长在山顶；B 在山脚餐厅；C 正在 5 号中央线中段往下滑；D 在山脚缆车站，新手只走初级；E 在山腰站
const TEAM = [
  { id: 'A', name: '阿明', at: { node: 'S' }, prefs: { maxDifficulty: 2 } },
  { id: 'B', name: '小白', at: { node: 'REST' }, prefs: { maxDifficulty: 2 } },
  { id: 'C', name: '小陈', at: { edgeId: 'R5', s: 200 }, prefs: { maxDifficulty: 2 } },
  { id: 'D', name: '大东', at: { node: 'B' }, prefs: { maxDifficulty: 1 } },
  { id: 'E', name: '阿娥', at: { node: 'M' }, prefs: { maxDifficulty: 2 } }
];

test('指定集合点：每人按自己的位置分别规划，路线首尾相接', () => {
  const p = planGather(R, TEAM, { goalNode: 'M' });
  assert.ok(p.ok && p.allReachable);
  assert.equal(p.goalName, '山腰站');
  // A 从山顶滑下来；B 从餐厅走到缆车站再坐 1 号缆车；D 直接坐 1 号缆车；E 已经在这里
  assert.deepEqual(ids(byId(p, 'A')), ['R0', 'R2']);
  assert.deepEqual(ids(byId(p, 'B')), ['W1', 'L1']);
  assert.deepEqual(ids(byId(p, 'D')), ['L1']);
  assert.ok(byId(p, 'E').here && byId(p, 'E').eta === 0);
  // C 在中央线上：不能掉头，只能先滑到底，再坐缆车上来
  const c = ids(byId(p, 'C'));
  assert.equal(c[0], 'R5');
  assert.equal(c[c.length - 1], 'L1');
  for (const m of p.members.filter((x) => x.route)) {
    m.route.edges.forEach((e, i) => { if (i) assert.equal(m.route.edges[i - 1].to, e.from); });
    assert.equal(m.route.edges[m.route.edges.length - 1].to, 'M');
  }
  // 到齐时间 = 最晚那个人
  assert.equal(p.allTogetherEta, Math.max(...p.members.map((m) => m.eta)));
  // 小白要先走 600 m 步道再坐缆车，最晚
  assert.equal(p.slowest, 'B');
});

test('每个人的难度上限分开算，不经过关闭的雪道', () => {
  const p = planGather(R, TEAM, { goalNode: 'B' });
  for (const m of p.members.filter((x) => x.ok && x.route)) {
    const lim = TEAM.find((t) => t.id === m.id).prefs.maxDifficulty;
    for (const e of m.route.edges) {
      assert.notEqual(e.id, 'R8', `${m.id} 走了关闭的悬崖线`);
      if (e.type === 'run') assert.ok(e.difficulty <= lim, `${m.id} 上限 ${lim} 却经过 ${e.id}`);
    }
  }
});

test('在雪道中段：已经滑过的部分不计入预计时间', () => {
  const start = planGather(R, [{ id: 'C', at: { edgeId: 'R5', s: 0 } }], { goalNode: 'B' });
  const mid = planGather(R, [{ id: 'C', at: { edgeId: 'R5', s: 300 } }], { goalNode: 'B' });
  assert.ok(mid.members[0].eta < start.members[0].eta);
  assert.deepEqual(ids(mid.members[0]), ids(start.members[0]));
});

test('有人到不了：明确标出，给出原因，不替他放宽难度', () => {
  // 新手在山顶：下到餐厅必须经过中级的 5 号中央线
  const team = [
    { id: 'A', name: '阿明', at: { node: 'M' }, prefs: { maxDifficulty: 2 } },
    { id: 'N', name: '新手', at: { node: 'S' }, prefs: { maxDifficulty: 1 } }
  ];
  const p = planGather(R, team, { goalNode: 'REST' });
  assert.ok(p.ok && !p.allReachable);
  const n = byId(p, 'N');
  assert.equal(n.ok, false);
  assert.equal(n.route, undefined);
  assert.ok(n.hints.some((h) => h.includes('中级')), n.hints.join('；'));
  const msg = gatherMessages(R, p, 'A');
  assert.match(msg.toMembers.find((x) => x.id === 'N').text, /到不了.*安全的地方停下/);
  assert.match(msg.toOrganizer, /新手到不了/);
});

test('自动选集合点：选所有人都能到、最晚的人最早到的地方', () => {
  const p = planGather(R, TEAM);
  assert.ok(p.ok && p.auto && p.allReachable);
  // 逐个候选验证：没有别的地方能让大家更早到齐
  for (const alt of chooseMeetingPoint(R, TEAM)) {
    assert.ok(alt.maxTime >= p.allTogetherEta - 1e-6, `${alt.name} 更快`);
  }
  // 新手只走初级时，餐厅和山脚都到不了，不能被选中
  const team = [
    { id: 'A', at: { node: 'REST' }, prefs: { maxDifficulty: 3 } },
    { id: 'N', at: { node: 'S' }, prefs: { maxDifficulty: 1 } }
  ];
  const q = planGather(R, team);
  assert.ok(q.ok && q.allReachable);
  assert.ok(!['REST', 'B'].includes(q.goalNode), q.goalName);
});

test('发给每个人的话：发起人不收到自己的通知，内容包含集合点、时间和路线', () => {
  const p = planGather(R, TEAM, { goalNode: 'M' });
  const msg = gatherMessages(R, p, 'A');
  assert.deepEqual(msg.toMembers.map((m) => m.id), ['B', 'C', 'D', 'E']);
  const b = msg.toMembers.find((m) => m.id === 'B').text;
  assert.match(b, /^阿明让大家到山腰站集合。你大约\d+分钟到：/);
  assert.match(b, /坐一号缆车/);
  assert.match(msg.toMembers.find((m) => m.id === 'E').text, /已经在这里/);
  assert.match(msg.toOrganizer, /已经通知了4个人/);
  assert.match(msg.toOrganizer, /到齐，最晚的是小白/);
  assert.match(msg.toOrganizer, /你自己大约\d+分钟到/);
});

test('发起人自己最晚时，告诉他“你自己最晚”而不是别人', () => {
  const team = [
    { id: 'A', name: '阿明', at: { node: 'REST' } },
    { id: 'B', name: '小白', at: { node: 'J4' } },
    { id: 'C', name: '小陈', at: { node: 'J3' } }
  ];
  const p = planGather(R, team, { goalNode: 'B' });
  assert.equal(p.slowest, 'A');
  assert.match(gatherMessages(R, p, 'A').toOrganizer, /到齐，你自己最晚/);
});

test('路线口头描述：最多三步，再多交给岔口提示', () => {
  const p = planGather(R, [{ id: 'C', at: { edgeId: 'R5' } }], { goalNode: 'S' });
  const s = routeBrief(p.members[0].route);
  assert.match(s, /^先滑五号雪道，再滑七号雪道/);
  assert.match(s, /后面听雪人的岔口提示$/);
  assert.equal(routeBrief({ edges: [R.edges.get('L1')] }), '坐一号缆车');
  // 同一条雪道被切成几段时只说一次；没有名字的雪道按难度称呼，不念内部编号
  const K = resort('kagura-osm');
  const seg = [...K.edges.values()].filter((e) => e.type === 'run' && e.name);
  const same = seg.find((e) => K.out.get(e.to).some((n) => n.name === e.name));
  const next = K.out.get(same.to).find((n) => n.name === same.name);
  assert.equal(routeBrief({ edges: [same, next] }), '滑' + same.name);
  const unnamed = [...K.edges.values()].find((e) => e.type === 'run' && !e.name && !e.ref && e.difficulty);
  assert.doesNotMatch(routeBrief({ edges: [unnamed] }), /[A-Z]\d|无名/);
});

test('听懂“集合”：有地点就用，没说地点就自动选，不是集合的话不处理', () => {
  assert.deepEqual(parseGather('雪人，让大家到山腰站集合', R).place, { node: 'M', name: '山腰站' });
  assert.equal(parseGather('大家去山脚餐厅集合吧', R).place.node, 'REST');
  assert.equal(parseGather('我们在山顶会合', R).place.node, 'S');
  assert.deepEqual(parseGather('雪人，大家集合', R), { place: null });
  assert.equal(parseGather('去山腰站', R), null);
  assert.equal(parseGather('集合', R).place, null);
  const unknown = parseGather('大家去火星基地集合', R);
  assert.equal(unknown.place, null);
  assert.ok(unknown.unknownPlace);
});
