// 测试辅助：载入雪场、规划路线、用模拟器跑一整段导航（无界面、无真实时间）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadResort } from '../nav/resort.js';
import { planRoute } from '../nav/planner.js';
import { Navigator } from '../nav/navigator.js';
import { Simulator } from '../nav/simulator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resort(name = 'demo-fictional') {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'resorts', name + '.json'), 'utf8'));
  const r = loadResort(json);
  if (r.errors.length) throw new Error(r.errors.join('; '));
  return r;
}

// 跑一次完整模拟，返回播报记录和状态序列
export function runScenario(r, { start, goal, prefs, sim = {}, events = [], maxSec = 3000, navCfg, routeEdges } = {}) {
  // routeEdges：直接指定路线（用于强制经过某个场景，例如回头弯）
  const plan = routeEdges
    ? { ok: true, edges: routeEdges.map((id) => r.edges.get(id)) }
    : planRoute(r, { startNode: start, goalNode: goal }, prefs);
  if (!plan.ok) throw new Error('无法规划：' + plan.reason);
  const spoken = [];
  const states = [];
  const nav = new Navigator(r, { onSpeak: (x) => spoken.push(x), cfg: navCfg });
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

export const texts = (spoken) => spoken.map((s) => s.text);
