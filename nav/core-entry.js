// 原生 App（iOS JavaScriptCore）用的入口：只包含纯逻辑，不引用 DOM。
// 用 `npm run build:ios` 打包成 IIFE，全局名 XRNav。
//
// 原生层只通过 createSession() 返回的对象交互：参数是普通值，返回值都是 JSON 字符串，
// 播报不走回调，而是放进队列，由原生层在每次调用后用 drainSpeech() 取走。

import { loadResort, edgeLabel, DIFFICULTY } from './resort.js';
import { planRoute, DEFAULT_PREFS } from './planner.js';
import { buildManeuvers, maneuverText } from './instructions.js';
import { Navigator, STATE_ZH, UNRELIABLE_ZH, NAV_CFG } from './navigator.js';
import { Simulator } from './simulator.js';
import { parseRequest } from './nlp.js';
import { runScenario } from './scenario.js';
import { overpassQuery, skiAreaQuery, parseSkiAreas, padBbox, elevationPoints, convertOsm, eleKey } from './osm-import.js';
import { createCompanion, rulesIntent, brainSystemPrompt, companionSystemPrompt, COMPANION_TOOLS, INTENT_SCHEMA, stripWake, hasWake, afterWake, WAKE_WORDS } from './companion.js';

export { loadResort, planRoute, Navigator, buildManeuvers, maneuverText, parseRequest, Simulator, runScenario, DEFAULT_PREFS, STATE_ZH, UNRELIABLE_ZH, createCompanion, rulesIntent, INTENT_SCHEMA, WAKE_WORDS };

const J = (x) => JSON.stringify(x);

// 自动下载地图（OpenStreetMap）：原生层负责联网，转换在这里。参数和返回值都是字符串
export const osm = {
  skiAreaQuery: (lat, lon, radiusKm) => skiAreaQuery(lat, lon, radiusKm),
  parseSkiAreas: (rawText, lat, lon) => J(parseSkiAreas(JSON.parse(rawText), lat, lon)),
  downloadQuery: (bboxJson) => overpassQuery(padBbox(JSON.parse(bboxJson))),
  elevationPoints: (rawText, optsJson) => J(elevationPoints(JSON.parse(rawText), JSON.parse(optsJson))),
  // elevJson：{ "lat5,lon5": 海拔 }；返回 { ok, resort（JSON 文本）, quality, errors }
  convert(rawText, optsJson, elevJson) {
    // 高程：{ "lat5,lon5": 海拔 } 或 [[lat, lon, 海拔], …]（后者由原生层按 elevationPoints 的顺序填好，避免两边取整不一致）
    const e = JSON.parse(elevJson || '{}');
    const elev = Array.isArray(e) ? Object.fromEntries(e.map(([la, lo, v]) => [eleKey(la, lo), v])) : e;
    const out = convertOsm(JSON.parse(rawText), JSON.parse(optsJson), (lat, lon) => elev[eleKey(lat, lon)] ?? null);
    const check = loadResort(out);
    const ok = !check.errors.length && out.edges.some((e) => e.type === 'run');
    return J({ ok, errors: check.errors, quality: out.importReport.quality, resort: JSON.stringify(out) });
  }
};

// M1 验收用：跑一遍完整模拟，返回播报文字序列（与 npm test 的同一场景对比）
export function scenarioTexts(resortJsonText, opts) {
  const r = loadResort(JSON.parse(resortJsonText));
  if (r.errors.length) return J({ ok: false, errors: r.errors });
  const res = runScenario(r, JSON.parse(opts || '{}'));
  return J({ ok: true, texts: res.spoken.map((s) => s.text), arrived: res.nav.state === 'arrived' });
}

