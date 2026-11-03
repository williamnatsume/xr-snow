// 导航指令：只根据已经计算好的路线和地图数据生成，不做任何猜测。
//
// 左右的判断：以“进入岔口的路线方向”为基准（来路末段约 40 m 的整体方向），
// 比较各分支“离开岔口的方向”（分支起始约 40 m 的整体方向）。
// 不使用手机朝向，也不假设用户面向山下——回头弯后用户可能朝着山上的方向滑行。

import { angleDiff } from './geo.js';
import { edgeLabel, poiOfNode } from './resort.js';

export const INSTR_CFG = {
  behindDeg: 120,     // 与来路方向夹角超过 120° 的分支视为“身后”，不算作岔口选项
  unclearDeg: 12,     // 选中分支与相邻分支方向差小于 12° 时，不说左右，只说路牌名称
  mergeWithinM: 60    // 两个岔口相距小于 60 m 时合并成一条提示（待实测）
};

const ZH_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function zhNumber(ref) {
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(ref);
  if (n <= 10) return ZH_NUM[n];
  if (n < 20) return '十' + ZH_NUM[n - 10];
  return ZH_NUM[Math.floor(n / 10)] + '十' + (n % 10 ? ZH_NUM[n % 10] : '');
}

// 语音里怎么称呼一条边：优先“编号 + 类型”，其次路牌/名称
export function spokenName(e, lang = 'zh') {
  if (!e) return '';
  if (lang === 'ja') {
    const kind = e.type === 'lift' ? '' : e.type === 'connector' ? '連絡路' : 'コース';
    if (e.ref) return `${e.ref}番${e.type === 'lift' ? 'リフト' : kind}`;
    if (e.type === 'connector' && e.attr?.geometry === 'derived') return '連絡路';
    if (e.name) return e.name;
    return e.type === 'run' ? '名前のないコース' : '連絡路';
  }
  const kind = e.type === 'lift' ? '缆车' : e.type === 'connector' ? '步道' : '雪道';
  if (e.ref) return `${zhNumber(e.ref)}号${kind}`;
  if (e.type === 'connector' && e.attr?.geometry === 'derived') return '步道'; // 推算的连接段没有真实名称
  if (e.name) return e.name;
  return e.type === 'run' ? '无名雪道' : '步道';
}

const SIDE = {
  zh: { left: '靠左', right: '靠右', middle: '走中间', unclear: '' },
  ja: { left: '左へ', right: '右へ', middle: '真ん中へ', unclear: '' }
};

// 计算岔口处选中分支的相对位置
export function forkSide(inEdge, chosen, alternatives) {
  const hin = inEdge.headEnd;
  const opts = [chosen, ...alternatives]
    .map((e) => ({ e, rel: angleDiff(e.headStart, hin) }))
    .filter((o) => o.e === chosen || Math.abs(o.rel) <= INSTR_CFG.behindDeg);
  const others = opts.filter((o) => o.e !== chosen);
  const relC = opts.find((o) => o.e === chosen).rel;
  if (!others.length) return { side: 'none', rel: relC, options: opts };
  const minGap = Math.min(...others.map((o) => Math.abs(o.rel - relC)));
  let side;
  if (minGap < INSTR_CFG.unclearDeg) side = 'unclear';
  else if (others.every((o) => o.rel > relC)) side = 'left';
  else if (others.every((o) => o.rel < relC)) side = 'right';
  else side = 'middle';
  return { side, rel: relC, minGap, options: opts.map((o) => ({ id: o.e.id, rel: Math.round(o.rel) })) };
}

// 为整条路线生成指令（每个需要用户做选择的节点一条）
export function buildManeuvers(resort, edges, destNodeId) {
  const dest = poiOfNode(resort, destNodeId);
  const destName = dest ? dest.name : (resort.nodes.get(destNodeId)?.name || '目的地');
  const destNameJa = dest ? (dest.name_ja || dest.name) : destName;
  const list = [];
  let cumStart = 0;
  for (let k = 0; k < edges.length; k++) {
    const e = edges[k];
    const endAlong = cumStart + e.length;
    if (k < edges.length - 1) {
      const next = edges[k + 1];
      const alternatives = (resort.out.get(e.to) || []).filter((x) => x !== next);
      let type, sideInfo = null;
      if (next.type === 'lift') type = 'board-lift';
      else if (e.type === 'lift') {
        type = 'exit-lift';
        sideInfo = forkSide(e, next, alternatives);
      } else {
        sideInfo = forkSide(e, next, alternatives);
        type = sideInfo.side === 'none' ? 'continue' : 'fork';
      }
      list.push({
        id: `M${k}:${e.to}`,
        index: k,             // 在第 k 条边的末端
        nodeId: e.to,
        type,
        side: sideInfo?.side || 'none',
        sideInfo,
        inEdge: e, outEdge: next,
        alternatives,
        along: endAlong,      // 从路线起点算起的沿路距离
        destName, destNameJa,
        announce: type !== 'continue'
      });
    } else {
      list.push({ id: `A:${e.to}`, index: k, nodeId: e.to, type: 'arrive', side: 'none', inEdge: e, outEdge: null, alternatives: [], along: endAlong, destName, destNameJa, announce: true });
    }
    cumStart = endAlong;
  }
  // 两个岔口相距很近（< 60 m）时，把第二个合并到第一个的提示里（“随后靠右…”）
  const ann = list.filter((m) => m.announce && m.type !== 'arrive');
  for (let i = 0; i < ann.length - 1; i++) {
    const a = ann[i], b = ann[i + 1];
    if (b.along - a.along < INSTR_CFG.mergeWithinM && (a.type === 'fork' || a.type === 'exit-lift') && b.type === 'fork') a.then = b;
  }
  for (const m of list) m.sameRun = !!(m.outEdge && m.inEdge && m.outEdge.name && m.outEdge.name === m.inEdge.name);
  return list;
}

