# 本地中文 TTS 选型调研（留档）

> **状态：暂不实施。** 用户已明确舍弃"听筒播报回复"功能，回复内容看屏幕即可。
> 本文留档，以备将来想加回播报时直接采用。
> 调研时间：2026-09-04

---

## 一、为什么要留这份档：现有方案为什么调不动

我们实测 Qwen3-TTS-12Hz-0.6B-CustomVoice 只有 **0.31x 实时率**（生成 1 秒音频要 3 秒），
当时试过换采样参数、换注意力实现（manual/sdpa/eager 差异仅 ±20%），都救不回来。

**调研给出了根本原因**：

| 事实 | 出处 |
|---|---|
| Qwen3-TTS 在 **HF Transformers 路径 RTF = 2.64**（即 0.38x），与我们的实测吻合 | [vllm-omni 官方性能文档](https://github.com/vllm-project/vllm-omni/blob/main/docs/design/qwen3_omni_tts_performance_optimization.md) |
| 只有切到 **vLLM-Omni** 才降到 RTF 0.16（6.25x）、TTFP 64ms | 同上 |
| **vLLM 原生不支持 Windows**，且 Blackwell(sm_120) 上 deep_gemm 有已知崩溃 | [vLLM #47130](https://github.com/vllm-project/vllm/issues/47130) |

**还有一个更普遍的坑——Windows 的 WDDM**：
每次 kernel 启动要走图形调度器，延迟达 20–50µs，而自回归解码是"每步几十个串行小 kernel"，
开销被成倍放大。实测证据：CosyVoice3-0.5B 在 Windows+4090 上 eager fp16 的 RTF 是 **2.43~3.28**，
加 CUDA Graph 才降到 0.76~0.95（[CosyVoice #1927](https://github.com/QwenAudio/CosyVoice/issues/1927)）。
（注：该 issue 建议的 TCC 模式在 GeForce 消费卡上不可用。）

**结论：凡是"逐 token 自回归 + 未优化运行时"的方案，在这台机器上都要打折。**
Qwen3-TTS 这条路在本环境基本可以放弃。

---

## 二、真正可行的替代方案（按推荐度）

### 🥇 sherpa-onnx + Matcha zh-en 8kHz，或 aishell3 8kHz

**为什么它是对的**：**纯 CPU 的 ONNX 非自回归模型，完全绕开 sm_120 / WDDM / vLLM 所有坑**，
而且**原生 8kHz 输出**——正好是电话要的格式，连重采样都省了。

| 模型 | 中文 | 实测 RTF | 显存 | 磁盘 |
|---|---|---|---|---|
| [Luigi/matcha-zh-en-8k](https://huggingface.co/Luigi/matcha-zh-en-8k) | ✅中英混读 | **0.014**（x86 CPU 4 线程，≈70x） | 0 | ~100MB |
| aishell3（sherpa-onnx VITS，174 说话人） | ✅ | Pi4 上 0.156（桌面估 20~50x） | 0 | 30~116MB |
| Kokoro-82M-v1.1-zh | ✅中英同句 | M3 Pro CPU 0.16（≈6x）；中文实现自报 5.4x | 0 | 47~311MB |

**matcha-zh-en-8k 的来历很关键**：它的模型卡写着是**为 Jetson Nano 上的电话客服产品做的**，
音频出口就是 8kHz G.711 通道——所以把 16kHz vocoder 蒸馏成 8kHz，专为电话场景设计。

⚠️ **风险**：单人发布、无独立复现，基座训练数据与商用许可未核实。**必须自己听 + 自测 RTF。**

**部署成本极低**：`pip install sherpa-onnx soundfile`，无需 CUDA、无需 Docker。

### 🥈 Kokoro-82M-v1.1-zh

- 许可最干净（**Apache-2.0**）、82M 极小、CPU 上 5~6x、**中英混读同一模型同一句**、100 个中文音色
- ⚠️ **最大的坑**：Kokoro 原生用**注音符号（Bopomofo）**音素集。若上游 G2P 走 IPA 路线，
  会有明显"外国人味"（音准但语调不对）。选它时 **G2P 链路比模型本身更重要**
- ⚠️ 弱 CPU 上会翻车：sherpa-onnx 在树莓派 4 线程实测 RTF 3.19

### 🥉 GSV-TTS-Lite（想要音色克隆时的 GPU 方案）

- 实测 **RTF 0.108 / 首包 133ms / 显存仅 0.8GB**（RTX 3050 Laptop），MIT 许可
- 它的核心加速手段是 **CUDA Graph + Nested KV Cache**——**正好对症 Windows/WDDM 的病**
- FlashAttn 可选（关掉只慢 13%，所以 sm_120 缺 flash-attn 不是阻塞项）
- ⚠️ 项目年轻（149 star），sm_120 + CUDA Graph 未在 Blackwell 上验证过

### 不推荐

| 方案 | 原因 |
|---|---|
| **Piper zh_CN-huayan** | 中文只有一个音色，且用 espeak-ng 前端导致**声调错误**（[issue #305](https://github.com/rhasspy/piper/issues/305) 三年未修）；主仓库已归档 |
| ChatTTS | 慢 + 协议受限 + 稳定性差 |
| Fish Speech S1 | 官方 issue 明确"实时场景不可行" |
| Spark-TTS | 原生 torch 路径仅 ~1x，快是靠 Linux 的 vLLM |
| F5-TTS | 速度分歧极大（0.17 / 0.63 / 3.0），且无流式设计 |
| 各种 vLLM 加速方案 | 依赖 Linux + WSL2，Blackwell 高风险 |

---

## 三、若将来要实施：两个工程要点

### 1. 别用裸抽取降采样

24k/16k → 8k **必须用多相滤波**（`soxr` 或 `scipy.signal.resample_poly`）+ 低通，
否则混叠噪声在 μ-law 里会变成刺耳的"金属声"。

### 2. 关键指标不是"整段 3x"，而是"首包延迟 + 不欠载"

电话场景该看的是：**首包 < 500ms** 和 **句级 RTF < 0.8**。
配合"句级流式 + 前向缓冲"（第 1 句合成完立刻推 RTP，第 2 句在播放第 1 句时并行合成），
对 RTF 的要求就退化成"平均 < 1 且方差小"，而不是整段 3x。

**加上"常用短语预缓存"**（我们已经在 `产物\缓存音频\` 里做好了 8 条：就绪音、错误提示等），
30~50% 的短回复（"嗯""好的""我在听"）可以零延迟播放。

### 3. 8kHz 通路上不要追音质

μ-law 的频率上限约 3.4kHz，**4kHz 以上的合成瑕疵在电话里根本听不到**。
选型应优先"**声调正确 / 可懂度 / 不吞字**"，不必追音色克隆与自然度。

---

## 四、建议的验证顺序（约 1 小时，将来用）

1. `pip install sherpa-onnx soundfile` → 跑 matcha-zh-en-8k，记录实测 RTF + 试听 3 句（20 分钟）
2. 同环境换 aishell3 + Kokoro v1.1-zh，横向比 RTF 与可懂度（15 分钟）
3. 若质量不够：`pip install gsv-tts-lite`，测 `infer_stream` 的 TTFT/RTF（20 分钟）

**决定性指标只看两个**：首包延迟（<500ms）、句级 RTF（<0.8）。
