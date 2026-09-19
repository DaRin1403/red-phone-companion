# -*- coding: utf-8 -*-
"""
注意力算子对比.py —— 验证"慢"是否来自手写注意力实现。

背景：日志持续警告 "flash-attn is not installed. Will only run the manual PyTorch
      version"，而实测 code_predictor 单次前向要 9.2ms（5 层网络本应 1–2ms）。
      本脚本在**同一个模型**上分别用三种注意力实现对同一段文本计时对比：
        · manual（默认，手写实现）
        · sdpa（PyTorch 内置优化注意力）
        · eager（参考基准）
      若三者差异显著，说明换实现就能提速。
"""
from __future__ import annotations

import os
import time

import numpy as np
import torch

MODEL_DIR = os.environ.get("PHONE_TTS_MODEL_DIR",
                           r"D:\model_cache\tts\Qwen3-TTS-12Hz-0.6B-CustomVoice")
TEXT = "这条语音是从电话听筒里播出来的。"
SPEAKER = "vivian"

from qwen_tts import Qwen3TTSModel


def bench(attn_impl: str | None, runs: int = 3):
    kwargs = {"device_map": "cuda:0", "dtype": torch.bfloat16}
    if attn_impl:
        kwargs["attn_implementation"] = attn_impl
    tag = attn_impl or "默认(manual)"
    try:
        tts = Qwen3TTSModel.from_pretrained(MODEL_DIR, **kwargs)
    except Exception as exc:
        print(f"[{tag}] 加载失败：{type(exc).__name__}: {str(exc)[:150]}")
        return None

    # 检查实际生效的注意力类
    applied = set()
    for _name, mod in tts.model.named_modules():
        cn = type(mod).__name__
        if "Attention" in cn:
            applied.add(cn)
    print(f"[{tag}] 注意力模块类型: {sorted(applied)}")

    times, durs = [], []
    for i in range(runs):
        torch.cuda.synchronize()
        t0 = time.time()
        wavs, sr = tts.generate_custom_voice(
            text=TEXT, speaker=SPEAKER, language="Chinese",
            instruct="用自然的普通话女声说。")
        torch.cuda.synchronize()
        dt = time.time() - t0
        audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
        times.append(dt)
        durs.append(len(audio) / sr)
        print(f"[{tag}]   第{i+1}次: 音频{durs[-1]:.2f}s 耗时{dt:.2f}s "
              f"实时率{durs[-1]/dt:.2f}x")
    del tts
    torch.cuda.empty_cache()
    steady = sum(times[1:]) / max(len(times[1:]), 1)
    rate = (sum(durs[1:]) / max(len(durs[1:]), 1)) / steady if steady else 0
    print(f"[{tag}] 稳态: 耗时{steady:.2f}s 实时率 {rate:.2f}x\n")
    return {"impl": tag, "steady_s": round(steady, 2), "rate": round(rate, 3)}


print("=" * 66)
results = []
for impl in [None, "sdpa", "eager"]:
    r = bench(impl)
    if r:
        results.append(r)
print("=" * 66)
print(f"{'实现':<16}{'稳态耗时(s)':>12}{'实时率':>10}")
for r in results:
    print(f"{r['impl']:<16}{r['steady_s']:>12.2f}{r['rate']:>9.2f}x")

if len(results) >= 2:
    best = max(results, key=lambda r: r["rate"])
    worst = min(results, key=lambda r: r["rate"])
    gain = best["rate"] / worst["rate"] if worst["rate"] else 0
    print(f"\n最佳实现 {best['impl']}，比最慢快 {gain:.2f} 倍")
    if gain < 1.2:
        print("结论：换注意力实现几乎没有收益 → 瓶颈不在注意力算子，而在串行前向的固定开销")
    else:
        print("结论：注意力实现影响显著 → 应固定使用最佳实现")
