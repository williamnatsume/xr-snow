// 把 OpenStreetMap（Overpass 导出）的雪道/缆车数据转换成导航用的雪场 JSON。
//
// 用法：node tools/import-osm.mjs [overpass.json] [输出.json]
//   默认读取 data/osm/kagura-overpass.json，输出 resorts/kagura-osm.json
//
// 数据可信度说明（会写进输出文件）：
//   - 雪道名称、难度、缆车名称：来自 OSM，社区编辑，未核实（attr = "osm"）
//   - 雪道方向：按 OSM 约定“雪道按下坡方向绘制”假定，再用国土地理院高程检查（attr = "derived"）
//   - 平路：用高程推算平均坡度，未实测（attr = "derived"）
//   - 开放状态：OSM 没有实时信息，一律未知（attr = "unknown"）
//   - 岔口拓扑：OSM 共享节点 + 程序吸附推算（attr = "osm" / "derived"）
//
// 高程来自国土地理院 標高API（出典：国土地理院），结果缓存在 data/osm/gsi-elev-cache.json。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN = process.argv[2] || path.join(ROOT, 'data/osm/kagura-overpass.json');
const OUT = process.argv[3] || path.join(ROOT, 'resorts/kagura-osm.json');
const CACHE = path.join(ROOT, 'data/osm/gsi-elev-cache.json');

// 雪场范围：神乐（三俣・神乐・田代），排除苗场一侧（ドラゴンドラ 等跨出范围的线）
const BBOX = { minLat: 36.836, maxLat: 36.90, minLon: 138.70, maxLon: 138.80 };
const LIFT_TYPES = new Set(['gondola', 'chair_lift', 'cable_car', 'drag_lift', 't-bar', 'platter', 'magic_carpet', 'mixed_lift', 'rope_tow']);
const SNAP_M = 25;          // 雪道端点离其他雪道这么近时，推算为相连
const LIFT_LINK_M = 60;     // 缆车站离雪道节点这么近时，加一段步行连接
const FLAT_GRADE = 0.06;    // 平均坡度低于 6% 视为平路（推算，待实测）
const DIR_TOL_M = 3;        // 终点比起点高出超过 3 m，判定方向存疑

