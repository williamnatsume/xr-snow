// 地图转换（nav/osm-import.js）：Mac 工具和 iPhone 自动下载共用。用已保存的神乐 Overpass 数据和高程缓存验证（不联网）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { convertOsm, elevationPoints, eleKey, parseSkiAreas, overpassQuery, padBbox } from '../nav/osm-import.js';
import { osm } from '../nav/core-entry.js';
import { loadResort } from '../nav/resort.js';
import { planRoute } from '../nav/planner.js';
import { genericPlaces } from '../nav/companion.js';

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/osm/kagura-overpass.json'), 'utf8'));
const cache = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/osm/gsi-elev-cache.json'), 'utf8'));
const OPTS = { id: 't', name: '神乐测试', bbox: { minLat: 36.836, maxLat: 36.90, minLon: 138.70, maxLon: 138.80 } };

test('转换：神乐数据结果与已提交的 resorts/kagura-osm.json 一致（拓扑、边、目的地）', () => {
  const out = convertOsm(raw, OPTS, (lat, lon) => cache[eleKey(lat, lon)] ?? null);
  const ref = JSON.parse(fs.readFileSync(path.join(ROOT, 'resorts/kagura-osm.json'), 'utf8'));
  assert.deepEqual(out.edges.map((e) => [e.id, e.from, e.to, e.difficulty, e.flat]), ref.edges.map((e) => [e.id, e.from, e.to, e.difficulty, e.flat]));
  assert.deepEqual(out.pois.map((p) => p.id), ref.pois.map((p) => p.id));
  assert.equal(loadResort(out).errors.length, 0);
  const q = out.importReport.quality;
  assert.equal(q.runs, 109);
  assert.equal(q.lifts, 18);
});

test('转换：不改动传入的原始数据；高程点覆盖所有边的端点', () => {
  const before = JSON.stringify(raw);
  const pts = elevationPoints(raw, OPTS);
  assert.equal(JSON.stringify(raw), before);
  assert.equal(pts.length, 92);
  assert.ok(pts.every(([lat, lon]) => eleKey(lat, lon) in cache));
});

test('原生接口：osm.convert 返回可用的雪场；没有高程时方向和平路记为未知', () => {
  const r = JSON.parse(osm.convert(JSON.stringify(raw), JSON.stringify(OPTS), '{}'));
  assert.equal(r.ok, true);
  const resort = JSON.parse(r.resort);
  assert.ok(resort.edges.filter((e) => e.type === 'run').every((e) => e.directionCheck === 'unknown'));
  assert.equal(r.quality.elevationKnown, 0);
});

test('找雪场：解析 landuse=winter_sports 区域，按“在里面 / 距离”排序，同名合并', () => {
  const sample = { elements: [
    { type: 'way', id: 1, tags: { landuse: 'winter_sports', name: 'かぐらスキー場' }, bounds: { minlat: 36.85, minlon: 138.73, maxlat: 36.89, maxlon: 138.78 } },
    { type: 'way', id: 2, tags: { landuse: 'winter_sports', name: 'かぐらスキー場' }, bounds: { minlat: 36.84, minlon: 138.74, maxlat: 36.86, maxlon: 138.76 } },
    { type: 'way', id: 3, tags: { landuse: 'winter_sports', name: '苗場スキー場' }, bounds: { minlat: 36.78, minlon: 138.76, maxlat: 36.80, maxlon: 138.79 } },
    { type: 'way', id: 4, tags: { landuse: 'winter_sports' }, bounds: { minlat: 1, minlon: 1, maxlat: 2, maxlon: 2 } }
  ] };
  const a = parseSkiAreas(sample, 36.87, 138.75);
  assert.equal(a.length, 2);
  assert.equal(a[0].name, 'かぐらスキー場');
  assert.equal(a[0].inside, true);
  assert.equal(a[0].bbox.minLat, 36.84);
  assert.match(overpassQuery(padBbox(a[0].bbox)), /piste:type/);
});

test('自动修补：神乐山脚 → 山顶能连通，走的是现实中的缆车顺序；推算的路段带 uncertain 标记', () => {
  const out = convertOsm(raw, OPTS, (lat, lon) => cache[eleKey(lat, lon)] ?? null);
  const R = loadResort(out);
  const g = genericPlaces(R);
  const p = planRoute(R, { startNode: g.base.node, goalNode: g.summit.node }, { maxDifficulty: 4, allowUnknownDifficulty: true });
  assert.ok(p.ok, p.reason);
  assert.deepEqual(p.edges.filter((e) => e.type === 'lift').map((e) => e.name),
    ['みつまたロープウェイ', 'みつまた第1高速リフト', 'かぐらゴンドラ', 'かぐら第1高速リフト', 'かぐら第5ロマンスリフト']);
  const q = out.importReport.quality;
  assert.ok(q.transferLinks >= 1 && q.plazaLinks >= 1);
  assert.ok(out.edges.filter((e) => e.type === 'connector' && e.uncertain).length >= q.transferLinks + q.plazaLinks);
  // 缆车站之间两两可达：只剩田代索道下站（从停车场进入；みつまた索道下站可以从下山コース滑到）
  const stations = out.pois.filter((x) => x.kind === 'lift-bottom' || x.kind === 'lift-top');
  const unreachable = stations.filter((b) => !stations.some((a) => a !== b && planRoute(R, { startNode: a.node, goalNode: b.node }, { maxDifficulty: 4, allowUnknownDifficulty: true }).ok));
  assert.deepEqual(unreachable.map((x) => x.name), ['田代ロープウェー 乘车处']);
});
