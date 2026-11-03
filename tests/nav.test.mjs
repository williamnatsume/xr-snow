// 完成标准的自动验证：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { resort, runScenario, texts } from './helpers.mjs';
import { planRoute } from '../nav/planner.js';
import { buildManeuvers, maneuverText, forkSide } from '../nav/instructions.js';
import { angleDiff } from '../nav/geo.js';

const R = resort('demo-fictional');
const ids = (plan) => plan.edges.map((e) => e.id);

/* ---------- 地图数据 ---------- */

test('虚构雪场：数据校验无错误，规模符合要求', () => {
  assert.equal(R.errors.length, 0, R.errors.join('\n'));
  assert.deepEqual(R.warnings, []);
  const runs = [...R.edges.values()].filter((e) => e.type === 'run');
  assert.ok(runs.length >= 8 && runs.length <= 12, `雪道 ${runs.length} 段`);
  assert.equal(R.dataStatus, 'fictional');
  assert.equal(R.allowRealGps, false, '虚构雪场不允许真实 GPS 导航');
  const forks = [...R.nodes.keys()].filter((n) => R.out.get(n).filter((e) => e.type === 'run').length >= 2);
  assert.ok(forks.length >= 3, `分岔口 ${forks.length} 个`);
  assert.ok(runs.some((e) => e.open === false), '有一条关闭雪道');
});

/* ---------- 路线规划 ---------- */

test('不会规划进入关闭的雪道', () => {
  // J3 → 山脚缆车站：最短是关闭的 8 号悬崖线，必须绕开
  const p = planRoute(R, { startNode: 'J3', goalNode: 'B' }, { maxDifficulty: 4, preferShort: true });
  assert.ok(p.ok);
  assert.ok(!ids(p).includes('R8'), ids(p).join(','));
});

test('不会规划超出难度上限的雪道', () => {
  for (const maxDifficulty of [1, 2, 3]) {
    for (const [a, b] of [['S', 'REST'], ['S', 'B'], ['M', 'REST'], ['J1', 'REST']]) {
      const p = planRoute(R, { startNode: a, goalNode: b }, { maxDifficulty });
      if (!p.ok) continue;
      for (const e of p.edges) if (e.type !== 'lift') assert.ok(e.difficulty <= maxDifficulty, `${a}→${b} 上限 ${maxDifficulty} 却经过 ${e.id}(${e.difficulty})`);
    }
  }
  // 允许高级时走 4 号西沟线更快；不允许时不能走
  const adv = planRoute(R, { startNode: 'J2', goalNode: 'REST' }, { maxDifficulty: 3 });
  assert.ok(ids(adv).includes('R4'));
  const mid = planRoute(R, { startNode: 'J2', goalNode: 'REST' }, { maxDifficulty: 2 });
  assert.ok(mid.ok && !ids(mid).includes('R4'));
});

test('没有符合条件的路线时明确告知，不偷偷放宽', () => {
  // 只走初级：从山顶出发必须经过中级的 5 号中央线才能下山
  const p = planRoute(R, { startNode: 'S', goalNode: 'REST' }, { maxDifficulty: 1 });
  assert.equal(p.ok, false);
  assert.equal(p.edges, undefined, '失败时不返回任何路线');
  assert.match(p.reason, /没有可用路线/);
  assert.ok(p.hints.some((h) => h.includes('中级')), p.hints.join('；'));
});

test('避开平路是软偏好：能绕就绕，绕不开仍然给出路线并说明', () => {
  // J2 → 山腰站：只有 3 号林间连接道（平路），避开平路时仍然走它，但给出警告
  const p = planRoute(R, { startNode: 'J2', goalNode: 'M' }, { maxDifficulty: 2, avoidFlat: true });
  assert.ok(p.ok && ids(p).includes('R3'));
  assert.ok(p.warnings.some((w) => w.includes('平路')));
});

