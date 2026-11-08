// 用真实轨迹（OSM 公开轨迹、用户自愿上传的轨迹）核对雪场地图。纯函数，Mac 工具和以后的 App 共用。
//   - 雪道：有多少长度被轨迹覆盖（有人真的滑过）
//   - 推算连接（广场 / 换乘 / 远距离缆车站连接）：有没有人真的走过
//   - 地图上缺的雪道：轨迹在雪场里按滑雪速度移动、却离所有雪道都很远的地方
// 输出只有统计结果，不含原始轨迹。

import { makeProjection, cumulative, projectToPolyline, pointAt } from './geo.js';

export const EVIDENCE_CFG = {
  NEAR_M: 25,          // 轨迹点离线这么近算“经过”
  SAMPLE_M: 20,        // 沿雪道每 20 m 取一个检查点
  OFF_M: 45,           // 离所有雪道 / 缆车 / 连接都超过 45 m 算“地图外”
  SKI_SPEED: [3, 30],  // 滑雪速度范围（m/s）
  MIN_OFF_RUN: 6       // 连续这么多个地图外的滑雪速度点，才算一处可能缺失的雪道
};

// 解析 OSM trackpoints API 返回的 GPX：[[ [lat, lon, tMs|null], … ], …]
export function parseTrackpointsGpx(gpx) {
  const segs = [];
  for (const seg of (gpx || '').split('<trkseg>').slice(1)) {
    const pts = [];
    const re = /<trkpt lat="([-\d.]+)" lon="([-\d.]+)">\s*(?:<time>([^<]+)<\/time>)?/g;
    let m;
    while ((m = re.exec(seg))) pts.push([+m[1], +m[2], m[3] ? Date.parse(m[3]) : null]);
    if (pts.length) segs.push(pts);
  }
  return segs;
}

// 下载轨迹用的小格（OSM API 每次一小块），bbox 用 minLat/minLon/maxLat/maxLon
export function traceTiles(b, step = 0.02) {
  const out = [];
  for (let lon = b.minLon; lon < b.maxLon; lon += step)
    for (let lat = b.minLat; lat < b.maxLat; lat += step)
      out.push([lon, lat, Math.min(lon + step, b.maxLon), Math.min(lat + step, b.maxLat)].map((x) => x.toFixed(5)).join(','));
  return out;
}

// 把证据写回雪场 JSON：推算的连接如果有轨迹佐证（一半以上的取样点附近有人走过），就不再算“不确定”
export function applyEvidence(resortJson, ev, minCoverage = 0.5) {
  const byId = new Map(ev.edges.map((e) => [e.id, e]));
  let confirmed = 0;
  for (const e of resortJson.edges) {
    const x = byId.get(e.id);
    if (!x || !x.traces) continue;
    e.evidence = { coverage: x.coverage, traces: x.traces };
    if (e.uncertain && x.coverage >= minCoverage) { e.uncertain = false; e.attr = { ...(e.attr || {}), geometry: 'derived', evidence: 'gps-traces' }; confirmed++; }
  }
  resortJson.importReport = { ...(resortJson.importReport || {}), traceEvidence: { ...ev.summary, confirmedInferred: confirmed, source: ev.source || 'GPS traces' } };
  if (resortJson.importReport.quality) resortJson.importReport.quality.traceConfirmed = confirmed;
  return resortJson;
}

