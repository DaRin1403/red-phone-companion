# -*- coding: utf-8 -*-
"""
性能诊断.py —— 查清 TTS 合成慢的原因：是在 GPU 上跑还是掉到 CPU 了？

测量项：
  · 模型参数实际所在设备与 dtype
  · 首句（含预热）与后续句子的耗时对比 —— 区分"首次编译/预热开销"与"稳态速度"
  · 显存占用与 GPU 利用率变化
"""
from __future__ import annotations

import os
import sys
import time

import numpy as np

MODEL_DIR = r"D:\model_cache\tts\Qwen3-TTS-12Hz-0.6B-CustomVoice"
DEVICE = os.environ.get("PHONE_TTS_DEVICE", "cuda:0")
DTYPE = os.environ.get("PHONE_TTS_DTYPE", "bfloat16")
SPEAKER = "vivian"

import importlib.util

import torch
from qwen_tts import Qwen3TTSModel

print("=== 环境 ===")
print("torch        :", torch.__version__)
print("cuda 可用    :", torch.cuda.is_available())
print("flash-attn   :", "已安装" if importlib.util.find_spec("flash_attn") else "未安装")
if torch.cuda.is_available():
    print("显卡         :", torch.cuda.get_device_name(0))
    print("计算能力     :", torch.cuda.get_device_capability(0))

print("\n=== 加载模型 ===")
t0 = time.time()
model = Qwen3TTSModel.from_pretrained(MODEL_DIR, device_map=DEVICE, dtype=getattr(torch, DTYPE))
print(f"加载 {time.time()-t0:.2f}s")

# 探查模型参数真实设备
inner = getattr(model, "model", None)
if inner is not None:
    devices = {}
    dtypes = {}
    for name, p in inner.named_parameters():
        devices[str(p.device)] = devices.get(str(p.device), 0) + p.numel()
        dtypes[str(p.dtype)] = dtypes.get(str(p.dtype), 0) + p.numel()
    print("参数设备分布:", {k: f"{v/1e6:.1f}M" for k, v in devices.items()})
    print("参数类型分布:", {k: f"{v/1e6:.1f}M" for k, v in dtypes.items()})
    try:
        print("模型 .device  :", getattr(inner, "device", "n/a"))
    except Exception:
        pass

print("\n=== 逐句合成计时（区分预热与稳态）===")
sentences = [
    "喂，我是你的座机。",
    "这条语音是从电话听筒里播出来的。",
    "现在测试一下连续多句合成的速度。",
    "如果每句都要等很久，那通电话就没法打了。",
]
total_audio = 0.0
total_time = 0.0
for i, s in enumerate(sentences, 1):
    if torch.cuda.is_available():
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
    t0 = time.time()
    wavs, sr = model.generate_custom_voice(text=s, speaker=SPEAKER, language="Chinese",
                                           instruct="用自然的普通话女声说。")
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    dt = time.time() - t0
    audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
    dur = len(audio) / sr
    total_audio += dur
    total_time += dt
    peak = (torch.cuda.max_memory_allocated() / 1024**3) if torch.cuda.is_available() else 0
    print(f"  句{i}: 文字{len(s):>3}字 → 音频{dur:5.2f}s  耗时{dt:6.2f}s  "
          f"实时率{dur/dt:5.2f}x  显存峰值{peak:.2f}GB")

print(f"\n合计: 音频 {total_audio:.2f}s，耗时 {total_time:.2f}s，整体实时率 {total_audio/total_time:.2f}x")
if total_audio / total_time < 1.0:
    print("❌ 慢于实时 —— 电话场景不可用，需要优化")
else:
    print("✅ 快于实时")
