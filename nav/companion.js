// “雪人”对话：把一句话（云端大模型或本地规则理解出的意图）变成动作和语音回复。
//
// 原则（与 nlp.js 相同）：大模型和规则只负责“理解用户想要什么”，输出统一的意图结构；
// 走哪条雪道、怎么转弯，只由路线规划和地图数据决定。大模型给出的地名必须能在地图里找到，否则追问。
//
// 意图结构（规则和大模型共用，见 INTENT_SCHEMA）：
//   { intent, destination, start, maxDifficulty, avoidFlat, preferShort, reply }
//   destination / start：地名原文（"" 表示没说）；maxDifficulty：0 表示没说；
//   avoidFlat / preferShort："yes" / "no" / ""；reply：仅 chat 时给出的简短回复。

import { parseRequest } from './nlp.js';
import { DIFFICULTY } from './resort.js';
import { matchFix } from './matcher.js';

export const INTENTS = ['navigate', 'confirm', 'cancel', 'stop', 'pause', 'resume', 'distance', 'repeat', 'easier', 'where', 'chat', 'unknown'];

export const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'destination', 'start', 'maxDifficulty', 'avoidFlat', 'preferShort', 'reply'],
  properties: {
    intent: { type: 'string', enum: INTENTS },
    destination: { type: 'string' },
    start: { type: 'string' },
    maxDifficulty: { type: 'integer', enum: [0, 1, 2, 3, 4] },
    avoidFlat: { type: 'string', enum: ['yes', 'no', ''] },
    preferShort: { type: 'string', enum: ['yes', 'no', ''] },
    reply: { type: 'string' }
  }
};

export const WAKE_WORDS = ['雪人', '雪だるま', 'ゆきだるま'];

const EMPTY = { intent: 'unknown', destination: '', start: '', maxDifficulty: 0, avoidFlat: '', preferShort: '', reply: '' };

// 去掉开头的唤醒词和语气词
export function stripWake(text) {
  let t = (text || '').trim();
  for (const w of WAKE_WORDS) {
    const i = t.indexOf(w);
    if (i >= 0 && i <= 3) { t = t.slice(i + w.length); break; }
  }
  return t.replace(/^[\s，,。、！!？?呀啊喂嘿]+/, '').trim();
}

const RULES = [
  // 顺序有意义：先匹配更具体的
  ['stop', /(结束导航|停止导航|不导航了|关掉导航|退出导航|案内(を)?終了|ナビ(を)?終了)/],
  ['pause', /(暂停|先停一下|等一下|一時停止)/],
  ['resume', /(继续导航|恢复导航|继续吧|^继续|再開)/],
  ['repeat', /(再说一遍|再说一次|重复|没听清|刚才说什么|もう一度|もう一回)/],
  ['distance', /(多远|还有多少|还要多久|多长时间|还有几|距离|あとどれ|どのくらい|何メートル)/],
  ['easier', /(简单点|简单一点|轻松|容易点|容易一点|累了|好累|太难|太陡|簡単|楽な)/],
  ['where', /(我在哪|在哪里|这是哪|现在在哪|ここはどこ|今どこ)/],
  ['cancel', /^(不要|不用|取消|算了|不了|不去了|别去了|いいえ|やめ|キャンセル)/],
  ['confirm', /^(好|好的|好啊|开始|出发|走吧|走|可以|行|对|是的|嗯|没问题|ok|okay|go|はい|お願い|スタート|行こう)/i]
];

// 本地规则：没有网络或云端失败时使用
export function rulesIntent(text, resort) {
  const t = stripWake(text);
  if (!t) return { ...EMPTY, intent: 'unknown' };
  const req = parseRequest(t, resort);
  const hasPlace = !!(req.destination || req.ambiguous.length);
  for (const [intent, re] of RULES) {
    if (!re.test(t)) continue;
    // “好，去山腰站” 这类带地名的句子按新目的地处理
    if ((intent === 'confirm' || intent === 'cancel') && hasPlace) break;
    if (intent === 'easier') return { ...EMPTY, intent, maxDifficulty: 0 };
    return { ...EMPTY, intent };
  }
  if (hasPlace || req.maxDifficulty != null || req.avoidFlat || req.preferShort) {
    const amb = req.ambiguous.length && !req.destination ? (req.ambiguous[0].match(/“(.+?)”/) || [])[1] || '' : '';
    return {
      ...EMPTY,
      intent: 'navigate',
      destination: req.destination?.name || amb,
      start: req.start?.name || '',
      maxDifficulty: req.maxDifficulty ?? 0,
      avoidFlat: req.avoidFlat ? 'yes' : '',
      preferShort: req.preferShort ? 'yes' : ''
    };
  }
  return { ...EMPTY, intent: 'unknown' };
}

