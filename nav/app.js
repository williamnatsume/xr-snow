// 页面逻辑：把界面、地图、模拟器 / GPS、语音和导航状态机连起来。
// 分层：
//   定位（simulator.js / position.js）→ 导航（navigator.js）→ 语音（voice.js）
//   路线规划（planner.js）和指令（instructions.js）只依赖地图数据（resort.js）

import { loadResort, edgeLabel, DIFFICULTY, ATTR_LABEL } from './resort.js';
import { planRoute, edgeTime } from './planner.js';
import { buildManeuvers, maneuverText } from './instructions.js';
import { Navigator, STATE_ZH } from './navigator.js';
import { Simulator } from './simulator.js';
import { GpsSource, WakeLock } from './position.js';
import { WebSpeechVoice, SilentVoice } from './voice.js';
import { parseRequest } from './nlp.js';
import { MapView } from './mapview.js';
import { matchFix } from './matcher.js';
import { dist } from './geo.js';

const RESORTS = [
  { id: 'demo-fictional', file: 'resorts/demo-fictional.json', label: '虚构演示雪场（测试用）' },
  { id: 'kagura-osm', file: 'resorts/kagura-osm.json', label: '神乐 かぐら（OSM 数据，未核实）' }
];
const SETTINGS_KEY = 'xrsnow.nav.v1'; // 只保存偏好设置，不保存位置

const $ = (id) => document.getElementById(id);
const fmtM = (m) => (m == null ? '—' : m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m');
const fmtMin = (s) => Math.max(1, Math.round(s / 60)) + ' 分钟';
const pad = (n) => String(n).padStart(2, '0');

/* ---------- 状态 ---------- */
const app = {
  resort: null,
  prefs: { maxDifficulty: 2, avoidFlat: false, preferShort: false },
  startNode: null, destNode: null,
  plan: null,
  nav: null,
  mode: 'sim',          // sim / gps —— 两者严格分开
  sim: null, simPlaying: false, simTimer: null, simAccum: 0,
  gps: null, gpsTimer: null, gpsAck: false, lastGpsFix: null,
  wake: new WakeLock(),
  voice: null,
  lang: 'zh',
  lastSpoken: null,
  lastRender: 0
};

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      resortId: app.resort?.id, prefs: app.prefs, lang: app.lang, voiceOn: app.voice?.enabled
    }));
  } catch { /* 忽略 */ }
}

/* ---------- 初始化 ---------- */
const map = new MapView($('map'));
const settings = loadSettings();
app.voice = (typeof speechSynthesis !== 'undefined') ? new WebSpeechVoice() : new SilentVoice();
if (settings.voiceOn === false) app.voice.enabled = false;
if (settings.prefs) Object.assign(app.prefs, settings.prefs);
app.lang = settings.lang || 'zh';
$('langSel').value = app.lang;

for (const r of RESORTS) $('resortSel').add(new Option(r.label, r.id));
$('resortSel').value = settings.resortId && RESORTS.some((r) => r.id === settings.resortId) ? settings.resortId : RESORTS[0].id;
$('resortSel').addEventListener('change', () => selectResort($('resortSel').value));
selectResort($('resortSel').value);

