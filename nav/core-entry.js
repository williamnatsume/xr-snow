// 原生 App（iOS JavaScriptCore）用的入口：只包含纯逻辑，不引用 DOM。
// 用 `npm run build:ios` 打包成 IIFE，全局名 XRNav。
//
// 原生层只通过 createSession() 返回的对象交互：参数是普通值，返回值都是 JSON 字符串，
// 播报不走回调，而是放进队列，由原生层在每次调用后用 drainSpeech() 取走。

import { loadResort, edgeLabel, DIFFICULTY } from './resort.js';
import { planRoute, DEFAULT_PREFS } from './planner.js';
import { buildManeuvers, maneuverText } from './instructions.js';
import { Navigator, STATE_ZH, UNRELIABLE_ZH } from './navigator.js';
import { Simulator } from './simulator.js';
import { parseRequest } from './nlp.js';
import { runScenario } from './scenario.js';

export { loadResort, planRoute, Navigator, buildManeuvers, maneuverText, parseRequest, Simulator, runScenario, DEFAULT_PREFS, STATE_ZH, UNRELIABLE_ZH };

const J = (x) => JSON.stringify(x);

// M1 验收用：跑一遍完整模拟，返回播报文字序列（与 npm test 的同一场景对比）
export function scenarioTexts(resortJsonText, opts) {
  const r = loadResort(JSON.parse(resortJsonText));
  if (r.errors.length) return J({ ok: false, errors: r.errors });
  const res = runScenario(r, JSON.parse(opts || '{}'));
  return J({ ok: true, texts: res.spoken.map((s) => s.text), arrived: res.nav.state === 'arrived' });
}

