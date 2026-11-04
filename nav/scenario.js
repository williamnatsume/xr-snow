// 无界面的完整模拟：规划路线 → 用模拟器逐秒产生定位 → 导航状态机 → 播报记录。
// 测试（tests/helpers.mjs）和原生 App 的自检共用这一份，保证两边跑的是同一个场景。

import { planRoute } from './planner.js';
import { Navigator } from './navigator.js';
import { Simulator } from './simulator.js';

export function runScenario(r, { start, goal, prefs, sim = {}, events = [], maxSec = 3000, navCfg, routeEdges, lang } = {}) {
  // routeEdges：直接指定路线（用于强制经过某个场景，例如回头弯）
  const plan = routeEdges
    ? { ok: true, edges: routeEdges.map((id) => r.edges.get(id)) }
    : planRoute(r, { startNode: start, goalNode: goal }, prefs);
  if (!plan.ok) throw new Error('无法规划：' + plan.reason);
  const spoken = [];
  const states = [];
  const nav = new Navigator(r, { onSpeak: (x) => spoken.push(x), cfg: navCfg, lang });
  const simu = new Simulator(r, { seed: sim.seed ?? 3, drift: sim.drift ?? 4, carve: sim.carve ?? true });
  simu.setPath(plan.edges);
  // 走错分支之后，模拟的滑雪者按导航重新规划的路线继续滑
  simu.follow = (node) => (nav.route || []).slice(nav.idx).find((e) => e.from === node) || null;
  nav.start({ route: plan, destNode: goal, prefs }, 0);
  const snaps = [];
  let lastState = null, doneAt = null;
  for (let sec = 1; sec <= maxSec; sec++) {
    if (nav.state === 'arrived' || (doneAt != null && sec - doneAt > 30)) {
      // 到终点后再多跑几秒，看会不会有多余播报
      for (let k = 0; k < 10; k++) { const f = simu.step(1); if (f) nav.onFix(f); nav.tick(simu.t); }
      break;
    }
    if (simu.done && doneAt == null) doneAt = sec;
    for (const ev of events) if (ev.at === sec) ev.do({ nav, simu, sec });
    const fix = simu.step(1);
    if (fix) nav.onFix(fix);
    nav.tick(simu.t);
    const snap = nav.snapshot(simu.t);
    snaps.push({ sec, snap, truth: fix?.truth, fix, inOutage: simu.inOutage });
    if (snap.state !== lastState) { states.push({ sec, state: snap.state, reason: snap.unreliable }); lastState = snap.state; }
  }
  return { plan, spoken, states, snaps, nav, simu, log: nav.log };
}
