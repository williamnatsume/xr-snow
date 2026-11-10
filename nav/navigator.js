// 导航状态机：路线 + 定位 → 状态和播报。
// 与定位来源（模拟 / 真实 GPS）和语音实现（浏览器 / 原生）都无关：
//   输入：onFix(fix)、tick(now)；输出：onSpeak({ key, text, reason })、snapshot()
//
// 状态：未开始 → 导航中 ⇄ 接近岔口 → 通过待确认 → 已通过 → 导航中 … → 到达
//       任何时候都可能进入：偏离路线 / 定位不可靠（定位中断、精度不足、相邻雪道无法区分）
//
// 所有阈值都是“待实测的初始值”，集中在 NAV_CFG 里。

import { Track, matchFix, distanceToEdge, MATCH_CFG } from './matcher.js';
import { buildManeuvers, maneuverText, SYSTEM_TEXT } from './instructions.js';
import { planRoute } from './planner.js';
import { edgeLabel } from './resort.js';

export const NAV_CFG = {
  // 定位可靠性
  accEnter: 25,          // 误差 > 25 m 连续 2 次 → 定位不可靠
  accExit: 18,           // 误差 ≤ 18 m 连续 2 次 → 恢复（滞回）
  accCount: 2,
  staleMs: 5000,         // 5 秒没有新定位 → 定位中断，不再把旧位置当实时位置
  recoverCount: 2,       // 恢复需要连续 2 个好定位
  // 静止
  stationarySpeed: 1.2,  // m/s
  stationaryMs: 3000,
  // 播报时机：提醒距离 = 速度 ×（语音时长 + 反应时间）+ 定位误差 + 余量
  reactSec: 4,
  marginM: 25,
  minMainM: 40,
  speedFloor: 3,         // 计算时速度下限 m/s（刚起步也留出余量）
  previewExtraSec: 15,   // 预告比主提示再提前 15 秒（或至少 150 m）
  previewMinExtraM: 150,
  lateM: 12,             // 距岔口 < 12 m 还没播报主提示时，只播一句短提示
  // 通过岔口的确认
  passRadius: 20,        // 距岔口 20 m 内开始“通过待确认”
  confirmAlong: 25,      // 进入分支至少 25 m 后才可能确认
  confirmCount: 3,       // 连续 3 次一致才确认
  sepMin: 10,            // 与其他分支的距离差至少 10 m（或定位误差）
  ambiguityLimit: 200,   // 过岔口 200 m 还分不清 → 定位不可靠（相邻雪道无法区分）
  // 偏航
  offRatio: 0.35,        // 路线上的候选得分低于最佳候选的 35%，视为可能不在路线上
  ambiguousRatio: 0.8,   // 路线候选得分在最佳候选 35%–80% 之间：无法区分，不下结论
  offCount: 3,           // 连续 3 次 → 偏离路线
  offMapCount: 5,        // 连续 5 次附近没有任何雪道 → 偏离路线
  offRepeatMs: 60000,    // 偏航提示最短间隔
  // 到达
  arriveRadius: 30,
  arrivePreviewM: 150,
  passedHoldMs: 3000
};

export const STATE_ZH = {
  idle: '未开始', navigating: '导航中', approaching: '接近岔口', passing: '通过待确认',
  passed: '已通过', offRoute: '偏离路线', unreliable: '定位不可靠', arrived: '到达', paused: '已暂停'
};
export const UNRELIABLE_ZH = { stale: '定位中断', accuracy: '精度不足', ambiguous: '相邻雪道无法区分', waiting: '等待定位' };

export function estimateSpeechSeconds(text, lang = 'zh') {
  const n = [...(text || '')].length;
  return lang === 'ja' ? n / 7 + 0.4 : n / 4.2 + 0.4;
}

export function announceDistances(speed, acc, tSpeech, cfg = NAV_CFG) {
  const v = Math.max(cfg.speedFloor, speed || 0);
  const main = Math.max(cfg.minMainM, v * (tSpeech + cfg.reactSec) + (acc ?? 10) + cfg.marginM);
  const pre = main + Math.max(cfg.previewMinExtraM, v * cfg.previewExtraSec);
  return { v, tSpeech, main, pre };
}

