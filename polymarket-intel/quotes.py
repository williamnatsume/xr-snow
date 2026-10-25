"""股票 / 加密货币行情（Yahoo Finance 公开接口，无需 key）。

代码格式：美股 AAPL、日股 7203.T、港股 0700.HK、加密 BTC-USD、汇率 JPY=X、指数 ^N225。
"""
from __future__ import annotations

import requests

_session = requests.Session()
_session.headers["User-Agent"] = "Mozilla/5.0 polymarket-intel/0.1"


def quote(symbol: str) -> dict:
    r = _session.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}",
                     params={"range": "1mo", "interval": "1d"}, timeout=20)
    r.raise_for_status()
    res = (r.json().get("chart") or {}).get("result")
    if not res:
        raise ValueError(f"找不到代码 {symbol}（日股加 .T，港股加 .HK，加密用 BTC-USD）")
    meta = res[0]["meta"]
    closes = [c for c in (res[0].get("indicators", {}).get("quote") or [{}])[0].get("close") or [] if c]
    price = meta.get("regularMarketPrice") or (closes[-1] if closes else None)

    def chg(n: int) -> float | None:
        return round(price / closes[-1 - n] - 1, 4) if price and len(closes) > n else None

    return {
        "symbol": symbol,
        "name": meta.get("shortName") or meta.get("longName"),
        "price": price,
        "currency": meta.get("currency"),
        "change_1d": chg(1),
        "change_5d": chg(5),
        "change_1mo": round(price / closes[0] - 1, 4) if price and closes else None,
        "market_time": meta.get("regularMarketTime"),
    }
