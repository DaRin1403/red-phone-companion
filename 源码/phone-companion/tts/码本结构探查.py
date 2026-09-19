# -*- coding: utf-8 -*-
"""
码本结构探查.py —— 弄清 Qwen3-TTS 的多码本架构与各段耗时占比。

背景：talker 出第 1 个码本后，code_predictor 会逐帧自回归预测其余码本。
      若码本数较多，实际串行前向次数 = 帧数 × 码本数，这是慢的根因。

做法：
  · 打印 talker / code_predictor 的层数、码本数、vocab
  · 统计一次合成中 code_predictor.forward 被调用的次数与总耗时
  · 统计 tokenizer 解码（波形生成）耗时
"""
from __future__ import annotations

import time

import numpy as np
import torch

MODEL_DIR = r"D:\model_cache\tts\Qwen3-TTS-12Hz-0.6B-CustomVoice"
SPEAKER = "vivian"
TEXT = "这条语音是从电话听筒里播出来的。"

from qwen_tts import Qwen3TTSModel

print("=== 加载 ===")
tts = Qwen3TTSModel.from_pretrained(MODEL_DIR, device_map="cuda:0", dtype=torch.bfloat16)
lm = tts.model

def cfg_of(obj):
    c = getattr(obj, "config", None)
    if c is None:
        return {}
    out = {}
    for k in ("num_code_groups", "num_hidden_layers", "hidden_size", "vocab_size",
              "codec_eos_token_id", "num_attention_heads", "max_position_embeddings"):
        if hasattr(c, k):
            v = getattr(c, k)
            if not callable(v):
                out[k] = v
    return out

print("\n=== 顶层 config ===")
print(cfg_of(lm))
talker = getattr(lm, "talker", None)
print("\n=== talker ===")
print("类型:", type(talker).__name__ if talker else "无")
print(cfg_of(talker) if talker else "")
cp = getattr(talker, "code_predictor", None) if talker else None
print("\n=== code_predictor（sub-talker）===")
print("类型:", type(cp).__name__ if cp else "无")
print(cfg_of(cp) if cp else "")
if cp is not None:
    embs = getattr(cp, "get_input_embeddings", None)
    try:
        emb_list = cp.get_input_embeddings()
        if isinstance(emb_list, (list, tuple)):
            print(f"码本嵌入层数量: {len(emb_list)}（= 每帧需额外预测的码本数）")
            for i, e in enumerate(emb_list):
                print(f"   码本{i+1}: {tuple(e.weight.shape)}")
    except Exception as exc:
        print("读取嵌入层失败:", exc)

# ---- 统计各段调用次数与耗时
counter = {"cp_calls": 0, "cp_time": 0.0}

def wrap_counter(mod):
    orig = mod.forward

    def timed(*a, **kw):
        t0 = time.time()
        out = orig(*a, **kw)
        torch.cuda.synchronize()
        counter["cp_calls"] += 1
        counter["cp_time"] += time.time() - t0
        return out

    mod.forward = timed
    return orig

orig_cp_forward = None
if cp is not None:
    cpm = getattr(cp, "model", cp)
    orig_cp_forward = wrap_counter(cpm)

print("\n=== 实测一次合成 ===")
torch.cuda.synchronize()
t0 = time.time()
with torch.no_grad():
    wavs, sr = tts.generate_custom_voice(
        text=TEXT, speaker=SPEAKER, language="Chinese",
        instruct="用自然的普通话女声说。")
torch.cuda.synchronize()
total = time.time() - t0
audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
dur = len(audio) / sr

print(f"文字 {len(TEXT)} 字 → 音频 {dur:.2f}s")
print(f"总耗时        : {total:.2f}s  （实时率 {dur/total:.2f}x）")
print(f"code_predictor: 调用 {counter['cp_calls']} 次，累计 {counter['cp_time']:.2f}s "
      f"（占 {counter['cp_time']/total*100:.0f}%）")
if counter["cp_calls"]:
    print(f"                平均每次 {counter['cp_time']/counter['cp_calls']*1000:.1f} ms")
print(f"其余部分      : {total - counter['cp_time']:.2f}s （含 talker 主解码 + 波形生成）")

# 推算帧数
frames = round(dur * 12)
print(f"\n按 12Hz 推算帧数 ≈ {frames}")
if counter["cp_calls"] and frames:
    print(f"每帧 code_predictor 调用 ≈ {counter['cp_calls']/frames:.1f} 次 → 即码本数-1")

if orig_cp_forward is not None:
    cp.model.forward = orig_cp_forward
