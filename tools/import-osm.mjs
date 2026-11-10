// 把 OpenStreetMap（Overpass 导出）的雪道/缆车数据转换成导航用的雪场 JSON。
// 转换逻辑在 nav/osm-import.js（iPhone 上自动下载地图也用同一份）；这里只负责读写文件和查高程。
//
// 用法：node tools/import-osm.mjs [overpass.json] [输出.json]
//   默认读取 data/osm/kagura-overpass.json，输出 resorts/kagura-osm.json
//
// 高程来自国土地理院 標高API（出典：国土地理院），结果缓存在 data/osm/gsi-elev-cache.json。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertOsm, elevationPoints, eleKey } from '../nav/osm-import.js';
import { applyEvidence } from '../nav/trace-evidence.js';
import { applyReview } from '../nav/review.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN = process.argv[2] || path.join(ROOT, 'data/osm/kagura-overpass.json');
const OUT = process.argv[3] || path.join(ROOT, 'resorts/kagura-osm.json');
const CACHE = path.join(ROOT, 'data/osm/gsi-elev-cache.json');

// 雪场范围：神乐（三俣・神乐・田代），排除苗场一侧（ドラゴンドラ 等跨出范围的线）
const OPTS = {
  id: 'kagura-osm',
  name: 'かぐらスキー場（神乐）— OSM 测试数据',
  region: '日本 新潟县 汤泽町',
  bbox: { minLat: 36.836, maxLat: 36.90, minLon: 138.70, maxLon: 138.80 },
  outOfBoxLabel: '超出神乐范围',
  elevationSource: '国土地理院 標高API（出典：国土地理院）',
  importer: 'tools/import-osm.mjs'
};

/* ---------- 高程（国土地理院） ---------- */
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* 首次运行 */ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchElevation(lat, lon) {
  const url = `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lon.toFixed(6)}&lat=${lat.toFixed(6)}&outtype=JSON`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const j = await (await fetch(url)).json();
      await sleep(120); // 控制请求频率
      return typeof j.elevation === 'number' ? j.elevation : null; // 取不到时 API 返回 "-----"
    } catch {
      await sleep(1000);
    }
  }
  return null;
}

const raw = JSON.parse(fs.readFileSync(IN, 'utf8'));
const points = elevationPoints(raw, OPTS);
const missing = points.filter(([lat, lon]) => !(eleKey(lat, lon) in cache));
console.log(`需要高程的点 ${points.length}，缓存里没有的 ${missing.length}`);
for (const [lat, lon] of missing) cache[eleKey(lat, lon)] = await fetchElevation(lat, lon);
fs.writeFileSync(CACHE, JSON.stringify(cache));

const out = convertOsm(raw, OPTS, (lat, lon) => cache[eleKey(lat, lon)] ?? null);
// 有轨迹证据（tools/analyze-traces.mjs 生成）时写进地图：被轨迹佐证的推算连接不再算“不确定”
const EVIDENCE = path.join(ROOT, 'data/osm', `${OPTS.id.replace(/-osm$/, '')}-trace-evidence.json`);
if (fs.existsSync(EVIDENCE)) {
  applyEvidence(out, JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')));
  console.log('轨迹证据：', JSON.stringify(out.importReport.traceEvidence));
}
// 人工核对（航空照片核对页的标记，tools/apply-review.mjs 导出）
const REVIEW = path.join(ROOT, 'data/osm', `${OPTS.id.replace(/-osm$/, '')}-review.json`);
if (fs.existsSync(REVIEW)) {
  applyReview(out, JSON.parse(fs.readFileSync(REVIEW, 'utf8')));
  const rv = out.importReport.review;
  console.log(`人工核对：${rv.marks} 个标记，确认 ${rv.confirmed} 处推算连接，关闭 ${rv.closed} 段，待办 ${rv.todo.length} 个`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const r = out.importReport;
console.log(`输出 ${OUT}`);
console.log(`节点 ${out.nodes.length}，边 ${out.edges.length}，目的地 ${out.pois.length}`);
console.log(`跳过 ${r.skipped.length}：`, r.skipped.map((s) => `${s[1] || s[0]}(${s[2]})`).join('，'));
console.log(`吸附推算连接 ${r.derivedJoins.length}`);
console.log(`缆车站步行连接：`, r.liftLinks.map((l) => `${l.lift}/${l.end}:${l.linked ? l.dist_m + 'm' : '未连接'}`).join('，'));
console.log(`方向存疑 ${r.directionConflicts.length}`);
console.log(`推算步行连接 ${r.walkLinks.length}：`, r.walkLinks.map((w) => `${w.dist_m}m ${w.why}`).join('；'));
console.log('质量：', JSON.stringify(r.quality));