// 生成播报文本。kind: 'preview'（提前预告）/ 'main'（主提示）/ 'late'（来不及时的短提示）/ 'confirm'
export function maneuverText(m, kind, { lang = 'zh', distance = null } = {}) {
  const S = SIDE[lang] || SIDE.zh;
  const side = S[m.side] || '';
  const out = m.outEdge ? spokenName(m.outEdge, lang) : '';
  const meters = distance != null ? Math.max(50, Math.round(distance / 50) * 50) : null;
  // 紧接着的第二个岔口
  const then = m.then ? (S[m.then.side] || '') : '';
  const thenOut = m.then ? spokenName(m.then.outEdge, lang) : '';

  if (lang === 'ja') {
    m = { ...m, destName: m.destNameJa || m.destName };
    const go = m.sameRun ? `${out}をそのまま進んでください` : `${out}に進んでください`;
    const thenJa = m.then ? `。続けて${then}${thenOut}へ` : '';
    switch (m.type) {
      case 'fork':
        if (kind === 'preview') return `およそ${meters}メートル先、分岐です。${side}${out}に進みます${thenJa}`;
        if (kind === 'late') return side ? `${side}、${out}` : `${out}へ`;
        if (kind === 'confirm') return `${out}に入りました`;
        return side ? `この先分岐、${side}、${go}${thenJa}。${m.destName}方面です` : `この先分岐、案内板に従って${go}${thenJa}`;
      case 'exit-lift':
        if (kind === 'confirm') return `${out}に入りました`;
        return side ? `リフトを降りたら、${side}${out}に進んでください` : `リフトを降りたら、${out}に進んでください`;
      case 'board-lift':
        if (kind === 'confirm') return `${out}に乗車しました`;
        if (kind === 'preview') return `およそ${meters}メートル先で、${out}に乗ります`;
        return `この先、${out}に乗ってください`;
      case 'arrive':
        if (kind === 'preview') return `まもなく${m.destName}に到着します`;
        return `${m.destName}に到着しました`;
      default: return '';
    }
  }

  const go = m.sameRun ? `继续走${out}` : `进入${out}`;
  const thenZh = m.then ? `，随后${then}进入${thenOut}` : '';
  switch (m.type) {
    case 'fork':
      if (kind === 'preview') return `约${meters}米后分岔，${side}${go}${thenZh}`;
      if (kind === 'late') return side ? `${side}，${out}` : `进入${out}`;
      if (kind === 'confirm') return `已进入${out}`;
      return side ? `前方分岔${side}，${go}${thenZh}，前往${m.destName}` : `前方分岔，请按路牌${go}${thenZh}，前往${m.destName}`;
    case 'exit-lift':
      if (kind === 'confirm') return `已进入${out}`;
      return (side ? `下缆车后${side}，进入${out}` : `下缆车后进入${out}`) + thenZh;
    case 'board-lift':
      if (kind === 'confirm') return `已乘上${out}`;
      if (kind === 'preview') return `约${meters}米后乘坐${out}`;
      return `前方乘坐${out}，前往${m.destName}`;
    case 'arrive':
      if (kind === 'preview') return `即将到达${m.destName}`;
      return `已到达${m.destName}`;
    default: return '';
  }
}

// 不涉及具体转向的系统提示
export const SYSTEM_TEXT = {
  zh: {
    offRoute: '可能偏离路线，请在安全位置停下查看地图',
    rerouted: '已按当前所在雪道重新规划路线',
    noReroute: '从当前雪道无法按设定条件到达目的地，请在安全位置停下查看地图',
    gpsLost: '定位信号中断，暂停转弯提示',
    gpsWeak: '定位精度不足，暂停转弯提示',
    gpsBack: '定位已恢复',
    ambiguous: '暂时无法确定所在雪道，请留意路牌',
    start: (dest) => `开始导航，前往${dest}`
  },
  ja: {
    offRoute: 'ルートを外れた可能性があります。安全な場所で止まって地図を確認してください',
    rerouted: '現在のコースからルートを再計算しました',
    noReroute: '現在のコースから条件に合うルートがありません。安全な場所で止まって地図を確認してください',
    gpsLost: '位置情報が途切れました。分岐案内を一時停止します',
    gpsWeak: '位置の精度が低いため、分岐案内を一時停止します',
    gpsBack: '位置情報が回復しました',
    ambiguous: '現在のコースを特定できません。案内板を確認してください',
    start: (dest) => `${dest}への案内を開始します`
  }
};

export { edgeLabel };
