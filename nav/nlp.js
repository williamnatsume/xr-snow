// 自然语言需求 → 结构化条件（本地规则，不调用任何 AI 服务）
// 只输出“条件”：起点、目的地、难度上限、避开平路、优先短路线。
// 不会、也不能决定具体走哪条雪道或怎么转弯——那由路线规划和地图数据决定。
// 将来接入大模型时，也必须输出同样的结构，再交给规划器。

const DIFF_WORDS = [
  // [正则, 难度上限, 说明]
  [/(只|仅)(走|滑)?(初级|绿道|新手|入门|简单)/, 1, '只走初级道'],
  [/(新手|初学|刚学|第一次滑)/, 1, '初学者 → 只走初级道'],
  [/(不|别|不要|避开|不想)(走|滑|去)?(中级|红道)/, 1, '不走中级道'],
  [/(不|别|不要|避开|不想)(走|滑|去)?(高级|黑道|上级|难的|陡的|陡坡)/, 2, '不走高级道'],
  [/(不|别|不要|避开|不想)(走|滑|去)?(专家|超高级|野雪|树林)/, 3, '不走专家级道'],
  [/(只|仅)(走|滑)?(中级|红道)/, 2, '最高中级道'],
  [/(可以|能|想|要)(走|滑)?(高级|黑道|上级)/, 3, '允许高级道'],
  [/(什么都行|都可以|随便|不限难度|专家级也行)/, 4, '不限难度']
];
const FLAT_WORDS = /(蹬|推着走|推着|走路|走着|平路|平地|平的|撑杖|划着走|单板.*平|不想.*走)/;
const SHORT_WORDS = /(最短|最近|近一点|快点|尽快|抄近路|直接|赶时间)/;
const FAST_WORDS = /(最快|省时间)/;

function normalize(s) {
  return (s || '').replace(/\s+/g, '').replace(/[，,。.！!？?、；;]/g, '，');
}

// 在文本中找出所有目的地名称/别名出现的位置
function findPlaces(text, resort) {
  const hits = [];
  for (const p of resort.pois) {
    for (const name of [p.name, ...(p.aliases || [])]) {
      if (!name) continue;
      let i = text.indexOf(name);
      while (i >= 0) { hits.push({ poi: p, name, at: i, len: name.length }); i = text.indexOf(name, i + 1); }
    }
  }
  // 同一位置只保留最长的匹配（“山脚餐厅”优先于“山脚”）
  hits.sort((a, b) => a.at - b.at || b.len - a.len);
  const out = [];
  for (const h of hits) {
    if (out.some((o) => h.at >= o.at && h.at + h.len <= o.at + o.len && !(o.at === h.at && o.len === h.len))) continue;
    out.push(h);
  }
  return out;
}

export function parseRequest(input, resort) {
  const text = normalize(input);
  const result = {
    input,
    start: null, destination: null,
    maxDifficulty: null, avoidFlat: null, preferShort: null,
    understood: [], notUnderstood: [], ambiguous: [],
    ok: false
  };
  if (!text) { result.notUnderstood.push('（空）'); return result; }

  // 地点：“从 X / 在 X” = 起点，“去 / 到 / 回 / 前往 X” 或其他 = 目的地
  const places = findPlaces(text, resort);
  const used = [];
  const groups = new Map(); // 同一位置出现的多个候选（别名冲突）
  for (const h of places) {
    const k = h.at + ':' + h.len;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }
  for (const hs of groups.values()) {
    const h = hs[0];
    const before = text.slice(Math.max(0, h.at - 3), h.at);
    const role = /(从|在|由)$/.test(before) || /^(出发|开始)/.test(text.slice(h.at + h.len, h.at + h.len + 2)) ? 'start' : 'destination';
    const uniq = [...new Set(hs.map((x) => x.poi))];
    used.push([h.at, h.at + h.len]);
    if (uniq.length > 1) {
      result.ambiguous.push(`“${h.name}”可能指：${uniq.map((p) => p.name).join(' / ')}，请在下面选择`);
      continue;
    }
    if (role === 'start') { result.start = uniq[0]; result.understood.push(`起点：${uniq[0].name}`); }
    else if (!result.destination) { result.destination = uniq[0]; result.understood.push(`目的地：${uniq[0].name}`); }
    else result.ambiguous.push(`提到了多个目的地（${result.destination.name}、${uniq[0].name}），先用第一个`);
  }

  // 难度：取所有命中规则里最严格的上限
  for (const [re, level, label] of DIFF_WORDS) {
    const m = re.exec(text);
    if (!m) continue;
    used.push([m.index, m.index + m[0].length]);
    if (result.maxDifficulty == null || level < result.maxDifficulty) result.maxDifficulty = level;
    result.understood.push(label);
  }
  const flat = FLAT_WORDS.exec(text);
  if (flat) { result.avoidFlat = true; used.push([flat.index, flat.index + flat[0].length]); result.understood.push('尽量避开平路'); }
  const short = SHORT_WORDS.exec(text) || FAST_WORDS.exec(text);
  if (short) { result.preferShort = true; used.push([short.index, short.index + short[0].length]); result.understood.push('优先短路线'); }

  // 没被任何规则覆盖的片段 → 明确列出“没理解”
  const FILLER = /^(我|我要|我想|想|要|请|帮我|麻烦|一下|吧|呢|啊|哦|嗯|去|到|回|前往|从|出发|然后|再|和|并且|而且|但是|不过|尽量|最好|让我|给我|的|了|走|滑|路线|一条|条)+$/;
  for (const part of text.split('，')) {
    if (!part) continue;
    const start = text.indexOf(part);
    const covered = used.some(([a, b]) => a < start + part.length && b > start);
    if (!covered && !FILLER.test(part)) result.notUnderstood.push(part);
  }
  result.ok = result.understood.length > 0;
  return result;
}
