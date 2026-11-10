// 打包导航核心给 iOS App 用：nav/core-entry.js → ios/XRSnowNav/Resources/navcore.js（IIFE，全局名 XRNav）
// 同时复制雪场数据，并生成 M1 验收用的期望播报序列（App 自检时对比）。
//   npm run build:ios

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { loadResort } from '../nav/resort.js';
import { runScenario } from '../nav/scenario.js';
import { SELFCHECK } from './selfcheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'ios/XRSnowNav/Resources');
fs.mkdirSync(path.join(OUT, 'resorts'), { recursive: true });

await build({
  entryPoints: [path.join(ROOT, 'nav/core-entry.js')],
  bundle: true,
  format: 'iife',
  globalName: 'XRNav',
  target: 'safari16',      // JavaScriptCore 与 Safari 同引擎；iOS 17+ 足够
  legalComments: 'none',
  banner: { js: '// 自动生成，请勿手改：npm run build:ios（源码在 nav/）' },
  outfile: path.join(OUT, 'navcore.js')
});

for (const f of fs.readdirSync(path.join(ROOT, 'resorts'))) {
  if (f.endsWith('.json')) fs.copyFileSync(path.join(ROOT, 'resorts', f), path.join(OUT, 'resorts', f));
}

// 期望播报序列：直接用源码（不经过打包）跑同一场景
const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'resorts', SELFCHECK.resort + '.json'), 'utf8'));
const res = runScenario(loadResort(json), SELFCHECK.scenario);
const expected = { ...SELFCHECK, texts: res.spoken.map((s) => s.text), arrived: res.nav.state === 'arrived' };
fs.writeFileSync(path.join(OUT, 'selfcheck-expected.json'), JSON.stringify(expected, null, 2) + '\n');

console.log(`navcore.js ${(fs.statSync(path.join(OUT, 'navcore.js')).size / 1024).toFixed(0)} KB；自检场景 ${expected.texts.length} 条播报，到达：${expected.arrived}`);
