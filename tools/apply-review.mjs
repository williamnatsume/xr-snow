// 用法：node tools/apply-review.mjs <标记目录或 JSON> <雪场 id（kagura / naeba）>
// 标记来自核对页的共享存储（ArtifactData list marks，out_dir 导出的一堆 JSON），
// 只取这个雪场的，存成 data/osm/<雪场>-review.json（tools/import-osm.mjs 会自动写进地图），并打印待办。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [src, resort] = process.argv.slice(2);
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
let marks = [];
if (fs.statSync(src).isDirectory()) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]);
  marks = walk(src).filter((f) => f.endsWith('.json')).map(read).map((x) => x.data || x);
} else marks = read(src);
marks = marks.filter((m) => m.resort === resort);
const out = path.join(ROOT, 'data/osm', `${resort}-review.json`);
fs.writeFileSync(out, JSON.stringify(marks.map(({ resort: r, kind, target, targetName, status, note, lat, lon, at }) => ({ resort: r, kind, target, targetName, status, note, lat, lon, at })), null, 1));
const count = {};
for (const m of marks) count[m.status] = (count[m.status] || 0) + 1;
console.log(`${resort}：${marks.length} 个标记 ${JSON.stringify(count)} → ${out}`);
for (const m of marks.filter((x) => ['shift', 'name', 'missing'].includes(x.status))) console.log(`  待办 ${m.status} ${m.targetName || m.target || ''} @${m.lat},${m.lon}：${m.note || ''}`);