test('不逆行、不把缆车当滑行段', () => {
  // 山腰站 → 山顶：只能乘 2 号缆车上去
  const up = planRoute(R, { startNode: 'M', goalNode: 'S' }, { maxDifficulty: 4 });
  assert.deepEqual(ids(up), ['L2']);
  // 所有规划结果中的边都按数据方向首尾相接
  for (const [a, b] of [['S', 'REST'], ['B', 'S'], ['REST', 'S'], ['J3', 'B']]) {
    const p = planRoute(R, { startNode: a, goalNode: b }, { maxDifficulty: 4 });
    assert.ok(p.ok, `${a}→${b}`);
    p.edges.forEach((e, i) => { if (i) assert.equal(p.edges[i - 1].to, e.from); });
    assert.equal(p.edges[0].from, a);
  }
  // 山脚缆车站 → 山脚餐厅：不能沿步道反走（步道只有 餐厅→缆车站 方向），只能上山再滑下来
  const p = planRoute(R, { startNode: 'B', goalNode: 'REST' }, { maxDifficulty: 2 });
  assert.ok(ids(p)[0] === 'L1' && !ids(p).includes('W1'));
});

/* ---------- 左右判断 ---------- */

test('回头弯后的岔口：按进入方向判断左右（用户朝北滑行）', () => {
  const J2in = R.edges.get('R1'), toM = R.edges.get('R3'), toRest = R.edges.get('R4');
  // 进入回头弯岔口时，行进方向大致朝北（而不是朝山下的南方）
  const hin = J2in.headEnd;
  assert.ok(Math.abs(angleDiff(hin, 0)) < 30, `进入方向 ${hin.toFixed(0)}°`);
  // 3 号林间连接道向东北 → 对朝北行进的人来说在右边
  assert.equal(forkSide(J2in, toM, [toRest]).side, 'right');
  assert.equal(forkSide(J2in, toRest, [toM]).side, 'left');
  // 对照：如果错误地假设“面向山下（南）”，东北方向会被说成左边
  const naive = angleDiff(toM.headStart, 180) > 0 ? 'right' : 'left';
  assert.equal(naive, 'left', '朴素算法会给出相反结论，说明这个场景确实能区分');

  const p = planRoute(R, { startNode: 'J1', goalNode: 'M' }, { maxDifficulty: 2, preferShort: false, avoidFlat: false });
  const viaHairpin = { edges: [R.edges.get('R1'), R.edges.get('R3')] };
  const ms = buildManeuvers(R, viaHairpin.edges, 'M');
  assert.equal(ms[0].side, 'right');
  assert.match(maneuverText(ms[0], 'main'), /靠右，进入三号雪道/);
  assert.ok(p.ok);
});

test('普通岔口和三分岔的左右', () => {
  const R0 = R.edges.get('R0'), R5 = R.edges.get('R5');
  assert.equal(forkSide(R0, R.edges.get('R2'), [R.edges.get('R1')]).side, 'left');   // 朝南滑，东坡线在左
  const alts = (keep) => ['R6', 'R7', 'R8'].filter((x) => x !== keep).map((x) => R.edges.get(x));
  assert.equal(forkSide(R5, R.edges.get('R6'), alts('R6')).side, 'right');
  assert.equal(forkSide(R5, R.edges.get('R7'), alts('R7')).side, 'middle');
  assert.equal(forkSide(R5, R.edges.get('R8'), alts('R8')).side, 'left');
});

/* ---------- 模拟导航 ---------- */

test('正常经过岔口：每条指令只播一次，按顺序确认，最终到达', () => {
  const run = runScenario(R, { start: 'S', goal: 'REST', prefs: { maxDifficulty: 2 } });
  const t = texts(run.spoken);
  const keys = run.spoken.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, '没有重复的播报 key');
  assert.equal(new Set(t).size, t.length, '没有重复的播报文本：\n' + t.join('\n'));
  assert.ok(t.some((x) => /前方分岔靠左，进入二号雪道/.test(x)), t.join('\n'));
  assert.ok(t.includes('已进入二号雪道'));
  // 森林岔口：规划会选 6 或 7 号（按时间代价），无论哪条都要有主提示和确认
  const forest = ids(run.plan).includes('R7') ? '七' : '六';
  assert.ok(t.some((x) => new RegExp(`前方分岔.*进入${forest}号雪道`).test(x)), t.join('\n'));
  assert.ok(t.includes(`已进入${forest}号雪道`));
  assert.ok(t.includes('已到达山脚餐厅'));
  assert.equal(run.nav.state, 'arrived');
  assert.ok(!run.states.some((s) => s.state === 'offRoute'), '正常滑行不应偏航：' + JSON.stringify(run.states));
  // 主提示必须在到达岔口之前
  for (const s of run.spoken.filter((x) => x.key.startsWith('main:'))) {
    const at = run.snaps.find((z) => z.snap.log.includes(s) || false);
    assert.ok(s.reason.includes('沿路距离'), s.reason);
    const d = Number(/沿路距离 (\d+) m/.exec(s.reason)[1]);
    assert.ok(d >= 40, `主提示在岔口前 ${d} m`);
  }
});