async function selectResort(id) {
  stopNavigation();
  const def = RESORTS.find((r) => r.id === id);
  let json;
  try {
    const res = await fetch(def.file, { cache: 'no-cache' });
    json = await res.json();
  } catch (e) {
    $('disclaimer').className = 'banner bad';
    $('disclaimer').textContent = `无法载入地图文件 ${def.file}：${e.message}。请用 npm start（本地服务器）或 GitHub Pages 打开本页面，直接双击 HTML 无法读取 JSON。`;
    return;
  }
  const r = loadResort(json);
  if (r.errors.length) {
    $('disclaimer').className = 'banner bad';
    $('disclaimer').textContent = '地图数据有错误：' + r.errors.join('；');
    return;
  }
  app.resort = r;
  saveSettings();

  // 数据可信度标识
  const badge = $('dataBadge');
  badge.className = 'badge ' + r.dataStatus;
  badge.textContent = { fictional: '虚构 · 不可用于真实导航', unverified: '未核实数据', verified: '已核实' }[r.dataStatus] || r.dataStatus;
  $('disclaimer').className = 'banner ' + (r.dataStatus === 'fictional' ? 'bad' : 'warn');
  $('disclaimer').textContent = (r.dataStatus === 'fictional' ? '⚠ ' : '⚠ ') + r.disclaimer;
  $('mapTitle').textContent = r.dataStatus === 'fictional' ? '示意图（虚构演示雪场，坐标为编造的米制坐标）' : `示意图 · ${r.name}`;
  $('mapNote').textContent = r.crs === 'wgs84'
    ? `数据：${r.provenance.source}；${r.provenance.license}；高程：${r.provenance.elevation || '—'}；导入日期 ${r.provenance.retrieved}`
    : '虚构雪场使用局部米制坐标，不对应任何真实经纬度。';

  // 起点 / 目的地选项
  fillPlaceSelect($('startSel'), r, true);
  fillPlaceSelect($('destSel'), r, false);
  const defaults = r.id === 'demo-fictional'
    ? { start: 'S', dest: 'REST' }
    : { start: r.pois.find((p) => p.name === 'かぐら第1高速リフト 下车处')?.node, dest: r.pois.find((p) => p.name === 'かぐらゴンドラ 乘车处')?.node };
  if (defaults.start) $('startSel').value = defaults.start;
  if (defaults.dest) $('destSel').value = defaults.dest;
  app.startNode = $('startSel').value; app.destNode = $('destSel').value;

  // 日文雪道名需要日语播报
  const kana = [...r.edges.values()].some((e) => /[ぁ-んァ-ン]/.test(e.name || ''));
  $('voiceNote').textContent = kana && app.lang === 'zh' ? '这个雪场的雪道名是日文，中文语音读不出假名，建议把播报语言切换为“日本語”。' : '';

  setMode(r.allowRealGps ? app.mode : 'sim');
  map.setResort(r);
  app.plan = null;
  renderPlan();
  renderDataInfo();
  render(true);
}