export class Navigator {
  constructor(resort, opts = {}) {
    this.resort = resort;
    this.cfg = { ...NAV_CFG, ...(opts.cfg || {}) };
    this.matchCfg = { ...MATCH_CFG, ...(opts.matchCfg || {}) };
    this.lang = opts.lang || 'zh';
    this.estimate = opts.estimateSpeech || ((t) => estimateSpeechSeconds(t, this.lang));
    this.onSpeak = opts.onSpeak || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.route = null;
    this.maneuvers = [];
    this.idx = 0;
    this.s = 0;
    this.track = new Track(this.matchCfg);
    this.lastFix = null;
    this.lastFixAt = null;
    this.accBad = 0; this.accGood = 0;
    this.unreliable = null;       // { reason }
    this.recoverLeft = 0;
    this.stationarySince = null;
    this.stationary = false;
    this.moving = false;
    this.speed = null;
    this.heading = null;
    this.matched = null;          // 当前认定所在的候选
    this.candidates = [];
    this.offCount = 0; this.offMapCount = 0;
    this.ambiguousNow = false;
    this.passing = null;
    this.passedAt = null;
    this.spoken = new Map();      // key → 时间（去重）
    this.log = [];
    this.lastTiming = null;
    this.noLate = new Set();
    this.lastOffRouteAt = -Infinity;
    this.rerouteFromEdge = null;
  }

  /* ---------- 控制 ---------- */

  start({ route, destNode, prefs }, now) {
    this.reset();
    this.route = route.edges;
    this.destNode = destNode;
    this.prefs = prefs;
    this.maneuvers = buildManeuvers(this.resort, this.route, destNode);
    this.state = 'unreliable';
    this.unreliable = { reason: 'waiting' };
    this.recoverLeft = this.cfg.recoverCount;
    this.startedAt = now;
    const last = this.maneuvers[this.maneuvers.length - 1];
    const dest = this.lang === 'ja' ? (last.destNameJa || last.destName) : last.destName;
    this.say('start', SYSTEM_TEXT[this.lang].start(dest), '开始导航', now);
    this.emit('state', now);
  }

  pause(now) {
    if (this.state === 'idle' || this.state === 'arrived') return;
    this.pausedFrom = this.state;
    this.state = 'paused';
    this.addLog(now, 'state', '已暂停导航（暂停期间不判断位置、不播报）');
  }

  resume(now) {
    if (this.state !== 'paused') return;
    // 暂停期间的位置都不可信：清空轨迹，重新等待新的定位
    this.track.clear();
    this.state = 'unreliable';
    this.unreliable = { reason: 'waiting' };
    this.recoverLeft = this.cfg.recoverCount;
    this.passing = null;
    this.addLog(now, 'state', '继续导航，等待新的定位');
  }

  stop(now) {
    this.addLog(now, 'state', '结束导航');
    const log = this.log;
    this.reset();
    this.log = log;
  }

  /* ---------- 输入 ---------- */

  // 定时调用（例如每秒），用于发现“定位中断”
  tick(now) {
    if (!this.isActive()) return;
    if (this.lastFixAt != null && now - this.lastFixAt > this.cfg.staleMs && this.unreliable?.reason !== 'stale') {
      this.setUnreliable('stale', now);
      this.track.clear(); // 旧轨迹不能再用来推算方向
    }
  }

  onFix(fix) {
    const now = fix.t;
    if (this.state === 'idle' || this.state === 'paused' || this.state === 'arrived') { this.lastFix = fix; return; }
    this.lastFix = fix;
    this.lastFixAt = now;

    // 1. 定位精度（滞回）
    const acc = fix.acc ?? 99;
    if (acc > this.cfg.accEnter) { this.accBad++; this.accGood = 0; }
    else if (acc <= this.cfg.accExit) { this.accGood++; this.accBad = 0; }
    if (this.accBad >= this.cfg.accCount && this.unreliable?.reason !== 'accuracy') {
      this.setUnreliable('accuracy', now);
    }
    if (acc > this.cfg.accEnter) return; // 精度太差的点完全不用

    this.track.push(fix);

    // 2. 恢复判断
    if (this.unreliable && this.unreliable.reason !== 'ambiguous') {
      // 因精度不足进入的“不可靠”要等精度明显变好（≤ accExit）才恢复（滞回）；
      // 刚开始等待定位、或定位中断后，只要精度达到可用水平（≤ accEnter）即可
      const okAcc = this.unreliable.reason === 'accuracy' ? this.cfg.accExit : this.cfg.accEnter;
      if (acc <= okAcc) this.recoverLeft--;
      if (this.recoverLeft > 0) return;
      const was = this.unreliable.reason;
      this.unreliable = null;
      this.state = this.passing ? 'passing' : 'navigating';
      if (was === 'stale' || was === 'accuracy') this.say(`back:${now}`, SYSTEM_TEXT[this.lang].gpsBack, '定位恢复', now, { voice: false });
      this.emit('state', now);
    }

    // 3. 运动状态
    this.speed = this.track.speed();
    this.heading = this.track.heading();
    const movingNow = this.speed != null && this.speed >= this.cfg.stationarySpeed;
    if (movingNow) this.stationarySince = null;
    else if (this.stationarySince == null) this.stationarySince = now;
    this.moving = movingNow;
    this.stationary = !movingNow && this.stationarySince != null && now - this.stationarySince >= this.cfg.stationaryMs;

    // 4. 匹配
    const prevEdge = this.matched?.edge || this.route[this.idx];
    this.candidates = matchFix(this.resort, fix, { heading: this.heading, moving: this.moving, prevEdge }, this.matchCfg);

    if (this.state === 'offRoute') return this.handleOffRoute(fix, now);
    if (this.passing) return this.handlePassing(fix, now);
    return this.handleOnRoute(fix, now);
  }

