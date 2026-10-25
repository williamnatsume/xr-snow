"""Polymarket 情报 agent：Claude 自己调用 Polymarket 数据工具 + 网页搜索，写出中文情报简报。

用法：
  python agent.py                         # 全站扫描，自动挑重点
  python agent.py "美联储 降息"            # 聚焦某个主题
  python agent.py --no-web                # 不联网查新闻，只看盘口数据
"""
from __future__ import annotations

import argparse
import functools
import json
import sys
from datetime import datetime
from pathlib import Path

import anthropic
from anthropic import beta_tool

import polymarket as pm
import scan

MODEL = "claude-opus-5-5"
REPORT_DIR = Path(__file__).with_name("reports")

SYSTEM = """你是一名预测市场情报分析师，任务是从 Polymarket 的盘口和资金流里挖出"有用的情报"：
市场正在给什么事件重新定价、聪明钱/大户在押什么、哪些概率变化领先于新闻。

工作方法：
1. 先调用 scan_signals 拿到全站异动信号（价格异动、成交暴增、新热门市场、大单资金流、与上次扫描的变化）。
   如果用户给了主题，再用 search_markets 找相关市场。
2. 挑出最值得深挖的 5-8 个市场。对每个市场按需查看价格走势、大单、持仓大户；
   对可疑的大户可以查看其钱包持仓，判断是不是长期盈利的老手、是否集中押注同一主题。
3. 如果可以用网页搜索，就查证异动背后有没有新闻驱动。没有对应新闻的异动（可能是信息领先）尤其值得标出。
4. 过滤噪音：体育单场、加密币小时级涨跌盘、流动性很差的盘口，除非异常极其明显，否则不要写。

输出一份中文 Markdown 简报：
- 开头"一句话总结"
- "重点情报"：每条包括 市场与当前概率、发生了什么（数据）、可能原因（标明是已证实新闻还是推测）、
  值得关注的点 / 后续观察信号、Polymarket 链接
- "资金动向"：值得注意的大户/集中下注
- "观察清单"：接下来值得盯的市场
数据要具体（概率、变动幅度、金额）。区分事实与推断，不要编造新闻；没查到就说没查到。
这只是信息整理，不构成投资建议。"""


def _tool(fn):
    """工具统一返回 JSON 字符串；出错时把错误告诉模型而不是让整个 agent 崩掉。"""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return json.dumps(fn(*args, **kwargs), ensure_ascii=False, default=str)
        except Exception as e:  # noqa: BLE001
            return json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False)
    return beta_tool(wrapper)


def _market_or_raise(slug: str) -> dict:
    m = pm.get_market(slug)
    if not m:
        raise ValueError(f"找不到市场 slug={slug}，请先用 search_markets 或 scan_signals 获取正确的 slug")
    return m


@_tool
def scan_signals() -> dict:
    """扫描 Polymarket 成交额最高的约 300 个活跃市场，返回异动信号：
    price_movers（价格异动）、volume_spikes（成交暴增）、fresh_hot_markets（新上线热门）、
    whale_flows（单笔≥1万美元的大单按市场和方向聚合）、changed_since_last_run（与上次扫描相比的变化）。
    概率以 0-1 表示，change_* 为价格变动（0.1 即 10 个百分点）。
    """
    return scan.run_scan()


@_tool
def search_markets(query: str) -> list:
    """按关键词搜索 Polymarket 活跃事件及其市场。关键词最好用英文。

    Args:
        query: 搜索关键词，例如 "Fed rate cut"、"Taiwan"、"election"。
    """
    return pm.search(query, limit=8)


@_tool
def get_market(slug: str) -> dict:
    """获取单个市场的当前详情（概率、成交、流动性、到期日、condition_id、token_ids）。

    Args:
        slug: 市场 slug（来自其它工具结果中的 slug 字段）。
    """
    return _market_or_raise(slug)


