// 模拟器：沿一条“真实路径”生成定位点，用来在不去雪场的情况下测试导航。
//   - 滑行时叠加左右 S 弯（横向摆动），检验方向过滤
//   - 定位漂移：随机游走的位置误差，报告的精度随漂移大小变化
//   - 定位中断：一段时间内不产生任何定位
//   - 走错分支：在下一个岔口故意进入另一条分支
// 模拟器只产生定位点，和真实 GPS 走同一套导航逻辑。

import { pointAt, seededRandom, gaussian } from './geo.js';

export const SIM_SPEED = { 1: 6, 2: 9, 3: 11, 4: 12 }; // 各难度的模拟滑行速度 m/s
const FLAT_SPEED = 3, WALK_SPEED = 1.3, LIFT_SPEED = 4;

export class Simulator {
  constructor(resort, { seed = 7, drift = 4, carve = true, skierFactor = 1 } = {}) {
    this.resort = resort;
    this.rand = seededRandom(seed);
    this.drift = drift;            // 定位漂移标准差（m）
    this.carve = carve;            // 是否模拟 S 弯
    this.skierFactor = skierFactor;
    this.outageUntil = -Infinity;
    this.wrongAtNextFork = false;
    this.path = [];
    this.reset();
  }

  // 设置真实路径（通常就是规划的路线）
  setPath(edges, { plannedRoute = null } = {}) {
    this.path = edges.slice();
    this.plannedRoute = plannedRoute || edges.slice();
    this.reset();
  }

  reset() {
    this.k = 0;         // 当前所在 path 的第几条边
    this.s = 0;         // 沿该边的距离
    this.t = 0;         // 模拟时钟（ms）
    this.dx = 0; this.dy = 0; // 当前漂移
    this.done = false;
    this.travelled = 0;
    this.wrongTaken = null;
  }

  edgeSpeed(e) {
    if (e.type === 'lift') return e.duration_min ? e.length / (e.duration_min * 60) : LIFT_SPEED;
    if (e.type === 'connector') return WALK_SPEED;
    if (e.flat === true) return FLAT_SPEED * this.skierFactor;
    return (SIM_SPEED[e.difficulty] || 8) * this.skierFactor;
  }

  // 在下一个岔口走错：把 path 从该岔口起替换为另一条分支 + 之后一路往下
  takeWrongBranchAtNextFork() {
    for (let k = this.k; k < this.path.length - 1; k++) {
      const e = this.path[k], next = this.path[k + 1];
      if (k === this.k && this.s > e.length - 30) continue; // 太近了来不及
      const alts = (this.resort.out.get(e.to) || []).filter((x) => x !== next && x.type !== 'lift');
      if (!alts.length) continue;
      // 优先选一条开放的分支（关闭的雪道也可以被“误入”，但先选开放的）
      const alt = alts.find((x) => x.open !== false) || alts[0];
      // 走错之后的路：交给 follow（通常 = 跟随导航重新规划的路线），否则一路取第一条下坡道
      this.path = [...this.path.slice(0, k + 1), alt];
      this.wrongTaken = { atNode: e.to, edge: alt.id };
      return this.wrongTaken;
    }
    return null;
  }

  // 路径走完但还没到目的地时（走错分支之后），决定下一段
  extendPath(nodeId) {
    if (!this.wrongTaken) return;
    let next = this.follow ? this.follow(nodeId) : null;
    if (!next) next = (this.resort.out.get(nodeId) || []).find((x) => x.type !== 'lift') || null;
    if (next && this.path.length < 200) this.path.push(next);
  }

  startOutage(seconds) { this.outageUntil = this.t + seconds * 1000; }
  get inOutage() { return this.t < this.outageUntil; }

  // 前进 dtSec 秒，返回这一步产生的定位点（中断时返回 null）
  step(dtSec = 1) {
    this.t += dtSec * 1000;
    let truth;
    if (!this.done) {
      let left = dtSec;
      while (left > 0 && !this.done) {
        const e = this.path[this.k];
        const v = this.edgeSpeed(e);
        const need = (e.length - this.s) / v;
        if (need > left) { this.s += v * left; this.travelled += v * left; left = 0; }
        else {
          this.travelled += e.length - this.s;
          left -= need;
          if (this.k === this.path.length - 1) this.extendPath(e.to);
          if (this.k < this.path.length - 1) { this.k++; this.s = 0; }
          else { this.s = e.length; this.done = true; }
        }
      }
    }
    const e = this.path[this.k];
    const p = pointAt(e.pts, e.cum, this.s);
    truth = { x: p.x, y: p.y, edge: e.id, s: this.s };
    this.lastTruth = truth;
    // S 弯：在雪道上做横向摆动（不在缆车、平路和步道上）
    let lx = 0, ly = 0;
    if (this.carve && !this.done && e.type === 'run' && e.flat !== true) {
      const amp = Math.min(8, (e.width_m || 30) * 0.3);
      const off = amp * Math.sin((2 * Math.PI * this.travelled) / 45);
      const h = (p.heading * Math.PI) / 180;
      lx = Math.cos(h) * off; ly = -Math.sin(h) * off; // 垂直于前进方向
    }
    // 漂移：均值回归的随机游走，长期标准差约为 this.drift
    const a = 0.85;
    this.dx = a * this.dx + Math.sqrt(1 - a * a) * this.drift * gaussian(this.rand);
    this.dy = a * this.dy + Math.sqrt(1 - a * a) * this.drift * gaussian(this.rand);

    if (this.inOutage) return null;
    const v = this.done ? 0 : this.edgeSpeed(e);
    return {
      t: this.t,
      x: p.x + lx + this.dx,
      y: p.y + ly + this.dy,
      acc: Math.round(this.drift * 1.6 + 4),
      speed: Math.max(0, v + gaussian(this.rand) * 0.3),
      source: 'sim',
      truth
    };
  }
}
