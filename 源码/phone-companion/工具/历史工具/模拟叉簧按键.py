# -*- coding: utf-8 -*-
"""
模拟「按住 CapsLock 说话」这一物理动作，验证 CapsWriter 的触发链路。

背景：本项目计划用电话叉簧开关（提机/挂机）通过 Arduino 模拟 USB 键盘按键，
      直接驱动 CapsWriter 录音。本脚本先在软件层面验证这条链路成立：
      按下 CapsLock → 保持 → 松开，观察客户端是否创建录音任务。

用法：
    python 模拟叉簧按键.py            # 默认按住 2.5 秒
    python 模拟叉簧按键.py 5          # 按住 5 秒
"""
import sys
import time

import keyboard

HOLD = float(sys.argv[1]) if len(sys.argv) > 1 else 2.5

print(f"[1/3] 按下 CapsLock（模拟提机）")
keyboard.press('caps lock')
t0 = time.time()

print(f"[2/3] 保持 {HOLD} 秒 —— 现在对着麦克风说话（模拟通话）")
try:
    while time.time() - t0 < HOLD:
        remain = HOLD - (time.time() - t0)
        print(f"      剩余 {remain:.1f}s ...", end='\r')
        time.sleep(0.1)
except KeyboardInterrupt:
    pass

print(f"\n[3/3] 松开 CapsLock（模拟挂机）")
keyboard.release('caps lock')
time.sleep(2.0)
print("完成。请查看客户端输出中的「任务标识 / 录音时长 / 识别结果」。")
