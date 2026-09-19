# -*- coding: utf-8 -*-
"""
端到端自测：用 Windows 自带 TTS 合成一句中文，按 CapsWriter 协议发给服务端，打印识别结果。

用途：不依赖任何硬件，验证「音频 -> 流式ASR -> 文字」整条链路。
用法：
    python 自测-端到端识别.py "要合成并识别的一句话"
"""
import asyncio
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
import websockets

SERVER = "ws://127.0.0.1:6016"
CHUNK_SEC = 0.5          # 每次发送 0.5 秒音频，模拟边说边发的流式行为
TEXT = sys.argv[1] if len(sys.argv) > 1 else "帮我把今天的拍摄计划整理一下"


def tts_to_wav(text: str, wav_path: Path) -> None:
    """用 Windows SAPI 合成中文语音（系统自带，无需联网）。"""
    ps = (
        "Add-Type -AssemblyName System.Speech;"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$s.Rate = 0;"
        "$s.SetOutputToWaveFile('%s');"
        "$s.Speak('%s');"
        "$s.Dispose()" % (wav_path, text.replace("'", "''"))
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True,
                   capture_output=True)


def load_as_16k_f32(wav_path: Path) -> np.ndarray:
    """读 wav 并转成 16kHz 单声道 float32 —— 与 CapsWriter 服务端约定一致。"""
    data, sr = sf.read(str(wav_path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != 16000:
        # 用线性重采样到 16k（自测够用；真实链路由客户端每 3 个样本取 1）
        n_out = int(len(mono) * 16000 / sr)
        idx = np.linspace(0, len(mono) - 1, n_out)
        mono = np.interp(idx, np.arange(len(mono)), mono).astype(np.float32)
    return mono


async def run(text: str, seg_duration: float = 2.0, seg_overlap: float = 0.5,
              quiet: bool = False) -> dict:
    wav = Path(tempfile.gettempdir()) / "capswriter_selftest.wav"
    if not quiet:
        print(f"[1/5] 合成语音：{text}")
    tts_to_wav(text, wav)
    if not quiet:
        print(f"      文件：{wav}  ({wav.stat().st_size / 1024:.0f} KB)")

    audio = load_as_16k_f32(wav)
    dur = len(audio) / 16000
    if not quiet:
        print(f"[2/5] 音频时长：{dur:.2f}s，采样率 16000，单声道 float32")

    task_id = str(uuid.uuid4())
    step = int(CHUNK_SEC * 16000)
    n_chunks = (len(audio) + step - 1) // step
    if not quiet:
        print(f"[3/5] 连接 {SERVER}，切片 {seg_duration}s/重叠 {seg_overlap}s，"
              f"分 {n_chunks} 片流式发送")

    t0 = time.time()
    first_partial = None
    final_text = None
    partials = []

    async with websockets.connect(SERVER, subprotocols=["binary"], max_size=None,
                                  proxy=None) as ws:
        for i in range(n_chunks):
            seg = audio[i * step:(i + 1) * step]
            msg = {
                "task_id": task_id,
                "source": "mic",
                "data": base64.b64encode(seg.astype(np.float32).tobytes()).decode(),
                "is_final": False,
                "time_start": t0,
                "seg_duration": seg_duration,
                "seg_overlap": seg_overlap,
                "context": "",
                "language": "chinese",
            }
            await ws.send(json.dumps(msg, ensure_ascii=False))
            await asyncio.sleep(CHUNK_SEC * 0.2)   # 模拟真实录音节奏

        # 最终包
        await ws.send(json.dumps({
            "task_id": task_id, "source": "mic", "data": "", "is_final": True,
            "time_start": t0, "seg_duration": seg_duration, "seg_overlap": seg_overlap,
            "context": "", "language": "chinese",
        }, ensure_ascii=False))

        if not quiet:
            print("[4/5] 等待识别结果...")
        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=deadline - time.time())
            except asyncio.TimeoutError:
                break
            res = json.loads(raw)
            text_out = res.get("text", "")
            if res.get("is_final"):
                final_text = text_out
                break
            else:
                partials.append(text_out)
                if first_partial is None:
                    first_partial = time.time() - t0
                if not quiet:
                    print(f"      流式中间结果 @{time.time() - t0:.2f}s: {text_out!r}")

    total = time.time() - t0
    hit = 0.0
    if final_text:
        hit = sum(1 for c in text if c in final_text) / max(len(text), 1)

    if not quiet:
        print(f"[5/5] 完成，总耗时 {total:.2f}s")
        print("=" * 62)
        print(f"原句     ：{text}")
        print(f"识别结果 ：{final_text!r}")
        print(f"首段中间结果延迟：{first_partial:.2f}s" if first_partial else "无中间结果")
        print(f"字符命中率：{hit * 100:.0f}%")
        print("=" * 62)

    return {"seg": f"{seg_duration}/{seg_overlap}", "final": final_text,
            "partial_at": first_partial, "total": total, "hit": hit,
            "partials": len(partials)}


async def compare(text: str) -> None:
    """对照实验：不同切片策略下的识别质量与首段延迟。"""
    configs = [(2.0, 0.5), (5.0, 1.0), (10.0, 1.5), (60.0, 4.0)]
    print("=" * 62)
    print(f"对照实验，原句：{text}")
    print("=" * 62)
    rows = []
    for seg, ov in configs:
        r = await run(text, seg, ov, quiet=True)
        rows.append(r)
        print(f"切片 {seg:>4}s/重叠 {ov:>3}s | 中间结果 {r['partials']:>2} 段 | "
              f"首段 {('%.2fs' % r['partial_at']) if r['partial_at'] else '  --  '} | "
              f"命中率 {r['hit'] * 100:>3.0f}% | 耗时 {r['total']:.2f}s")
        print(f"    -> {r['final']!r}")
    print("=" * 62)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUTF8", "1")
    if len(sys.argv) > 1 and sys.argv[1] == "--compare":
        sentence = sys.argv[2] if len(sys.argv) > 2 else TEXT
        asyncio.run(compare(sentence))
    else:
        asyncio.run(run(TEXT))
