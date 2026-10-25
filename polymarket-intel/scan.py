"""规则扫描：不用大模型，直接从 Polymarket 数据里挑出异动信号。

可单独运行：  python scan.py            （打印 Markdown）
             python scan.py --json     （输出 JSON）
"""
from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import polymarket as pm

STATE_FILE = Path(__file__).with_name("state.json")

# 阈值都可以按需调整
MIN_VOLUME_24H = 50_000      # 低于此成交额的市场噪音太大，忽略
MOVE_1D = 0.10               # 24 小时价格变动 ≥ 10 个百分点
MOVE_1H = 0.05               # 1 小时价格变动 ≥ 5 个百分点
VOLUME_SPIKE = 3.0           # 24h 成交额 ≥ 近 7 日日均的 3 倍
WHALE_USD = 10_000           # 单笔大额成交
FRESH_HOURS = 72             # 新上线市场


def _hours_since(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - dt).total_seconds() / 3600


def _brief(m: dict) -> dict:
    keys = ("question", "event", "slug", "url", "outcomes", "change_1h", "change_1d",
            "change_1w", "volume_24h", "liquidity", "end_date")
    return {k: m.get(k) for k in keys}


def find_signals(markets: list[dict], trades: list[dict], prev: dict | None = None) -> dict:
    liquid = [m for m in markets if m["volume_24h"] >= MIN_VOLUME_24H]

    movers = sorted(
        (m for m in liquid if abs(m["change_1d"]) >= MOVE_1D or abs(m["change_1h"]) >= MOVE_1H),
        key=lambda m: max(abs(m["change_1d"]), 2 * abs(m["change_1h"])), reverse=True)

    spikes = []
    for m in liquid:
        daily_avg = m["volume_1w"] / 7 if m["volume_1w"] else 0
        if daily_avg and m["volume_24h"] / daily_avg >= VOLUME_SPIKE:
            spikes.append({**_brief(m), "spike_ratio": round(m["volume_24h"] / daily_avg, 1)})
    spikes.sort(key=lambda s: s["spike_ratio"], reverse=True)

    fresh = []
    for m in liquid:
        h = _hours_since(m.get("created_at"))
        if h is not None and h <= FRESH_HOURS:
            fresh.append({**_brief(m), "age_hours": round(h, 1)})
    fresh.sort(key=lambda m: m["volume_24h"], reverse=True)

    # 大单按 市场+方向 聚合，能看出是不是有人在集中押注
    flows: dict[tuple, dict] = defaultdict(lambda: {"usd": 0.0, "count": 0, "wallets": set()})
    for t in trades:
        key = (t["market"], t["slug"], t["outcome"], t["side"])
        f = flows[key]
        f["usd"] += t["usd"]
        f["count"] += 1
        f["wallets"].add(t["wallet"])
        f["last_price"] = t["price"]
    whale_flows = sorted(({
        "market": k[0], "slug": k[1], "outcome": k[2], "side": k[3],
        "usd": round(v["usd"]), "trades": v["count"], "wallets": len(v["wallets"]),
        "last_price": v.get("last_price"),
    } for k, v in flows.items()), key=lambda x: x["usd"], reverse=True)

    # 与上次运行对比：概率跨过 50% 或较上次变动 ≥ 10 个百分点
    since_last = []
    if prev:
        for m in liquid:
            old = prev.get(m["slug"])
            if not old or not m["outcomes"]:
                continue
            name, p = next(iter(m["outcomes"].items()))
            p0 = old.get(name)
            if p0 is None:
                continue
            if abs(p - p0) >= 0.10 or (p0 - 0.5) * (p - 0.5) < 0:
                since_last.append({**_brief(m), "outcome": name, "prev": p0, "now": p})

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "markets_scanned": len(markets),
        "price_movers": [_brief(m) for m in movers[:15]],
        "volume_spikes": spikes[:10],
        "fresh_hot_markets": fresh[:10],
        "whale_flows": whale_flows[:15],
        "changed_since_last_run": since_last[:15],
    }


def load_state() -> dict | None:
    try:
        return json.loads(STATE_FILE.read_text())["prices"]
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        return None


def save_state(markets: list[dict]) -> None:
    STATE_FILE.write_text(json.dumps({
        "saved_at": int(time.time()),
        "prices": {m["slug"]: m["outcomes"] for m in markets if m.get("slug")},
    }, ensure_ascii=False))


def run_scan(n_markets: int = 300, save: bool = True) -> dict:
    markets = pm.top_markets(n_markets)
    trades = pm.large_trades(min_usd=WHALE_USD, limit=500)
    signals = find_signals(markets, trades, load_state())
    if save:
        save_state(markets)
    return signals


def _pct(x: float) -> str:
    return f"{x * 100:+.1f}pp"


def to_markdown(s: dict) -> str:
    lines = [f"# Polymarket 异动扫描 {s['generated_at']}", f"扫描市场数：{s['markets_scanned']}", ""]

    def odds(m):
        return " / ".join(f"{k} {v:.0%}" for k, v in (m.get("outcomes") or {}).items())

    lines.append("## 价格异动")
    for m in s["price_movers"]:
        lines.append(f"- {m['question']} — {odds(m)}（1h {_pct(m['change_1h'])}, 24h {_pct(m['change_1d'])}，"
                     f"24h 成交 ${m['volume_24h']:,.0f}）{m['url'] or ''}")
    lines.append("\n## 成交量暴增")
    for m in s["volume_spikes"]:
        lines.append(f"- {m['question']} — {odds(m)}，成交为 7 日均值 {m['spike_ratio']}×")
    lines.append("\n## 新上线热门市场")
    for m in s["fresh_hot_markets"]:
        lines.append(f"- {m['question']} — {odds(m)}，上线 {m['age_hours']}h，24h 成交 ${m['volume_24h']:,.0f}")
    lines.append(f"\n## 大单资金流（单笔 ≥ ${WHALE_USD:,}）")
    for f in s["whale_flows"]:
        lines.append(f"- {f['market']} — {f['side']} {f['outcome']} ${f['usd']:,}（{f['trades']} 笔 / {f['wallets']} 个钱包，最新价 {f['last_price']}）")
    if s["changed_since_last_run"]:
        lines.append("\n## 与上次扫描相比")
        for m in s["changed_since_last_run"]:
            lines.append(f"- {m['question']} — {m['outcome']} {m['prev']:.0%} → {m['now']:.0%}")
    return "\n".join(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--markets", type=int, default=300)
    args = ap.parse_args()
    sig = run_scan(args.markets)
    print(json.dumps(sig, ensure_ascii=False, indent=2) if args.json else to_markdown(sig))
