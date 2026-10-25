"""在命令行里调用 agent 的同一套工具，供 Claude Code 定时任务使用（不需要 Anthropic API key）。

  python cli.py list                                  # 列出全部工具及参数
  python cli.py scan_signals
  python cli.py search_markets query="Fed rate cut"
  python cli.py get_quote symbol=7203.T
  python cli.py save_report reports/草稿.md            # 保存简报并记录末尾 json 代码块里的交易思路
"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import agent
import ideas

TOOLS = {t.name: t for t in agent.TOOLS}


def _parse(v: str):
    try:
        return json.loads(v)
    except json.JSONDecodeError:
        return v


def save_report(path: str) -> None:
    body, new_ideas = ideas.extract(Path(path).read_text(encoding="utf-8"))
    ideas.record(new_ideas)
    agent.REPORT_DIR.mkdir(exist_ok=True)
    out = agent.REPORT_DIR / f"{datetime.now():%Y-%m-%d_%H%M}.md"
    out.write_text(body, encoding="utf-8")
    print(f"已保存 {out}，记录 {len(new_ideas)} 条交易思路")


def main(argv: list[str]) -> None:
    if not argv or argv[0] == "list":
        for t in TOOLS.values():
            params = ", ".join(t.input_schema.get("properties", {}))
            print(f"{t.name}({params})\n    {t.description.splitlines()[0]}")
        return
    if argv[0] == "save_report":
        return save_report(argv[1])
    tool = TOOLS[argv[0]]
    kwargs = dict(a.split("=", 1) for a in argv[1:])
    print(tool.func(**{k: _parse(v) for k, v in kwargs.items()}))


if __name__ == "__main__":
    main(sys.argv[1:])
