// 导出给“航空照片核对页”用的精简地图数据：雪道 / 缆车 / 连接（含是否推算、轨迹佐证）、岔口、范围、质量。
// 用法：node tools/export-review.mjs <雪场 JSON> <输出 JSON> [轨迹证据 JSON]
import fs from 'node:fs';
import { loadResort } from '../nav/resort.js';
import { applyEvidence } from '../nav/trace-evidence.js';

const [inPath, outPath, evPath] = process.argv.slice(2);
const json = JSON.parse(fs.readFileSync(inPath, 'utf8'));
if (evPath) applyEvidence(json, JSON.parse(fs.readFileSync(evPath, 'utf8')));
const R = loadResort(json);
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const edges = json.edges.map((e) => ({
  id: e.id, t: e.type, n: e.name || null, d: e.difficulty ?? null,
  g: e.geometry.map(([a, b]) => [r5(a), r5(b)]),
  u: e.uncertain ? 1 : 0,
  inf: e.type === 'connector' ? 1 : 0,
  ev: e.evidence ? Math.round(e.evidence.coverage * 100) : null,
  note: e.note || null
}));
// 岔口：有两条以上可以往下走的雪道 / 连接的节点
const forks = [];
for (const [id, outs] of R.out) {
  const ways = outs.filter((e) => e.type !== 'lift');
  if (ways.length < 2) continue;
  const n = R.nodes.get(id);
  forks.push({ id, lat: r5(n.pos[0]), lon: r5(n.pos[1]), ele: n.ele ?? null, outs: ways.map((e) => e.name || (e.type === 'connector' ? '连接' : `无名（${e.difficulty ?? '?'}级）`)) });
}
const all = edges.flatMap((e) => e.g);
const lats = all.map((p) => p[0]), lons = all.map((p) => p[1]);
const pad = 0.003;
const out = {
  id: json.id, name: json.name,
  bounds: [[Math.min(...lats) - pad, Math.min(...lons) - pad], [Math.max(...lats) + pad, Math.max(...lons) + pad]],
  quality: json.importReport?.quality || null,
  traceEvidence: json.importReport?.traceEvidence ? (({ traceSegments, tracePoints, runsWithTraces, inferredConnectors, inferredSupported, confirmedInferred }) => ({ traceSegments, tracePoints, runsWithTraces, inferredConnectors, inferredSupported, confirmedInferred }))(json.importReport.traceEvidence) : null,
  edges, forks
};
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`${json.name}：边 ${edges.length}（推算连接 ${edges.filter((e) => e.inf).length}，仍不确定 ${edges.filter((e) => e.u).length}），岔口 ${forks.length}，范围 ${JSON.stringify(out.bounds)}，${Math.round(fs.statSync(outPath).size / 1024)} KB`);