test('S 弯 + 中等漂移：不会反复播报左右', () => {
  for (const seed of [1, 2, 5, 9, 11]) {
    const run = runScenario(R, { start: 'S', goal: 'REST', prefs: { maxDifficulty: 2 }, sim: { seed, drift: 7 } });
    const t = texts(run.spoken);
    assert.equal(new Set(t).size, t.length, `seed ${seed} 有重复播报：\n` + t.join('\n'));
    const forkCalls = t.filter((x) => /前方分岔/.test(x));
    assert.ok(forkCalls.length <= 3, `seed ${seed}：${forkCalls.join(' / ')}`);
    assert.equal(run.nav.state, 'arrived', `seed ${seed} 状态 ${JSON.stringify(run.states)}`);
  }
});

test('定位中断：不输出确定的转弯指令，恢复后才继续', () => {
  // 在快到森林岔口时中断 25 秒
  const run = runScenario(R, {
    start: 'M', goal: 'REST', prefs: { maxDifficulty: 2 },
    events: [{ at: 30, do: ({ simu }) => simu.startOutage(25) }]
  });
  const during = run.spoken.filter((s) => s.t > 30000 + 5000 && s.t < 55000);
  for (const s of during) assert.ok(!/靠左|靠右|走中间|已进入/.test(s.text), '中断期间不该有转向/确认：' + s.text);
  assert.ok(run.spoken.some((s) => s.text.includes('定位信号中断')));
  // 中断期间界面不显示距离（不把旧位置当实时位置）
  const outageSnaps = run.snaps.filter((z) => z.sec > 37 && z.sec < 55);
  assert.ok(outageSnaps.every((z) => z.snap.distToNext === null), '中断期间距离应为空');
  assert.ok(outageSnaps.every((z) => z.snap.state === 'unreliable'));
  assert.equal(run.nav.state, 'arrived');
});

test('回头弯（完整模拟）：在回头弯岔口播报“靠右”，并确认进入', () => {
  const run = runScenario(R, { goal: 'M', prefs: { maxDifficulty: 2 }, routeEdges: ['R1', 'R3'], sim: { drift: 5, seed: 2 } });
  const t = texts(run.spoken);
  assert.ok(t.some((x) => x.startsWith('前方分岔靠右，进入三号雪道')), t.join('\n'));
  assert.ok(!t.some((x) => /靠左/.test(x)), t.join('\n'));
  assert.ok(t.includes('已进入三号雪道'));
  assert.equal(run.nav.state, 'arrived');
});