// resort：loadResort 的结果（wgs84）；traces：[[ [lat, lon, tMs|null], … ], …]
export function traceEvidence(resort, traces, cfg = EVIDENCE_CFG) {
  const proj = resort.proj;
  const segs = traces.map((s) => s.map(([lat, lon, t]) => ({ ...proj.toXY(lat, lon), t, lat, lon })));
  // 网格索引，加速“附近有没有轨迹点”
  const CELL = 50;
  const grid = new Map();
  const key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  segs.forEach((s, si) => s.forEach((p) => { const k = key(p.x, p.y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push([p, si]); }));
  const nearPoints = (x, y, r) => {
    const out = [];
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), n = Math.ceil(r / CELL);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (const it of grid.get(`${cx + i},${cy + j}`) || []) {
      if (Math.hypot(it[0].x - x, it[0].y - y) <= r) out.push(it);
    }
    return out;
  };

  // 每条边：沿线取样，看取样点附近有没有轨迹（记录来自几条不同轨迹）
  const edges = [];
  for (const e of resort.edges.values()) {
    const n = Math.max(2, Math.ceil(e.length / cfg.SAMPLE_M) + 1);
    let hit = 0;
    const sources = new Set();
    for (let i = 0; i < n; i++) {
      const p = pointAt(e.pts, e.cum, (e.length * i) / (n - 1));
      const near = nearPoints(p.x, p.y, cfg.NEAR_M);
      if (near.length) { hit++; near.forEach(([, si]) => sources.add(si)); }
    }
    edges.push({ id: e.id, type: e.type, name: e.name || null, inferred: !!e.uncertain || e.attr?.geometry === 'derived',
      length: Math.round(e.length), coverage: Math.round((hit / n) * 100) / 100, traces: sources.size });
  }

  // 地图外的滑雪：离所有边都远、速度在滑雪范围内的连续点
  const allEdges = [...resort.edges.values()];
  const distToMap = (p) => {
    let best = Infinity;
    for (const e of allEdges) {
      const b = e.bbox;
      if (b && (p.x < b.x0 - cfg.OFF_M || p.x > b.x1 + cfg.OFF_M || p.y < b.y0 - cfg.OFF_M || p.y > b.y1 + cfg.OFF_M)) continue;
      best = Math.min(best, projectToPolyline(p, e.pts, e.cum).d);
      if (best < cfg.OFF_M) break;
    }
    return best;
  };
  for (const e of allEdges) if (!e.bbox) {
    const xs = e.pts.map((p) => p.x), ys = e.pts.map((p) => p.y);
    e.bbox = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }
  const offMap = [];
  segs.forEach((s) => {
    let run = [];
    const flush = () => {
      if (run.length >= cfg.MIN_OFF_RUN) {
        const len = cumulative(run)[run.length - 1];
        const a = run[0], b = run[run.length - 1];
        offMap.push({ points: run.length, length: Math.round(len),
          from: [+a.lat.toFixed(5), +a.lon.toFixed(5)], to: [+b.lat.toFixed(5), +b.lon.toFixed(5)],
          meanDistToMap: Math.round(run.reduce((x, p) => x + p.d, 0) / run.length) });
      }
      run = [];
    };
    for (let i = 1; i < s.length; i++) {
      const p = s[i], q = s[i - 1];
      const dt = p.t != null && q.t != null ? (p.t - q.t) / 1000 : null;
      const v = dt && dt > 0 ? Math.hypot(p.x - q.x, p.y - q.y) / dt : null;
      const d = distToMap(p);
      if (v != null && v >= cfg.SKI_SPEED[0] && v <= cfg.SKI_SPEED[1] && d > cfg.OFF_M) run.push({ ...p, d });
      else flush();
    }
    flush();
  });

  const runs = edges.filter((e) => e.type === 'run');
  const inferred = edges.filter((e) => e.inferred && e.type === 'connector');
  return {
    summary: {
      traceSegments: segs.length,
      tracePoints: segs.reduce((x, s) => x + s.length, 0),
      runs: runs.length,
      runsWithTraces: runs.filter((e) => e.coverage >= 0.3).length,
      runLengthCovered: Math.round(runs.reduce((x, e) => x + e.length * e.coverage, 0)),
      runLengthTotal: runs.reduce((x, e) => x + e.length, 0),
      inferredConnectors: inferred.length,
      inferredSupported: inferred.filter((e) => e.coverage >= 0.5).length,
      offMapSkiing: offMap.length
    },
    edges,
    offMap
  };
}
