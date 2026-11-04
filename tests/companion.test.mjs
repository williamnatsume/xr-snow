// “雪人”对话：本地规则理解 + 对话流程（规划 → 确认 → 导航中问答）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, resort } from './helpers.mjs';
import { rulesIntent, resolvePlace, stripWake, hasWake, brainSystemPrompt } from '../nav/companion.js';
import { createSession } from '../nav/core-entry.js';

const R = resort('demo-fictional');
const demoText = fs.readFileSync(path.join(ROOT, 'resorts/demo-fictional.json'), 'utf8');

function session() {
  const s = createSession(demoText);
  s.configure('sim', 'S', 3);
  const talk = (text) => JSON.parse(s.converse(s.understandLocal(text), 0));
  const talkIntent = (intent) => JSON.parse(s.converse(JSON.stringify(intent), 0));
  const run = (sec) => { for (let i = 0; i < sec; i++) s.simStep(); };
  return { s, talk, talkIntent, run };
}

test('唤醒词：去掉开头的“雪人”', () => {
  assert.equal(stripWake('雪人，去山腰站'), '去山腰站');
  assert.equal(stripWake('嘿雪人 还有多远'), '还有多远');
  assert.equal(stripWake('去山腰站'), '去山腰站');
  // 真机实测的识别结果：唤醒词在句尾、重复、同音字
  assert.equal(stripWake('告诉我怎么走雪人。'), '告诉我怎么走');
  assert.equal(stripWake('雪人。雪人我想去餐厅'), '我想去餐厅');
  assert.equal(stripWake('学人，还有多远'), '还有多远');
  assert.equal(stripWake('雪人。'), '');
  assert.ok(hasWake('告诉我怎么走雪人。'));
  assert.ok(!hasWake('今天天气不错'));
});

test('本地规则：常见说法', () => {
  const nav = rulesIntent('雪人，去山脚餐厅，不走高级道，别让我蹬着走', R);
  assert.equal(nav.intent, 'navigate');
  assert.equal(nav.destination, '山脚餐厅');
  assert.equal(nav.maxDifficulty, 2);
  assert.equal(nav.avoidFlat, 'yes');
  assert.equal(rulesIntent('好，走吧', R).intent, 'confirm');
  assert.equal(rulesIntent('算了', R).intent, 'cancel');
  assert.equal(rulesIntent('还有多远', R).intent, 'distance');
  assert.equal(rulesIntent('没听清，再说一遍', R).intent, 'repeat');
  assert.equal(rulesIntent('我累了，换条简单点的', R).intent, 'easier');
  assert.equal(rulesIntent('结束导航', R).intent, 'stop');
  assert.equal(rulesIntent('今天天气真好', R).intent, 'unknown');
  // “好，去山腰站” 是新目的地，不是确认
  assert.equal(rulesIntent('好，去山腰站', R).intent, 'navigate');
});

test('地名解析：精确、别名、歧义、找不到', () => {
  assert.equal(resolvePlace(R, '山腰站').node, 'M');
  assert.equal(resolvePlace(R, '餐厅').node, 'REST');
  assert.deepEqual(resolvePlace(R, '山脚').ambiguous.sort(), ['山脚缆车站', '山脚餐厅'].sort());
  assert.equal(resolvePlace(R, '火星'), null);
});

test('对话：说目的地 → 复述路线并询问 → 确认后开始导航', () => {
  const { s, talk, run } = session();
  const a = talk('雪人，去山脚餐厅，不走高级道');
  assert.equal(a.mode, 'confirming');
  assert.equal(a.awaiting, true);
  assert.match(a.say, /从山顶去山脚餐厅/);
  assert.match(a.say, /中级以下/);
  assert.match(a.say, /要出发吗/);
  const b = talk('好的');
  assert.equal(b.event, 'started');
  assert.equal(b.mode, 'navigating');
  assert.match(JSON.parse(s.drainSpeech())[0].text, /开始导航，前往山脚餐厅/);
  run(60);
  const d = talk('还有多远');
  assert.match(d.say, /米|公里/);
  const r = talk('再说一遍');
  assert.ok(r.say.length > 0);
  const st = talk('结束导航');
  assert.equal(st.event, 'stopped');
  assert.equal(st.mode, 'idle');
});

test('对话：地名有歧义时追问，不猜', () => {
  const { talk } = session();
  const a = talk('去山脚');
  assert.match(a.say, /山脚餐厅/);
  assert.match(a.say, /山脚缆车站/);
  assert.notEqual(a.mode, 'confirming');
});

test('对话：取消待确认的路线', () => {
  const { talk } = session();
  talk('去山腰站');
  const c = talk('算了');
  assert.equal(c.mode, 'idle');
  assert.equal(talk('好').say, '现在没有待确认的路线。告诉我想去哪里吧。');
});

test('对话：没有符合条件的路线时如实说明，不偷偷放宽', () => {
  const { talk } = session();
  const a = talk('只走初级道，去山脚餐厅');
  assert.notEqual(a.mode, 'confirming');
  assert.match(a.say, /没有可用路线/);
});

test('对话：导航中要求更简单的路线 → 从当前雪道向前重新规划并询问', () => {
  const { talk, run } = session();
  talk('去山脚餐厅，可以走高级道');
  talk('好');
  run(20);
  const e = talk('我累了，换条简单点的');
  assert.equal(e.mode, 'confirming');
  assert.match(e.say, /中级以下/);
});

test('对话：云端意图（大模型输出）同样经过地图校验', () => {
  const { talkIntent } = session();
  const bad = talkIntent({ intent: 'navigate', destination: '不存在的雪道', start: '', maxDifficulty: 0, avoidFlat: '', preferShort: '', reply: '' });
  assert.match(bad.say, /没有找到/);
  const chat = talkIntent({ intent: 'chat', destination: '', start: '', maxDifficulty: 0, avoidFlat: '', preferShort: '', reply: '今天雪很好，玩得开心！' });
  assert.equal(chat.say, '今天雪很好，玩得开心！');
  const weird = talkIntent({ intent: 'navigate', destination: '山腰站', maxDifficulty: 9 });
  assert.equal(weird.mode, 'confirming');
});

test('真实 GPS 模式：不知道位置时要求说出发地；虚构雪场不允许真实 GPS 导航', () => {
  const s = createSession(demoText);
  s.configure('gps', null);
  const a = JSON.parse(s.converse(s.understandLocal('去山脚餐厅'), Date.now()));
  assert.match(a.say, /从哪里出发/);
  const b = JSON.parse(s.converse(s.understandLocal('从山顶出发去山脚餐厅'), Date.now()));
  assert.equal(b.mode, 'confirming');
  const c = JSON.parse(s.converse(s.understandLocal('好'), Date.now()));
  assert.match(c.say, /不允许真实 GPS/);
});

test('对话：没有更简单的路线时用一句话说明，继续原路线', () => {
  const { talk, run } = session();
  talk('去山脚餐厅，不走高级道');
  talk('好');
  run(20);
  const e = talk('换条简单点的');
  assert.equal(e.mode, 'navigating');
  assert.equal(e.say, '去山脚餐厅没有只走初级的路线，继续按原来的路线走。');
});

test('云端提示：包含地点表，说明不由模型决定路线', () => {
  const p = brainSystemPrompt(R, 'zh');
  assert.ok(p.includes('山脚餐厅'));
  assert.ok(p.includes('不规划路线'));
});
