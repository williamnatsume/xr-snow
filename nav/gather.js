// 小队集合：根据每个队员当前所在位置和各自的难度设置，算出每个人到集合点的路线和预计时间，
// 并生成发给每个人的话。集合点可以由发起人指定，也可以自动选（让最晚到的人尽量早到）。
//
// 规则与 planner.js 相同：只按数据方向通行（雪道下坡、缆车上行），每个人的难度上限分开算，
// 某人到不了就明确说出来并告诉发起人，绝不替他放宽条件。
//
// 队员：{ id, name, at, prefs }
//   at = { node }：在某个节点（缆车站、岔口……）
//   at = { edgeId, s }：在某条雪道 / 缆车上，s 为已走过的距离（米，可省略 = 刚进入）
//   prefs：与 planRoute 相同（maxDifficulty、avoidFlat……），省略时用默认值

import { planRoute, edgeBlockReason, edgeCost, edgeTime, DEFAULT_PREFS } from './planner.js';
import { poiOfNode, DIFFICULTY } from './resort.js';
import { spokenName } from './instructions.js';
import { resolvePlace, stripWake } from './companion.js';

// 起点：在节点上就是节点本身；在某条边上只能沿它走到终点（不能掉头），先算出剩下这段的时间
function startOf(resort, at) {
  if (at?.node != null) {
    if (!resort.nodes.has(at.node)) return null;
    return { node: at.node, prefix: null, prefixTime: 0 };
  }
  const e = at?.edgeId != null ? resort.edges.get(at.edgeId) : null;
  if (!e) return null;
  const done = Math.min(Math.max(at.s || 0, 0), e.length);
  const left = e.length ? 1 - done / e.length : 0;
  return { node: e.to, prefix: e, prefixTime: edgeTime(e) * left };
}

// 单源 Dijkstra：从一个人的起点到所有节点。代价与 planRoute 相同（所以路线一致），另外沿路累计时间
function reachAll(resort, start, prefs) {
  const cost = new Map([[start.node, 0]]);
  const time = new Map([[start.node, start.prefixTime]]);
  const done = new Set();
  const queue = [start.node];
  while (queue.length) {
    // 节点数在几百以内，线性找最小值足够快
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if (cost.get(queue[i]) < cost.get(queue[bi])) bi = i;
    const n = queue.splice(bi, 1)[0];
    if (done.has(n)) continue;
    done.add(n);
    for (const e of resort.out.get(n) || []) {
      if (edgeBlockReason(e, prefs)) continue;
      const nc = cost.get(n) + edgeCost(e, prefs);
      if (nc < (cost.get(e.to) ?? Infinity)) {
        cost.set(e.to, nc);
        time.set(e.to, time.get(n) + edgeTime(e));
        queue.push(e.to);
      }
    }
  }
  return time;
}

// 适合当集合点的地方：有名字的地点（餐厅、缆车站……）+ 所有缆车的上下站
export function meetingCandidates(resort) {
  const set = new Set(resort.pois.map((p) => p.node));
  for (const e of resort.edges.values()) if (e.type === 'lift') { set.add(e.from); set.add(e.to); }
  return [...set];
}

export function placeName(resort, node) {
  return poiOfNode(resort, node)?.name || resort.nodes.get(node)?.name || node;
}

// 自动选集合点：所有人都能到的候选里，最晚到的人用时最短；一样时总用时短的优先
export function chooseMeetingPoint(resort, members, { candidates } = {}) {
  const cands = candidates || meetingCandidates(resort);
  const reach = members.map((m) => {
    const st = startOf(resort, m.at);
    return st ? reachAll(resort, st, { ...DEFAULT_PREFS, ...m.prefs }) : new Map();
  });
  const scored = [];
  for (const node of cands) {
    const times = reach.map((r) => r.get(node));
    if (times.some((t) => t == null)) continue;
    scored.push({ node, name: placeName(resort, node), maxTime: Math.max(...times), sumTime: times.reduce((a, b) => a + b, 0) });
  }
  scored.sort((a, b) => a.maxTime - b.maxTime || a.sumTime - b.sumTime);
  return scored;
}

// 每个人到 goalNode 的路线。goalNode 省略时自动选集合点
export function planGather(resort, members, { goalNode, candidates } = {}) {
  if (!members.length) return { ok: false, reason: '小队里没有人' };
  let auto = false, alternatives = [];
  if (goalNode == null) {
    const ranked = chooseMeetingPoint(resort, members, { candidates });
    if (!ranked.length) {
      return { ok: false, reason: '找不到所有人都能到的集合点', members: members.map((m) => planOne(resort, m, null)) };
    }
    goalNode = ranked[0].node;
    alternatives = ranked.slice(1, 3);
    auto = true;
  }
  if (!resort.nodes.has(goalNode)) return { ok: false, reason: '集合点不存在' };

  const out = members.map((m) => planOne(resort, m, goalNode));
  const reachable = out.filter((m) => m.ok);
  const slowest = reachable.reduce((a, b) => (!a || b.eta > a.eta ? b : a), null);
  return {
    ok: true,
    goalNode,
    goalName: placeName(resort, goalNode),
    auto,
    alternatives,
    members: out,
    allReachable: reachable.length === out.length,
    allTogetherEta: slowest ? slowest.eta : null,
    slowest: slowest ? slowest.id : null
  };
}