// 地名 → 地点。返回 { node, name } / { ambiguous: [名称…] } / null
export function resolvePlace(resort, text) {
  const q = (text || '').replace(/\s+/g, '');
  if (!q) return null;
  const cands = [];
  const add = (node, name, score) => {
    const old = cands.find((c) => c.node === node);
    if (!old) cands.push({ node, name, score });
    else if (score > old.score) old.score = score;
  };
  for (const p of resort.pois) {
    const names = [p.name, p.name_ja, ...(p.aliases || [])].filter(Boolean);
    for (const n of names) {
      if (n === q) add(p.node, p.name, 3);
      else if (q.includes(n) && n.length >= 2) add(p.node, p.name, 2);
      else if (n.includes(q) && q.length >= 2) add(p.node, p.name, 1);
    }
  }
  for (const n of resort.nodes.values()) {
    if (!n.name || resort.pois.some((p) => p.node === n.id)) continue;
    if (n.name === q) add(n.id, n.name, 3);
    else if (q.length >= 2 && (n.name.includes(q) || q.includes(n.name))) add(n.id, n.name, 1);
  }
  if (!cands.length) return null;
  const best = Math.max(...cands.map((c) => c.score));
  const top = cands.filter((c) => c.score === best);
  if (top.length === 1) return top[0];
  return { ambiguous: top.map((c) => c.name) };
}

const DIFF_ZH = { 1: '初级', 2: '中级', 3: '高级', 4: '专家级' };
const DIFF_JA = { 1: '初級', 2: '中級', 3: '上級', 4: 'エキスパート' };

const T = {
  zh: {
    noDest: (ex) => `要去哪里？比如：${ex}`,
    notFound: (q, ex) => `地图上没有找到“${q}”。可以去：${ex}`,
    ambiguous: (list) => `你说的是${list.join('，还是')}？`,
    noStart: '我还不知道你现在在哪。请说从哪里出发，比如“从山顶出发去餐厅”。',
    summary: (from, to, diff, km, min, via, warn) =>
      `从${from}去${to}，只走${diff}以下，约${km}公里、${min}分钟${via ? `，经过${via}` : ''}。${warn}要出发吗？`,
    noRoute: (reason, hint) => `${reason}${hint ? '。' + hint : ''}`,
    cancelled: '好的，取消了。',
    nothingToConfirm: '现在没有待确认的路线。告诉我想去哪里吧。',
    stopped: '已结束导航。',
    notNavigating: '现在没有在导航。',
    paused: '已暂停导航。说“继续”就恢复。',
    resumed: '继续导航。',
    unreliable: (why) => `${why}，暂时无法判断距离。`,
    distance: (d, next, rem) => `${next ? `${next}。` : ''}${rem != null ? `到目的地还有约${rem}。` : ''}`,
    arrivedAlready: '已经到达目的地了。',
    where: (edge) => `你现在大概在${edge}。`,
    whereUnknown: '暂时无法确定你在哪条雪道上。',
    easierNone: '已经是最简单的路线了。',
    easierNoRoute: (diff, to) => `去${to}没有只走${diff}的路线，继续按原来的路线走。`,
    unknown: '我没听懂。你可以说：去山脚餐厅，不走高级道；或者：还有多远。',
    noRepeat: '还没有可以重复的提示。',
    km: (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)}公里` : `${Math.round(m / 10) * 10}米`),
    sep: '、',
    warnUnknownOpen: '注意开放状态未知。'
  },
  ja: {
    noDest: (ex) => `どこへ行きますか？例えば：${ex}`,
    notFound: (q, ex) => `地図に「${q}」が見つかりません。行ける場所：${ex}`,
    ambiguous: (list) => `${list.join('と')}のどちらですか？`,
    noStart: '現在地がまだわかりません。「山頂からレストランへ」のように出発地を言ってください。',
    summary: (from, to, diff, km, min, via, warn) =>
      `${from}から${to}まで、${diff}以下のコースで約${km}、${min}分です${via ? `。${via}を通ります` : ''}。${warn}出発しますか？`,
    noRoute: (reason, hint) => `${reason}${hint ? '。' + hint : ''}`,
    cancelled: 'わかりました、キャンセルします。',
    nothingToConfirm: '確認待ちのルートはありません。行き先を教えてください。',
    stopped: '案内を終了しました。',
    notNavigating: '今は案内していません。',
    paused: '案内を一時停止しました。「再開」で戻ります。',
    resumed: '案内を再開します。',
    unreliable: (why) => `${why}のため、距離がわかりません。`,
    distance: (d, next, rem) => `${next ? `${next}。` : ''}${rem != null ? `目的地まであと約${rem}です。` : ''}`,
    arrivedAlready: 'もう目的地に着いています。',
    where: (edge) => `今はおそらく${edge}にいます。`,
    whereUnknown: '今どのコースにいるか特定できません。',
    easierNone: 'すでに一番やさしいルートです。',
    easierNoRoute: (diff, to) => `${to}まで${diff}だけのルートはありません。今のルートを続けます。`,
    unknown: 'よくわかりませんでした。「山麓レストランへ、上級コースなし」や「あとどれくらい」と言ってください。',
    noRepeat: 'まだ繰り返す案内がありません。',
    km: (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)}キロ` : `${Math.round(m / 10) * 10}メートル`),
    sep: '、',
    warnUnknownOpen: '営業状況は不明です。'
  }
};

