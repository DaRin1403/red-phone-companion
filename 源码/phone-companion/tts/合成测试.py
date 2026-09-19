# -*- coding: utf-8 -*-
"""
合成测试.py —— 用本地 Qwen3-TTS 把中文合成出来，并验证"文字 → 电话音频"整条链路。

步骤：
  1. 加载本地模型（第一次会较慢）
  2. 合成一段中文，测量耗时与实时率
  3. 用 ffmpeg 转成 8kHz 电话用的 μ-law，确认能落到电话侧格式
  4. 顺带列出可用音色/语言，便于挑声音

用法：
  python 合成测试.py                       # 默认文本
  python 合成测试.py "想合成的一句话"
  python 合成测试.py --model <模型目录> --speaker Vivian
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time

import numpy as np
import soundfile as sf

DEFAULT_TEXT = "喂，我是你的座机，这条语音是从电话听筒里播出来的。"
MODEL_DIR = r"D:\model_cache\tts\Qwen3-TTS-12Hz-0.6B-CustomVoice"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "产物")
INSTRUCT = (
    "用自然亲切的普通话女声，语速中等偏快，表达清晰沉稳，"
    "像在电话里跟熟人交代事情，不要念稿感。"
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("text", nargs="?", default=DEFAULT_TEXT)
    ap.add_argument("--model", default=MODEL_DIR)
    ap.add_argument("--speaker", default="Vivian")
    ap.add_argument("--language", default="Chinese")
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument("--dtype", default="bfloat16")
    ap.add_argument("--no-instruct", action="store_true")
    args = ap.parse_args()

    out_dir = os.path.abspath(OUT_DIR)
    os.makedirs(out_dir, exist_ok=True)

    import torch
    from qwen_tts import Qwen3TTSModel

    print(f"[1/4] 加载模型 {args.model}")
    print(f"      device={args.device} dtype={args.dtype}")
    t0 = time.time()
    model = Qwen3TTSModel.from_pretrained(
        args.model, device_map=args.device, dtype=getattr(torch, args.dtype)
    )
    print(f"      加载完成 {time.time()-t0:.1f}s")

    try:
        speakers = model.get_supported_speakers()
        langs = model.get_supported_languages()
        print(f"      可用音色: {speakers}")
        print(f"      可用语言: {langs}")
    except Exception as exc:
        print(f"      （音色列表读取失败：{exc}）")

    print(f"\n[2/4] 合成：{args.text!r}")
    if args.device.startswith("cuda"):
        torch.cuda.reset_peak_memory_stats()
    t0 = time.time()
    wavs, sr = model.generate_custom_voice(
        text=args.text,
        speaker=args.speaker,
        language=args.language,
        instruct="" if args.no_instruct else INSTRUCT,
    )
    dt = time.time() - t0
    audio = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
    dur = len(audio) / sr
    print(f"      完成 {dt:.2f}s | 采样率 {sr} | 时长 {dur:.2f}s | 实时率 {dur/dt:.1f}x")
    if args.device.startswith("cuda"):
        peak = torch.cuda.max_memory_allocated() / 1024 ** 3
        print(f"      显存峰值 {peak:.2f} GB")

    def report(tag, path, extra=""):
        size = os.path.getsize(path)
        print(f"      {tag}: {path}")
        print(f"        {size/1024:.0f} KB{extra}")

    # 原始 24k wav
    raw_wav = os.path.join(out_dir, "合成测试-原始.wav")
    sf.write(raw_wav, audio, sr)
    print("\n[3/4] 写出音频文件")
    report("原始", raw_wav, f"（{sr}Hz 单声道）")

    # 电话格式：8kHz μ-law 裸流 + 一个 wav 便于试听
    if shutil_which("ffmpeg"):
        mulaw = os.path.join(out_dir, "合成测试-电话8k.mulaw")
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
               "-i", raw_wav, "-ac", "1", "-ar", "8000", "-f", "mulaw", mulaw]
        subprocess.run(cmd, check=True)
        report("电话μ-law", mulaw, "（8kHz 单声道 裸流，可直接走 RTP）")

        tel_wav = os.path.join(out_dir, "合成测试-电话8k.wav")
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
               "-i", raw_wav, "-ac", "1", "-ar", "8000",
               "-acodec", "pcm_mulaw", tel_wav]
        subprocess.run(cmd, check=True)
        report("电话试听", tel_wav, "（8kHz μ-law 封装 wav，可直接播放）")
    else:
        print("      ⚠️ 未找到 ffmpeg，跳过电话格式转换")

    print("\n[4/4] 校验")
    if not np.isfinite(audio).all():
        print("      ✗ 音频含 NaN/Inf")
        return 1
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(audio ** 2)))
    print(f"      峰值 {peak:.3f}  有效值 {rms:.4f}")
    if peak < 0.01:
        print("      ✗ 音量过低，可能合成失败")
        return 1
    if peak >= 0.999:
        print("      ⚠️ 有削波，播报时需要限幅")
    print("      ✅ 合成正常")
    return 0


def shutil_which(name: str):
    from shutil import which
    return which(name)


if __name__ == "__main__":
    sys.exit(main())
