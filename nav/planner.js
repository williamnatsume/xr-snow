// 路线规划：有向图 + Dijkstra。
// 规则：
//   - 每条边只能按数据里的方向通行（雪道 = 下坡方向，缆车 = 上行方向），不存在逆行或穿越非雪道区域
//   - 缆车是“乘坐”段，不会被当成滑行段，也不会反向乘坐
//   - 关闭 / 超过难度上限 / 方向数据矛盾的边：硬性禁止
//   - 避开平路：软偏好，只增加代价
//   - 找不到路线时明确报告原因，绝不偷偷放宽条件

export const DEFAULT_PREFS = {
  maxDifficulty: 2,            // 1 初级 / 2 中级 / 3 高级 / 4 专家
  avoidFlat: false,
  preferShort: false,
  allowUnknownDifficulty: false, // 难度未知的雪道默认不进入
  allowUnknownOpen: true         // 开放状态未知（真实数据一律未知）默认允许，但会给出警告
};

// 代价参数：都是待实测的初始值
export const COST = {
  runSpeed: { 1: 5.5, 2: 7, 3: 8, 4: 8 }, // m/s，按难度估计的平均滑行速度
  flatSpeed: 2.5,           // 平路（蹬行）m/s
  walkSpeed: 1.2,           // 步道 m/s
  liftSpeed: 4,             // 没有乘坐时间数据时按 4 m/s 估算
  liftWait: 180,            // 每次乘缆车估计排队 + 上下车 3 分钟
  flatPenalty: 4            // 避开平路时，平路段代价 × 4
};

export function edgeBlockReason(e, prefs) {
  if (e.open === false) return e.type === 'lift' ? '缆车停运' : '雪道关闭';
  if (e.open == null && !prefs.allowUnknownOpen) return '开放状态未知';
  if (e.directionCheck === 'conflict') return '方向数据矛盾';
  if (e.type === 'lift') return null;
  if (e.difficulty == null) return prefs.allowUnknownDifficulty ? null : '难度未知';
  if (e.difficulty > prefs.maxDifficulty) return '超过难度上限';
  return null;
}

export function edgeTime(e) {
  if (e.type === 'lift') return (e.duration_min ? e.duration_min * 60 : e.length / COST.liftSpeed) + COST.liftWait;
  if (e.type === 'connector') return e.length / COST.walkSpeed;
  if (e.flat === true) return e.length / COST.flatSpeed;
  return e.length / (COST.runSpeed[e.difficulty] || COST.runSpeed[2]);
}

export function edgeCost(e, prefs) {
  let c = prefs.preferShort ? e.length : edgeTime(e);
  if (prefs.avoidFlat && e.flat === true) c *= COST.flatPenalty;
  return c;
}

// 简单的二叉堆
class Heap {
  constructor() { this.a = []; }
  push(x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].k <= a[i].k) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

function dijkstra(resort, startNode, goalNode, prefs) {
  const best = new Map([[startNode, 0]]);
  const prev = new Map();
  const heap = new Heap();
  heap.push({ k: 0, n: startNode });
  while (heap.size) {
    const { k, n } = heap.pop();
    if (n === goalNode) break;
    if (k > best.get(n)) continue;
    for (const e of resort.out.get(n) || []) {
      if (edgeBlockReason(e, prefs)) continue;
      const nk = k + edgeCost(e, prefs);
      if (nk < (best.get(e.to) ?? Infinity)) {
        best.set(e.to, nk);
        prev.set(e.to, e);
        heap.push({ k: nk, n: e.to });
      }
    }
  }
  if (!best.has(goalNode)) return null;
  const edges = [];
  let n = goalNode;
  while (n !== startNode) { const e = prev.get(n); edges.unshift(e); n = e.from; }
  return { edges, cost: best.get(goalNode) };
}

function summarize(resort, edges, prefs) {
  const warnings = [];
  let length = 0, time = 0, flatLen = 0, liftCount = 0, maxDiff = 0;
  for (const e of edges) {
    length += e.length; time += edgeTime(e);
    if (e.flat === true) flatLen += e.length;
    if (e.type === 'lift') liftCount++;
    if (e.type !== 'lift' && e.difficulty) maxDiff = Math.max(maxDiff, e.difficulty);
  }
  if (edges.some((e) => e.open == null)) warnings.push('路线中有开放状态未知的雪道/缆车，出发前请确认现场开放情况');
  if (edges.some((e) => e.type !== 'lift' && e.flat == null)) warnings.push('部分路段是否为平路未知');
  if (prefs.avoidFlat && flatLen > 0) warnings.push(`已尽量避开平路，但仍有约 ${Math.round(flatLen)} m 平路无法绕开`);
  if (edges.some((e) => e.attr?.geometry === 'derived')) warnings.push('部分连接段是程序推算的，实际路径可能不同');
  return { length, time, flatLen, liftCount, maxDiff, warnings };
}

// 规划：从节点 startNode（或当前所在边 startEdge 的下游）到 goalNode
export function planRoute(resort, { startNode, startEdgeId, goalNode }, prefs = DEFAULT_PREFS) {
  prefs = { ...DEFAULT_PREFS, ...prefs };
  let prefix = [];
  let from = startNode;
  if (startEdgeId) {
    // 已经在某条边上（重新规划）：只能沿这条边继续向前，不能掉头
    const cur = resort.edges.get(startEdgeId);
    if (!cur) return { ok: false, reason: '当前所在路段不存在' };
    prefix = [cur];
    from = cur.to;
  }
  if (!resort.nodes.has(from) || !resort.nodes.has(goalNode)) return { ok: false, reason: '起点或目的地不存在' };
  if (from === goalNode) {
    if (prefix.length) return { ok: true, edges: prefix, ...summarize(resort, prefix, prefs), prefs };
    return { ok: false, reason: '起点和目的地相同' };
  }

  const r = dijkstra(resort, from, goalNode, prefs);
  if (r) {
    const edges = [...prefix, ...r.edges];
    return { ok: true, edges, ...summarize(resort, edges, prefs), prefs };
  }

  // 没有路线：只做诊断，不返回放宽后的路线
  const hints = [];
  const tryWith = (p, text) => { if (dijkstra(resort, from, goalNode, { ...prefs, ...p })) hints.push(text); };
  if (prefs.maxDifficulty < 4) {
    for (let d = prefs.maxDifficulty + 1; d <= 4; d++) {
      if (dijkstra(resort, from, goalNode, { ...prefs, maxDifficulty: d })) {
        hints.push(`如果允许${['', '初级', '中级', '高级', '专家级'][d]}雪道则可以到达`);
        break;
      }
    }
  }
  if (!prefs.allowUnknownDifficulty) tryWith({ allowUnknownDifficulty: true, maxDifficulty: 4 }, '部分可能的路线经过难度未知的雪道');
  const anyOpen = dijkstra(resort, from, goalNode, { maxDifficulty: 4, allowUnknownDifficulty: true, allowUnknownOpen: true, avoidFlat: false, preferShort: true });
  if (!anyOpen && !hints.length) hints.push('即使不限难度也没有连通路线：可能必须经过关闭的雪道，或地图数据缺失');
  return {
    ok: false,
    reason: '在当前条件下没有可用路线（未自动放宽条件）',
    hints,
    prefs
  };
}

// 规划结果的逐段说明（界面展示用）
export function routeSteps(resort, route) {
  return route.edges.map((e) => ({
    id: e.id,
    type: e.type,
    length: e.length,
    time: edgeTime(e),
    difficulty: e.difficulty,
    flat: e.flat,
    open: e.open
  }));
}
