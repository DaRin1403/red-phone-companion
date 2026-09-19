# -*- coding: utf-8 -*-
"""
性能剖析.py —— 拆开 TTS 的两段耗时：自回归 LM 解码 vs 声码器解码。

背景：Qwen3-TTS 是"LLM 生成声学 token + tokenizer 解码成波形"的两段式架构。
      实测整体实时率仅 0.31x，必须定位到具体哪一段慢。

做法：
  · 用 forward hook 抓住 lm_head 的输出，得到真实生成的 token 数
  · 分别计时 generate 与后续解码，算出每条 token 的耗时
  · 对比不同 attention 实现（sdpa / eager）与是否用编译

用法：
  python 性能剖析.py
  python 性能剖析.py --attn sdpa
"""
from __future__ import annotations

import argparse
import os
import time

import numpy as np
import torch

MODEL_DIR = os.environ.get("PHONE_TTS_MODEL_DIR",
                           r"D:\model_cache\tts\Qwen3-TTS-12Hz-0.6B-CustomVoice")
SPEAKER = "vivian"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--attn", default=None, help="attention 实现：sdpa / eager / flash_attention_2")
    ap.add_argument("--text", default="这条语音是从电话听筒里播出来的。")
    ap.add_argument("--repeat", type=int, default=3)
    args = ap.parse_args()

    from qwen_tts import Qwen3TTSModel

    kwargs = {"device_map": "cuda:0", "dtype": torch.bfloat16}
    if args.attn:
        kwargs["attn_implementation"] = args.attn

    print(f"=== 加载（attn={args.attn or '默认'}）===")
    t0 = time.time()
    tts = Qwen3TTSModel.from_pretrained(MODEL_DIR, **kwargs)
    print(f"加载 {time.time()-t0:.2f}s")

    lm = tts.model
    print("LM 类型:", type(lm).__name__)
    # 找 lm_head 或最后的线性层
    lm_head = None
    for name, mod in lm.named_modules():
        if name.endswith("lm_head") or (isinstance(mod, torch.nn.Linear) and mod.out_features > 10000):
            lm_head = (name, mod)
    print("输出层:", lm_head[0] if lm_head else "未找到")

    # 抓生成 token 数
    captured = {}

    def hook(_mod, _inp, out):
        try:
            logits = out[0] if isinstance(out, tuple) else out
            captured["codes"] = tuple(logits.shape)
        except Exception:
            pass

    handle = None
    if lm_head:
        handle = lm_head[1].register_forward_hook(hook)

    print(f"\n=== 逐次合成（文本{len(args.text)}字，共{args.repeat}次）===")
    print(f"{'序':>3} {'音频秒':>7} {'总耗时':>8} {'解码前':>8} {'输出形状':>22} {'音频/耗时':>9}")
    results = []
    for i in range(1, args.repeat + 1):
        captured.clear()
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        t0 = time.time()
        wavs, sr = tts.generate_custom_voice(
            text=args.text, speaker=SPEAKER, language="Chinese",
            instruct="用自然的普通话女声说。")
        torch.cuda.synchronize()
        dt = time.time() - t0
        audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
        dur = len(audio) / sr
        peak = torch.cuda.max_memory_allocated() / 1024**3
        codes = captured.get("codes")
        n_tokens = None
        if codes and len(codes) >= 2:
            # 形如 (batch, seq, vocab) 或 (batch, seq)
            n_tokens = codes[1] if len(codes) >= 3 else codes[-1]
        rate = dur / dt
        tok_info = f"{codes}" if codes else "未捕获"
        print(f"{i:>3} {dur:>7.2f} {dt:>8.2f} {'':>8} {tok_info:>22} {rate:>8.2f}x")
        results.append((dur, dt, n_tokens, peak))

    if handle:
        handle.remove()

    print("\n=== 汇总 ===")
    warm = results[1:] if len(results) > 1 else results
    avg_rate = sum(d for d, _, _, _ in warm) / sum(t for _, t, _, _ in warm)
    print(f"稳态实时率（跳过首次）: {avg_rate:.2f}x")
    print(f"显存峰值: {max(p for *_, p in results):.2f} GB")
    if results[0][2]:
        n = results[0][2]
        dur, dt, _, _ = results[0]
        print(f"生成 token 数 ≈ {n}，每条 token 耗时 ≈ {dt/max(n,1)*1000:.1f} ms")
        print(f"（若每条 token 耗时 >50ms，说明自回归解码本身是瓶颈）")

    # 单独测一次纯前向，估算单步成本
    print("\n=== 单步前向成本（不含采样循环）===")
    try:
        probe = torch.randint(0, 1000, (1, 32), device="cuda")
        emb = lm.get_input_embeddings()
        with torch.no_grad():
            x = emb(probe)
            for _ in range(3):
                out = lm(inputs_embeds=x, use_cache=True)
                torch.cuda.synchronize()
            t0 = time.time()
            for _ in range(10):
                out = lm(inputs_embeds=x, use_cache=True)
                torch.cuda.synchronize()
            per = (time.time() - t0) / 10 * 1000
        print(f"32-token 前向: {per:.1f} ms/次")
    except Exception as exc:
        print(f"前向探测失败: {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
