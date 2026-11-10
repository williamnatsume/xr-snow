// 用 data/traces/<名字>.json（tools/fetch-osm-traces.mjs 下载的公开轨迹，或用户上传的轨迹）核对雪场地图。
// 用法：node tools/analyze-traces.mjs <雪场 JSON> <轨迹 JSON> [输出证据 JSON]
// 证据文件只含统计（每条边的覆盖率、有几条轨迹经过、地图外滑雪的位置），可以提交到仓库。

import fs from 'node:fs';
import { loadResort } from '../nav/resort.js';
import { traceEvidence } from '../nav/trace-evidence.js';

const [resortPath, tracePath, outPath] = process.argv.slice(2);
const resort = loadResort(JSON.parse(fs.readFileSync(resortPath, 'utf8')));
const tr = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
const ev = traceEvidence(resort, tr.segments);
const s = ev.summary;
console.log(`${resort.name}：轨迹 ${s.traceSegments} 段 / ${s.tracePoints} 点`);
console.log(`雪道 ${s.runs} 段，有轨迹经过的 ${s.runsWithTraces} 段；被覆盖的长度 ${(s.runLengthCovered / 1000).toFixed(1)} / ${(s.runLengthTotal / 1000).toFixed(1)} km`);
console.log(`推算连接 ${s.inferredConnectors} 处，有轨迹佐证 ${s.inferredSupported} 处`);
for (const e of ev.edges.filter((x) => x.inferred && x.type === 'connector' && x.coverage >= 0.5)) console.log(`  ✓ ${e.name}（${e.length} m，${e.traces} 条轨迹）`);
// 地图外的快速移动：用国土地理院高程区分“滑雪下坡”和“开车 / 上坡”
async function gsi(lat, lon) {
  try {
    const j = await (await fetch(`https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lon}&lat=${lat}&outtype=JSON`)).json();
    return typeof j.elevation === 'number' ? j.elevation : null;
  } catch { return null; }
}
for (const o of ev.offMap) {
  const a = await gsi(...o.from), b = await gsi(...o.to);
  o.drop_m = a != null && b != null ? Math.round(a - b) : null;
  o.grade = o.drop_m != null && o.length ? Math.round((o.drop_m / o.length) * 1000) / 1000 : null;
  o.likelySkiing = o.grade != null && o.drop_m >= 20 && o.grade >= 0.05;
}
const ski = ev.offMap.filter((o) => o.likelySkiing);
console.log(`地图外的快速移动 ${ev.offMap.length} 处，其中像滑雪（下降 ≥20 m、坡度 ≥5%）的 ${ski.length} 处 —— 可能缺雪道：`);
for (const o of ev.offMap) console.log(`  ${o.likelySkiing ? '⛷' : '🚗'} ${o.length} m，下降 ${o.drop_m} m（坡度 ${o.grade}）：${o.from} → ${o.to}`);
ev.summary.offMapLikelySkiing = ski.length;
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify({ source: tr.source, retrieved: tr.retrieved, resort: resort.id, ...ev }, null, 1));
  console.log(`证据 → ${outPath}`);
}
