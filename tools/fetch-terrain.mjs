// 下载雪场范围的地形高度网格，给 App 的雪道图（3D）用。只支持日本：国土地理院 DEM10B 瓦片（出典：国土地理院）。
// 用法：node tools/fetch-terrain.mjs resorts/kagura-osm.json
// 输出到 ios/XRSnowNav/Resources/terrain/：<雪场 id>.terrain.json（范围、行列数）
//   + <雪场 id>.terrain.bin（Int16 小端，单位 0.1 米，按行从北到南、每行从西到东）。瓦片缓存在 data/terrain-tiles/（不提交）。
import fs from 'node:fs';
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [resortPath, outDir = path.join(ROOT, "ios/XRSnowNav/Resources/terrain"), cacheDir = path.join(ROOT, "data/terrain-tiles")] = process.argv.slice(2);
if (!resortPath) { console.error("用法：node tools/fetch-terrain.mjs <雪场.json> [输出目录] [缓存目录]"); process.exit(1); }
const Z = 14, MARGIN_M = 1500, CELL_M = 16;

const resort = JSON.parse(fs.readFileSync(resortPath, 'utf8'));
if (resort.crs?.type !== 'wgs84') throw new Error('只支持经纬度坐标的雪场');
let s = 90, w = 180, n = -90, e = -180;
for (const ed of resort.edges) for (const [lat, lon] of ed.geometry) { s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon); }
const lat0 = (s + n) / 2, mLat = 110540, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
s -= MARGIN_M / mLat; n += MARGIN_M / mLat; w -= MARGIN_M / mLon; e += MARGIN_M / mLon;
const cols = Math.round((e - w) * mLon / CELL_M) + 1, rows = Math.round((n - s) * mLat / CELL_M) + 1;

const tx = lon => (lon + 180) / 360 * 2 ** Z;
const ty = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** Z;

fs.mkdirSync(cacheDir, { recursive: true }); fs.mkdirSync(outDir, { recursive: true });
const tiles = new Map();
async function tile(x, y) {
  const key = `${x}_${y}`;
  if (tiles.has(key)) return tiles.get(key);
  const f = path.join(cacheDir, `${Z}_${key}.txt`);
  let txt;
  if (fs.existsSync(f)) txt = fs.readFileSync(f, 'utf8');
  else {
    const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/dem/${Z}/${x}/${y}.txt`);
    if (!res.ok) throw new Error(`瓦片 ${key} 下载失败：${res.status}`);
    txt = await res.text(); fs.writeFileSync(f, txt);
    await new Promise(r => setTimeout(r, 200));   // 不给服务器添麻烦
  }
  const grid = txt.trim().split('\n').map(l => l.split(',').map(v => v === 'e' ? NaN : +v));
  tiles.set(key, grid); return grid;
}
// 先把要用的瓦片都取回来
const x0 = Math.floor(tx(w)), x1 = Math.floor(tx(e)), y0 = Math.floor(ty(n)), y1 = Math.floor(ty(s));
for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) await tile(x, y);
console.log(`瓦片 ${(x1 - x0 + 1) * (y1 - y0 + 1)} 张`);

function px(gx, gy) {   // 全局像素坐标 → 高度
  const X = Math.floor(gx / 256), Y = Math.floor(gy / 256);
  const g = tiles.get(`${X}_${Y}`); if (!g) return NaN;
  return g[gy - Y * 256]?.[gx - X * 256] ?? NaN;
}
function sample(lat, lon) {   // 双线性插值
  const fx = tx(lon) * 256 - 0.5, fy = ty(lat) * 256 - 0.5;
  const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
  const a = px(ix, iy), b = px(ix + 1, iy), c = px(ix, iy + 1), d = px(ix + 1, iy + 1);
  const vals = [a, b, c, d].filter(Number.isFinite);
  if (vals.length < 4) return vals.length ? vals.reduce((p, q) => p + q) / vals.length : NaN;
  return a * (1 - ax) * (1 - ay) + b * ax * (1 - ay) + c * (1 - ax) * ay + d * ax * ay;
}
const buf = Buffer.alloc(cols * rows * 2);
let min = Infinity, max = -Infinity, missing = 0;
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  const lat = n - (n - s) * r / (rows - 1), lon = w + (e - w) * c / (cols - 1);
  let h = sample(lat, lon);
  if (!Number.isFinite(h)) { h = 0; missing++; }
  min = Math.min(min, h); max = Math.max(max, h);
  buf.writeInt16LE(Math.round(h * 10), (r * cols + c) * 2);
}
fs.writeFileSync(path.join(outDir, `${resort.id}.terrain.bin`), buf);
fs.writeFileSync(path.join(outDir, `${resort.id}.terrain.json`), JSON.stringify({
  south: s, west: w, north: n, east: e, cols, rows, cellM: CELL_M, unit: 0.1,
  source: '国土地理院 標高タイル（DEM10B）', attribution: '出典：国土地理院',
}, null, 1));
console.log(`网格 ${cols}×${rows}（约 ${CELL_M} 米一格），高度 ${min.toFixed(0)}–${max.toFixed(0)} 米，缺失 ${missing} 点，${(buf.length / 1e6).toFixed(1)} MB`);