  /* ---------- 路线上 ---------- */

  handleOnRoute(fix, now) {
    const cfg = this.cfg;
    const cur = this.route[this.idx], nxt = this.route[this.idx + 1];
    const top = this.candidates[0];
    const onRoute = this.candidates.filter((c) => c.edge === cur || c.edge === nxt);
    const eBest = onRoute[0] || null;

    if (!top) {
      // 附近没有任何雪道
      this.offMapCount++;
      this.matched = null;
      if (this.offMapCount >= cfg.offMapCount) return this.enterOffRoute(null, now, '附近没有已知雪道');
      return;
    }
    this.offMapCount = 0;

    if (!eBest || eBest.score < cfg.offRatio * top.score) {
      this.offCount++;
      this.ambiguousNow = false;
      if (this.offCount >= cfg.offCount) return this.enterOffRoute(top, now, `连续 ${this.offCount} 次匹配到路线外的 ${edgeLabel(top.edge)}`);
      return;
    }
    this.offCount = 0;
    // 路线上的候选与最佳候选得分接近但不是最佳：相邻雪道无法区分
    this.ambiguousNow = eBest !== top && eBest.score < cfg.ambiguousRatio * top.score;
    this.matched = eBest;

    if (eBest.edge === nxt) this.s = cur.length; // 已经过了节点
    else this.s = eBest.s;

    if (this.state === 'passed' && now - this.passedAt > cfg.passedHoldMs) this.state = 'navigating';

    // 5. 下一个需要播报的指令
    const { m, d } = this.nextAnnounced();
    if (m) this.handleAnnouncements(m, d, fix, now);

    // 6. 到达当前边的末端
    const mHere = this.maneuvers[this.idx];
    const remaining = cur.length - this.s;
    if (mHere.type === 'arrive') {
      if (remaining <= cfg.arriveRadius) return this.arrive(now);
      return;
    }
    if (remaining <= cfg.passRadius || eBest.edge === nxt) {
      if (mHere.type === 'continue') {
        // 没有选择的节点：进入下一条边后直接前进
        if (eBest.edge === nxt) { this.idx++; this.s = eBest.s; }
      } else {
        this.passing = { m: mHere, correct: 0, wrong: 0, startAt: now, maxAlong: 0 };
        this.state = 'passing';
        this.emit('state', now);
      }
    }
  }

  // 沿路线找到下一个需要播报的指令，以及沿路线的距离
  nextAnnounced() {
    let d = this.route[this.idx].length - this.s;
    for (let j = this.idx; j < this.maneuvers.length; j++) {
      const m = this.maneuvers[j];
      if (j > this.idx) d += this.route[j].length;
      if (m.announce) return { m, d: Math.max(0, d) };
    }
    return { m: null, d: null };
  }