function planOne(resort, m, goalNode) {
  const base = { id: m.id, name: m.name || m.id };
  const st = startOf(resort, m.at);
  if (!st) return { ...base, ok: false, reason: '位置不明' };
  if (goalNode == null) return { ...base, ok: false, reason: '没有集合点' };
  const prefs = { ...DEFAULT_PREFS, ...m.prefs };
  if (!st.prefix && st.node === goalNode) return { ...base, ok: true, here: true, eta: 0, route: null };
  const route = planRoute(resort, st.prefix ? { startEdgeId: st.prefix.id, goalNode } : { startNode: st.node, goalNode }, prefs);
  if (!route.ok) return { ...base, ok: false, reason: route.reason, hints: route.hints || [], maxDifficulty: prefs.maxDifficulty };
  // planRoute 算的是整条当前边；扣掉已经走过的部分
  const eta = route.time - (st.prefix ? edgeTime(st.prefix) - st.prefixTime : 0);
  return { ...base, ok: true, here: false, eta, route };
}

/* ============ 说给每个人听的话 ============ */

const minutes = (sec) => Math.max(1, Math.round(sec / 60));

// 路线压缩成几步口头描述：用语音里的叫法（与岔口提示一致），同名的连续路段只说一次；
// 最多 3 步，其余交给沿途的岔口提示
export function routeBrief(route, maxSteps = 3) {
  const steps = [];
  for (const e of route.edges) {
    const verb = e.type === 'lift' ? '坐' : e.type === 'connector' ? '走' : '滑';
    const step = verb + spokenName(e);
    if (steps[steps.length - 1] !== step) steps.push(step);
  }
  if (steps.length === 1) return steps[0];
  if (steps.length <= maxSteps) return `先${steps[0]}，` + steps.slice(1).map((x, i, a) => (i === a.length - 1 ? `最后${x}` : `再${x}`)).join('，');
  return `先${steps[0]}，` + steps.slice(1, maxSteps).map((x) => `再${x}`).join('，') + '，后面听雪人的岔口提示';
}

// fromId：发起人。返回 { toMembers: [{ id, text }], toOrganizer }
export function gatherMessages(resort, plan, fromId) {
  const from = plan.members?.find((m) => m.id === fromId);
  const fromName = from?.name || '队长';
  if (!plan.ok) {
    return { toMembers: [], toOrganizer: `没法安排集合：${plan.reason}。` };
  }
  const place = plan.goalName;
  const toMembers = [];
  for (const m of plan.members) {
    if (m.id === fromId) continue;
    let text = `${fromName}让大家到${place}集合。`;
    if (!m.ok) {
      const lim = DIFFICULTY[m.maxDifficulty]?.zh;
      text += lim ? `按你现在的设置（最高${lim}）到不了，` : '你那边暂时规划不出路线，';
      text += `先在安全的地方停下，我已经告诉${fromName}了。`;
    } else if (m.here) {
      text += '你已经在这里了，原地等大家就行。';
    } else {
      text += `你大约${minutes(m.eta)}分钟到：${routeBrief(m.route)}。`;
    }
    toMembers.push({ id: m.id, text });
  }

  const parts = [];
  if (plan.auto) parts.push(`集合点选在${place}，这里大家到齐最快。`);
  else parts.push(`好，叫大家到${place}集合。`);
  const notified = toMembers.length;
  if (notified) parts.push(`已经通知了${notified}个人。`);
  if (from?.ok && !from.here) parts.push(`你自己大约${minutes(from.eta)}分钟到：${routeBrief(from.route)}。`);
  else if (from?.here) parts.push('你就在这里，等大家就行。');
  const moving = plan.members.filter((m) => m.ok && !m.here);
  const slow = plan.members.find((m) => m.id === plan.slowest);
  if (slow && !slow.here) {
    if (slow.id === fromId) parts.push(`预计${minutes(plan.allTogetherEta)}分钟后到齐，你自己最晚。`);
    else if (moving.length === 1) parts.push(`${slow.name}大约${minutes(slow.eta)}分钟到。`);
    else parts.push(`预计${minutes(plan.allTogetherEta)}分钟后到齐，最晚的是${slow.name}（约${minutes(slow.eta)}分钟）。`);
  }
  for (const m of plan.members.filter((x) => !x.ok)) {
    const hint = m.hints?.[0] ? `（${m.hints[0]}）` : '';
    parts.push(`${m.name}到不了${hint}，要不要换个集合点？`);
  }
  return { toMembers, toOrganizer: parts.join('') };
}

/* ============ 听懂“集合”这句话 ============ */

const GATHER_RE = /(集合|会合|汇合|碰头|会面|聚一下|集まろう|集まって|集合して|合流)/;
const ALL_RE = /(大家|所有人|全员|全体|我们|咱们|みんな|全員)/;
// 集合点：“到 / 去 / 在 X 集合”
const PLACE_RE = /(?:到|去|在|回|来)(.{1,14}?)(?:集合|会合|汇合|碰头|会面|聚|に集|で集|で合流)/;

// 返回 null（不是集合）或 { place: { node, name } | null（自动选）, ambiguous?, unknownPlace? }
export function parseGather(text, resort) {
  const t = stripWake(text).replace(/\s+/g, '');
  if (!GATHER_RE.test(t)) return null;
  if (!ALL_RE.test(t) && !/^(集合|集まろう)/.test(t)) return null;
  const m = PLACE_RE.exec(t);
  const raw = m ? m[1].replace(/^(大家|所有人|我们|咱们|みんな)/, '') : '';
  if (!raw) return { place: null };
  const hit = resolvePlace(resort, raw);
  if (!hit) return { place: null, unknownPlace: raw };
  if (hit.ambiguous) return { place: null, ambiguous: hit.ambiguous };
  return { place: { node: hit.node, name: hit.name }, guess: !!hit.guess };
}