@_tool
def price_history(slug: str, interval: str = "1w") -> dict:
    """获取市场第一个结果（通常是 Yes）的价格走势，可用来判断异动发生的具体时间点。

    Args:
        slug: 市场 slug。
        interval: 时间范围：1d、1w、1m 或 max。
    """
    m = _market_or_raise(slug)
    if not m["token_ids"]:
        raise ValueError("该市场没有 token id")
    fidelity = {"1d": 15, "1w": 60, "1m": 360, "max": 1440}.get(interval, 60)
    hist = pm.price_history(m["token_ids"][0], interval=interval, fidelity=fidelity)
    # 控制返回长度，最多保留约 60 个点
    step = max(1, len(hist) // 60)
    return {"outcome": next(iter(m["outcomes"]), None),
            "points": [{"time": datetime.fromtimestamp(p["t"]).strftime("%m-%d %H:%M"), "p": p["p"]}
                       for p in hist[::step]]}


@_tool
def market_large_trades(slug: str, min_usd: float = 5000) -> list:
    """获取某个市场近期的大额成交（吃单方），看是谁在什么价位买卖了什么方向。

    Args:
        slug: 市场 slug。
        min_usd: 单笔最低金额（美元）。
    """
    m = _market_or_raise(slug)
    return pm.large_trades(min_usd=min_usd, limit=50, condition_id=m["condition_id"])


@_tool
def market_top_holders(slug: str) -> dict:
    """获取某个市场各结果的持仓大户（钱包地址、持股数量）。

    Args:
        slug: 市场 slug。
    """
    m = _market_or_raise(slug)
    return {"outcomes": list(m["outcomes"]), "holders": pm.top_holders(m["condition_id"], limit=10)}


@_tool
def wallet_positions(address: str) -> list:
    """查看某个钱包当前的全部持仓和盈亏，用于判断大户是否为老手、是否集中押注某一主题。

    Args:
        address: 钱包地址（0x 开头，来自大单或持仓大户结果中的 wallet 字段）。
    """
    return pm.wallet_positions(address)


TOOLS = [scan_signals, search_markets, get_market, price_history,
         market_large_trades, market_top_holders, wallet_positions]
WEB_SEARCH = {"type": "web_search_20260209", "name": "web_search", "max_uses": 15}


def run(topic: str | None, use_web: bool = True, verbose: bool = True) -> str:
    client = anthropic.Anthropic()
    tools = TOOLS + ([WEB_SEARCH] if use_web else [])
    today = datetime.now().strftime("%Y-%m-%d")
    ask = (f"今天是 {today}。请围绕主题「{topic}」从 Polymarket 上挖情报，写一份简报。" if topic
           else f"今天是 {today}。请扫描 Polymarket 全站，写一份今日情报简报。")
    messages: list = [{"role": "user", "content": ask}]

    # 网页搜索是服务端工具，长回合可能返回 pause_turn；Python 的 tool runner 不会自动续上，
    # 所以这里自己记录历史，遇到 pause_turn 就带着历史重新起一个 runner。
    last = None
    for _ in range(5):
        runner = client.beta.messages.tool_runner(
            model=MODEL,
            max_tokens=32000,
            system=SYSTEM,
            tools=tools,
            messages=messages,
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        for message in runner:
            last = message
            messages.append({"role": "assistant", "content": message.content})
            if verbose:
                for block in message.content:
                    if block.type == "tool_use":
                        print(f"  → {block.name}({json.dumps(block.input, ensure_ascii=False)})", file=sys.stderr)
                    elif block.type == "server_tool_use":
                        print(f"  → {block.name}: {block.input.get('query', '')}", file=sys.stderr)
            tool_response = runner.generate_tool_call_response()
            if tool_response is not None:
                messages.append(tool_response)
        if last is None or last.stop_reason != "pause_turn":
            break

    if last is None:
        raise RuntimeError("模型没有返回任何内容")
    if last.stop_reason == "refusal":
        raise RuntimeError(f"请求被拒绝：{getattr(last.stop_details, 'explanation', '')}")
    report = "".join(b.text for b in last.content if b.type == "text").strip()
    if last.stop_reason == "max_tokens":
        report += "\n\n（输出达到长度上限，被截断）"
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description="Polymarket 情报 agent")
    ap.add_argument("topic", nargs="?", help="可选：聚焦的主题，例如 'Fed rate' 或 '中国'")
    ap.add_argument("--no-web", action="store_true", help="不使用网页搜索查证新闻")
    ap.add_argument("-q", "--quiet", action="store_true", help="不打印工具调用过程")
    args = ap.parse_args()

    report = run(args.topic, use_web=not args.no_web, verbose=not args.quiet)
    REPORT_DIR.mkdir(exist_ok=True)
    path = REPORT_DIR / f"{datetime.now():%Y-%m-%d_%H%M}.md"
    path.write_text(report, encoding="utf-8")
    print(report)
    print(f"\n已保存：{path}", file=sys.stderr)


if __name__ == "__main__":
    main()