  handleAnnouncements(m, d, fix, now) {
    const cfg = this.cfg;
    const mainText = maneuverText(m, 'main', { lang: this.lang });
    const tSpeech = this.estimate(mainText);
    const t = announceDistances(this.speed, fix.acc, tSpeech, cfg);
    this.lastTiming = { ...t, d, maneuver: m.id };

    // 不下结论的情况：静止、相邻雪道无法区分
    const hold = this.stationary || this.ambiguousNow;
    // 刚重新规划、第一个岔口又很近：只显示文字，不用语音催促转向
    if (this.noLate.has(m.id)) {
      if (!this.spoken.has(`quiet:${m.id}`)) {
        this.spoken.set(`quiet:${m.id}`, now);
        this.addLog(now, 'text', `（仅文字）${mainText} — 重新规划后距岔口仅 ${Math.round(d)} m，不做语音催促`);
      }
      return;
    }
    if (m.type !== 'arrive' && this.state !== 'passing' && this.state !== 'passed') {
      this.state = d <= t.pre ? 'approaching' : 'navigating';
    }
    if (hold) return;

    if (m.type === 'arrive') {
      if (d <= cfg.arrivePreviewM && d > cfg.arriveRadius) this.say(`pre:${m.id}`, maneuverText(m, 'preview', { lang: this.lang }), `距目的地 ${Math.round(d)} m`, now);
      return;
    }

    const reason = `沿路距离 ${Math.round(d)} m，速度 ${(t.v * 3.6).toFixed(0)} km/h，误差 ±${Math.round(fix.acc ?? 0)} m，语音约 ${t.tSpeech.toFixed(1)} s → 主提示阈值 ${Math.round(t.main)} m`;
    if (d <= t.pre && d > t.main + 50) {
      this.say(`pre:${m.id}`, maneuverText(m, 'preview', { lang: this.lang, distance: d }), '预告：' + reason, now);
    }
    // 刚开始导航时就在岔口附近：用完整提示，不用“来不及”的短提示
    const atStart = this.idx === 0 && this.s < 30;
    let spokeMain = false;
    if (d <= t.main && (d > cfg.lateM || atStart)) {
      spokeMain = this.say(`main:${m.id}`, mainText, (atStart && d <= cfg.lateM ? '导航开始时已在岔口附近：' : '主提示：') + reason, now);
    } else if (d <= cfg.lateM && !this.spoken.has(`main:${m.id}`)) {
      spokeMain = this.say(`main:${m.id}`, maneuverText(m, 'late', { lang: this.lang }), '来不及完整播报，短提示：' + reason, now);
    }
    // 合并播报了紧接着的第二个岔口：它自己的预告/主提示不再单独播
    if (spokeMain && m.then) for (const key of ['pre', 'main']) if (!this.spoken.has(`${key}:${m.then.id}`)) this.spoken.set(`${key}:${m.then.id}`, now);
  }

  /* ---------- 通过岔口 ---------- */

