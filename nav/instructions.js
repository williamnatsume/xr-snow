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
  zh: { left: '靠左', right: '靠右', middle: '走中间那条', unclear: '' },
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

// 同一类提示换着说，听起来不像机器（按指令 id 固定选择，同一条提示每次说法一样，便于测试和重播）
function pick(m, kind, variants) {
  const key = `${m.id || ''}:${kind}`;
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return variants[h % variants.length];
}

// 生成播报文本。kind: 'preview'（提前预告）/ 'main'（主提示）/ 'late'（来不及时的短提示）/ 'confirm'
// 口吻是陪滑的朋友，不是车载导航：短、口语、关键信息（左右 + 雪道）放在最前面。
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
    const go = m.sameRun ? `${out}をそのまま` : `${out}へ`;
    const thenJa = m.then ? `、すぐ${then}${thenOut}` : '';
    switch (m.type) {
      case 'fork':
        if (kind === 'preview') return side ? `${meters}メートルくらい先で分岐。${side}、${go}ね${thenJa}` : `${meters}メートルくらい先で分岐。案内板の${go}ね${thenJa}`;
        if (kind === 'late') return side ? `${side}、${out}！` : `${out}！`;
        if (kind === 'confirm') return pick(m, kind, [`OK、${out}に入ったよ`, `いいね、${out}だよ`, `${out}、合ってるよ`]);
        return side ? `分岐だよ、${side}！${go}${thenJa}` : `分岐だよ、案内板を見て${go}${thenJa}`;
      case 'exit-lift':
        if (kind === 'confirm') return `OK、${out}に入ったよ`;
        return side ? `リフト降りたら${side}、${out}ね` : `リフト降りたら${out}ね`;
      case 'board-lift':
        if (kind === 'confirm') return pick(m, kind, [`${out}に乗ったね。ちょっと休憩しよう`, `${out}、乗れたね。一息つこう`]);
        if (kind === 'preview') return `${meters}メートルくらい先で${out}に乗るよ`;
        return `ここで${out}に乗ろう`;
      case 'arrive':
        if (kind === 'preview') return `もうすぐ${m.destName}だよ`;
        return pick(m, kind, [`着いた！${m.destName}だよ`, `到着、${m.destName}！`]);
      default: return '';
    }
  }

  // 有左右时：“靠左，二号雪道”；没有左右时：“看路牌走二号雪道”
  const go = m.sameRun ? `顺着${out}接着滑` : out;
  const goNoSide = m.sameRun ? `顺着${out}接着滑` : `走${out}`;
  const thenZh = m.then ? `，紧接着${then}，${thenOut}` : '';
  switch (m.type) {
    case 'fork':
      if (kind === 'preview') return side ? `前面${meters}米有个岔口，到时候${side}，${go}${thenZh}` : `前面${meters}米有个岔口，看路牌${goNoSide}${thenZh}`;
      if (kind === 'late') return side ? `${side}！${out}！` : `${out}！`;
      if (kind === 'confirm') return pick(m, kind, [`好嘞，进${out}了`, `对，就是${out}`, `漂亮，${out}没走错`]);
      return side ? `岔口到了，${side}，${go}${thenZh}` : `岔口到了，看路牌${goNoSide}${thenZh}`;
    case 'exit-lift':
      if (kind === 'confirm') return `好嘞，进${out}了`;
      return (side ? `下了缆车${side}，走${out}` : `下了缆车走${out}`) + thenZh;
    case 'board-lift':
      if (kind === 'confirm') return pick(m, kind, [`坐上${out}了，歇会儿吧`, `上${out}了，喘口气`]);
      if (kind === 'preview') return `前面${meters}米坐${out}`;
      return `到了，坐${out}`;
    case 'arrive':
      if (kind === 'preview') return `快到${m.destName}啦`;
      return pick(m, kind, [`到啦，${m.destName}！`, `${m.destName}到了！`]);
    default: return '';
  }
}

// 不涉及具体转向的系统提示
export const SYSTEM_TEXT = {
  zh: {
    offRoute: '诶，好像走偏了。先找个安全的地方停一下，看看地图',
    rerouted: '没事，换条路，从你现在这条道接着走',
    noReroute: '从这条道过不去了，先找个安全的地方停一下，看看地图',
    gpsLost: '信号丢了，转弯先不报，留意路牌',
    gpsWeak: '定位不太准，转弯先不报，留意路牌',
    gpsBack: '信号回来了',
    ambiguous: '我分不清你在哪条道上，留意一下路牌',
    start: (dest) => `出发！去${dest}，跟着我`
  },
  ja: {
    offRoute: 'あれ、ルートから外れたかも。安全な所で止まって地図を見よう',
    rerouted: '大丈夫、今のコースからルートを変えたよ',
    noReroute: 'このコースからは行けないみたい。安全な所で止まって地図を見よう',
    gpsLost: '位置が取れない。分岐の案内は止めるね、案内板を見て',
    gpsWeak: '位置があいまい。分岐の案内は止めるね、案内板を見て',
    gpsBack: '位置、戻ったよ',
    ambiguous: 'どのコースにいるか分からない。案内板を見てね',
    start: (dest) => `出発！${dest}まで、ついてきて`
  }
};

export { edgeLabel };
