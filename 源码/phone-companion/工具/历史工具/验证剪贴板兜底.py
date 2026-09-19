# -*- coding: utf-8 -*-
"""
验证「识别结果保留在剪贴板」功能：
1. 先把剪贴板设成一个可识别的哨兵值
2. 模拟按住 CapsLock 录音（走完整链路）
3. 读出剪贴板，看哨兵是否还在（还在=没生效；变了=识别结果已留底）

注意：测试期间不要把焦点放在会接收 Ctrl+V 的输入框里（本脚本自己会占用控制台）。
"""
import subprocess
import sys
import time

import keyboard
import pyclip

HOLD = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0
SENTINEL = "__剪贴板哨兵_未生效__"

print(f"[1/4] 设置剪贴板哨兵：{SENTINEL}")
pyclip.copy(SENTINEL)
time.sleep(0.3)
print(f"      当前剪贴板：{pyclip.paste().decode('utf-8', 'ignore')!r}")

print(f"[2/4] 模拟按住 CapsLock {HOLD} 秒（现在说话）")
keyboard.press('caps lock')
try:
    t0 = time.time()
    while time.time() - t0 < HOLD:
        time.sleep(0.1)
finally:
    keyboard.release('caps lock')

print("[3/4] 等待识别与上屏...")
time.sleep(3.0)

print("[4/4] 检查剪贴板")
now = pyclip.paste().decode('utf-8', 'ignore')
print(f"      当前剪贴板：{now!r}")
if now == SENTINEL:
    print("      ❌ 剪贴板被还原了 —— keep_result_in_clip 未生效（或未走到粘贴分支）")
elif now.strip() in ('', '.'):
    print("      ⚠️ 剪贴板已改变但内容为空/仅标点（本次可能没录到有效语音）")
    print("         → 说明覆盖发生了，但无法确认内容；建议真人说话再测一次")
else:
    print("      ✅ 剪贴板保留了识别结果 —— keep_result_in_clip 生效")
