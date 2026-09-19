# -*- coding: utf-8 -*-
"""一次性检查 CapsWriter 各模块的第三方依赖是否齐全，避免反复重启试错。"""
import importlib
import sys
import traceback

MODULES = [
    # 服务端
    "numpy", "soundfile", "sentencepiece", "onnxruntime", "sherpa_onnx",
    "gguf", "rich", "websockets", "watchdog", "pypinyin",
    "pystray", "PIL", "markdown", "tkhtmlview", "colorama",
    # 客户端
    "keyboard", "pynput", "pyclip", "sounddevice", "typer",
    "numba", "srt", "rapidfuzz", "openai", "ollama", "httpx", "pywin32",
    "win32gui", "win32process", "psutil",
]

ok, bad = [], []
for name in MODULES:
    try:
        importlib.import_module(name)
        ok.append(name)
    except Exception as e:
        bad.append((name, type(e).__name__, str(e)[:80]))

print("=== 可用 ===")
print(", ".join(ok) if ok else "(无)")
print("\n=== 缺失 ===")
if bad:
    for name, kind, msg in bad:
        print(f"  ✗ {name}: {kind}: {msg}")
else:
    print("(全部可用)")

print("\n=== ONNX 加速后端 ===")
try:
    import onnxruntime as ort
    print(ort.get_available_providers())
except Exception as e:
    print("读取失败:", e)

print("\n=== 关键链路导入测试 ===")
# 指到你自己的 CapsWriter-Offline 目录（本脚本很早就不用了，留档而已）
sys.path.insert(0, os.environ.get('CAPSWRITER_DIR', '源码/CapsWriter-Offline'))
try:
    from core.server.engines.sensevoice_onnx.asr_engine import SenseVoiceEngine  # noqa
    print("  ✓ SenseVoice 引擎导入成功")
except Exception:
    print("  ✗ SenseVoice 引擎导入失败:")
    traceback.print_exc(limit=3)

sys.exit(1 if bad else 0)
