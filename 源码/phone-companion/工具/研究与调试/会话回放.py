# -*- coding: utf-8 -*-
"""
会话回放.py —— 提取 DSH 会话里每个回合的输入与最终回复，用于校准 S5 通知逻辑。

要点：
  · 一个回合可能有多条 assistant/message（分步产出），**最后一条**才是最终回复。
  · user/message 的事件结构在不同来源下不一致（有的字段在 data 下、有的直接平铺），
    本脚本两种都兼容，并把原始结构打印出来便于判断如何打"电话发起"标记。

用法：
  python 会话回放.py              # 最新会话，最近 3 个回合
  python 会话回放.py -n 5         # 最近 5 个回合
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import zstandard

SESSIONS_ROOT = Path(os.environ.get("USERPROFILE", "")) / ".dsh" / "sessions"


def newest_session_file() -> Path:
    best = None
    for root, _d, files in os.walk(SESSIONS_ROOT):
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
        raise SystemExit("未找到会话文件")
    return best[1]


def load_events(path: Path):
    with open(path, "rb") as f:
        raw = zstandard.ZstdDecompressor().stream_reader(f).read()
    out = []
    for line in raw.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


def text_of(content) -> str:
    """把 message.content（可能是 str / list of blocks）拼成纯文本。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                t = block.get("text") or block.get("content")
                if isinstance(t, str):
                    parts.append(t)
                elif block.get("type") == "text" and isinstance(block.get("value"), str):
                    parts.append(block["value"])
    return "".join(parts)


def dig(event: dict, *keys, default=None):
    """在 data 与顶层两处找字段。"""
    data = event.get("data") or {}
    for k in keys:
        if k in data:
            return data[k]
        if k in event:
            return event[k]
    return default


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", type=int, default=3, help="显示最近几个回合")
    ap.add_argument("path", nargs="?", help="会话目录或 .jsonl.zstd 文件")
    args = ap.parse_args()

    if args.path:
        p = Path(args.path)
        path = p / "session.jsonl.zstd" if p.is_dir() else p
    else:
        path = newest_session_file()
    print(f"会话: {path.name}  ({path.stat().st_size/1024/1024:.1f} MB)\n")

    events = load_events(path)

    # 按回合归集
    turns: dict[int, dict] = {}
    for e in events:
        etype = e.get("type")
        turn = dig(e, "turn")
        if turn is None:
            continue
        slot = turns.setdefault(turn, {"user": [], "assistant": [], "end": None})
        if etype == "user/message":
            slot["user"].append(e)
        elif etype == "assistant/message":
            slot["assistant"].append(e)
        elif etype == "turn/end":
            slot["end"] = e

    keys = sorted(turns.keys())[-args.n:]
    for t in keys:
        slot = turns[t]
        print("=" * 72)
        print(f"回合 {t}")
        for u in slot["user"]:
            msg = dig(u, "message") or {}
            content = text_of(msg.get("content") if isinstance(msg, dict) else None) or text_of(dig(u, "content"))
            src = (msg.get("source") if isinstance(msg, dict) else None) or dig(u, "source")
            print(f"  [用户输入] {content[:300]!r}")
            print(f"             source={json.dumps(src, ensure_ascii=False)[:260]}")
        if slot["assistant"]:
            last = slot["assistant"][-1]
            msg = dig(last, "message") or {}
            content = text_of(msg.get("content") if isinstance(msg, dict) else None)
            print(f"  [最终回复] 共 {len(slot['assistant'])} 条 assistant/message，取最后一条：")
            print(f"             {content[:400]!r}")
        if slot["end"]:
            print(f"  [回合结束] {json.dumps(dig(slot['end'], 'reason'), ensure_ascii=False)}")

    print("=" * 72)
    print("\n=== user/message 的两种结构样例（决定如何打'电话发起'标记）===")
    seen = 0
    for e in events:
        if e.get("type") != "user/message":
            continue
        print(json.dumps(e, ensure_ascii=False)[:700])
        print("-" * 60)
        seen += 1
        if seen >= 2:
            break


if __name__ == "__main__":
    main()
