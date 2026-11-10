// M1 验收场景：虚构雪场，山顶 → 山脚餐厅，中级以下，模拟器种子 3。
// tools/build-ios.mjs 用它生成期望播报序列，tests/core-bundle.test.mjs 和 App 自检都对比这个序列。
export const SELFCHECK = {
  resort: 'demo-fictional',
  scenario: { start: 'S', goal: 'REST', prefs: { maxDifficulty: 2 }, sim: { seed: 3 } }
};