  handlePassing(fix, now) {
    const cfg = this.cfg;
    const P = this.passing, m = P.m;
    const outs = [m.outEdge, ...m.alternatives];
    const cOut = this.candidates.filter((c) => outs.includes(c.edge));
    const best = cOut[0] || null;
    const acc = fix.acc ?? 10;
    const sepNeeded = Math.max(cfg.sepMin, acc);

    // 与预期分支、其他分支的距离（直接计算，不依赖候选筛选）
    const dExp = distanceToEdge(fix, m.outEdge).d;
    const dAlts = m.alternatives.map((e) => distanceToEdge(fix, e).d);
    const dAltMin = dAlts.length ? Math.min(...dAlts) : Infinity;

    this.matched = best || this.candidates.find((c) => c.edge === m.inEdge) || null;
    if (best) P.maxAlong = Math.max(P.maxAlong, best.s);

    // 很短的分支（真实地图里常见）：进入 60% 长度即可开始确认
    const confirmAlong = Math.min(cfg.confirmAlong, m.outEdge.length * 0.6);
    // 已经滑过了很短的分支、到了路线后面的路段，也算走对
    const routeAhead = this.route.slice(this.idx + 2);
    const top = this.candidates[0] || null;
    const ahead = top && routeAhead.includes(top.edge) ? top : null;

    let verdict = 'unknown';
    P.ahead = null;
    if (!this.stationary) {
      if (best && best.s >= confirmAlong) {
        if (best.edge === m.outEdge && dAltMin - dExp >= sepNeeded) verdict = 'correct';
        else if (best.edge !== m.outEdge && dExp - best.d >= sepNeeded) { verdict = 'wrong'; P.wrongCand = best; }
      }
      if (verdict === 'unknown' && ahead && dAltMin - ahead.d >= sepNeeded) { verdict = 'correct'; P.ahead = ahead; }
      // 既不在任何分支上、也不在后续路线上：去了别的地方
      if (verdict === 'unknown' && top && !outs.includes(top.edge) && top.edge !== m.inEdge && !routeAhead.includes(top.edge)) {
        if (dExp - top.d >= sepNeeded) { verdict = 'wrong'; P.wrongCand = top; }
      }
    }
    if (verdict === 'correct') { P.correct++; P.wrong = 0; }
    else if (verdict === 'wrong') { P.wrong++; P.correct = 0; }
    else { P.correct = 0; P.wrong = 0; }
    P.last = { verdict, dExp, dAltMin, sepNeeded, along: best?.s ?? 0 };

    if (P.correct >= cfg.confirmCount) {
      this.passing = null;
      if (P.ahead) {
        // 跳过中间很短的路段；这些路段末端的指令已经来不及，标记为已处理，避免事后补播
        const j = this.route.indexOf(P.ahead.edge);
        for (let k = this.idx + 1; k < j; k++) {
          const mk = this.maneuvers[k];
          for (const key of ['pre', 'main', 'confirm']) if (!this.spoken.has(`${key}:${mk.id}`)) this.spoken.set(`${key}:${mk.id}`, now);
        }
        this.idx = j;
        this.s = P.ahead.s;
        this.matched = P.ahead;
      } else {
        this.idx++;
        this.s = distanceToEdge(fix, m.outEdge).s;
        this.matched = { edge: m.outEdge, s: this.s };
      }
      this.unreliable = null;
      this.state = 'passed';
      this.passedAt = now;
      const kind = m.type === 'board-lift' ? '乘上缆车' : '进入分支';
      // 沿同一条有名字的雪道继续时，“已进入”只显示文字，不占用语音
      this.say(`confirm:${m.id}`, maneuverText(m, 'confirm', { lang: this.lang }), `连续 ${cfg.confirmCount} 次确认${kind}${P.ahead ? '（已到后续路段）' : ''}：距预期分支 ${Math.round(P.ahead ? P.ahead.d : dExp)} m，距其他分支 ≥ ${Math.round(dAltMin)} m`, now, { voice: !m.sameRun });
      this.emit('state', now);
      return;
    }
    if (P.wrong >= cfg.confirmCount) {
      this.passing = null;
      const wc = P.wrongCand;
      return this.enterOffRoute(wc, now, `在${m.nodeId}进入了 ${edgeLabel(wc.edge)}（连续 ${cfg.confirmCount} 次）`);
    }
    // 过了岔口很远还分不清：相邻雪道无法区分
    if (P.maxAlong > cfg.ambiguityLimit && verdict === 'unknown') {
      if (this.unreliable?.reason !== 'ambiguous') {
        this.unreliable = { reason: 'ambiguous' };
        this.state = 'unreliable';
        this.say(`amb:${m.id}`, SYSTEM_TEXT[this.lang].ambiguous, `过岔口 ${Math.round(P.maxAlong)} m 仍无法区分分支（预期 ${Math.round(dExp)} m / 其他 ${Math.round(dAltMin)} m）`, now);
        this.emit('state', now);
      }
    } else if (this.unreliable?.reason !== 'ambiguous') {
      this.state = 'passing';
    }
  }

  /* ---------- 偏航 ---------- */

  enterOffRoute(cand, now, why) {
    this.passing = null;
    this.state = 'offRoute';
    this.offCount = 0;
    this.matched = cand;
    if (now - this.lastOffRouteAt >= this.cfg.offRepeatMs) {
      this.lastOffRouteAt = now;
      this.say(`off:${now}`, SYSTEM_TEXT[this.lang].offRoute, '偏离路线：' + why, now);
    } else {
      this.addLog(now, 'info', '再次偏离路线（60 秒内不重复播报）：' + why);
    }
    this.emit('state', now);
    this.tryReroute(cand, now);
  }

  handleOffRoute(fix, now) {
    const top = this.candidates[0];
    if (!top) { this.matched = null; return; }
    this.matched = top;
    this.tryReroute(top, now);
  }