function fillPlaceSelect(sel, r, isStart) {
  sel.innerHTML = '';
  const groups = new Map();
  const kindZh = { 'lift-top': '缆车下车处 / 山顶', 'lift-bottom': '缆车乘车处', restaurant: '餐厅', station: '站点', poi: '地点' };
  for (const p of r.pois) {
    const k = kindZh[p.kind] || '其他';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  if (isStart && r.id === 'demo-fictional') {
    // 虚构雪场：岔口也可以作为起点，方便测试
    groups.set('岔口', [...r.nodes.values()].filter((n) => n.kind === 'junction').map((n) => ({ node: n.id, name: n.name })));
  }
  for (const [k, ps] of groups) {
    const g = document.createElement('optgroup');
    g.label = k;
    for (const p of ps.sort((a, b) => a.name.localeCompare(b.name, 'ja'))) g.appendChild(new Option(p.name, p.node));
    sel.appendChild(g);
  }
}

/* ---------- 规划 ---------- */

function syncPrefsUI() {
  document.querySelectorAll('#diffBtns button').forEach((b) => b.classList.toggle('on', Number(b.dataset.d) === app.prefs.maxDifficulty));
  $('avoidFlat').checked = !!app.prefs.avoidFlat;
  $('preferShort').checked = !!app.prefs.preferShort;
}
syncPrefsUI();
document.querySelectorAll('#diffBtns button').forEach((b) => b.addEventListener('click', () => { app.prefs.maxDifficulty = Number(b.dataset.d); syncPrefsUI(); saveSettings(); }));
$('avoidFlat').addEventListener('change', (e) => { app.prefs.avoidFlat = e.target.checked; saveSettings(); });
$('preferShort').addEventListener('change', (e) => { app.prefs.preferShort = e.target.checked; saveSettings(); });
$('startSel').addEventListener('change', (e) => { app.startNode = e.target.value; });
$('destSel').addEventListener('change', (e) => { app.destNode = e.target.value; });
$('planBtn').addEventListener('click', () => doPlan());

$('parseBtn').addEventListener('click', () => {
  const r = parseRequest($('nlInput').value, app.resort);
  const chips = [];
  for (const u of r.understood) chips.push(`<span class="chip ok">✓ ${esc(u)}</span>`);
  for (const a of r.ambiguous) chips.push(`<span class="chip warn">? ${esc(a)}</span>`);
  for (const n of r.notUnderstood) chips.push(`<span class="chip bad">没理解：“${esc(n)}”</span>`);
  if (!r.ok && !r.ambiguous.length) chips.unshift('<span class="chip bad">没有识别出任何条件，请直接在下面选择</span>');
  $('parseResult').innerHTML = `<div class="parsed">${chips.join('')}</div>` +
    (r.ok ? '<p class="muted">已填入下面的选项，可以再修改；点“规划路线”后才会生效。</p>' : '');
  if (r.start) { $('startSel').value = r.start.node; app.startNode = r.start.node; }
  if (r.destination) { $('destSel').value = r.destination.node; app.destNode = r.destination.node; }
  if (r.maxDifficulty != null) app.prefs.maxDifficulty = r.maxDifficulty;
  if (r.avoidFlat != null) app.prefs.avoidFlat = r.avoidFlat;
  if (r.preferShort != null) app.prefs.preferShort = r.preferShort;
  syncPrefsUI();
});

function doPlan({ startEdgeId = null } = {}) {
  const r = app.resort;
  if (!r) return;
  app.plan = planRoute(r, startEdgeId ? { startEdgeId, goalNode: app.destNode } : { startNode: app.startNode, goalNode: app.destNode }, app.prefs);
  app.plan.destNode = app.destNode;
  renderPlan();
  render(true);
}

function renderPlan() {
  const p = app.plan, box = $('planResult');
  map.setRoute(p?.ok ? p.edges : null);
  map.setMarks({ dest: p?.ok ? p.destNode : null });
  renderAttrTable();
  if (!p) { box.innerHTML = ''; return; }
  if (!p.ok) {
    box.innerHTML = `<div class="banner bad" style="margin-top:10px">${esc(p.reason)}${p.hints?.length ? '<br>' + p.hints.map(esc).join('<br>') : ''}</div>`;
    return;
  }
  const ms = buildManeuvers(app.resort, p.edges, p.destNode).filter((m) => m.announce && m.type !== 'arrive');
  const steps = p.edges.map((e) => {
    const color = e.type === 'lift' ? 'var(--lift)' : e.type === 'connector' ? 'var(--connector)' : (DIFFICULTY[e.difficulty]?.color || 'var(--run-unknown)');
    const tags = [];
    if (e.type === 'lift') tags.push('乘坐缆车');
    else if (e.difficulty) tags.push(DIFFICULTY[e.difficulty].zh);
    if (e.flat === true) tags.push('平路');
    if (e.open == null) tags.push('开放状态未知');
    if (e.attr?.geometry === 'derived') tags.push('推算连接');
    return `<li><span class="dot" style="background:${color}"></span><span>${esc(edgeLabel(e))}<div class="meta">${tags.join(' · ')}</div></span><span class="meta">${fmtM(e.length)}</span></li>`;
  }).join('');
  box.innerHTML = `
    <div class="summary"><span>${fmtM(p.length)}</span><span>约 ${fmtMin(p.time)}</span><span>缆车 ${p.liftCount} 次</span><span>最难：${DIFFICULTY[p.maxDiff]?.zh || '—'}</span></div>
    ${p.warnings.map((w) => `<div class="banner warn" style="margin:6px 0">${esc(w)}</div>`).join('')}
    <ol class="steps">${steps}</ol>
    <p class="muted" style="margin-top:10px">将播报的岔口指令（${ms.length} 条）：<br>${ms.map((m) => '· ' + esc(maneuverText(m, 'main', { lang: app.lang }))).join('<br>')}</p>`;
}

/* ---------- 导航控制 ---------- */

$('startBtn').addEventListener('click', () => startNavigation());
$('pauseBtn').addEventListener('click', () => {
  const nav = app.nav; if (!nav) return;
  const now = clockNow();
  if (nav.state === 'paused') { nav.resume(now); $('pauseBtn').textContent = '暂停'; }
  else { nav.pause(now); $('pauseBtn').textContent = '继续'; }
  render(true);
});
$('stopBtn').addEventListener('click', () => { stopNavigation(); render(true); });

function startNavigation() {
  if (!app.plan?.ok) { doPlan(); if (!app.plan?.ok) { flash('请先规划出一条可用路线', true); return; } }
  if (app.mode === 'gps') {
    if (!app.resort.allowRealGps) { flash('这个地图不允许真实 GPS 导航', true); return; }
    if (!$('gpsAck').checked) { flash('请先勾选“我知道数据未核实”', true); return; }
  }
  stopNavigation(true);
  app.nav = new Navigator(app.resort, {
    lang: app.lang,
    onSpeak: (item) => onSpeak(item)
  });
  const now = clockNow();
  if (app.mode === 'sim') {
    const sim = new Simulator(app.resort, { drift: Number($('simDrift').value), carve: $('simCarve').checked, skierFactor: Number($('simSkier').value), seed: Date.now() % 100000 });
    sim.setPath(app.plan.edges);
    sim.follow = (node) => (app.nav?.route || []).slice(app.nav.idx).find((e) => e.from === node) || null;
    app.sim = sim;
    app.nav.start({ route: app.plan, destNode: app.plan.destNode, prefs: app.prefs }, 0);
    setSimPlaying(true);
  } else {
    app.nav.start({ route: app.plan, destNode: app.plan.destNode, prefs: app.prefs }, now);
    ensureGps();
    app.wake.request();
    app.gpsTimer = setInterval(() => { app.nav?.tick(Date.now()); render(); }, 1000);
  }
  $('pauseBtn').disabled = false; $('stopBtn').disabled = false; $('pauseBtn').textContent = '暂停';
  map.follow = app.resort.edges.size > 40; // 大雪场默认跟随位置
  render(true);
}

function stopNavigation(keepGps = false) {
  if (app.nav) app.nav.stop(clockNow());
  app.nav = null;
  setSimPlaying(false);
  app.sim = null;
  clearInterval(app.gpsTimer); app.gpsTimer = null;
  if (!keepGps && app.gps?.running) app.gps.stop();
  app.wake.release();
  app.voice?.cancel();
  $('pauseBtn').disabled = true; $('stopBtn').disabled = true;
}

function clockNow() { return app.mode === 'sim' ? (app.sim?.t ?? 0) : Date.now(); }

/* ---------- 语音 ---------- */

function onSpeak(item) {
  app.lastSpoken = item;
  let spoke = false;
  if (item.voice !== false) spoke = app.voice.speak(item.text, app.lang);
  flash(item.text, !spoke && item.voice !== false, item.reason);
}

function flash(text, loud = false, reason = '') {
  const f = $('flash');
  f.className = 'show' + (loud ? ' loud' : '');
  f.innerHTML = `${loud ? '🔇 ' : '🔊 '}${esc(text)}${reason ? `<small>${esc(reason)}</small>` : ''}`;
}

$('testVoiceBtn').addEventListener('click', () => {
  const ok = app.voice.test(app.lang);
  if (!ok) flash(app.voice.enabled ? '此浏览器不支持语音合成，导航时会只显示文字' : '语音已关闭', true);
  else flash(app.voice.hasVoiceFor?.(app.lang) ? '正在播放测试语音' : '正在播放（未找到该语言的专用语音，发音可能不准）');
});
$('muteBtn').addEventListener('click', () => {
  app.voice.enabled = !app.voice.enabled;
  if (!app.voice.enabled) app.voice.cancel();
  renderVoiceBtn(); saveSettings();
});
function renderVoiceBtn() {
  $('muteBtn').textContent = app.voice.enabled ? '语音：开' : '语音：关';
  $('muteBtn').classList.toggle('on', app.voice.enabled);
}
renderVoiceBtn();
$('langSel').addEventListener('change', (e) => {
  app.lang = e.target.value; saveSettings();
  if (app.nav) flash('播报语言将在下次开始导航时生效');
  renderPlan();
});
$('replayBtn').addEventListener('click', () => {
  const snap = app.nav?.snapshot(clockNow());
  if (!snap) { flash('还没有开始导航'); return; }
  // 只重播可靠的指令；定位不可靠时说明原因，不重复旧指令
  if (snap.nextText && snap.distToNext != null) {
    const t = snap.distToNext > 60 ? `${app.lang === 'ja' ? '' : '约' + (Math.round(snap.distToNext / 10) * 10) + '米后，'}${snap.nextText}` : snap.nextText;
    app.voice.speak(t, app.lang); flash(t, !app.voice.enabled, '重播');
  } else {
    const t = snap.unreliable ? `定位不可靠（${snap.unreliable}），暂无可靠指令` : snap.state === 'offRoute' ? '可能偏离路线，请在安全位置停下查看地图' : '当前没有下一条指令';
    app.voice.speak(t, 'zh'); flash(t, !app.voice.enabled, '重播');
  }
});

/* ---------- 模拟器 ---------- */

$('tabSim').addEventListener('click', () => setMode('sim'));
$('tabGps').addEventListener('click', () => setMode('gps'));

function setMode(m) {
  if (m === app.mode && app.resort) { /* 刷新界面 */ }
  if (m !== app.mode) stopNavigation();
  app.mode = m;
  $('tabSim').classList.toggle('on', m === 'sim');
  $('tabGps').classList.toggle('on', m === 'gps');
  $('simPanel').classList.toggle('hidden', m !== 'sim');
  $('gpsPanel').classList.toggle('hidden', m !== 'gps');
  const r = app.resort;
  const blocked = r && !r.allowRealGps;
  $('gpsBlocked').classList.toggle('hidden', !blocked);
  $('gpsAllowed').classList.toggle('hidden', !!blocked);
  if (blocked) $('gpsBlocked').textContent = '当前是虚构演示雪场：真实 GPS 不能套用虚构地图导航。请切换到真实雪场数据（例如“神乐”），或使用模拟器。';
  if (r && r.allowRealGps) $('gpsWarn').textContent = r.disclaimer;
  if (m !== 'gps' && app.gps?.running) app.gps.stop();
}

$('simPlay').addEventListener('click', () => {
  if (!app.nav || app.mode !== 'sim') { startNavigation(); return; }
  setSimPlaying(!app.simPlaying);
});
$('simReset').addEventListener('click', () => { stopNavigation(); startNavigation(); setSimPlaying(false); render(true); });
$('simDrift').addEventListener('input', (e) => { $('simDriftVal').textContent = e.target.value + ' m'; if (app.sim) app.sim.drift = Number(e.target.value); });
$('simSkier').addEventListener('input', (e) => { $('simSkierVal').textContent = Number(e.target.value).toFixed(1) + '×'; if (app.sim) app.sim.skierFactor = Number(e.target.value); });
$('simCarve').addEventListener('change', (e) => { if (app.sim) app.sim.carve = e.target.checked; });
$('simOutage').addEventListener('click', () => { if (!app.sim) return; app.sim.startOutage(20); flash('模拟：接下来 20 秒没有任何定位'); });
$('simWrong').addEventListener('click', () => {
  if (!app.sim) return;
  const w = app.sim.takeWrongBranchAtNextFork();
  flash(w ? `模拟：将在 ${app.resort.nodes.get(w.atNode)?.name || w.atNode} 走错，进入 ${edgeLabel(app.resort.edges.get(w.edge))}` : '前方没有可以走错的岔口');
});

function setSimPlaying(on) {
  app.simPlaying = on;
  $('simPlay').textContent = on ? '❚❚ 暂停模拟' : '▶ 播放';
  clearInterval(app.simTimer); app.simTimer = null;
  if (!on) return;
  app.simTimer = setInterval(() => {
    const sim = app.sim, nav = app.nav;
    if (!sim || !nav) return;
    app.simAccum += 0.1 * Number($('simRate').value);
    while (app.simAccum >= 1) {
      app.simAccum -= 1;
      const fix = sim.step(1);
      if (fix) nav.onFix(fix);
      nav.tick(sim.t);
    }
    render();
    if (nav.state === 'arrived' || (sim.done && sim.t > 0 && nav.state !== 'passing')) {
      if (sim.done) setSimPlaying(false);
    }
  }, 100);
}

/* ---------- 真实 GPS ---------- */

function ensureGps() {
  if (!app.gps) {
    app.gps = new GpsSource(app.resort, {
      onFix: (fix) => {
        app.lastGpsFix = fix;
        if (app.nav && app.mode === 'gps') app.nav.onFix(fix);
        render();
      },
      onStatus: (s) => {
        if (s.error) $('gpsStatus').textContent = '定位：' + s.error;
        else if (s.started) $('gpsStatus').textContent = '定位已开启，等待信号…';
      }
    });
  }
  app.gps.resort = app.resort;
  app.gps.start();
}
$('gpsStartBtn').addEventListener('click', () => { ensureGps(); app.wake.request(); });
$('gpsHereBtn').addEventListener('click', () => {
  ensureGps();
  const f = app.lastGpsFix;
  if (!f || Date.now() - f.t > 10000) { flash('还没有新的定位，请稍等几秒再点', true); return; }
  if (f.acc > 25) { flash(`当前定位误差 ±${Math.round(f.acc)} m，太大，暂不确定起点`, true); return; }
  const cands = matchFix(app.resort, f, { heading: null, moving: false, prevEdge: null });
  // 先找最近的节点（缆车站等），再考虑所在雪道
  let nearest = null;
  for (const n of app.resort.nodes.values()) { const d = dist(n, f); if (!nearest || d < nearest.d) nearest = { n, d }; }
  if (nearest && nearest.d <= 60) {
    app.startNode = nearest.n.id;
    flash(`起点：离你最近的节点（约 ${Math.round(nearest.d)} m）`);
    doPlan();
  } else if (cands[0]) {
    flash(`起点：你所在的 ${edgeLabel(cands[0].edge)}（向下坡方向）`);
    doPlan({ startEdgeId: cands[0].edge.id });
  } else {
    flash('你的位置不在这个雪场的雪道数据附近', true);
  }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && app.wake.want) app.wake.request(); });

