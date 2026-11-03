// 神乐（OSM 导入）数据：能载入、能规划、能在模拟中跑通；并且没有冒充“已核实”的属性
import test from 'node:test';
import assert from 'node:assert/strict';
import { resort, runScenario, texts } from './helpers.mjs';
import { planRoute } from '../nav/planner.js';

const K = resort('kagura-osm');
const poi = (name) => K.pois.find((p) => p.name === name);

test('神乐数据：载入无错误，标注为未核实', () => {
  assert.equal(K.errors.length, 0, K.errors.join('\n'));
  assert.equal(K.dataStatus, 'unverified');
  assert.equal(K.allowRealGps, true);
  assert.ok(K.edges.size > 100);
  for (const e of K.edges.values()) {
    assert.equal(e.open, null, `${e.id} 的开放状态必须是未知`);
    for (const [k, v] of Object.entries(e.attr)) assert.notEqual(v, 'verified', `${e.id}.${k} 不能标为已核实`);
  }
});

test('神乐：从かぐら第1高速リフト下车处 滑到 かぐらゴンドラ乘车处', () => {
  const a = poi('かぐら第1高速リフト 下车处'), b = poi('かぐらゴンドラ 乘车处');
  assert.ok(a && b);
  const p = planRoute(K, { startNode: a.node, goalNode: b.node }, { maxDifficulty: 2 });
  assert.ok(p.ok, p.reason + ' ' + (p.hints || []).join(';'));
  for (const e of p.edges) if (e.type !== 'lift') assert.ok(e.difficulty <= 2);
  assert.ok(p.warnings.some((w) => w.includes('开放状态未知')));
});

test('神乐：模拟滑行能到达，且没有误报偏航', () => {
  const a = poi('かぐら第1高速リフト 下车处'), b = poi('かぐらゴンドラ 乘车处');
  const run = runScenario(K, { start: a.node, goal: b.node, prefs: { maxDifficulty: 2 }, sim: { drift: 4, seed: 3 } });
  const t = texts(run.spoken);
  assert.equal(run.nav.state, 'arrived', JSON.stringify(run.states) + '\n' + t.join('\n'));
  assert.ok(!t.some((x) => /偏离路线/.test(x)), t.join('\n'));
  // 真实地图里同名雪道会被拆成多段，不同岔口的提示文字可能相同；但同一个岔口只能播一次
  const keys = run.spoken.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, '同一指令无重复播报');
  assert.ok(!t.some((x) => x.includes('推算步行连接')), '推算的连接段不念名称');
});

test('神乐：日语播报模板', async () => {
  const { buildManeuvers, maneuverText } = await import('../nav/instructions.js');
  const a = poi('かぐら第1高速リフト 下车处'), b = poi('かぐらゴンドラ 乘车处');
  const p = planRoute(K, { startNode: a.node, goalNode: b.node }, { maxDifficulty: 2 });
  const ms = buildManeuvers(K, p.edges, b.node).filter((m) => m.announce && m.type === 'fork');
  const ja = ms.map((m) => maneuverText(m, 'main', { lang: 'ja' }));
  assert.ok(ja.every((x) => /^この先分岐/.test(x)), ja.join('\n'));
  assert.ok(ja.some((x) => x.includes('かぐらメインゲレンデ')));
});

test('神乐：田代区域内的路线', () => {
  const tops = K.pois.filter((p) => p.kind === 'lift-top' && /田代/.test(p.name));
  const bottoms = K.pois.filter((p) => p.kind === 'lift-bottom' && /田代/.test(p.name));
  let ok = 0;
  for (const a of tops) for (const b of bottoms) if (planRoute(K, { startNode: a.node, goalNode: b.node }, { maxDifficulty: 3 }).ok) ok++;
  assert.ok(ok > tops.length, `田代区域可规划的组合只有 ${ok} 个`);
});
