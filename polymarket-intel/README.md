# Polymarket 情报 agent

把 Polymarket 当情报源：找出预测市场已经重新定价、但美股 / 日股 / 港股 / 加密货币还没充分反应的事件，
给出带代码、方向、失效条件和置信度的交易思路，并在下一次运行时复盘之前思路的表现。

## 两部分

| 文件 | 作用 | 需要 Claude API key？ |
|---|---|---|
| `scan.py` | 规则扫描：价格异动、成交暴增、新上线热门市场、大单资金流、与上次扫描的对比 | 不需要 |
| `agent.py` | Claude agent：先调用扫描，再自己挑重点深挖（价格走势、大单、持仓大户、大户钱包），并上网查证新闻，输出简报 | 需要 |
| `quotes.py` / `ideas.py` | Yahoo Finance 行情（AAPL、7203.T、0700.HK、BTC-USD）；交易思路记录与复盘（`ideas.jsonl`） | — |
| `cli.py` + `SCHEDULED.md` | 让 Claude Code 定时任务用命令行调用同一套工具（不需要 API key） | 不需要 |
| `polymarket.py` | Polymarket 公开 API 封装（Gamma / Data / CLOB，无需登录） | — |

## 安装

```bash
cd polymarket-intel
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # Windows: set ANTHROPIC_API_KEY=sk-ant-...
```

## 使用

```bash
python scan.py                    # 只看规则扫描结果（免费、秒出）
python agent.py                   # 全站情报简报
python agent.py "Fed rate cut"    # 聚焦主题（关键词用英文搜得更准）
python agent.py --no-web          # 不上网查新闻，只分析盘口数据
```

简报会打印出来，同时保存到 `reports/日期_时间.md`。
每次扫描会把各市场概率存到 `state.json`，下次运行时会列出"与上次扫描相比"变化大的市场，
所以定时跑（比如每天早上一次）效果最好。

## 调参

阈值在 `scan.py` 顶部：最低成交额、价格异动幅度、成交暴增倍数、大单金额等。
Agent 的分析重点和简报格式在 `prompt.md` 里，可以直接改成你关心的方向
（例如只看政治/宏观、忽略体育）。

## 说明

- 默认模型 `claude-opus-5-5`，开启自适应思考；被安全策略拒绝时自动切换到备用模型（`fallbacks: "default"`）。
- 一次全站简报大约调用几十次工具，会消耗一定 API 费用；`--no-web` 更便宜。
- `reports/`、`ideas.jsonl`、`state.json` 会提交进仓库，用来复盘，所以请放在私有仓库里。
- 只做信息整理，不构成投资建议。