/* ---------- 渲染 ---------- */

function render(force = false) {
  const nowMs = performance.now();
  if (!force && nowMs - app.lastRender < 200) return;
  app.lastRender = nowMs;
  const nav = app.nav;
  const now = clockNow();
  const destPoi = app.plan?.ok ? app.resort.pois.find((p) => p.node === app.plan.destNode) : null;
  $('destName').textContent = destPoi?.name || app.resort?.nodes.get(app.destNode)?.name || '—';

  if (!nav) {
    $('instr').className = 'dim';
    $('instr').textContent = app.plan?.ok ? '点“开始导航”' : '规划路线后开始导航';
    $('dist').textContent = '—'; $('distLabel').textContent = '';
    setChip('stateChip', '未开始', '');
    setChip('gpsChip', app.mode === 'sim' ? '定位：模拟器' : (app.lastGpsFix ? `定位 ±${Math.round(app.lastGpsFix.acc)} m` : '定位：未开启'), '');
    setChip('speedChip', '— km/h', '');
    map.setPosition({ fix: app.mode === 'gps' ? app.lastGpsFix : null });
    renderDebug(null, now);
    return;
  }

  const snap = nav.snapshot(now);
  // 主指令
  let instr = '', dim = false;
  if (snap.state === 'arrived') instr = `已到达 ${destPoi?.name || ''}`;
  else if (snap.state === 'paused') { instr = '已暂停'; dim = true; }
  else if (snap.state === 'offRoute') instr = '可能偏离路线，请在安全位置停下查看地图';
  else if (snap.unreliable) { instr = `定位不可靠（${snap.unreliable}）：暂停转弯提示`; dim = true; }
  else if (snap.stationary) { instr = '静止中，暂不判断方向'; dim = true; }
  else if (snap.ambiguous) { instr = '暂时无法确定所在雪道，请留意路牌'; dim = true; }
  else if (snap.nextText) instr = snap.nextText;
  $('instr').className = dim ? 'dim' : '';
  $('instr').textContent = instr;
  if (snap.state === 'passing') { $('dist').textContent = '通过中'; $('distLabel').textContent = '正在确认进入的分支'; }
  else if (snap.distToNext != null && snap.state !== 'arrived') {
    $('dist').textContent = fmtM(snap.distToNext);
    $('distLabel').textContent = (snap.next?.type === 'arrive' ? '到目的地' : '到下一个岔口') + (snap.remaining != null ? ` · 全程剩余 ${fmtM(snap.remaining)}` : '');
  } else { $('dist').textContent = '—'; $('distLabel').textContent = snap.state === 'arrived' ? '' : '定位不可靠时不显示距离'; }

  const stCls = { navigating: 'ok', approaching: 'warn', passing: 'warn', passed: 'ok', offRoute: 'bad', unreliable: 'bad', arrived: 'ok', paused: '' }[snap.state] || '';
  setChip('stateChip', snap.stateZh + (snap.unreliable ? '：' + snap.unreliable : ''), stCls);
  const accTxt = snap.acc != null ? `±${Math.round(snap.acc)} m` : '—';
  const age = snap.ageMs != null ? Math.round(snap.ageMs / 1000) : null;
  setChip('gpsChip', snap.stale ? `定位过期 ${age} s` : `定位 ${accTxt}${app.mode === 'sim' ? '（模拟）' : ''}`, snap.stale || (snap.acc ?? 99) > 25 ? 'bad' : (snap.acc ?? 99) > 15 ? 'warn' : 'ok');
  setChip('speedChip', snap.speed != null ? `${(snap.speed * 3.6).toFixed(0)} km/h${snap.stationary ? ' · 静止' : ''}` : '— km/h', '');

  // 地图
  if (snap.route !== map._route) { map.setRoute(snap.route); map._route = snap.route; }
  map.setMarks({ next: snap.next && snap.next.type !== 'arrive' ? snap.next : null, dest: app.plan?.destNode });
  map.setPosition({ fix: snap.fix && !snap.stale ? snap.fix : snap.fix, stale: snap.stale, truth: app.mode === 'sim' ? app.sim?.lastTruth || snap.fix?.truth : null });

  if (app.mode === 'sim' && app.sim) {
    const sim = app.sim;
    $('simStatus').textContent = `模拟时间 ${fmtClock(sim.t, true)} · 真实位置在 ${edgeLabel(app.resort.edges.get(sim.path[sim.k]?.id))}${sim.inOutage ? ' · 定位中断中' : ''}${sim.wrongTaken ? ' · 已安排走错分支' : ''}${sim.done ? ' · 模拟结束' : ''}`;
  }
  renderDebug(snap, now);
}

