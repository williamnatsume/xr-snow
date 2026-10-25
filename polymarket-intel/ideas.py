"""交易思路记录：每次简报的思路连同当时价格存进 ideas.jsonl，下次运行时复盘表现。"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

import quotes

IDEAS_FILE = Path(__file__).with_name("ideas.jsonl")
_BLOCK = re.compile(r"```json\s*(\{.*?\"ideas\".*?\})\s*```", re.S)


def extract(report: str) -> tuple[str, list[dict]]:
    """从简报末尾的 ```json {"ideas": [...]} ``` 代码块取出思路，并从正文里去掉该代码块。"""
    m = _BLOCK.search(report)
    if not m:
        return report, []
    try:
        ideas = json.loads(m.group(1)).get("ideas") or []
    except json.JSONDecodeError:
        return report, []
    return (report[:m.start()] + report[m.end():]).strip(), ideas


def record(ideas: list[dict]) -> None:
    now = int(time.time())
    with IDEAS_FILE.open("a", encoding="utf-8") as f:
        for idea in ideas:
            try:
                idea["entry_price"] = quotes.quote(idea["symbol"])["price"]
            except Exception:  # noqa: BLE001
                idea["entry_price"] = None
            idea["ts"] = now
            f.write(json.dumps(idea, ensure_ascii=False) + "\n")


def review(days: int = 14) -> list[dict]:
    if not IDEAS_FILE.exists():
        return []
    cutoff = time.time() - days * 86400
    rows = [json.loads(l) for l in IDEAS_FILE.read_text(encoding="utf-8").splitlines() if l.strip()]
    out = []
    for r in rows:
        if r.get("ts", 0) < cutoff:
            continue
        cur = None
        try:
            cur = quotes.quote(r["symbol"])["price"]
        except Exception:  # noqa: BLE001
            pass
        ret = None
        if cur and r.get("entry_price"):
            ret = cur / r["entry_price"] - 1
            if r.get("direction") == "short":
                ret = -ret
        out.append({**r, "current_price": cur,
                    "return_in_direction": round(ret, 4) if ret is not None else None,
                    "age_days": round((time.time() - r["ts"]) / 86400, 1)})
    return out
