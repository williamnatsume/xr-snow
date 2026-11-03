import test from 'node:test';
import assert from 'node:assert/strict';
import { resort } from './helpers.mjs';
import { parseRequest } from '../nav/nlp.js';

const R = resort('demo-fictional');

test('示例句：去山脚餐厅，不走高级道，尽量别让我蹬着走', () => {
  const r = parseRequest('去山脚餐厅，不走高级道，尽量别让我蹬着走。', R);
  assert.equal(r.destination?.name, '山脚餐厅');
  assert.equal(r.maxDifficulty, 2);
  assert.equal(r.avoidFlat, true);
  assert.equal(r.notUnderstood.length, 0, r.notUnderstood.join('|'));
});

test('起点和目的地', () => {
  const r = parseRequest('从山腰站出发去缆车站，最短的路', R);
  assert.equal(r.start?.name, '山腰站');
  assert.equal(r.destination?.name, '山脚缆车站');
  assert.equal(r.preferShort, true);
});

test('有歧义的地名会提示选择，而不是猜', () => {
  const r = parseRequest('去山脚', R);
  assert.equal(r.destination, null);
  assert.ok(r.ambiguous.length === 1 && r.ambiguous[0].includes('山脚餐厅') && r.ambiguous[0].includes('山脚缆车站'));
});

test('无法理解的内容明确列出', () => {
  const r = parseRequest('带我去看日落，顺便找个厕所', R);
  assert.equal(r.ok, false);
  assert.ok(r.notUnderstood.length >= 1);
  const r2 = parseRequest('只走初级道，去餐厅，避开那个有很多石头的地方', R);
  assert.equal(r2.maxDifficulty, 1);
  assert.equal(r2.destination?.name, '山脚餐厅');
  assert.ok(r2.notUnderstood.some((x) => x.includes('石头')), r2.notUnderstood.join('|'));
});
