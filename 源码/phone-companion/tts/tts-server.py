# -*- coding: utf-8 -*-
"""
tts-server.py —— 本地 TTS HTTP 服务（供电话链路调用）

设计要点
--------
1. **按句分段合成**：Qwen3-TTS 的 non_streaming_mode=False 只是"模拟流式文本输入"，
   并不是真正的流式音频输出。电话场景要的是"第一句尽快出声"，所以这里按句末标点
   切分，逐句合成、逐句以 chunked 响应吐出去 —— 电话端边收边播。
2. **输出 16k 单声道 16bit PCM 裸流**：电话端再做 16k→8k 的 μ-law 转换，
   重采样放在 JS 侧是因为那边已经有经过 audioop 校准的实现。
3. **常驻进程，模型只加载一次**：首次请求再加载模型，避免空占显存。
4. 单线程串行推理（一把锁），电话链路本来就是一次一问一答。

接口
----
  GET  /health                  健康检查 + 模型状态
  GET  /voices                  可用音色与语言
  POST /tts    {text, speaker, language, instruct}
       → 响应体为 16k/mono/s16le 裸 PCM，逐句 chunked 输出
       响应头 X-Sample-Rate / X-Channels / X-Format / X-Chunk-Count

运行
----
  set HF_HOME=D:\\model_cache\\hf
  python tts-server.py --model Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice --port 8123
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import List, Optional

import numpy as np
import soundfile as sf

# ---------------------------------------------------------------- 全局状态

STATE = {
    "model": None,
    "sample_rate": None,
    "model_id": None,
    "device": None,
    "load_error": None,
    "loaded_at": None,
    "requests": 0,
    "last_synth_ms": None,
}
LOAD_LOCK = threading.Lock()
INFER_LOCK = threading.Lock()

DEFAULT_MODEL = os.environ.get("PHONE_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
DEFAULT_SPEAKER = os.environ.get("PHONE_TTS_SPEAKER", "Vivian")
DEFAULT_LANGUAGE = os.environ.get("PHONE_TTS_LANGUAGE", "Chinese")
DEFAULT_INSTRUCT = os.environ.get(
    "PHONE_TTS_INSTRUCT",
    "用自然亲切的普通话女声，语速中等偏快，表达清晰沉稳，像在电话里跟熟人交代事情，不要念稿感。",
)

# 句末标点：在这里切分，保证每段都是一句完整的话
SENTENCE_END = re.compile(r"(?<=[。！？!?；;…])\s*")


def split_sentences(text: str, max_chars: int = 120) -> List[str]:
    """按句末标点切句；单句过长时再按逗号/硬切细分。"""
    text = (text or "").strip()
    if not text:
        return []
    rough = [s for s in SENTENCE_END.split(text) if s and s.strip()]
    out: List[str] = []
    for s in rough:
        s = s.strip()
        while len(s) > max_chars:
            cut = -1
            for mark in ("，", ",", "、", " "):
                idx = s.rfind(mark, 0, max_chars)
                if idx > cut:
                    cut = idx
            if cut <= 0:
                cut = max_chars - 1
            out.append(s[: cut + 1].strip())
            s = s[cut + 1 :].strip()
        if s:
            out.append(s)
    return out


def load_model(model_id: str, device: str, dtype: str):
    """懒加载模型（同一进程只加载一次）。"""
    with LOAD_LOCK:
        if STATE["model"] is not None:
            return
        if STATE["load_error"]:
            raise RuntimeError(f"模型此前加载失败：{STATE['load_error']}")
        import torch
        from qwen_tts import Qwen3TTSModel

        t0 = time.time()
        print(f"[tts] 正在加载 {model_id}（device={device}, dtype={dtype}）...", flush=True)
        try:
            model = Qwen3TTSModel.from_pretrained(
                model_id,
                device_map=device,
                dtype=getattr(torch, dtype),
            )
        except Exception as exc:                       # 记录失败原因，避免反复重试
            STATE["load_error"] = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
            raise
        STATE["model"] = model
        STATE["model_id"] = model_id
        STATE["device"] = device
        STATE["loaded_at"] = time.time()
        print(f"[tts] 加载完成，用时 {time.time() - t0:.1f}s", flush=True)

        # 探测输出采样率
        try:
            wavs, sr = model.generate_custom_voice(
                text="测试", speaker=DEFAULT_SPEAKER, language=DEFAULT_LANGUAGE
            )
            STATE["sample_rate"] = int(sr)
            print(f"[tts] 输出采样率 = {sr}", flush=True)
        except Exception as exc:
            STATE["sample_rate"] = 24000
            print(f"[tts] 采样率探测失败（按 24000 处理）：{exc}", flush=True)


def synth_to_pcm16(model, text: str, speaker: str, language: str,
                   instruct: Optional[str]) -> bytes:
    """合成一段文本，返回 16bit 单声道 PCM（模型原生采样率）。"""
    with INFER_LOCK:
        wavs, sr = model.generate_custom_voice(
            text=text,
            speaker=speaker,
            language=language,
            instruct=instruct or "",
        )
    audio = wavs[0]
    if isinstance(audio, list):
        audio = np.asarray(audio)
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    # 限幅后转 16bit，避免削波爆音
    audio = np.clip(audio, -1.0, 1.0)
    return (audio * 32767.0).astype("<i2").tobytes(), int(sr)


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PhoneTTS/0.1"

    def log_message(self, fmt, *args):                 # 静默默认访问日志
        pass

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            ready = STATE["model"] is not None
            self._json(200, {
                "ok": True,
                "model_ready": ready,
                "model": STATE["model_id"],
                "device": STATE["device"],
                "sample_rate": STATE["sample_rate"],
                "load_error": STATE["load_error"],
                "requests": STATE["requests"],
                "last_synth_ms": STATE["last_synth_ms"],
            })
        elif self.path.startswith("/voices"):
            model = STATE["model"]
            speakers = languages = None
            if model is not None:
                try:
                    speakers = model.get_supported_speakers()
                    languages = model.get_supported_languages()
                except Exception:
                    pass
            self._json(200, {"speakers": speakers, "languages": languages,
                             "default_speaker": DEFAULT_SPEAKER,
                             "default_language": DEFAULT_LANGUAGE})
        else:
            self._json(404, {"ok": False, "error": "未知路径"})

    def do_POST(self):
        if not self.path.startswith("/tts"):
            self._json(404, {"ok": False, "error": "未知路径"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            req = json.loads(raw.decode("utf-8") or "{}")
        except Exception as exc:
            self._json(400, {"ok": False, "error": f"请求体解析失败：{exc}"})
            return

        text = (req.get("text") or "").strip()
        if not text:
            self._json(400, {"ok": False, "error": "缺少 text"})
            return
        speaker = req.get("speaker") or DEFAULT_SPEAKER
        language = req.get("language") or DEFAULT_LANGUAGE
        instruct = req.get("instruct") or DEFAULT_INSTRUCT

        try:
            load_model(STATE["model_id"] or DEFAULT_MODEL,
                       os.environ.get("PHONE_TTS_DEVICE", "cuda:0"),
                       os.environ.get("PHONE_TTS_DTYPE", "bfloat16"))
        except Exception as exc:
            self._json(500, {"ok": False, "error": f"模型加载失败：{exc}"})
            return

        sentences = split_sentences(text)
        if not sentences:
            self._json(400, {"ok": False, "error": "文本没有可朗读内容"})
            return

        model = STATE["model"]
        sr = STATE["sample_rate"] or 24000
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Sample-Rate", str(sr))
        self.send_header("X-Channels", "1")
        self.send_header("X-Format", "s16le")
        self.send_header("X-Chunk-Count", str(len(sentences)))
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        t_start = time.time()
        first_at = None
        try:
            for idx, sentence in enumerate(sentences):
                pcm, got_sr = synth_to_pcm16(model, sentence, speaker, language, instruct)
                sr = got_sr or sr
                if first_at is None:
                    first_at = time.time() - t_start
                    print(f"[tts] 首句出声 {first_at * 1000:.0f}ms（{len(sentence)} 字）", flush=True)
                self._write_chunk(pcm)
                if idx == 0:
                    # 首包之后把真实采样率告诉客户端（写在自定义头里会太早）
                    print(f"[tts] 采样率={sr}，句数={len(sentences)}", flush=True)
            self._write_chunk(b"")                     # 结束块
            STATE["requests"] += 1
            STATE["last_synth_ms"] = round((time.time() - t_start) * 1000)
            print(f"[tts] 完成 共 {len(sentences)} 句 "
                  f"{STATE['last_synth_ms']}ms（首句 {first_at * 1000:.0f}ms）", flush=True)
        except Exception as exc:
            traceback.print_exc()
            try:
                self._write_chunk(b"")
            except Exception:
                pass

    def _write_chunk(self, data: bytes):
        self.wfile.write(f"{len(data):x}\r\n".encode())
        if data:
            self.wfile.write(data)
        self.wfile.write(b"\r\n")
        self.wfile.flush()


def main():
    ap = argparse.ArgumentParser(description="本地 TTS 服务（电话链路专用）")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--preload", action="store_true", help="启动时立即加载模型")
    ap.add_argument("--show-sentences", help="只打印句子切分结果后退出（调试用）")
    args = ap.parse_args()

    if args.show_sentences is not None:
        for i, s in enumerate(split_sentences(args.show_sentences), 1):
            print(f"{i:>2}. [{len(s):>3}字] {s}")
        return

    STATE["model_id"] = args.model
    if args.preload:
        try:
            load_model(args.model, os.environ.get("PHONE_TTS_DEVICE", "cuda:0"),
                       os.environ.get("PHONE_TTS_DTYPE", "bfloat16"))
        except Exception as exc:
            print(f"[tts] 预加载失败（服务仍会启动，收到请求时重试）：{exc}", flush=True)

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[tts] 服务已启动 http://{args.host}:{args.port}  模型={args.model}", flush=True)
    print(f"[tts] 音色={DEFAULT_SPEAKER}  语言={DEFAULT_LANGUAGE}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[tts] 退出", flush=True)


if __name__ == "__main__":
    sys.exit(main())
