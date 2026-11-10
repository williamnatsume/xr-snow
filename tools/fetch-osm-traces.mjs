// 下载 OpenStreetMap 上公开的 GPS 轨迹点（trackpoints API），用来核对雪场地图。
// 原始轨迹只存在本机 data/traces/（不提交到仓库）；只提交由它算出来的统计结果。
//
// 用法：node tools/fetch-osm-traces.mjs <名字> <minLon,minLat,maxLon,maxLat>
//   例：node tools/fetch-osm-traces.mjs kagura 138.70,36.836,138.80,36.90
// 大范围会拆成 0.02° 的小格逐格下载（API 每页最多 5000 点），请求之间稍作停顿。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [name, bboxArg] = process.argv.slice(2);
if (!name || !bboxArg) { console.error('用法：node tools/fetch-osm-traces.mjs <名字> <minLon,minLat,maxLon,maxLat>'); process.exit(1); }
const [minLon, minLat, maxLon, maxLat] = bboxArg.split(',').map(Number);
const STEP = 0.02;
const UA = 'XRSnow-Xueren/0.1 (ski map verification prototype)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

import { parseTrackpointsGpx as parse } from '../nav/trace-evidence.js';

const all = [];
let points = 0;
for (let lon = minLon; lon < maxLon; lon += STEP) {
  for (let lat = minLat; lat < maxLat; lat += STEP) {
    const b = [lon, lat, Math.min(lon + STEP, maxLon), Math.min(lat + STEP, maxLat)].map((x) => x.toFixed(5)).join(',');
    for (let page = 0; page < 50; page++) {
      const res = await fetch(`https://api.openstreetmap.org/api/0.6/trackpoints?bbox=${b}&page=${page}`, { headers: { 'User-Agent': UA } });
      if (!res.ok) { console.error(`格 ${b} 第 ${page} 页：HTTP ${res.status}`); break; }
      const segs = parse(await res.text());
      const n = segs.reduce((s, x) => s + x.length, 0);
      all.push(...segs);
      points += n;
      await sleep(300);
      if (n < 5000) break;
    }
  }
  process.stdout.write(`经度 ${lon.toFixed(3)} 完成，累计 ${points} 点\r`);
}
const out = path.join(ROOT, 'data/traces', `${name}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ source: 'OpenStreetMap public GPS traces (trackpoints API)', bbox: [minLon, minLat, maxLon, maxLat], retrieved: new Date().toISOString(), segments: all }));
console.log(`\n${name}：${all.length} 段，${points} 点 → ${out}`);
