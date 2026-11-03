// 雪场数据：载入可替换的 JSON，校验后建立有向图。
// JSON 格式见 resorts/README.md。坐标系：
//   crs.type = "local-meters"：pos / geometry 为 [x, y]（米，x 向东，y 向北）——只用于虚构雪场
//   crs.type = "wgs84"：pos / geometry 为 [lat, lon]——真实雪场

import { makeProjection, cumulative, headingNearStart, headingNearEnd, dist } from './geo.js';

export const DIFFICULTY = {
  1: { zh: '初级', ja: '初級', color: '#2ea44f' },
  2: { zh: '中级', ja: '中級', color: '#e5484d' },
  3: { zh: '高级', ja: '上級', color: '#e8e8e8' },
  4: { zh: '专家级', ja: 'エキスパート', color: '#a78bfa' }
};

// 属性可信度标签（每条雪道的 attr 字段里使用）
export const ATTR_LABEL = {
  demo: '演示（虚构）',
  unknown: '未知',
  osm: 'OSM，未核实',
  derived: '推算，未核实',
  conflict: '数据矛盾',
  verified: '已核实'
};

export function loadResort(json) {
  const errors = [], warnings = [];
  if (!json || json.schema !== 'xrsnow.resort/1') errors.push('不是 xrsnow.resort/1 格式的雪场文件');
  const crs = json.crs?.type;
  if (crs !== 'local-meters' && crs !== 'wgs84') errors.push('crs.type 必须是 local-meters 或 wgs84');
  if (errors.length) return { errors, warnings };

  // 真实雪场：以所有节点的中心为原点投影到局部平面
  let proj = null;
  if (crs === 'wgs84') {
    const lats = json.nodes.map((n) => n.pos[0]), lons = json.nodes.map((n) => n.pos[1]);
    proj = makeProjection((Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2);
  }
  const toXY = (p) => (proj ? proj.toXY(p[0], p[1]) : { x: p[0], y: p[1] });

  const nodes = new Map();
  for (const n of json.nodes || []) {
    if (nodes.has(n.id)) errors.push(`节点 id 重复：${n.id}`);
    nodes.set(n.id, { ...n, ...toXY(n.pos) });
  }

  const edges = new Map();
  const out = new Map(), inc = new Map();
  for (const n of nodes.keys()) { out.set(n, []); inc.set(n, []); }

  for (const e of json.edges || []) {
    if (edges.has(e.id)) { errors.push(`雪道 id 重复：${e.id}`); continue; }
    if (!nodes.has(e.from) || !nodes.has(e.to)) { errors.push(`${e.id}：起点或终点节点不存在`); continue; }
    if (!['run', 'lift', 'connector'].includes(e.type)) { errors.push(`${e.id}：type 必须是 run / lift / connector`); continue; }
    const pts = (e.geometry || []).map(toXY);
    if (pts.length < 2) { errors.push(`${e.id}：折线至少需要 2 个点`); continue; }
    // 折线方向必须与通行方向一致：首点在起点附近，末点在终点附近
    const a = nodes.get(e.from), b = nodes.get(e.to);
    if (dist(pts[0], a) > 30 || dist(pts[pts.length - 1], b) > 30) {
      warnings.push(`${e.id}：折线端点与节点相距超过 30 m，检查方向是否画反`);
    }
    const cum = cumulative(pts);
    const edge = {
      ...e,
      pts, cum,
      length: cum[cum.length - 1],
      headStart: headingNearStart(pts, cum),
      headEnd: headingNearEnd(pts, cum),
      attr: e.attr || {}
    };
    if (e.length_m && Math.abs(e.length_m - edge.length) > Math.max(20, e.length_m * 0.1)) {
      warnings.push(`${e.id}：标注长度 ${e.length_m} m 与折线长度 ${Math.round(edge.length)} m 不一致，以折线为准`);
    }
    if (e.type === 'run') {
      const ea = a.ele, eb = b.ele;
      if (ea != null && eb != null && eb > ea + 3) warnings.push(`${e.id}：终点比起点高，雪道方向可能有误`);
    }
    edges.set(e.id, edge);
    out.get(e.from).push(edge);
    inc.get(e.to).push(edge);
  }

  const pois = (json.pois || []).filter((p) => {
    if (!nodes.has(p.node)) { warnings.push(`目的地 ${p.name} 指向不存在的节点 ${p.node}`); return false; }
    return true;
  });

  return {
    errors, warnings,
    id: json.id,
    name: json.name,
    region: json.region,
    disclaimer: json.disclaimer,
    dataStatus: json.dataStatus,        // fictional / unverified / verified
    allowRealGps: json.allowRealGps === true && json.dataStatus !== 'fictional' && crs === 'wgs84',
    provenance: json.provenance || {},
    importReport: json.importReport,
    crs, proj,
    nodes, edges, out, in: inc, pois,
    raw: json
  };
}

// 雪道的显示名称：编号 + 名称（路牌上写什么就显示什么）
export function edgeLabel(e) {
  if (!e) return '';
  const kind = e.type === 'lift' ? '缆车' : e.type === 'connector' ? '步道' : '雪道';
  if (e.ref && e.name) return `${e.ref}号${kind}「${e.name}」`;
  if (e.ref) return `${e.ref}号${kind}`;
  if (e.name) return e.name;
  return e.type === 'run' ? `无名雪道（${e.id}）` : `无名${kind}（${e.id}）`;
}

export function poiOfNode(resort, nodeId) {
  return resort.pois.find((p) => p.node === nodeId) || null;
}
