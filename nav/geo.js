// 几何工具：内部统一使用以米为单位的局部平面坐标（x 向东，y 向北）。
// 真实雪场（WGS84）在载入时投影到局部平面；虚构雪场本身就是局部坐标。

const R = 6371000;
const RAD = Math.PI / 180;

// 以某个经纬度为原点的等距投影（雪场范围几公里内误差可以忽略）
export function makeProjection(lat0, lon0) {
  const kx = Math.cos(lat0 * RAD) * R * RAD;
  const ky = R * RAD;
  return {
    lat0, lon0,
    toXY: (lat, lon) => ({ x: (lon - lon0) * kx, y: (lat - lat0) * ky }),
    toLatLon: (x, y) => ({ lat: lat0 + y / ky, lon: lon0 + x / kx })
  };
}

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// 方位角：0 = 北，90 = 东（顺时针），单位度
export function bearing(a, b) {
  const deg = Math.atan2(b.x - a.x, b.y - a.y) / RAD;
  return (deg + 360) % 360;
}

// 角度差，结果在 (-180, 180]；正值 = 向右（顺时针）
export function angleDiff(to, from) {
  let d = ((to - from) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

// 折线的累计长度表
export function cumulative(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return cum;
}

// 点到折线的投影：返回最近距离、沿线距离 s、所在段方向、带符号的横向偏移（右正）
export function projectToPolyline(p, pts, cum) {
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    const qx = a.x + dx * t, qy = a.y + dy * t;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (!best || d < best.d) {
      // 叉积符号：点在前进方向右侧为正
      const cross = dx * (p.y - a.y) - dy * (p.x - a.x);
      best = { d, s: cum[i] + Math.sqrt(L2) * t, seg: i, heading: bearing(a, b), side: cross > 0 ? -1 : 1, point: { x: qx, y: qy } };
    }
  }
  return best;
}

// 沿折线距离 s 处的点
export function pointAt(pts, cum, s) {
  if (s <= 0) return { ...pts[0], heading: bearing(pts[0], pts[1]) };
  const total = cum[cum.length - 1];
  if (s >= total) return { ...pts[pts.length - 1], heading: bearing(pts[pts.length - 2], pts[pts.length - 1]) };
  let i = 1;
  while (cum[i] < s) i++;
  const a = pts[i - 1], b = pts[i];
  const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, heading: bearing(a, b) };
}

// 从折线某一端起，取约 len 米范围内的整体方向（用首尾连线，平滑掉小弯）
export function headingNearStart(pts, cum, len = 40) {
  const p = pointAt(pts, cum, Math.min(len, cum[cum.length - 1]));
  return bearing(pts[0], p);
}
export function headingNearEnd(pts, cum, len = 40) {
  const total = cum[cum.length - 1];
  const p = pointAt(pts, cum, Math.max(0, total - len));
  return bearing(p, pts[pts.length - 1]);
}

// 可复现的伪随机数（模拟器和测试用）
export function seededRandom(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
export function gaussian(rand) {
  const u = Math.max(1e-12, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