function setChip(id, text, cls) { const c = $(id); c.textContent = text; c.className = 'chip ' + cls; }
function fmtClock(t, sim = app.mode === 'sim') {
  if (sim) { const s = Math.floor(t / 1000); return `T+${pad(Math.floor(s / 60))}:${pad(s % 60)}`; }
  const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let lastLogLen = -1;
function renderDebug(snap, now) {
  if (!$('debug').open) return;
  const kv = [];
  if (snap) {
    kv.push(['状态', `${snap.stateZh}${snap.unreliable ? '（' + snap.unreliable + '）' : ''}`]);
    kv.push(['当前路段', snap.route ? `${snap.idx + 1}/${snap.route.length} ${edgeLabel(snap.route[snap.idx])}，已滑 ${Math.round(snap.s)} / ${Math.round(snap.route[snap.idx].length)} m` : '—']);
    kv.push(['匹配到', snap.matched ? `${edgeLabel(snap.matched.edge)} s=${Math.round(snap.matched.s ?? 0)}` : '—']);
    kv.push(['候选', snap.candidates.map((c) => `${c.edge.ref || c.edge.id} d=${c.d.toFixed(0)} Δ=${c.headingDelta == null ? '—' : c.headingDelta.toFixed(0) + '°'} 分=${c.score.toFixed(2)}`).join('；') || '无']);
    kv.push(['速度 / 方向', `${snap.speed != null ? (snap.speed * 3.6).toFixed(1) + ' km/h' : '—'} / ${snap.heading != null ? snap.heading.toFixed(0) + '°' : '—（位移不足 35 m）'}${snap.stationary ? ' · 静止' : ''}`]);
    kv.push(['定位', `误差 ${snap.acc != null ? '±' + Math.round(snap.acc) + ' m' : '—'}，${snap.ageMs != null ? (snap.ageMs / 1000).toFixed(1) + ' s 前' : '—'}${snap.stale ? '（已过期）' : ''}`]);
    if (snap.timing) kv.push(['播报时机', `距 ${Math.round(snap.timing.d)} m；按 ${(snap.timing.v * 3.6).toFixed(0)} km/h、语音 ${snap.timing.tSpeech.toFixed(1)} s → 主提示 ${Math.round(snap.timing.main)} m，预告 ${Math.round(snap.timing.pre)} m（初始值，待实测）`]);
    if (snap.passing) {
      const L = snap.passing.last;
      kv.push(['通过确认', `${snap.passing.m.nodeId}：正确 ${snap.passing.correct} / 错误 ${snap.passing.wrong}${L ? `；距预期 ${L.dExp.toFixed(0)} m，距其他 ${isFinite(L.dAltMin) ? L.dAltMin.toFixed(0) : '—'} m，需拉开 ${L.sepNeeded.toFixed(0)} m` : ''}`]);
    }
  } else kv.push(['状态', '未开始']);
  $('dbgKv').innerHTML = kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  const log = snap?.log || [];
  if (log.length !== lastLogLen) {
    lastLogLen = log.length;
    $('logBody').innerHTML = log.slice().reverse().map((l) => `<tr class="${l.type}"><td class="t">${fmtClock(l.t)}</td><td>${{ speak: '语音', text: '文字', state: '状态', info: '信息', suppressed: '已抑制' }[l.type] || l.type}</td><td>${esc(l.text)}</td><td>${esc(l.reason || '')}</td></tr>`).join('');
  }
}

function renderAttrTable() {
  const p = app.plan;
  const lab = (e, k) => `${ATTR_LABEL[e.attr?.[k]] || '未标注'}`;
  $('attrBody').innerHTML = p?.ok ? p.edges.map((e) => `<tr><td>${esc(edgeLabel(e))}</td>
    <td>${e.type === 'lift' ? '—' : (DIFFICULTY[e.difficulty]?.zh || '未知')}<br><span class="muted">${lab(e, 'difficulty')}</span></td>
    <td>${e.open === true ? '开放' : e.open === false ? '关闭' : '未知'}<br><span class="muted">${lab(e, 'open')}</span></td>
    <td>${e.type === 'lift' ? '—' : e.flat === true ? '是' : e.flat === false ? '否' : '未知'}<br><span class="muted">${lab(e, 'flat')}</span></td>
    <td><span class="muted">${lab(e, 'direction')}</span></td>
    <td><span class="muted">${lab(e, 'geometry')}</span></td></tr>`).join('') : '';
}

function renderDataInfo() {
  const r = app.resort;
  const rep = r.importReport;
  const kv = [
    ['名称', r.name], ['数据状态', { fictional: '虚构', unverified: '未核实', verified: '已核实' }[r.dataStatus]],
    ['真实 GPS 导航', r.allowRealGps ? '允许（需确认数据未核实）' : '不允许'],
    ['来源', `${r.provenance.source || '—'} / ${r.provenance.license || '—'}`],
    ['规模', `节点 ${r.nodes.size}，路段 ${r.edges.size}，目的地 ${r.pois.length}`]
  ];
  if (r.warnings.length) kv.push(['数据警告', r.warnings.join('；')]);
  if (rep) {
    kv.push(['导入：跳过', rep.skipped.map((s) => `${s[1] || s[0]}（${s[2]}）`).join('；') || '无']);
    kv.push(['导入：推算连接', `${rep.derivedJoins.length} 处雪道端点吸附；${rep.liftLinks.filter((l) => l.linked).length} 处缆车站步行连接；未连接：${rep.liftLinks.filter((l) => !l.linked).map((l) => `${l.lift}(${l.end === 'toLift' ? '乘车处' : '下车处'})`).join('、') || '无'}`]);
    kv.push(['导入：方向矛盾', rep.directionConflicts.length ? rep.directionConflicts.map((c) => c.name || c.id).join('、') : '无（按国土地理院高程检查）']);
  }
  $('dataKv').innerHTML = kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}
$('debug').addEventListener('toggle', () => { lastLogLen = -1; render(true); });

/* ---------- 地图控制 ---------- */
$('zoomIn').addEventListener('click', () => map.zoom(1 / 1.4));
$('zoomOut').addEventListener('click', () => map.zoom(1.4));
$('zoomFit').addEventListener('click', () => { map.follow = false; map.fit(); });
$('zoomFollow').addEventListener('click', () => {
  map.follow = true;
  const v = map.view; const target = Math.min(v.w, 900 * (map.unit || 1));
  if (v.w > target) map.zoom(target / v.w);
  render(true);
});

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// 供调试
window.__app = app;
