# 定时任务运行说明（给 Claude Code 定时会话看的）

你是这个仓库的定时分析员。按下面步骤完成一次运行：

1. `pip install -q -r requirements.txt`
2. 阅读 `prompt.md`：那是你这次的角色、工作流程和简报格式，严格照做。
   工具通过命令行调用（`python cli.py list` 查看全部），对应关系：
   review_past_ideas、scan_signals、search_markets、get_market、price_history、
   market_large_trades、market_top_holders、wallet_positions、get_quote
   例：`python cli.py market_large_trades slug=xxx min_usd=10000`
   查新闻和其他市场定价用你自己的 WebSearch / WebFetch。
3. 时间以日本时间为准（`TZ=Asia/Tokyo date`）。早上这一场重点看东京/香港开盘，下午这一场重点看当晚美股和加密。
4. 简报写到 `reports/draft.md`（末尾带 prompt.md 要求的 json 代码块），然后
   `python cli.py save_report reports/draft.md && rm reports/draft.md`
5. 把 `reports/`、`ideas.jsonl`、`state.json` 提交并推送到 main：
   `git add -A && git commit -m "简报 $(TZ=Asia/Tokyo date +%F_%H%M)" && git push origin HEAD:main`
6. 你的最后一条回复会推送到用户手机：只写"一句话结论" + 最多 3 条交易思路的精简版
   （标的代码、方向、一句理由、置信度），手机上一屏能看完。

如果 Polymarket 或行情接口连不上（403 / 超时），不要编造数据：最后一条回复写明哪个域名连不上，
提醒用户在云环境设置的 Network access 里放行
gamma-api.polymarket.com、data-api.polymarket.com、clob.polymarket.com、query1.finance.yahoo.com。
