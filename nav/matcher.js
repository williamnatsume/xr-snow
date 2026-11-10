// 定位匹配：判断用户当前在哪条雪道上。
// 只用位置轨迹（不用手机朝向）：
//   - 行进方向 = 最近约 35 m 位移的整体方向，滑雪时连续左右转弯（S 弯）会被平均掉
//   - 候选雪道 = 距离足够近 + 行进方向与雪道方向一致 + 与上一次所在雪道连续
// 匹配只给出候选和得分，“是否可以下结论”由导航状态机根据上下文决定。

import { projectToPolyline, angleDiff, dist, bearing } from './geo.js';

export const MATCH_CFG = {
  maxDistBase: 30,      // 候选最大距离下限（m）
  headingWindow: 35,    // 用最近 35 m 位移计算行进方向（待实测）
  headingMaxAgeMs: 25000,
  headingTolDeg: 75,    // 行进方向与雪道方向夹角超过 75° 视为不在这条雪道上行进
  speedWindowMs: 5000,
  keepMs: 60000
};

// 最近的定位轨迹
export class Track {
  constructor(cfg = MATCH_CFG) { this.cfg = cfg; this.fixes = []; }
  push(f) {
    this.fixes.push(f);
    const cutoff = f.t - this.cfg.keepMs;
    while (this.fixes.length && this.fixes[0].t < cutoff) this.fixes.shift();
  }
  clear() { this.fixes = []; }
  last() { return this.fixes[this.fixes.length - 1] || null; }

  // 行进方向：从最新点往回找，第一个直线距离 ≥ headingWindow 的点
  heading() {
    const f = this.fixes, n = f.length;
    if (n < 2) return null;
    const last = f[n - 1];
    for (let i = n - 2; i >= 0; i--) {
      if (last.t - f[i].t > this.cfg.headingMaxAgeMs) break;
      const d = dist(f[i], last);
      if (d >= this.cfg.headingWindow) return bearing(f[i], last);
    }
    return null;
  }

  // 速度（m/s）：优先用设备给出的速度（多普勒），否则用位移估算
  speed() {
    const f = this.fixes, n = f.length;
    if (!n) return null;
    const recent = f.slice(-3).filter((x) => x.speed != null && x.speed >= 0);
    if (recent.length) return recent.reduce((s, x) => s + x.speed, 0) / recent.length;
    const last = f[n - 1];
    let first = null;
    for (let i = n - 2; i >= 0; i--) {
      if (last.t - f[i].t > this.cfg.speedWindowMs) break;
      first = f[i];
    }
    if (!first || last.t === first.t) return null;
    return dist(first, last) / ((last.t - first.t) / 1000);
  }
}

// 预先计算每条边的包围盒，加速筛选
export function prepareIndex(resort) {
  for (const e of resort.edges.values()) {
    if (e.bbox) continue;
    const xs = e.pts.map((p) => p.x), ys = e.pts.map((p) => p.y);
    e.bbox = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }
}

// 返回按得分排序的候选：[{ edge, s, d, segHeading, headingDelta, score }]
export function matchFix(resort, fix, { heading, moving, prevEdge }, cfg = MATCH_CFG) {
  prepareIndex(resort);
  const acc = Math.max(3, fix.acc ?? 10);
  const out = [];
  for (const e of resort.edges.values()) {
    const halfW = (e.width_m || (e.type === 'lift' ? 10 : 30)) / 2;
    // 不确定度：定位误差 + 雪道半宽（人可能在雪道任意位置）
    const sigma = Math.hypot(acc, halfW * 0.7);
    const maxD = Math.max(cfg.maxDistBase, 2.5 * sigma);
    const b = e.bbox;
    if (fix.x < b.x0 - maxD || fix.x > b.x1 + maxD || fix.y < b.y0 - maxD || fix.y > b.y1 + maxD) continue;
    const pr = projectToPolyline(fix, e.pts, e.cum);
    if (pr.d > maxD) continue;
    let headingDelta = null, hf = 0.7;
    if (heading != null && moving) {
      headingDelta = Math.abs(angleDiff(heading, pr.heading));
      if (headingDelta > cfg.headingTolDeg) continue; // 行进方向不符：不可能在这条边上（例如逆着缆车方向）
      hf = 0.4 + 0.6 * Math.cos(headingDelta * Math.PI / 180);
    }
    let cont = 1;
    if (prevEdge) {
      if (e === prevEdge) cont = 1.6;
      else if (prevEdge.to === e.from) cont = 1.3;
    }
    const lik = Math.exp(-0.5 * (pr.d / sigma) ** 2);
    out.push({ edge: e, s: pr.s, d: pr.d, side: pr.side, segHeading: pr.heading, headingDelta, sigma, score: lik * hf * cont });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// 点到某条边的距离（不做筛选，供分岔判断比较用）
export function distanceToEdge(fix, e) {
  return projectToPolyline(fix, e.pts, e.cum);
}