export function createSession(resortJsonText) {
  const resort = loadResort(JSON.parse(resortJsonText));
  let lang = 'zh', plan = null, prefs = { ...DEFAULT_PREFS }, nav = null, sim = null;
  let queue = [], lastSpoken = null;

  const places = () => {
    // 可选地点：POI 优先，其余节点用节点名
    const seen = new Set(), list = [];
    for (const p of resort.pois || []) {
      if (seen.has(p.node)) continue;
      seen.add(p.node);
      list.push({ node: p.node, name: p.name, nameJa: p.name_ja || null });
    }
    for (const n of resort.nodes?.values() || []) {
      if (seen.has(n.id) || !n.name) continue;
      seen.add(n.id);
      list.push({ node: n.id, name: n.name, nameJa: n.name_ja || null });
    }
    return list;
  };

  const newNav = () => new Navigator(resort, {
    lang,
    onSpeak: (item) => { lastSpoken = item; queue.push({ text: item.text, reason: item.reason, voice: item.voice !== false, key: item.key, t: item.t }); }
  });

  return {
    info() {
      return J({
        errors: resort.errors, warnings: resort.warnings,
        id: resort.id, name: resort.name, region: resort.region || null,
        dataStatus: resort.dataStatus, allowRealGps: !!resort.allowRealGps,
        disclaimer: resort.disclaimer || '',
        places: resort.errors.length ? [] : places()
      });
    },

    setLang(l) { lang = l === 'ja' ? 'ja' : 'zh'; if (nav) nav.lang = lang; },

    // prefsJson：{ maxDifficulty, avoidFlat, preferShort }
    plan(startNode, goalNode, prefsJson) {
      prefs = { ...DEFAULT_PREFS, ...JSON.parse(prefsJson || '{}') };
      const p = planRoute(resort, { startNode, goalNode }, prefs);
      plan = p.ok ? { ...p, destNode: goalNode } : null;
      if (!p.ok) return J({ ok: false, reason: p.reason, hints: p.hints || [] });
      const ms = buildManeuvers(resort, p.edges, goalNode);
      return J({
        ok: true, warnings: p.warnings,
        length: p.length, time: p.time, flatLen: p.flatLen, liftCount: p.liftCount,
        maxDiff: p.maxDiff, maxDiffZh: DIFFICULTY[p.maxDiff]?.zh || null,
        steps: p.edges.map((e) => ({ id: e.id, type: e.type, label: edgeLabel(e), length: e.length, difficulty: e.difficulty })),
        maneuvers: ms.map((m) => maneuverText(m, 'main', { lang }))
      });
    },

    // mode：'sim' 用内置模拟器（时间从 0 开始，每次 simStep 前进 1 秒）；'gps' 用真实定位
    start(mode, nowMs, seed) {
      if (!plan) return J({ ok: false, reason: '请先规划路线' });
      if (mode === 'gps' && !resort.allowRealGps) return J({ ok: false, reason: '这个地图不允许真实 GPS 导航' });
      queue = []; lastSpoken = null;
      nav = newNav();
      if (mode === 'sim') {
        sim = new Simulator(resort, { seed: seed ?? 3, drift: 4, carve: true });
        sim.setPath(plan.edges);
        sim.follow = (node) => (nav?.route || []).slice(nav.idx).find((e) => e.from === node) || null;
        nav.start({ route: plan, destNode: plan.destNode, prefs }, 0);
      } else {
        sim = null;
        nav.start({ route: plan, destNode: plan.destNode, prefs }, nowMs);
      }
      return J({ ok: true });
    },

    simStep() {
      if (!nav || !sim) return J({ done: true });
      const fix = sim.step(1);
      if (fix) nav.onFix(fix);
      nav.tick(sim.t);
      return J({ done: nav.state === 'arrived' || nav.state === 'idle', simDone: sim.done, t: sim.t });
    },

    simWrongBranch() { return J(sim ? sim.takeWrongBranchAtNextFork() : null); },
    simOutage(sec) { if (sim) sim.startOutage(sec); },

    // 真实定位（CoreLocation）：速度 < 0 或误差 > 50 m 时不使用设备速度，与网页版一致
    onLocation(tMs, lat, lon, acc, speed) {
      if (!nav || !resort.proj) return;
      const { x, y } = resort.proj.toXY(lat, lon);
      const devSpeed = speed != null && !isNaN(speed) && speed >= 0 && acc <= 50 ? speed : null;
      nav.onFix({ t: tMs, x, y, acc, speed: devSpeed, source: 'gps' });
    },

    tick(nowMs) { if (nav && !sim) nav.tick(nowMs); },
    pause(nowMs) { nav?.pause(sim ? sim.t : nowMs); },
    resume(nowMs) { nav?.resume(sim ? sim.t : nowMs); },
    stop(nowMs) { nav?.stop(sim ? sim.t : nowMs); nav = null; sim = null; },

    drainSpeech() { const q = queue; queue = []; return J(q); },

    // 重播：有距离时带上距离（与网页版的“重播”按钮一致）
    replayText(nowMs) {
      if (!nav) return J(lastSpoken?.text || null);
      const s = nav.snapshot(sim ? sim.t : nowMs);
      if (!s.nextText) return J(lastSpoken?.text || null);
      if (s.distToNext > 60 && lang !== 'ja') return J(`约${Math.round(s.distToNext / 10) * 10}米后，${s.nextText}`);
      return J(s.nextText);
    },

    snapshot(nowMs) {
      if (!nav) return J({ state: 'idle', stateZh: STATE_ZH.idle });
      const s = nav.snapshot(sim ? sim.t : nowMs);
      return J({
        state: s.state, stateZh: s.stateZh, unreliable: s.unreliable,
        stationary: s.stationary, ambiguous: s.ambiguous,
        acc: s.acc, speed: s.speed, ageMs: s.ageMs, stale: s.stale,
        nextText: s.nextText, distToNext: s.distToNext, remaining: s.remaining,
        edge: s.matched?.edge ? edgeLabel(s.matched.edge) : null,
        simT: sim ? sim.t : null
      });
    }
  };
}
