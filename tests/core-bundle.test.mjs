// iOS 用的打包文件（navcore.js）：在没有 DOM、没有 Node 全局变量的干净环境里运行（接近 JavaScriptCore），
// 按 App 的调用方式逐秒模拟，播报序列必须与源码跑同一场景的结果一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, resort, runScenario, texts } from './helpers.mjs';
import { SELFCHECK } from '../tools/selfcheck.mjs';

const RES = path.join(ROOT, 'ios/XRSnowNav/Resources');
const bundlePath = path.join(RES, 'navcore.js');
const has = fs.existsSync(bundlePath);

function loadBundle() {
  const ctx = vm.createContext({});   // 只有 JS 内置对象
  vm.runInContext(fs.readFileSync(bundlePath, 'utf8'), ctx);
  return ctx.XRNav;
}

// 与 Swift 端 NavCore.runSelfCheck 相同的调用顺序
function driveLikeApp(XRNav, resortText, sc) {
  const s = XRNav.createSession(resortText);
  assert.equal(JSON.parse(s.plan(sc.start, sc.goal, JSON.stringify(sc.prefs))).ok, true);
  assert.equal(JSON.parse(s.start('sim', 0, sc.sim.seed)).ok, true);
  const out = [...JSON.parse(s.drainSpeech())];
  let doneAt = null;
  for (let sec = 1; sec <= 3000; sec++) {
    const snap = JSON.parse(s.snapshot(0));
    if (snap.state === 'arrived' || (doneAt != null && sec - doneAt > 30)) {
      for (let k = 0; k < 10; k++) { s.simStep(); out.push(...JSON.parse(s.drainSpeech())); }
      break;
    }
    const r = JSON.parse(s.simStep());
    if (r.simDone && doneAt == null) doneAt = sec;
    out.push(...JSON.parse(s.drainSpeech()));
  }
  return { texts: out.map((x) => x.text), state: JSON.parse(s.snapshot(0)).state };
}

test('iOS 打包文件：干净环境可载入，导出接口齐全', { skip: !has && '尚未运行 npm run build:ios' }, () => {
  const X = loadBundle();
  for (const k of ['createSession', 'scenarioTexts', 'loadResort', 'planRoute', 'Navigator', 'buildManeuvers', 'maneuverText', 'parseRequest']) {
    assert.equal(typeof X[k], 'function', k);
  }
  const info = JSON.parse(X.createSession(fs.readFileSync(path.join(RES, 'resorts/demo-fictional.json'), 'utf8')).info());
  assert.deepEqual(info.errors, []);
  assert.equal(info.allowRealGps, false);
  assert.ok(info.places.some((p) => p.node === 'REST'));
});

test('iOS 打包文件：按 App 方式跑自检场景，播报序列与源码一致，且与期望文件一致', { skip: !has && '尚未运行 npm run build:ios' }, () => {
  const sc = SELFCHECK.scenario;
  const resortText = fs.readFileSync(path.join(RES, `resorts/${SELFCHECK.resort}.json`), 'utf8');
  const app = driveLikeApp(loadBundle(), resortText, sc);
  const src = runScenario(resort(SELFCHECK.resort), sc);
  assert.deepEqual(app.texts, texts(src.spoken));
  assert.equal(app.state, 'arrived');
  const expected = JSON.parse(fs.readFileSync(path.join(RES, 'selfcheck-expected.json'), 'utf8'));
  assert.deepEqual(expected.texts, app.texts, '期望文件过期：请重新运行 npm run build:ios');
});

test('iOS 打包文件：会话不允许在虚构雪场上用真实 GPS', { skip: !has && '尚未运行 npm run build:ios' }, () => {
  const s = loadBundle().createSession(fs.readFileSync(path.join(RES, 'resorts/demo-fictional.json'), 'utf8'));
  s.plan('S', 'REST', '{"maxDifficulty":2}');
  const r = JSON.parse(s.start('gps', Date.now()));
  assert.equal(r.ok, false);
});