/* ---------- 几何 ---------- */
const R = 6371000, rad = Math.PI / 180;
function hav(a, b) {
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const lineLen = (pts) => pts.reduce((s, p, i) => (i ? s + hav(pts[i - 1], p) : 0), 0);
// 点到线段的最近点（局部平面近似）
function projectOnLine(p, pts) {
  const kx = Math.cos(p.lat * rad) * R * rad, ky = R * rad;
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = (pts[i].lon - p.lon) * kx, ay = (pts[i].lat - p.lat) * ky;
    const bx = (pts[i + 1].lon - p.lon) * kx, by = (pts[i + 1].lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const x = ax + dx * t, y = ay + dy * t, d = Math.hypot(x, y);
    if (!best || d < best.d) best = { d, i, t };
  }
  return best;
}

/* ---------- 高程（国土地理院） ---------- */
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* 首次运行 */ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function elevation(lat, lon) {
  const key = lat.toFixed(5) + ',' + lon.toFixed(5);
  if (key in cache) return cache[key];
  const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}&outtype=JSON`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      const j = await res.json();
      const e = typeof j.elevation === 'number' ? j.elevation : null; // 取不到时 API 返回 "-----"
      cache[key] = e;
      await sleep(120); // 控制请求频率
      return e;
    } catch {
      await sleep(1000);
    }
  }
  return null;
}

/* ---------- 读入 OSM ---------- */
const raw = JSON.parse(fs.readFileSync(IN, 'utf8'));
const osmNodes = new Map();
const osmWays = [];
for (const e of raw.elements) {
  if (e.type === 'node') osmNodes.set(e.id, { ...(osmNodes.get(e.id) || {}), ...e });
  else if (e.type === 'way') osmWays.push(e);
}
const inBox = (n) => n.lat >= BBOX.minLat && n.lat <= BBOX.maxLat && n.lon >= BBOX.minLon && n.lon <= BBOX.maxLon;

const skipped = [];
const pistes = [], lifts = [];
for (const w of osmWays) {
  const t = w.tags || {};
  const isPiste = t['piste:type'] === 'downhill';
  const isLift = LIFT_TYPES.has(t.aerialway);
  if (!isPiste && !isLift) continue;
  const pts = w.nodes.map((id) => osmNodes.get(id));
  if (pts.some((p) => !p)) { skipped.push([w.id, t.name, '缺少节点坐标']); continue; }
  if (!pts.every(inBox)) { skipped.push([w.id, t.name, '超出神乐范围']); continue; }
  if (w.nodes[0] === w.nodes[w.nodes.length - 1] || t.area === 'yes') { skipped.push([w.id, t.name, '面状雪道，无法作为路线']); continue; }
  (isPiste ? pistes : lifts).push(w);
}

/* ---------- 顶点：多条雪道共享的节点 + 端点 ---------- */
const useCount = new Map();
for (const w of pistes) for (const id of new Set(w.nodes)) useCount.set(id, (useCount.get(id) || 0) + 1);
const vertexIds = new Set();
for (const w of pistes) {
  vertexIds.add(w.nodes[0]); vertexIds.add(w.nodes[w.nodes.length - 1]);
  for (const id of w.nodes) if (useCount.get(id) > 1) vertexIds.add(id);
}
for (const w of lifts) { vertexIds.add(w.nodes[0]); vertexIds.add(w.nodes[w.nodes.length - 1]); }

// 吸附：雪道端点没和任何其他雪道相连、但离某条雪道很近 → 在那条雪道上插一个推算节点
const derivedJoins = [];
let synthId = -1;
for (const w of pistes) {
  for (const endIdx of [0, w.nodes.length - 1]) {
    const nid = w.nodes[endIdx];
    if (useCount.get(nid) > 1) continue;
    const p = osmNodes.get(nid);
    let best = null;
    for (const o of pistes) {
      if (o === w) continue;
      const pr = projectOnLine(p, o.nodes.map((id) => osmNodes.get(id)));
      if (pr && pr.d <= SNAP_M && (!best || pr.d < best.pr.d)) best = { o, pr };
    }
    if (!best) continue;
    const { o, pr } = best;
    const a = osmNodes.get(o.nodes[pr.i]), b = osmNodes.get(o.nodes[pr.i + 1]);
    let joinId;
    if (pr.t < 0.05) joinId = o.nodes[pr.i];
    else if (pr.t > 0.95) joinId = o.nodes[pr.i + 1];
    else {
      // 在目标雪道上插入一个新节点
      joinId = synthId--;
      osmNodes.set(joinId, { id: joinId, lat: a.lat + (b.lat - a.lat) * pr.t, lon: a.lon + (b.lon - a.lon) * pr.t });
      o.nodes.splice(pr.i + 1, 0, joinId);
    }
    // 把本雪道的端点换成连接点（距离 ≤ 25 m，记为推算）
    w.nodes[endIdx] = joinId;
    useCount.set(joinId, (useCount.get(joinId) || 1) + 1);
    vertexIds.add(joinId);
    derivedJoins.push({ way: w.id, name: w.tags.name || null, gap_m: Math.round(pr.d), join: joinId });
  }
}

/* ---------- 拆分成图的边 ---------- */
const DIFF = { novice: 1, easy: 1, intermediate: 2, advanced: 3, expert: 4, freeride: 4, extreme: 4 };
const edges = [];
const usedVertex = new Set();
function addEdge(e) { edges.push(e); usedVertex.add(e.fromOsm); usedVertex.add(e.toOsm); }

for (const w of pistes) {
  const t = w.tags;
  let start = 0, part = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    if (!vertexIds.has(w.nodes[i]) && i !== w.nodes.length - 1) continue;
    const ids = w.nodes.slice(start, i + 1);
    part++;
    addEdge({
      osmWay: w.id, part, type: 'run',
      fromOsm: ids[0], toOsm: ids[ids.length - 1],
      pts: ids.map((id) => osmNodes.get(id)),
      name: t.name || null,
      difficulty: DIFF[t['piste:difficulty']] || null,
      freeride: t['piste:difficulty'] === 'freeride',
      grooming: t['piste:grooming'] || null
    });
    start = i;
  }
}
for (const w of lifts) {
  const t = w.tags;
  addEdge({
    osmWay: w.id, part: 1, type: 'lift', liftType: t.aerialway,
    fromOsm: w.nodes[0], toOsm: w.nodes[w.nodes.length - 1],
    pts: w.nodes.map((id) => osmNodes.get(id)),
    name: t.name || null,
    durationMin: t['aerialway:duration'] ? parseFloat(t['aerialway:duration']) : null
  });
}

// 缆车站与雪道节点不相连时，补一段步行连接（推算）
const pisteVertex = [...usedVertex].filter((id) => edges.some((e) => e.type === 'run' && (e.fromOsm === id || e.toOsm === id)));
const liftLinks = [];
for (const e of edges.filter((x) => x.type === 'lift')) {
  for (const [end, dir] of [[e.fromOsm, 'toLift'], [e.toOsm, 'fromLift']]) {
    if (pisteVertex.includes(end)) continue;
    const p = osmNodes.get(end);
    let best = null;
    for (const v of pisteVertex) {
      const d = hav(p, osmNodes.get(v));
      if (d <= LIFT_LINK_M && (!best || d < best.d)) best = { v, d };
    }
    if (!best) { liftLinks.push({ lift: e.name, end: dir, linked: false }); continue; }
    const a = dir === 'toLift' ? best.v : end, b = dir === 'toLift' ? end : best.v;
    edges.push({
      type: 'connector', fromOsm: a, toOsm: b,
      pts: [osmNodes.get(a), osmNodes.get(b)],
      name: dir === 'toLift' ? `${e.name || '缆车'} 乘车处步道` : `${e.name || '缆车'} 下车处步道`,
      difficulty: 1, flat: true, linkOf: e.name
    });
    usedVertex.add(a); usedVertex.add(b);
    liftLinks.push({ lift: e.name, end: dir, linked: true, dist_m: Math.round(best.d) });
  }
}

/* ---------- 高程：方向检查 + 平路推算 ---------- */
console.log(`雪道边 ${edges.filter((e) => e.type === 'run').length}，缆车 ${edges.filter((e) => e.type === 'lift').length}，正在查询高程…`);
const eleOf = async (p) => elevation(p.lat, p.lon);
for (const e of edges) {
  e.eleFrom = await eleOf(e.pts[0]);
  e.eleTo = await eleOf(e.pts[e.pts.length - 1]);
  e.length = lineLen(e.pts);
  if (e.type !== 'run') continue;
  if (e.eleFrom === null || e.eleTo === null) { e.dirCheck = 'unknown'; e.flat = null; continue; }
  const drop = e.eleFrom - e.eleTo;
  e.dirCheck = drop >= -DIR_TOL_M ? 'ok' : 'conflict';
  // 平均坡度：只用两端高程，忽略中间起伏（推算，待实测）
  e.grade = e.length > 0 ? drop / e.length : null;
  e.flat = e.grade !== null && e.length > 30 ? e.grade < FLAT_GRADE : null;
}
/* ---------- 推算步行连接（OSM 里没画、但现场一般可以走过去的短距离） ---------- */
// (a) 雪道死胡同终点 → 附近 80 m 内、爬升 ≤ 10 m 的节点
// (b) 只能乘缆车到达的节点（如吊厢下车处）← 附近 120 m 内、可以滑到的节点（爬升 ≤ 15 m）
const WALK_DEAD_M = 80, WALK_DEAD_CLIMB = 10, WALK_SRC_M = 120, WALK_SRC_CLIMB = 15;
const eleMap = new Map();
for (const e of edges) { if (e.eleFrom != null) eleMap.set(e.fromOsm, e.eleFrom); if (e.eleTo != null) eleMap.set(e.toOsm, e.eleTo); }
const outOf = (id) => edges.filter((e) => e.fromOsm === id);
const inOf = (id) => edges.filter((e) => e.toOsm === id);
const walkLinks = [];
function addWalk(a, b, why) {
  if (edges.some((e) => e.fromOsm === a && e.toOsm === b)) return;
  const pa = osmNodes.get(a), pb = osmNodes.get(b);
  edges.push({
    type: 'connector', fromOsm: a, toOsm: b, pts: [pa, pb], length: hav(pa, pb),
    eleFrom: eleMap.get(a) ?? null, eleTo: eleMap.get(b) ?? null,
    name: '推算步行连接', difficulty: 1, flat: true, linkOf: why, walk: true
  });
  walkLinks.push({ from: a, to: b, dist_m: Math.round(hav(pa, pb)), why });
}
const verts = [...usedVertex];
for (const id of verts) {
  const p = osmNodes.get(id), ele = eleMap.get(id);
  if (ele == null) continue;
  const runsIn = inOf(id).filter((e) => e.type !== 'lift');
  if (!outOf(id).length && runsIn.length) {
    let best = null;
    for (const m of verts) {
      if (m === id || eleMap.get(m) == null || eleMap.get(m) > ele + WALK_DEAD_CLIMB || !outOf(m).length) continue;
      const d = hav(p, osmNodes.get(m));
      if (d <= WALK_DEAD_M && (!best || d < best.d)) best = { m, d };
    }
    if (best) addWalk(id, best.m, `雪道终点 ${runsIn[0].name || runsIn[0].osmWay} 没有后续`);
  }
  if (inOf(id).every((e) => e.type === 'lift') && outOf(id).some((e) => e.type === 'run')) {
    let best = null;
    for (const m of verts) {
      if (m === id || eleMap.get(m) == null || ele > eleMap.get(m) + WALK_SRC_CLIMB) continue;
      if (!inOf(m).some((e) => e.type === 'run')) continue;
      const d = hav(p, osmNodes.get(m));
      if (d <= WALK_SRC_M && (!best || d < best.d)) best = { m, d };
    }
    if (best) addWalk(best.m, id, `只能乘缆车到达的节点（${inOf(id).map((e) => e.name).join('、') || '起点'}）`);
  }
}
fs.writeFileSync(CACHE, JSON.stringify(cache));

/* ---------- 输出 ---------- */
const nodeIdOf = (osmId) => (osmId < 0 ? 'D' + -osmId : 'N' + osmId);
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const nodes = [...usedVertex].map((id) => {
  const p = osmNodes.get(id);
  return { id: nodeIdOf(id), pos: [round6(p.lat), round6(p.lon)], kind: 'vertex', attr: { pos: id < 0 ? 'derived' : 'osm' } };
});
const nodeEle = new Map();
for (const e of edges) { nodeEle.set(e.fromOsm, e.eleFrom); nodeEle.set(e.toOsm, e.eleTo); }
for (const n of nodes) {
  const osmId = n.id[0] === 'D' ? -Number(n.id.slice(1)) : Number(n.id.slice(1));
  const ele = nodeEle.get(osmId);
  if (ele !== null && ele !== undefined) { n.ele = Math.round(ele); n.attr.ele = 'derived'; }
}

const LIFT_ZH = { gondola: '吊厢', chair_lift: '吊椅', cable_car: '缆车', drag_lift: '拖牵', 't-bar': '拖牵', platter: '拖牵', magic_carpet: '魔毯', mixed_lift: '混合缆车', rope_tow: '拖绳' };
const outEdges = edges.map((e, i) => {
  const base = {
    id: e.type === 'lift' ? `L${e.osmWay}` : e.type === 'connector' ? `C${i}` : `R${e.osmWay}${e.part > 1 ? '_' + e.part : ''}`,
    type: e.type,
    from: nodeIdOf(e.fromOsm), to: nodeIdOf(e.toOsm),
    geometry: e.pts.map((p) => [round6(p.lat), round6(p.lon)]),
    name: e.name,
    sign: e.name, // 路牌名称：暂用 OSM 名称，未核实是否与现场路牌一致
    ref: null,
    length_m: Math.round(e.length)
  };
  if (e.type === 'lift') {
    return {
      ...base, liftType: e.liftType, liftTypeZh: LIFT_ZH[e.liftType] || '缆车',
      duration_min: e.durationMin, open: null,
      attr: { name: e.name ? 'osm' : 'unknown', geometry: 'osm', direction: 'osm', open: 'unknown', duration: e.durationMin ? 'osm' : 'unknown' },
      source: { osmWay: e.osmWay }
    };
  }
  if (e.type === 'connector') {
    return {
      ...base, difficulty: 1, open: null, flat: true,
      attr: { name: 'derived', geometry: 'derived', direction: 'derived', difficulty: 'derived', open: 'unknown', flat: 'derived' },
      note: e.walk ? `程序推算的步行连接：${e.linkOf}；OSM 中没有这段，实际能否通行未知` : `程序推算的缆车站步行连接（${e.linkOf || ''}），实际路径未知`
    };
  }
  return {
    ...base,
    difficulty: e.difficulty, freeride: e.freeride || undefined,
    open: null,
    flat: e.flat,
    grade: e.grade === undefined || e.grade === null ? null : Math.round(e.grade * 1000) / 1000,
    directionCheck: e.dirCheck,
    attr: {
      name: e.name ? 'osm' : 'unknown',
      geometry: 'osm',
      direction: e.dirCheck === 'ok' ? 'derived' : e.dirCheck === 'conflict' ? 'conflict' : 'osm',
      difficulty: e.difficulty ? 'osm' : 'unknown',
      open: 'unknown',
      flat: e.flat === null ? 'unknown' : 'derived'
    },
    source: { osmWay: e.osmWay, part: e.part }
  };
});

// 目的地：缆车乘车处/下车处 + OSM 上的餐厅（吸附到最近的图节点，推算）
const pois = [];
for (const e of outEdges.filter((x) => x.type === 'lift' && x.name)) {
  pois.push({ id: `P_${e.id}_bottom`, name: `${e.name} 乘车处`, name_ja: `${e.name} 乗り場`, node: e.from, kind: 'lift-bottom', aliases: [e.name], attr: { name: 'osm', node: 'osm' } });
  pois.push({ id: `P_${e.id}_top`, name: `${e.name} 下车处`, name_ja: `${e.name} 降り場`, node: e.to, kind: 'lift-top', aliases: [], attr: { name: 'osm', node: 'osm' } });
}
for (const el of raw.elements) {
  const t = el.tags || {};
  if (!/^(restaurant|cafe|fast_food)$/.test(t.amenity || '') || !t.name) continue;
  let p = el.type === 'node' ? el : null;
  if (!p && el.nodes) {
    const ps = el.nodes.map((id) => osmNodes.get(id)).filter(Boolean);
    p = { lat: ps.reduce((s, q) => s + q.lat, 0) / ps.length, lon: ps.reduce((s, q) => s + q.lon, 0) / ps.length };
  }
  if (!p || !inBox(p)) continue;
  let best = null;
  for (const n of nodes) {
    const d = hav(p, { lat: n.pos[0], lon: n.pos[1] });
    if (!best || d < best.d) best = { n, d };
  }
  if (!best || best.d > 200) continue;
  pois.push({ id: `P_amenity_${el.id}`, name: t.name, name_ja: t.name, node: best.n.id, kind: 'restaurant', aliases: [], dist_m: Math.round(best.d), attr: { name: 'osm', node: 'derived' }, note: `离最近的雪道节点约 ${Math.round(best.d)} m（推算）` });
}

const out = {
  schema: 'xrsnow.resort/1',
  id: 'kagura-osm',
  name: 'かぐらスキー場（神乐）— OSM 测试数据',
  region: '日本 新潟县 汤泽町',
  dataStatus: 'unverified',
  allowRealGps: true,
  disclaimer: '地图数据来自 OpenStreetMap 社区编辑，未经雪场或本项目核实，可能有误、过时或缺失（例如雪道开放状态一律未知）。仅供测试，请始终以现场路牌、雪场官方地图和巡逻员指示为准。',
  crs: { type: 'wgs84' },
  provenance: {
    source: 'OpenStreetMap contributors（Overpass API 导出）',
    license: 'ODbL 1.0 — © OpenStreetMap contributors',
    elevation: '国土地理院 標高API（出典：国土地理院）',
    retrieved: new Date().toISOString().slice(0, 10),
    importer: 'tools/import-osm.mjs'
  },
  attributeLegend: {
    demo: '演示属性（虚构）', unknown: '未知', osm: '来自 OSM，未核实', derived: '程序推算，未核实',
    conflict: '数据矛盾（不参与规划）', verified: '已核实'
  },
  importReport: {
    skipped,
    derivedJoins,
    liftLinks,
    walkLinks,
    directionConflicts: outEdges.filter((e) => e.directionCheck === 'conflict').map((e) => ({ id: e.id, name: e.name, from_ele: nodeEle.get(e.from), grade: e.grade })),
    params: { SNAP_M, LIFT_LINK_M, FLAT_GRADE, DIR_TOL_M }
  },
  nodes,
  edges: outEdges,
  pois
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`输出 ${OUT}`);
console.log(`节点 ${nodes.length}，边 ${outEdges.length}，目的地 ${pois.length}`);
console.log(`跳过 ${skipped.length}：`, skipped.map((s) => `${s[1] || s[0]}(${s[2]})`).join('，'));
console.log(`吸附推算连接 ${derivedJoins.length}`);
console.log(`缆车站步行连接：`, liftLinks.map((l) => `${l.lift}/${l.end}:${l.linked ? l.dist_m + 'm' : '未连接'}`).join('，'));
console.log(`方向存疑 ${out.importReport.directionConflicts.length}：`, out.importReport.directionConflicts.map((c) => `${c.name || c.id}(${c.grade})`).join('，'));
console.log(`推算步行连接 ${walkLinks.length}：`, walkLinks.map((w) => `${w.dist_m}m ${w.why}`).join('；'));
console.log(`平路（推算）${outEdges.filter((e) => e.flat === true && e.type === 'run').length} 段`);