// api：由 core-entry 的会话提供（见那里的说明）
export function createCompanion(api) {
  let mode = 'idle';          // idle / confirming / navigating
  let pending = null;         // { startNode, startEdgeId, goal, prefs, plan }
  let prefs = { maxDifficulty: 2, avoidFlat: false, preferShort: false };
  let lastReply = '';
  const t = () => T[api.lang() === 'ja' ? 'ja' : 'zh'];

  const placeExamples = () => api.resort.pois.slice(0, 4).map((p) => (api.lang() === 'ja' && p.name_ja) || p.name).join(t().sep);
  const placeName = (node) => {
    const p = api.resort.pois.find((x) => x.node === node);
    if (p) return (api.lang() === 'ja' && p.name_ja) || p.name;
    return api.resort.nodes.get(node)?.name || node;
  };

  // 当前位置 → 起点：在雪道上就从这条雪道向前；否则最近的节点（150 m 内）
  function locateStart() {
    const fix = api.lastFix();
    if (!fix) return null;
    const cands = matchFix(api.resort, fix, { heading: null, moving: false, prevEdge: null });
    const c = cands.find((x) => x.d <= Math.max(40, (fix.acc || 10) * 1.5));
    if (c) return { startEdgeId: c.edge.id, label: api.edgeLabel(c.edge) };
    let best = null;
    for (const n of api.resort.nodes.values()) {
      const d = Math.hypot(n.x - fix.x, n.y - fix.y);
      if (d <= 150 && (!best || d < best.d)) best = { node: n.id, d };
    }
    return best ? { startNode: best.node, label: placeName(best.node) } : null;
  }

  function summarize(p, fromLabel, goal) {
    const L = t();
    const diffName = (api.lang() === 'ja' ? DIFF_JA : DIFF_ZH)[p.prefs.maxDifficulty] || '';
    const runs = p.edges.filter((e) => e.type === 'run' && e.ref).map((e) => api.lang() === 'ja' ? `${e.ref}番` : `${e.ref}号`);
    const via = [...new Set(runs)].slice(0, 4).join(L.sep);
    const km = api.lang() === 'ja' ? L.km(p.length) : (p.length / 1000).toFixed(1);
    const warn = p.edges.some((e) => e.open == null) ? L.warnUnknownOpen : '';
    return L.summary(fromLabel, placeName(goal), diffName, km, Math.max(1, Math.round(p.time / 60)), via, warn);
  }

  function planAndConfirm(intent) {
    const L = t();
    const dest = resolvePlace(api.resort, intent.destination);
    if (!intent.destination && !pending) return say(L.noDest(placeExamples()));
    let goal = pending?.goal;
    if (intent.destination) {
      if (!dest) return say(L.notFound(intent.destination, placeExamples()));
      if (dest.ambiguous) return say(L.ambiguous(dest.ambiguous));
      goal = dest.node;
    }
    // 起点：说了就用说的；否则用当前位置；模拟模式下用默认起点
    let start = null, fromLabel = '';
    if (intent.start) {
      const s = resolvePlace(api.resort, intent.start);
      if (!s) return say(L.notFound(intent.start, placeExamples()));
      if (s.ambiguous) return say(L.ambiguous(s.ambiguous));
      start = { startNode: s.node }; fromLabel = placeName(s.node);
    } else if (api.isNavigating() && api.currentEdge()) {
      start = { startEdgeId: api.currentEdge().id }; fromLabel = api.edgeLabel(api.currentEdge());
    } else if (api.usesGps()) {
      const loc = locateStart();
      if (!loc) return say(L.noStart);
      start = loc; fromLabel = loc.label;
    } else {
      const n = api.defaultStart();
      if (!n) return say(L.noStart);
      start = { startNode: n }; fromLabel = placeName(n);
    }
    // 条件只在规划成功后才记住，失败时不改变用户原来的设定
    const want = { ...prefs };
    if (intent.maxDifficulty) want.maxDifficulty = intent.maxDifficulty;
    if (intent.avoidFlat) want.avoidFlat = intent.avoidFlat === 'yes';
    if (intent.preferShort) want.preferShort = intent.preferShort === 'yes';
    const p = api.plan({ ...start, goalNode: goal }, want);
    if (!p.ok) {
      if (!api.isNavigating() && !intent.destination) pending = null;
      mode = api.isNavigating() ? 'navigating' : 'idle';
      return say(L.noRoute(p.reason, (p.hints || []).join('；')));
    }
    prefs = want;
    pending = { ...start, goal, prefs: { ...p.prefs }, plan: p };
    mode = 'confirming';
    return say(summarize(p, fromLabel, goal), { awaiting: true });
  }

  function say(text, extra = {}) {
    if (text) lastReply = text;
    return { say: text, mode, ...extra };
  }

  function handle(intent) {
    const L = t();
    const it = { ...EMPTY, ...(intent || {}) };
    if (it.maxDifficulty && !(it.maxDifficulty >= 1 && it.maxDifficulty <= 4)) it.maxDifficulty = 0;
    if (api.isNavigating() && mode !== 'confirming') mode = 'navigating';
    if (!api.isNavigating() && mode === 'navigating') mode = 'idle';

    switch (it.intent) {
      case 'navigate':
        return planAndConfirm(it);
      case 'confirm': {
        if (mode !== 'confirming' || !pending) return say(L.nothingToConfirm);
        const r = api.startNav(pending.plan, pending.goal, pending.prefs);
        if (!r.ok) { mode = 'idle'; return say(r.reason); }
        mode = 'navigating';
        pending = null;
        return say('', { event: 'started' }); // 导航本身会播报“开始导航，前往…”
      }
      case 'cancel':
        if (mode === 'confirming') { pending = null; mode = api.isNavigating() ? 'navigating' : 'idle'; return say(L.cancelled); }
        return say(L.cancelled);
      case 'stop':
        pending = null;
        if (!api.isNavigating()) { mode = 'idle'; return say(L.notNavigating); }
        api.stopNav(); mode = 'idle';
        return say(L.stopped, { event: 'stopped' });
      case 'pause':
        if (!api.isNavigating()) return say(L.notNavigating);
        api.pause(); return say(L.paused, { event: 'paused' });
      case 'resume':
        if (!api.isNavigating()) return say(L.notNavigating);
        api.resume(); return say(L.resumed, { event: 'resumed' });
      case 'repeat': {
        const r = api.replay() || lastReply;
        return r ? { say: r, mode } : say(L.noRepeat);
      }
      case 'distance': {
        if (!api.isNavigating()) return say(L.notNavigating);
        const s = api.snapshot();
        if (s.state === 'arrived') return say(L.arrivedAlready);
        if (s.unreliable || s.stale) return say(L.unreliable(s.unreliable || ''));
        const d = s.distToNext != null ? Math.round(s.distToNext / 10) * 10 : null;
        // 远处用预告说法（“约 N 米后分岔，靠左…”），近处用主提示
        const next = d != null && d > 60 && s.nextPreview ? s.nextPreview : (s.nextText || '');
        return say(L.distance(d, next, s.remaining != null ? L.km(s.remaining) : null));
      }
      case 'where': {
        const e = api.isNavigating() ? api.currentEdge() : null;
        if (e) return say(L.where(api.edgeLabel(e)));
        const loc = api.usesGps() ? locateStart() : null;
        return say(loc ? L.where(loc.label) : L.whereUnknown);
      }
      case 'easier': {
        const cur = (pending?.prefs || api.navPrefs() || prefs).maxDifficulty || prefs.maxDifficulty;
        if (cur <= 1) return say(L.easierNone);
        const goal = pending?.goal || api.navGoal();
        if (!goal) { prefs.maxDifficulty = cur - 1; return say(L.noDest(placeExamples())); }
        const hadPending = !!pending;
        pending = pending || { goal };
        const r = planAndConfirm({ ...EMPTY, intent: 'navigate', maxDifficulty: cur - 1 });
        if (r.mode !== 'confirming') {
          if (!hadPending) pending = null;
          return say(L.easierNoRoute((api.lang() === 'ja' ? DIFF_JA : DIFF_ZH)[cur - 1], placeName(goal)));
        }
        return r;
      }
      case 'chat':
        return say((it.reply || '').slice(0, 120) || L.unknown);
      default:
        return say(L.unknown);
    }
  }

  return {
    handle,
    get mode() { return mode; },
    get pending() { return pending; },
    get prefs() { return { ...prefs }; },
    setPrefs(p) { prefs = { ...prefs, ...p }; },
    reset() { mode = 'idle'; pending = null; }
  };
}