test('相邻雪道：沿两条雪道正中间滑行时，不确认任何一条，也不判偏航', async () => {
  const { Navigator } = await import('../nav/navigator.js');
  const { pointAt } = await import('../nav/geo.js');
  const plan = { edges: ['R5', 'R7', 'R10'].map((x) => R.edges.get(x)) };
  const spoken = [];
  const nav = new Navigator(R, { onSpeak: (x) => spoken.push(x) });
  nav.start({ route: plan, destNode: 'REST', prefs: { maxDifficulty: 2 } }, 0);
  const R5 = R.edges.get('R5'), R6 = R.edges.get('R6'), R7 = R.edges.get('R7');
  let t = 0;
  const feed = (p) => { t += 1000; nav.onFix({ t, x: p.x, y: p.y, acc: 8, speed: 8 }); nav.tick(t); };
  for (let s = 0; s <= R5.length; s += 8) feed(pointAt(R5.pts, R5.cum, s));
  // 过岔口后沿 6 号和 7 号的正中间（离两条各约 15 m）滑行
  const states = new Set();
  for (let s = 0; s <= R7.length - 60; s += 8) {
    const a = pointAt(R6.pts, R6.cum, s * R6.length / R7.length), b = pointAt(R7.pts, R7.cum, s);
    feed({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    states.add(nav.state);
  }
  const tx = spoken.map((x) => x.text);
  assert.ok(!tx.some((x) => /^已进入/.test(x)), '不应确认：' + tx.join(' / '));
  assert.ok(!tx.some((x) => /偏离路线/.test(x)), '不应判偏航：' + tx.join(' / '));
  assert.ok(states.has('unreliable') && nav.unreliable?.reason === 'ambiguous', [...states].join(','));
  assert.ok(tx.includes('暂时无法确定所在雪道，请留意路牌'));
  assert.equal(nav.snapshot(t).distToNext, null, '无法区分时不显示距离');
});

test('相邻雪道 + 较大漂移（模拟）：确认时一定与其他分支拉开距离', () => {
  for (const seed of [4, 6, 8]) {
    const run = runScenario(R, { start: 'M', goal: 'J4', prefs: { maxDifficulty: 2, preferShort: true }, sim: { drift: 9, seed, carve: false } });
    assert.ok(run.snaps.some((z) => z.truth?.edge === 'R7' || z.truth?.edge === 'R6'), '确实滑到了相邻雪道');
    for (const c of run.spoken.filter((s) => /^已进入/.test(s.text))) {
      const m = /距预期分支 (\d+) m，距其他分支 ≥ (\d+) m/.exec(c.reason);
      assert.ok(m && Number(m[2]) - Number(m[1]) >= 10, c.reason);
    }
    assert.ok(!run.spoken.some((s) => /可能偏离路线/.test(s.text)), `seed ${seed}：` + texts(run.spoken).join('\n'));
  }
});

test('相邻雪道 + 小漂移：可以正确确认', () => {
  const run = runScenario(R, { start: 'M', goal: 'REST', prefs: { maxDifficulty: 2, preferShort: true }, sim: { drift: 2, seed: 4 } });
  const t = texts(run.spoken);
  assert.ok(t.some((x) => /^已进入(六|七)号雪道$/.test(x)), t.join('\n'));
});

test('走错分支：提示偏航但不要求掉头/急转，并从当前雪道向前重新规划', () => {
  // 从山腰站去山脚餐厅（中级上限），在森林岔口故意走错
  const run = runScenario(R, {
    start: 'M', goal: 'REST', prefs: { maxDifficulty: 2 },
    events: [{ at: 5, do: ({ simu }) => simu.takeWrongBranchAtNextFork() }]
  });
  const t = texts(run.spoken);
  assert.ok(t.includes('可能偏离路线，请在安全位置停下查看地图'), t.join('\n'));
  const offIdx = t.indexOf('可能偏离路线，请在安全位置停下查看地图');
  // 偏航后的任何提示都不能包含掉头/逆行/立即转向
  for (const x of t.slice(offIdx)) assert.ok(!/掉头|逆行|往回|立即|马上|急转/.test(x), x);
  // 紧接偏航后的提示中不能出现转向
  assert.ok(!/靠左|靠右/.test(t[offIdx + 1] || ''), '偏航后下一句不应是转向：' + t[offIdx + 1]);
  // 重新规划的路线第一段就是当前所在的雪道（向前），不是逆行
  const reroute = run.log.find((l) => l.key?.startsWith('reroute:'));
  assert.ok(reroute, '应当重新规划');
  assert.match(reroute.reason, /向前重新规划/);
  assert.equal(run.nav.state, 'arrived');
});

test('走进关闭雪道时：仍只提示偏航，并从该雪道向前规划', () => {
  // 让模拟者在森林岔口进入关闭的 8 号悬崖线
  const run = runScenario(R, {
    start: 'M', goal: 'REST', prefs: { maxDifficulty: 4 },
    events: [{ at: 5, do: ({ simu }) => {
      const k = simu.path.findIndex((e) => e.to === 'J3');
      simu.path = [...simu.path.slice(0, k + 1), R.edges.get('R8')];
    } }]
  });
  const t = texts(run.spoken);
  assert.ok(t.includes('可能偏离路线，请在安全位置停下查看地图'), t.join('\n'));
  for (const x of t) assert.ok(!/掉头|逆行|往回/.test(x), x);
});

test('静止时不做方向判断', () => {
  // 在接近森林岔口前停下 40 秒（速度为 0），期间不应有主提示
  const run = runScenario(R, {
    start: 'M', goal: 'REST', prefs: { maxDifficulty: 2 },
    events: [{ at: 20, do: ({ simu }) => { simu._saved = simu.skierFactor; simu.skierFactor = 0.0001; } },
             { at: 60, do: ({ simu }) => { simu.skierFactor = simu._saved; } }]
  });
  const during = run.spoken.filter((s) => s.t > 25000 && s.t < 60000);
  for (const s of during) assert.ok(!/靠左|靠右|走中间|已进入/.test(s.text), '静止期间不应有方向结论：' + s.text);
  assert.equal(run.nav.state, 'arrived');
});
