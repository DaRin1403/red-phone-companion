# -*- coding: utf-8 -*-
"""
模型下载：把 Qwen3-TTS 权重拉到本地缓存（D 盘），供 tts-server.py 使用。

策略：
  1. 先试 ModelScope（国内直连，通常最快）
  2. 再试 HuggingFace 镜像 hf-mirror.com
  3. 最后试 HuggingFace 官方（走系统代理）
按顺序找到能用的通道下载，任一成功即停止。

用法：
  python download-tts-model.py                    # 默认下载 0.6B
  python download-tts-model.py --size 1.7B        # 下载 1.7B（质量更好）
  python download-tts-model.py --probe            # 只探测通道可用性，不下载
"""
from __future__ import annotations

import argparse
import os
import socket
import sys
import time
import urllib.request

# 各通道的候选模型 id
CANDIDATES = {
    "0.6B": [
        "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    ],
    "1.7B": [
        "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    ],
}


def probe(url: str, timeout: float = 8.0) -> tuple[bool, float, str]:
    """探测一个 URL 是否可达，返回 (可达, 耗时秒, 说明)"""
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "phone-companion/0.1"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return True, time.time() - t0, f"HTTP {resp.status}"
    except Exception as exc:
        return False, time.time() - t0, f"{type(exc).__name__}: {str(exc)[:100]}"


def probe_channels():
    print("=== 通道探测 ===")
    tests = [
        ("ModelScope", "https://www.modelscope.cn/api/v1/models/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"),
        ("HF 镜像 hf-mirror", "https://hf-mirror.com/api/models/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"),
        ("HF 官方", "https://huggingface.co/api/models/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"),
        ("代理 7897", None),
    ]
    results = {}
    for name, url in tests:
        if url is None:
            s = socket.socket()
            s.settimeout(3)
            try:
                s.connect(("127.0.0.1", 7897))
                results[name] = (True, 0.0, "代理端口可连")
            except Exception as exc:
                results[name] = (False, 0.0, str(exc)[:60])
            finally:
                s.close()
            continue
        ok, dt, info = probe(url)
        results[name] = (ok, dt, info)
    for name, (ok, dt, info) in results.items():
        print(f"  {'✓' if ok else '✗'} {name:22s} {dt:5.2f}s  {info}")
    return results


def download_modelscope(model_id: str, target_dir: str) -> str:
    from modelscope import snapshot_download          # type: ignore
    print(f"[ModelScope] 下载 {model_id} → {target_dir}")
    path = snapshot_download(model_id, local_dir=target_dir)
    return path


def download_hf(model_id: str, target_dir: str, endpoint: str | None) -> str:
    if endpoint:
        os.environ["HF_ENDPOINT"] = endpoint
        print(f"[HuggingFace] 使用端点 {endpoint}")
    from huggingface_hub import snapshot_download      # type: ignore
    print(f"[HuggingFace] 下载 {model_id} → {target_dir}")
    path = snapshot_download(repo_id=model_id, local_dir=target_dir,
                             max_workers=4, resume_download=True)
    return path


def free_gb(drive: str) -> float:
    import shutil
    try:
        return shutil.disk_usage(drive).free / 1024 ** 3
    except Exception:
        return -1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", choices=["0.6B", "1.7B"], default="0.6B")
    ap.add_argument("--probe", action="store_true", help="只探测通道")
    ap.add_argument("--target", default=None, help="本地目录（默认 D:\\model_cache\\tts\\<模型名>）")
    args = ap.parse_args()

    results = probe_channels()
    if args.probe:
        return 0

    model_id = CANDIDATES[args.size][0]
    short = model_id.split("/")[-1]
    target = args.target or os.path.join("D:\\model_cache\\tts", short)
    os.makedirs(target, exist_ok=True)
    print(f"\n目标目录: {target}")
    print(f"D 盘剩余: {free_gb('D:\\\\'):.1f} GB\n")

    attempts = []
    if results.get("ModelScope", (False,))[0]:
        attempts.append(("modelscope", lambda: download_modelscope(model_id, target)))
    if results.get("HF 镜像 hf-mirror", (False,))[0]:
        attempts.append(("hf-mirror", lambda: download_hf(model_id, target, "https://hf-mirror.com")))
    if results.get("HF 官方", (False,))[0]:
        attempts.append(("huggingface", lambda: download_hf(model_id, target, None)))

    if not attempts:
        print("❌ 三个通道都不可达，无法下载")
        return 1

    for name, fn in attempts:
        try:
            t0 = time.time()
            path = fn()
            print(f"\n✅ 下载成功（通道 {name}，用时 {time.time()-t0:.0f}s）")
            print(f"   路径: {path}")
            return 0
        except ModuleNotFoundError as exc:
            print(f"⚠️ 通道 {name} 缺依赖：{exc}（跳过）")
        except Exception as exc:
            print(f"⚠️ 通道 {name} 失败：{type(exc).__name__}: {str(exc)[:200]}")
            print("   换下一个通道…")

    print("\n❌ 所有通道都失败")
    return 1


if __name__ == "__main__":
    sys.exit(main())