// 给云端大模型的系统提示：只做理解，输出意图 JSON。地点表随雪场变化，放在最后。
export function brainSystemPrompt(resort, lang) {
  const places = resort.pois.map((p) => {
    const names = [p.name, p.name_ja, ...(p.aliases || [])].filter(Boolean);
    return `- ${names.join(' / ')}`;
  }).join('\n');
  return [
    '你是“雪人”，一个滑雪语音导航伙伴的语言理解模块。用户戴着手套在雪道上，用中文或日语对手机说话（语音识别结果可能有错字）。',
    '你的唯一任务：把用户这一句话理解成一个意图 JSON。你不规划路线、不决定走哪条雪道、不给转弯指令——这些由导航程序根据地图完成。',
    '',
    '意图：',
    '- navigate：想去某地，或修改路线条件（难度、避开平路、最短）。destination 填地点表里的名称（用表里写法）；用户说了出发地才填 start。',
    '- confirm：同意/确认出发（好、走吧、可以）。cancel：不要、算了。',
    '- stop：结束导航。pause / resume：暂停 / 继续导航。',
    '- distance：问还有多远/多久。repeat：没听清、再说一遍。easier：想走更简单/轻松的路。where：问自己在哪。',
    '- chat：闲聊、打招呼、情绪表达、与导航无关的问题。reply 填一句简短友好的回复（不超过 40 字，用用户的语言），不要给任何路线或雪道建议，不要编造雪场信息。',
    '- unknown：听不懂或语音识别明显错乱。',
    '',
    '难度 maxDifficulty：1 初级（绿）、2 中级（红）、3 高级（黑/上级）、4 专家；“不走高级道”= 2，“只走初级”= 1，没提到 = 0。',
    'avoidFlat：怕平路/不想蹬/不想走路 = "yes"；preferShort：要最短最快 = "yes"；没提到 = ""。',
    '不需要的字段填空字符串或 0。只能用下面地点表里的地点；用户说的地点不在表里时，destination 原样填用户的说法（程序会追问）。',
    `当前播报语言：${lang === 'ja' ? '日语' : '中文'}。`,
    '',
    `雪场：${resort.name}`,
    '地点表：',
    places
  ].join('\n');
}
