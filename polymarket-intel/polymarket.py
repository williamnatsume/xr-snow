"""Polymarket 公开 API 的轻量封装（无需登录 / API key）。

- Gamma API：市场、事件、搜索
- Data API：成交、持仓大户、钱包持仓
- CLOB API：价格历史
"""
from __future__ import annotations

import json
import time
from typing import Any

import requests

GAMMA = "https://gamma-api.polymarket.com"
DATA = "https://data-api.polymarket.com"
CLOB = "https://clob.polymarket.com"

_session = requests.Session()
_session.headers["User-Agent"] = "polymarket-intel/0.1"


def _get(url: str, params: dict | None = None, retries: int = 3) -> Any:
    for attempt in range(retries):
        try:
            r = _session.get(url, params=params, timeout=20)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f"{r.status_code} {r.text[:200]}")
            r.raise_for_status()
            return r.json()
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError):
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def _json_list(v: Any) -> list:
    """Gamma 把 outcomes / outcomePrices / clobTokenIds 存成 JSON 字符串。"""
    if isinstance(v, list):
        return v
    if isinstance(v, str) and v:
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            return []
    return []


def _f(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def normalize_market(m: dict) -> dict:
    """把 Gamma 的市场对象压成 agent 好读的精简结构。"""
    outcomes = _json_list(m.get("outcomes"))
    prices = [_f(p) for p in _json_list(m.get("outcomePrices"))]
    events = m.get("events") or []
    return {
        "question": m.get("question"),
        "slug": m.get("slug"),
        "event": events[0].get("title") if events else None,
        "event_slug": events[0].get("slug") if events else None,
        "condition_id": m.get("conditionId"),
        "token_ids": _json_list(m.get("clobTokenIds")),
        "outcomes": dict(zip(outcomes, prices)),
        "change_1h": _f(m.get("oneHourPriceChange")),
        "change_1d": _f(m.get("oneDayPriceChange")),
        "change_1w": _f(m.get("oneWeekPriceChange")),
        "volume_24h": _f(m.get("volume24hr")),
        "volume_1w": _f(m.get("volume1wk")),
        "volume_total": _f(m.get("volumeNum") or m.get("volume")),
        "liquidity": _f(m.get("liquidityNum") or m.get("liquidity")),
        "end_date": m.get("endDate"),
        "created_at": m.get("createdAt") or m.get("startDate"),
        "url": f"https://polymarket.com/event/{events[0]['slug']}" if events and events[0].get("slug") else None,
    }


# ---------- Gamma ----------

def list_markets(order: str = "volume24hr", limit: int = 100, offset: int = 0, **filters) -> list[dict]:
    params = {"active": "true", "closed": "false", "archived": "false",
              "order": order, "ascending": "false", "limit": limit, "offset": offset, **filters}
    return [normalize_market(m) for m in _get(f"{GAMMA}/markets", params)]


def top_markets(n: int = 300, order: str = "volume24hr") -> list[dict]:
    out: list[dict] = []
    while len(out) < n:
        page = list_markets(order=order, limit=min(100, n - len(out)), offset=len(out))
        if not page:
            break
        out.extend(page)
    return out


def get_market(slug: str) -> dict | None:
    rows = _get(f"{GAMMA}/markets", {"slug": slug})
    return normalize_market(rows[0]) if rows else None


def search(query: str, limit: int = 10) -> list[dict]:
    """全站搜索，返回活跃事件及其下属市场。"""
    res = _get(f"{GAMMA}/public-search", {"q": query, "limit_per_type": limit, "events_status": "active"})
    events = []
    for e in res.get("events") or []:
        events.append({
            "title": e.get("title"),
            "slug": e.get("slug"),
            "volume_24h": _f(e.get("volume24hr")),
            "url": f"https://polymarket.com/event/{e.get('slug')}",
            "markets": [normalize_market(m) for m in (e.get("markets") or []) if not m.get("closed")],
        })
    return events


# ---------- Data API ----------

def large_trades(min_usd: float = 10_000, limit: int = 200, condition_id: str | None = None) -> list[dict]:
    params = {"limit": limit, "takerOnly": "true", "filterType": "CASH", "filterAmount": min_usd}
    if condition_id:
        params["market"] = condition_id
    out = []
    for t in _get(f"{DATA}/trades", params):
        size, price = _f(t.get("size")), _f(t.get("price"))
        out.append({
            "wallet": t.get("proxyWallet"),
            "trader": t.get("name") or t.get("pseudonym"),
            "side": t.get("side"),
            "outcome": t.get("outcome"),
            "price": price,
            "usd": round(size * price, 2),
            "timestamp": t.get("timestamp"),
            "market": t.get("title"),
            "slug": t.get("slug"),
            "event_slug": t.get("eventSlug"),
            "condition_id": t.get("conditionId"),
        })
    return out


def top_holders(condition_id: str, limit: int = 10) -> list[dict]:
    out = []
    for group in _get(f"{DATA}/holders", {"market": condition_id, "limit": limit}):
        for h in group.get("holders") or []:
            out.append({
                "wallet": h.get("proxyWallet"),
                "trader": h.get("name") or h.get("pseudonym"),
                "outcome_index": h.get("outcomeIndex"),
                "shares": _f(h.get("amount")),
            })
    return out


def wallet_positions(address: str, limit: int = 50) -> list[dict]:
    rows = _get(f"{DATA}/positions", {"user": address, "limit": limit, "sortBy": "CURRENT", "sizeThreshold": 1})
    return [{
        "market": p.get("title"),
        "slug": p.get("slug"),
        "outcome": p.get("outcome"),
        "shares": _f(p.get("size")),
        "avg_price": _f(p.get("avgPrice")),
        "cur_price": _f(p.get("curPrice")),
        "value_usd": _f(p.get("currentValue")),
        "pnl_usd": _f(p.get("cashPnl")),
    } for p in rows]


# ---------- CLOB ----------

def price_history(token_id: str, interval: str = "1w", fidelity: int = 60) -> list[dict]:
    """interval: 1h / 6h / 1d / 1w / 1m / max；fidelity 为采样间隔（分钟）。"""
    res = _get(f"{CLOB}/prices-history", {"market": token_id, "interval": interval, "fidelity": fidelity})
    return [{"t": p["t"], "p": p["p"]} for p in res.get("history", [])]