export function createSession(resortJsonText) {
  const resort = loadResort(JSON.parse(resortJsonText));
  let lang = 'zh', talkLang = 'zh', navLang = null, extraLead = 0, plan = null, prefs = { ...DEFAULT_PREFS }, nav = null, sim = null;
  let queue = [], lastSpoken = null;
  let mode = 'sim', lastFix = null, defaultStart = null, simSeed = null;

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
    lang: navLang || lang,
    // 用实时语音播报时，说出来要多花约 1 秒：提醒相应提前
    cfg: extraLead ? { reactSec: NAV_CFG.reactSec + extraLead } : undefined,
    onSpeak: (item) => { lastSpoken = item; queue.push({ text: item.text, reason: item.reason, voice: item.voice !== false, key: item.key, t: item.t }); }
  });

  let lastNow = 0;
  const nowOf = () => (sim ? sim.t : lastNow);

  // 开始导航（按钮和对话共用）
  function startNav(p, destNode, pr, nowMs) {
    if (mode === 'gps' && !resort.allowRealGps) return { ok: false, reason: '这个地图不允许真实 GPS 导航' };
    queue = []; lastSpoken = null;
    nav = newNav();
    if (mode === 'sim') {
      sim = new Simulator(resort, { seed: simSeed ?? 3, drift: 4, carve: true });
      sim.setPath(p.edges);
      sim.follow = (node) => (nav?.route || []).slice(nav.idx).find((e) => e.from === node) || null;
      nav.start({ route: p, destNode, prefs: pr }, 0);
    } else {
      sim = null;
      nav.start({ route: p, destNode, prefs: pr }, nowMs ?? lastNow);
      if (lastFix) nav.onFix(lastFix);
    }
    plan = { ...p, destNode };
    prefs = pr;
    return { ok: true };
  }

  const isNavigating = () => !!nav && nav.state !== 'idle';
  const companion = createCompanion({
    resort,
    lang: () => talkLang,
    usesGps: () => mode === 'gps',
    lastFix: () => lastFix,
    defaultStart: () => defaultStart || places()[0]?.node || null,
    isNavigating,
    currentEdge: () => (nav ? (nav.matched?.edge || nav.route?.[nav.idx] || null) : null),
    navPrefs: () => (nav ? nav.prefs : null),
    navGoal: () => (nav ? nav.destNode : null),
    edgeLabel,
    plan: (q, pr) => planRoute(resort, q, pr),
    startNav: (p, goal, pr) => startNav(p, goal, pr, lastNow),
    stopNav: () => { nav?.stop(nowOf()); nav = null; sim = null; },
    pause: () => nav?.pause(nowOf()),
    resume: () => nav?.resume(nowOf()),
    snapshot: () => {
      const sn = nav.snapshot(nowOf());
      sn.nextPreview = sn.next && sn.distToNext != null ? maneuverText(sn.next, 'preview', { lang, distance: sn.distToNext }) : null;
      return sn;
    },
    replay: () => {
      if (!nav) return lastSpoken?.text || null;
      const s = nav.snapshot(nowOf());
      return s.nextText || lastSpoken?.text || null;
    }
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

    // lang：导航播报语言（神乐用日语，因为雪道名是假名）；talkLang：用户说话和雪人回话的语言
    setLang(l) { lang = l === 'ja' ? 'ja' : 'zh'; if (nav) nav.lang = lang; },
    setTalkLang(l) { talkLang = l === 'ja' ? 'ja' : 'zh'; },
    // 实时语音播报导航时：播报文字用说话的语言（名称保留原文，模型会按原文读音读），并提前 extraSec 秒提醒
    setRealtimeAnnounce(on, extraSec) { navLang = on ? talkLang : null; extraLead = on ? (extraSec || 0) : 0; },

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
    start(m, nowMs, seed) {
      if (!plan) return J({ ok: false, reason: '请先规划路线' });
      mode = m === 'gps' ? 'gps' : 'sim';
      simSeed = seed;
      return J(startNav(plan, plan.destNode, prefs, nowMs));
    },

    // 对话用的设置：定位来源、模拟时的默认起点
    configure(m, startNode, seed) { mode = m === 'gps' ? 'gps' : 'sim'; defaultStart = startNode || null; simSeed = seed ?? null; },

    // 一句话 → 意图（本地规则）。返回意图 JSON
    understandLocal(text) { return J(rulesIntent(text, resort)); },
    stripWake(text) { return stripWake(text); },
    hasWake(text) { return hasWake(text); },
    afterWake(text) { return afterWake(text); },

    // 云端“雪人”：人设系统提示 + 工具定义；工具由原生层转调 tool()
    companionPrompt() { return J({ system: companionSystemPrompt(resort, talkLang), tools: COMPANION_TOOLS }); },
    tool(name, argsJson, nowMs) {
      if (nowMs != null) lastNow = nowMs;
      let args = {};
      try { args = JSON.parse(argsJson || '{}'); } catch { /* 空参数 */ }
      return J(companion.tool(name, args));
    },
    status(nowMs) { if (nowMs != null) lastNow = nowMs; return J(companion.status()); },

    // 给云端大模型的系统提示和输出格式
    brainPrompt() { return J({ system: brainSystemPrompt(resort, talkLang), schema: INTENT_SCHEMA }); },

    // 执行意图（来自云端或本地规则），返回 { say, mode, awaiting?, event? }
    converse(intentJson, nowMs) {
      lastNow = nowMs;
      let intent;
      try { intent = JSON.parse(intentJson); } catch { intent = { intent: 'unknown' }; }
      return J(companion.handle(intent));
    },
    companionMode() { return companion.mode; },

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
      if (!resort.proj) return;
      const { x, y } = resort.proj.toXY(lat, lon);
      const devSpeed = speed != null && !isNaN(speed) && speed >= 0 && acc <= 50 ? speed : null;
      lastNow = Math.max(lastNow, tMs);
      lastFix = { t: tMs, x, y, acc, speed: devSpeed, source: 'gps' };
      if (nav && !sim) nav.onFix(lastFix);
    },

    tick(nowMs) { lastNow = nowMs; if (nav && !sim) nav.tick(nowMs); },
    pause(nowMs) { nav?.pause(sim ? sim.t : nowMs); },
    resume(nowMs) { nav?.resume(sim ? sim.t : nowMs); },
    stop(nowMs) { nav?.stop(sim ? sim.t : nowMs); nav = null; sim = null; companion.reset(); },

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
        simT: sim ? sim.t : null,
        routeKm: s.route ? s.route.reduce((a, e) => a + e.length, 0) / 1000 : null
      });
    }
  };
}
