# -*- coding: utf-8 -*-
"""
会话探测.py —— 读取 DSH 会话文件，弄清"回合结束"与"助手回复"事件的结构。

用途：S5 通知链路的依据调研。DSH 把会话存成 session.jsonl.zstd，
其中 turn/end 表示回合结束、assistant/message 是助手的完整回复。

用法：
  python 会话探测.py                      # 自动取会话目录里最新修改的那个会话
  python 会话探测.py <会话目录或 zstd 文件路径>
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import zstandard

SESSIONS_ROOT = Path(os.environ.get("USERPROFILE", "")) / ".dsh" / "sessions"


def newest_session_file() -> Path:
    """找出最近被写入的会话文件。"""
    best = None
    for root, _dirs, files in os.walk(SESSIONS_ROOT):
        for name in files:
            if name.endswith(".jsonl.zstd"):
                p = Path(root) / name
                try:
                    m = p.stat().st_mtime
                except OSError:
                    continue
                if best is None or m > best[0]:
                    best = (m, p)
    if best is None:
        raise SystemExit(f"在 {SESSIONS_ROOT} 下没找到会话文件")
    return best[1]


def load_events(path: Path):
    with open(path, "rb") as f:
        raw = zstandard.ZstdDecompressor().stream_reader(f).read()
    events = []
    for line in raw.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return raw, events


def brief(value, limit=200) -> str:
    return json.dumps(value, ensure_ascii=False)[:limit]


def main():
    if len(sys.argv) > 1:
        target = Path(sys.argv[1])
        if target.is_dir():
            target = target / "session.jsonl.zstd"
    else:
        target = newest_session_file()

    print(f"会话文件: {target}")
    print(f"大小: {target.stat().st_size / 1024 / 1024:.1f} MB")
    raw, events = load_events(target)
    print(f"解压后: {len(raw) / 1024 / 1024:.1f} MB，事件数: {len(events)}\n")

    # 事件类型统计
    counts = {}
    for e in events:
        counts[e.get("type")] = counts.get(e.get("type"), 0) + 1
    print("=== 事件类型分布 ===")
    for k, v in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {k:34s} {v}")

    print("\n=== turn 生命周期（turn/start 与 turn/end）===")
    for e in events:
        if e.get("type") in ("turn/start", "turn/end"):
            print(f"  seq={e.get('seq'):<6} {e['type']:<12} data={brief(e.get('data'))}")

    print("\n=== 最后一条 assistant/message 的完整结构 ===")
    amsgs = [e for e in events if e.get("type") == "assistant/message"]
    if amsgs:
        a = amsgs[-1]
        d = a.get("data") or {}
        m = d.get("message") or {}
        print(f"  seq={a.get('seq')}  turn={d.get('turn')}  step={d.get('step')}  surfaceOp={a.get('surfaceOp')}")
        print(f"  role={m.get('role')}  id={str(m.get('id'))[:44]}")
        print(f"  source={brief(m.get('source'), 300)}")
        print(f"  content={brief(m.get('content'), 900)}")
    else:
        print("  （没有 assistant/message 事件）")

    print("\n=== 最后一条 user/message 的结构（识别'电话发起的回合'用）===")
    umsgs = [e for e in events if e.get("type") == "user/message"]
    if umsgs:
        u = umsgs[-1]
        d = u.get("data") or {}
        m = d.get("message") or {}
        print(f"  seq={u.get('seq')}  turn={d.get('turn')}  step={d.get('step')}")
        print(f"  keys={list(d.keys())}")
        print(f"  role={m.get('role')}  source={brief(m.get('source'), 240)}")
        print(f"  content={brief(m.get('content'), 600)}")
    else:
        print("  （没有 user/message 事件）")

    print("\n=== 最后一个回合的完整事件序列（用于确认'回复完成'的可靠标志）===")
    turn_ends = [e for e in events if e.get("type") == "turn/end"]
    if turn_ends:
        last_turn = (turn_ends[-1].get("data") or {}).get("turn")
        print(f"  最后一个回合编号: {last_turn}")
        seqs = [e for e in events
                if (e.get("data") or {}).get("turn") == last_turn
                and e.get("type") in ("turn/start", "user/message", "assistant/message", "turn/end")]
        for e in seqs:
            d = e.get("data") or {}
            extra = ""
            if e["type"] == "assistant/message":
                c = (d.get("message") or {}).get("content")
                extra = brief(c, 160)
            elif e["type"] == "user/message":
                c = (d.get("message") or {}).get("content")
                extra = brief(c, 160)
            print(f"  seq={e.get('seq'):<6} step={d.get('step')}  {e['type']:<18} {extra}")


if __name__ == "__main__":
    main()
