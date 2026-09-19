# -*- coding: utf-8 -*-
"""
预热缓存.py —— 把固定话术提前渲染成电话音频（μ-law 8k），避免通话中现算。

为什么需要：
  实测 Qwen3-TTS 0.6B 本地合成只有 0.31x 实时率（生成 1 秒音频要 3 秒）。
  但"就绪音""错误提示""开场白"这类文本是**固定的**，完全可以提前渲染好，
  通话时直接读文件播放 → 这部分延迟降到 0。

  只有"我给你的回复"是每次不同、必须当场合成的。

产物：产物/缓存音频/<键>.mulaw    （8kHz 单声道 μ-law 裸流，可直接走 RTP）
     产物/缓存音频/index.json     （键 → 文本 / 时长 / 生成时间）

用法：
  python 预热缓存.py                 # 渲染所有缺失的缓存
  python 预热缓存.py --force         # 全部重渲染
  python 预热缓存.py --list          # 只看清单
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np
import soundfile as sf

MODEL_DIR = os.environ.get("PHONE_TTS_MODEL_DIR",
                           r"D:\model_cache\tts\Qwen3-TTS-12Hz-0.6B-CustomVoice")
SPEAKER = os.environ.get("PHONE_TTS_SPEAKER", "vivian")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.abspath(os.path.join(HERE, "..", "产物", "缓存音频"))
INSTRUCT = "用自然亲切的普通话女声，语速中等偏快，像在电话里说话。"

# 固定话术：键名 → 文本
PHRASES: dict[str, str] = {
    "ready":            "我在听。",
    "thinking":         "我看一下。",
    "error_api":        "接口出错了，等我查一下日志。",
    "error_empty":      "没听清，你再说一遍。",
    "hangup_thanks":    "好，就这样。",
    "not_bound":        "电话还没绑上任务。",
    "reply_done":       "我说完了。",
    "long_work":        "这个要算一会儿，你先放着听筒也行。",
}


def to_mulaw8k(wav_24k: str, out_mulaw: str) -> int:
    """24k wav → 8k 单声道 μ-law 裸流，返回字节数。"""
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", wav_24k, "-ac", "1", "-ar", "8000", "-f", "mulaw", out_mulaw],
        check=True,
    )
    return os.path.getsize(out_mulaw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="强制重渲染")
    ap.add_argument("--list", action="store_true", help="只列出清单")
    ap.add_argument("--device", default="cuda:0")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    index_path = os.path.join(OUT_DIR, "index.json")
    index = {}
    if os.path.exists(index_path):
        try:
            index = json.load(open(index_path, encoding="utf-8"))
        except Exception:
            index = {}

    if args.list:
        print(f"缓存目录: {OUT_DIR}")
        for key, text in PHRASES.items():
            info = index.get(key)
            if info and os.path.exists(os.path.join(OUT_DIR, f"{key}.mulaw")):
                print(f"  ✓ {key:16s} {info.get('duration', 0):5.2f}s  {info.get('text')}")
            else:
                print(f"  ✗ {key:16s} （未渲染）  {text}")
        return 0

    todo = {k: v for k, v in PHRASES.items()
            if args.force or not os.path.exists(os.path.join(OUT_DIR, f"{k}.mulaw"))}
    if not todo:
        print("全部缓存已就绪，无需渲染。（想重做用 --force）")
        return 0

    print(f"待渲染 {len(todo)} 条 → {OUT_DIR}")
    import torch
    from qwen_tts import Qwen3TTSModel

    print(f"加载模型 {MODEL_DIR}（device={args.device}）")
    t0 = time.time()
    tts = Qwen3TTSModel.from_pretrained(
        MODEL_DIR, device_map=args.device, dtype=torch.bfloat16)
    print(f"加载完成 {time.time()-t0:.1f}s\n")

    failures = 0
    for key, text in todo.items():
        t0 = time.time()
        try:
            wavs, sr = tts.generate_custom_voice(
                text=text, speaker=SPEAKER, language="Chinese", instruct=INSTRUCT)
            audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
            tmp_wav = os.path.join(OUT_DIR, f"_{key}.tmp.wav")
            sf.write(tmp_wav, audio, sr)
            out_mulaw = os.path.join(OUT_DIR, f"{key}.mulaw")
            size = to_mulaw8k(tmp_wav, out_mulaw)
            os.remove(tmp_wav)
            dur = size / 8000  # μ-law 8k：1 字节 = 1 采样
            index[key] = {
                "text": text, "duration": round(dur, 3),
                "bytes": size, "speaker": SPEAKER,
                "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
            print(f"  ✓ {key:16s} {len(text):>3}字 → {dur:5.2f}s 音频  "
                  f"耗时 {time.time()-t0:5.1f}s  {size/1024:.1f}KB")
        except Exception as exc:
            failures += 1
            print(f"  ✗ {key:16s} 失败：{type(exc).__name__}: {exc}")

    json.dump(index, open(index_path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    total = sum(v.get("bytes", 0) for v in index.values())
    print(f"\n写入索引 {index_path}")
    print(f"缓存总量 {total/1024:.1f} KB，共 {len(index)} 条")
    if failures:
        print(f"⚠️ {failures} 条失败")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
