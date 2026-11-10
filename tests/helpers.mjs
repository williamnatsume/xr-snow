// 测试辅助：载入雪场、规划路线、用模拟器跑一整段导航（无界面、无真实时间）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadResort } from '../nav/resort.js';

export { runScenario } from '../nav/scenario.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resort(name = 'demo-fictional') {
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'resorts', name + '.json'), 'utf8'));
  const r = loadResort(json);
  if (r.errors.length) throw new Error(r.errors.join('; '));
  return r;
}

export const texts = (spoken) => spoken.map((s) => s.text);