  // 只从“当前所在雪道向前”重新规划：不会要求掉头或逆行
  tryReroute(cand, now) {
    if (!cand) return;
    if (this.rerouteFromEdge === cand.edge.id) return; // 同一条雪道上已经试过
    this.rerouteFromEdge = cand.edge.id;
    const plan = planRoute(this.resort, { startEdgeId: cand.edge.id, goalNode: this.destNode }, this.prefs);
    if (!plan.ok) {
      this.say(`noreroute:${cand.edge.id}`, SYSTEM_TEXT[this.lang].noReroute, `从 ${edgeLabel(cand.edge)} 出发：${plan.reason}`, now);
      return;
    }
    this.route = plan.edges;
    this.maneuvers = buildManeuvers(this.resort, this.route, this.destNode);
    this.idx = 0;
    this.s = cand.s;
    this.passing = null;
    this.state = 'navigating';
    this.rerouteFromEdge = null;
    // 距离太近的第一个岔口：不发“来不及”的短促转向提示
    const { m, d } = this.nextAnnounced();
    if (m && d < this.cfg.minMainM) this.noLate.add(m.id);
    this.say(`reroute:${now}`, SYSTEM_TEXT[this.lang].rerouted, `从 ${edgeLabel(cand.edge)} 向前重新规划，共 ${this.route.length} 段`, now);
    this.emit('state', now);
  }

  arrive(now) {
    const m = this.maneuvers[this.maneuvers.length - 1];
    this.state = 'arrived';
    this.say(`arrive:${m.id}`, maneuverText(m, 'main', { lang: this.lang }), '已到达目的地附近', now);
    this.emit('state', now);
  }

  /* ---------- 工具 ---------- */

  isActive() { return !['idle', 'paused', 'arrived'].includes(this.state); }

  setUnreliable(reason, now) {
    this.unreliable = { reason };
    this.state = 'unreliable';
    this.recoverLeft = this.cfg.recoverCount;
    this.ambiguousNow = false;
    if (reason === 'stale') this.say(`lost:${now}`, SYSTEM_TEXT[this.lang].gpsLost, `超过 ${this.cfg.staleMs / 1000} 秒没有新定位`, now, { cooldownKey: 'gps', cooldownMs: 30000 });
    if (reason === 'accuracy') this.say(`weak:${now}`, SYSTEM_TEXT[this.lang].gpsWeak, `定位误差 > ${this.cfg.accEnter} m`, now, { cooldownKey: 'gps', cooldownMs: 30000 });
    this.emit('state', now);
  }

  // 播报（带去重）：同一个 key 只说一次；cooldownKey 用于限制同类提示的频率
  say(key, text, reason, now, { voice = true, cooldownKey = null, cooldownMs = 0 } = {}) {
    if (this.spoken.has(key)) return false;
    if (cooldownKey) {
      const lastAt = this.spoken.get('cd:' + cooldownKey);
      if (lastAt != null && now - lastAt < cooldownMs) { this.addLog(now, 'suppressed', `${text}（${Math.round(cooldownMs / 1000)} 秒内不重复）`); return false; }
      this.spoken.set('cd:' + cooldownKey, now);
    }
    this.spoken.set(key, now);
    const item = { t: now, key, text, reason, voice, state: this.state };
    this.log.push({ ...item, type: voice ? 'speak' : 'text' });
    this.onSpeak(item);
    return true;
  }

  addLog(now, type, text) { this.log.push({ t: now, type, text }); }

  emit(type, now) { this.onEvent({ type, state: this.state, t: now }); }

  // 给界面用的当前状态
  snapshot(now) {
    const fix = this.lastFix;
    const ageMs = this.lastFixAt != null && now != null ? now - this.lastFixAt : null;
    const stale = this.isActive() && ageMs != null && ageMs > this.cfg.staleMs;
    let next = null, dist = null, remaining = null;
    if (this.route && this.state !== 'arrived') {
      const r = this.nextAnnounced();
      next = r.m; dist = r.d;
      remaining = this.route.slice(this.idx).reduce((a, e) => a + e.length, 0) - this.s;
    }
    // 定位不可靠或过期时，不给出“距离”
    const trustworthy = !this.unreliable && !stale && this.state !== 'offRoute';
    return {
      state: this.state,
      stateZh: STATE_ZH[this.state],
      unreliable: this.unreliable ? UNRELIABLE_ZH[this.unreliable.reason] : null,
      stationary: this.stationary,
      ambiguous: this.ambiguousNow,
      fix, ageMs, stale,
      acc: fix?.acc ?? null,
      speed: this.speed,
      heading: this.heading,
      route: this.route,
      idx: this.idx,
      s: this.s,
      matched: this.matched,
      candidates: this.candidates.slice(0, 4),
      next,
      nextText: next ? maneuverText(next, 'main', { lang: this.lang }) : null,
      distToNext: trustworthy ? dist : null,
      remaining: trustworthy ? remaining : null,
      passing: this.passing,
      timing: this.lastTiming,
      log: this.log
    };
  }
}
