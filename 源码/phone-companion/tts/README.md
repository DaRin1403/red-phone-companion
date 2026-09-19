# 本地 TTS 环境 · 存档说明

> **状态：当前项目未使用。** 用户已明确舍弃"听筒播报回复"功能，回复内容看屏幕即可。
> 本目录的脚本与《本地TTS选型调研-留档.md》一起保留，供将来需要时快速恢复。

---

## 一、当前为什么不启用

实测 **Qwen3-TTS-12Hz-0.6B-CustomVoice 只有 0.31x 实时率**（生成 1 秒音频要 3 秒），
无法用于电话对话。根因是架构性的：**16 个码本、每帧需串行预测 15 次**，
约 180 次前向/秒音频。已排除的优化方向：

| 尝试 | 结果 |
|---|---|
| 换注意力实现（manual / sdpa / eager） | 差异仅 ±20%，**不是瓶颈** |
| 换采样参数 | 无效 |

调研结论（详见 `本地TTS选型调研-留档.md`）：
该类模型在 Transformers 路径下 RTF 本就是 2.64，只有 **Linux + vLLM** 才能到 6 倍速，
而 vLLM 不支持 Windows；叠加 **Windows WDDM** 让每次 kernel 启动延迟高一个数量级，
凡"逐 token 生成"的模型在本机都要打折。

---

## 二、要恢复时怎么做

### 1) 建环境（已实测可用的命令）

```powershell
# 普通包走国内镜像
C:\Users\<用户>\AppData\Local\Programs\Python\Python312\python.exe -m venv D:\phone-tts\.venv
D:\phone-tts\.venv\Scripts\python.exe -m pip install qwen-tts -i https://pypi.tuna.tsinghua.edu.cn/simple

# ⚠️ torch 必须从 PyTorch 官方源装 CUDA 版：
#    清华镜像只有 CPU 版，装上后 cuda.is_available() 会是 False
D:\phone-tts\.venv\Scripts\python.exe -m pip install --force-reinstall torch torchaudio `
    --index-url https://download.pytorch.org/whl/cu129

# 补依赖（作者 requirements 漏了）
D:\phone-tts\.venv\Scripts\python.exe -m pip install sentencepiece soundfile zstandard modelscope
```

**实测版本**（2026-09 时点）：
```
torch 2.8.0+cu129（编译含 sm_120，与本机 Blackwell 匹配）
qwen-tts 0.1.1
transformers 4.57.3
```

### 2) 下载模型

```powershell
$env:HF_HOME='D:\model_cache\hf'
D:\phone-tts\.venv\Scripts\python.exe tts\download-tts-model.py --size 0.6B
```

模型落在 `D:\model_cache\tts\Qwen3-TTS-12Hz-0.6B-CustomVoice`（**1.8GB，已保留**）。

### 3) 验证环境能不能真算

```powershell
D:\phone-tts\.venv\Scripts\python.exe tts\cuda冒烟测试.py
```

**这一步不能省**：`torch.cuda.is_available()` 返回 True **不代表能执行核函数**，
缺对应架构内核时第一次真正计算才会抛错。冒烟测试会实测 8 类核函数。

### 4) 生成提示音缓存

```powershell
D:\phone-tts\.venv\Scripts\python.exe tts\预热缓存.py
```

产物写入 `产物\缓存音频\`，电话就绪音会优先用它（零延迟）。

---

## 三、目录内容

| 文件 | 用途 |
|---|---|
| `tts-server.py` | TTS HTTP 服务（按句分段、chunked 流式输出） |
| `download-tts-model.py` | 模型下载（ModelScope / HF 镜像 / HF 官方三通道自动选择） |
| `cuda冒烟测试.py` | 验证 GPU 能否真正执行推理 |
| `合成测试.py` | 单句合成 + 输出电话格式 μ-law |
| `预热缓存.py` | 批量渲染固定话术 → `产物\缓存音频\` |
| `性能诊断.py` / `性能剖析.py` / `码本结构探查.py` / `注意力算子对比.py` | 定位性能瓶颈用的分析脚本 |

**当前仍在使用的只有 `预热缓存.py` 的产物**（`产物\缓存音频\` 里那 8 条 .mulaw 文件），
电话服务每次摘机都会播其中的 `ready.mulaw`。

---

## 四、如果要加回播报功能

**不建议继续用 Qwen3-TTS。** 调研已给出更好的选择：

1. **sherpa-onnx + Matcha zh-en 8kHz**（首选）
   - 纯 CPU ONNX，**原生 8kHz 输出**正好配电话
   - 自报 RTF 0.014（≈70x 实时率），且完全绕开 Blackwell / WDDM 的坑
   - `pip install sherpa-onnx soundfile` 即可，无需 CUDA
2. **Kokoro-82M-v1.1-zh**（备选）
   - Apache-2.0、82M 极小、CPU 上 5~6x
   - ⚠️ 中文 G2P 必须走**注音符号（Bopomofo）**路线，否则有明显"外国人味"
3. **GSV-TTS-Lite**（想要音色克隆时）
   - 实测 RTF 0.108 / 首包 133ms / 显存仅 0.8GB
   - 核心加速手段是 CUDA Graph，**正好对症 Windows/WDDM**

**关键设计建议**：电话场景该看的指标是**首包延迟（<500ms）**和**句级 RTF（<0.8）**，
而不是整段实时率。配合"句级流式 + 前向缓冲"，第 1 句合成完立刻推 RTP、
第 2 句在播放第 1 句时并行合成，对实时率的要求就宽松得多。
