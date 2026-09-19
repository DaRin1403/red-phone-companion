# -*- coding: utf-8 -*-
"""
CUDA 冒烟测试：确认 torch 能在本机 Blackwell (sm_120) 显卡上真正执行核函数。
只读 is_available() 是不够的 —— 没有对应架构的内核时，is_available() 仍返回 True，
但第一次真正计算会抛 "no kernel image is available for execution on the device"。
"""
import sys
import time

import torch

print("torch        :", torch.__version__)
print("cuda 版本    :", torch.version.cuda)
print("架构支持列表 :", torch.cuda.get_arch_list())
print("显卡         :", torch.cuda.get_device_name(0))
print("计算能力     :", torch.cuda.get_device_capability(0))

if not torch.cuda.is_available():
    print("\n❌ CUDA 不可用，后续只能用 CPU")
    sys.exit(1)

cap = torch.cuda.get_device_capability(0)
sm = f"sm_{cap[0]}{cap[1]}"
archs = torch.cuda.get_arch_list()
print(f"\n本月显卡需要 {sm}；torch 编译支持: {archs}")
if sm not in archs and f"{sm[0:3]}{cap[0]}{cap[1]}" not in archs:
    print(f"⚠️  torch 未显式编译 {sm}（可能仍可通过兼容路径运行，下面实测）")

failures = []

def step(name, fn):
    try:
        t0 = time.time()
        result = fn()
        torch.cuda.synchronize()
        print(f"✓ {name:32s} {(time.time()-t0)*1000:7.1f} ms  {result}")
        return True
    except Exception as exc:
        print(f"✗ {name:32s} {type(exc).__name__}: {str(exc)[:160]}")
        failures.append((name, exc))
        return False

print("\n=== 逐项实测 GPU 核函数 ===")
step("张量创建与同步", lambda: tuple(torch.zeros(1024, device="cuda").shape))
step("矩阵乘法 (fp32)", lambda: float((torch.randn(512, 512, device="cuda") @ torch.randn(512, 512, device="cuda")).sum()))
step("矩阵乘法 (bf16)", lambda: float((torch.randn(512, 512, device="cuda", dtype=torch.bfloat16) @ torch.randn(512, 512, device="cuda", dtype=torch.bfloat16)).float().sum()))
step("矩阵乘法 (fp16)", lambda: float((torch.randn(512, 512, device="cuda", dtype=torch.float16) @ torch.randn(512, 512, device="cuda", dtype=torch.float16)).float().sum()))
step("卷积 1d", lambda: tuple(torch.nn.functional.conv1d(
    torch.randn(1, 8, 256, device="cuda"), torch.randn(16, 8, 3, device="cuda")).shape))
step("LayerNorm", lambda: tuple(torch.nn.LayerNorm(256).cuda()(torch.randn(4, 32, 256, device="cuda")).shape))
step("softmax", lambda: float(torch.softmax(torch.randn(64, 128, device="cuda"), dim=-1).sum()))
step("注意力式 einsum", lambda: tuple(torch.einsum('bhd,bhd->bh', torch.randn(2, 8, 64, device="cuda"), torch.randn(2, 8, 64, device="cuda")).shape))

print("\n=== 显存 ===")
free, total = torch.cuda.mem_get_info()
print(f"空闲 {free/1024**3:.2f} GB / 共 {total/1024**3:.2f} GB")

if failures:
    print(f"\n❌ {len(failures)} 项失败：{[n for n, _ in failures]}")
    sys.exit(1)
print("\n✅ 全部通过：GPU 可真正用于推理")
