# phone-companion

**红色座机语音终端 · 服务端**

把一台红色模拟座机（经 **Grandstream HT801** 网关）做成 DSH 的语音输入/通知终端：

```
摘机 → 听就绪音 → 说话 → 挂机 → 本地识别 → 自动发进 DSH
                                              ↓
             电话响铃 ← 我这一轮回复完成 ←───────┘
```

识别在本机（CapsWriter-Offline / SenseVoice-Small），全程不出本机、不依赖云端。

---

## 一、现在能做什么

| 能力 | 状态 | 真机验证 |
|---|---|---|
| 摘机 → 就绪音 → 收音 → 挂机 | ✅ | ✔ 用户已实测 |
| 本地语音识别（SenseVoice，DirectML） | ✅ | ✔ 真机识别准确 |
| 识别结果自动注入 DSH 输入框并发送 | ✅ | ✔ 用户已实测收到消息 |
| **DSH 回复完成 → 座机响铃** | ✅ | ✔ 见下方"真机验证记录" |
| 接听回铃 → 听筒放确认音 → 自动挂断 | ✅ | 代码完备，逻辑已离线验证 |
| 听筒里播报回复内容（TTS） | ⛔ **已砍掉** | 见 `tts/README.md` |

### 回铃是「通知铃」，不是等人接的电话

用户明确要求：**响约 5 秒后自动挂断，不需要走过去接听**——铃声本身就是"我这一轮说完了"的信号。

| 配置项 | 值 | 含义 |
|---|---|---|
| `ringbackEnabled` | `true` / `false` | **总开关**。`false` 时一声都不响（可随时暂停/恢复通知铃） |
| `ringTimeoutSeconds` | `5` | 响这么久就自动收线 |
| 网关 `P4010`–`P4019` | `c=1000/1000;` | 铃音节奏：响 1 秒、停 1 秒（**原本是 2000/4000，那样 5 秒里只响 2 秒**） |

> ⚠️ 改 `ringTimeoutSeconds` 时记得一起看网关的铃音节奏：
> 节奏是"响 2 秒停 4 秒"的话，把超时设成 5 秒只会听到 2 秒铃响然后静默 3 秒。
> 节奏用 `python ht801.py set P4010='c=1000/1000;'` 改（`set` 是通用写入入口）。

> TTS 播报是**主动放弃**的范围，不是没做完：用户当时的原话是
> "先不用这个文字转音频了，舍弃这个功能，主要就是能在当时那轮对话你说完的时候响铃就可以了"。
> 相关代码和模型都保留着，想恢复看 `tts/README.md`。

## 二、快速开始

```powershell
cd 源码\phone-companion

# 起服务（电话就位了就一直开着）
node src/phone-control.mjs start --debug

# 看服务状态（含 armed 等待状态、统计、当前通话）
node src/phone-control.mjs status

# 环境自检（不占端口，可以随时跑）
node src/phone-control.mjs selftest

# 全链路演练：模拟一次来电，走真实识别、真实注入
node src/phone-control.mjs 模拟来电 --seconds 3
```

配置改 `phone.config.json`，改完重启服务生效。

**关键配置项**

| 项 | 值 | 说明 |
|---|---|---|
| `localAddress` | `auto` | 自动探测通往网关的本机地址（多网卡必用） |
| `ataAddress` | `172.50.1.103` | HT801 地址 |
| `sipPort` / `rtpPort` | `5090` / `15004` | 本机 SIP / RTP 端口 |
| `workspace` | 例：`C:\Users\you\my-project` | ★必改★ 决定去哪个目录找 DSH 会话文件，写错就永远不响铃 |

## 三、真机验证记录

### 回铃链路（2026-09-17）

`工具/验证/验证真机响铃.mjs` 直接向 HT801 发 INVITE：

```
→ 已发出 INVITE（目标 172.50.1.103:5060）
← +   23ms  100 Trying
← +   33ms  180 Ringing        ← 座机在真机上确实振铃
（此后 10 秒无响应 = 响着但没人接，符合预期）
```

两条附带结论：

1. **HT801 不校验来源端口** —— 从 5091 发 INVITE 照样振铃。
   所以验证响铃不必停掉正在跑的语音服务，随便挑个空闲端口就行。
2. **遇到"180 之后几毫秒就来 200"要警惕** —— 那不是"响了两秒有人接"，
   是**话筒没挂好**（网关处于摘机状态，来电被直接接通）。
   红色老式话机的叉簧容易卡住，检查时手动按一下再松开。

### 上行链路（用户实测）

摘机 → 就绪音 → 说话 → 挂机 → 识别 → 注入 DSH 输入框 → 自动发送，全程跑通，
用户确认收到了消息。

## 四、架构

```
                        ┌─────────────────── phone-companion ───────────────────┐
 红色座机 ──电话线──► HT801 ──SIP/UDP 5090──► sip-endpoint.mjs                    │
                     (FXS)  ──RTP/UDP 15004──►   │                               │
                                                ▼                               │
                                        phone-machine.mjs  状态机              │
                                    摘机/收音/挂机/提交/回铃                     │
                                       │        │        │                     │
               ┌───────────────────────┘        │        └──────────────┐      │
               ▼                                ▼                       ▼      │
    phone-transcription.mjs            phone-inject.mjs          phone-replies  │
      ws://127.0.0.1:6016                Win32 剪贴板+CtrlV        轮询会话文件   │
      CapsWriter/SenseVoice              自动 ENTER             检测回合完成     │
                                                                     │         │
                                     DSH 会话文件 session.jsonl.zstd │         │
                                                                     ▼         │
                                                          回合完成 → 回铃 ──────┘
```

### 各模块职责

| 文件 | 职责 | 测试 |
|---|---|---|
| `src/phone-audio-lib.mjs` | μ-law 编解码、RTP 打包、重采样、提示音、文本清洗 | 15 项 |
| `src/sip-endpoint.mjs` | SIP 信令（来电应答、主动呼叫、ACK、BYE）、RTP 收发、DTMF、僵死通话清理 | 14 项 |
| `src/phone-machine.mjs` | 业务状态机：摘机→收音→提交→等回复→回铃→接听 | 20 项 |
| `src/phone-replies.mjs` | 只读监听 DSH 会话文件，检测"这一轮说完了" | 17 项 |
| `src/phone-inject.mjs` | 把识别结果注入 DSH 输入框并自动发送 | 18 项 |
| `src/phone-transcription.mjs` | CapsWriter WebSocket 客户端（16k 单声道 float32） | 15 项 |
| `src/phone-control.mjs` | 装配与 CLI（start / status / selftest / 模拟来电） | 5 项 |
| `src/phone-convert.mjs` | 音频格式转换小工具 | — |

`node --test "src/**/*.test.mjs"` → **146 项全通过**。

## 五、关键技术决策

### 1. μ-law 以 Python `audioop` 为准

网上流传的"0x00 = 最大正电平"是 AD&D 变体，**与本项目不一致**。
本实现逐条对照 Python 标准库 `audioop` 验证：

| PCM | 本实现 / audioop |
|---|---|
| +32124 | 0x80 |
| −32124 | 0x00 |
| 0 | 0xFF（静音） |

复核脚本：`工具/研究与调试/μlaw标准校验.mjs`。

### 2. 音频参数与参考实现（codex-redline）一致

- G.711 μ-law (PCMU)、8000 Hz、单声道、20 ms RTP 帧（160 字节）
- DTMF 走 RFC 2833/4733，动态 payload type 101
- 就绪音 660 Hz / 300 ms；错误音 220 Hz / 600 ms

### 3. 回复完成怎么检测（DSH 没有 Stop Hook）

DSH 不像 Codex 那样有 `Stop` Hook，所以改成**只读监听会话文件**。
踩过的坑都记在 `phone-replies.mjs` 的注释里，核心三条：

- 会话存为 `session.jsonl.zstd`，是**多 frame 拼接**的；
  Node 的 `zstdDecompressSync` 只解第一个 frame，会漏掉全部内容 →
  必须按魔数 `28 B5 2F FD` 切开逐个解压（实测 6000+ 帧全成功）。
- `turn/end` 事件的 `data.reason.kind === 'completed'` 才是"这一轮说完了"。
- **只在电话发起的回合之后才响铃**：进入等待时记录时间下界，
  之后完成的回合才算数，这样用户自己打字时不会被电话打扰。

### 4. 与参考实现的差异

| 参考实现（codex-redline，macOS） | 本项目（Windows） |
|---|---|
| Swift 辅助功能桥操作输入框 | Win32 `SetForegroundWindow` + 剪贴板 + Ctrl+V |
| OpenAI Realtime STT（云端） | 本地 CapsWriter + SenseVoice |
| Codex 的 `Stop` Hook | 只读轮询 DSH 会话文件 |
| 独立 USB 网口隔离 | 单网口静态 IP 隔离（本机 172.50.1.2/24） |

## 六、踩过的坑（都已在代码里注明原因）

| 现象 | 根因 |
|---|---|
| 一直响高频忙音，`audioRxFrames: 0` | 200 OK 少了 `Contact` 头 → 网关不发 ACK |
| 识别结果是乱码数字 | `Buffer.from(Float32Array)` 忽略 `byteOffset`，字节数算错 |
| 电话永远不响（1）| 状态机没调用 `arm()` → 监听器一直待机 |
| 电话永远不响（2）| 装配时没绑定 `reply-completed` → 检测到了也没人发起呼叫 |
| 电话永远不响（3）| `start()` 把**未完成的当前回合**也标成"已见" → 它完成时被跳过 |
| **过了电话后，电话再也不响** | 通话只靠对端 BYE 收尾；对端异常消失/验证脚本没发 BYE → `call` 对象永久留着 → `isBusy` 恒为 true → 回铃全被 `line-busy` 挡掉。已加 `sweepStaleCall()` 周期兜底 |
| **连续试铃几次后，呼叫永远返回 486 Busy Here** | `hangup()` 只处理"已接听"的通话，**没被接听的去电从来没发过 CANCEL** → 对端一直振铃、线路一直忙。这条路径正是"响 5 秒自动挂断"要走的，不修则通知铃会一直响下去并把线路占死 |
| **回铃目标被自检脚本改成本机自己** | 回铃目标从"谁打进来"学习，而验证脚本也往 5090 打 INVITE → 目标被学成 `172.50.1.2`，电话静默地不响。已排除本机来源 |
| 注入的文字跑到浏览器地址栏 | 注入时误按 Alt 使焦点跑到浏览器菜单按钮 |
| 第一次 ENTER 不发送 | 盲重试 3 次；改为"确认文字在框里 → 按一次 → 等框清空" |
| 服务随机死掉 | `emit('error')` 没有监听者会抛异常，已加默认空监听 |
| `loadConfig()` 静默用错地址 | 不传参时**不读文件**，返回 `192.168.82.x` 占位值 → 已修 |
| 重复启动只报 `EADDRINUSE` | 已加前置探测，直接提示"已有一个服务在跑（PID xxx）" |
| **启动器"有时候起不来"** | `PROJECT = join(HERE,'..')` 把根目录算高了一层（本文件就在 `phone-companion\` 里）→ 用 `源码\` 当 cwd → `Cannot find module '...\源码\src\phone-control.mjs'`。长期被误判成"detached spawn 在 DSH 里不work"。已修，并改用服务心跳判断运行状态 |
| 网关配置文件打印 `✓` 崩掉 | 控制台默认 GBK；已在入口 `sys.stdout.reconfigure(encoding='utf-8')` |
| **离线演练会把真座机弄响** | `模拟来电` 建服务时沿用了配置里的**真网关**地址当回铃目标 → 本该纯离线的演练打到了真设备上；工具自己还报 `假 ATA 收到回铃 INVITE: 否 ✗`。已改为指向假 ATA |
| **静音被 ASR 幻觉成「我。」并提交** | 摘机后没说话时，识别在静音上凭空编出一个字，还当成消息提交了（真机连着两次）。**光靠录音时长拦不住——静音也有时长**。已加峰值电平判据 `silencePeakThreshold`，静音整段不送识别 |
| **短文本按内容定位会锁错回合** | 注入「我。」时，更早的消息里也含「我。」；按内容定位若从头往后找就锁到了旧回合，等待回合号错位 → 又变漏响。已改为**从最新往旧找** |
| **等待被"正在生成的那条回复"消耗掉** | 用户在我还没写完时又说一句，`arm()` 的等待会被那条在生成的回复提前消耗 → 提前响铃，而真正属于用户的那一轮反而漏响。已改为**锁定"那句话所在回合"**（`_expectTurn`） |

## 七、目录结构

```
phone-companion/
├── phone.config.json          配置（改完重启生效）
├── ht801.py                   网关配置工具 inspect / configure / restore
├── 启动.mjs                   启动器（start / --stop / --status / --debug）
├── src/                       8 个模块 + 8 个测试文件
├── tts/                       TTS 相关（功能已砍，见 tts/README.md）
├── 产物/缓存音频/              预生成的提示音（μ-law 裸数据）
├── .runtime/                  运行产物：状态快照、日志、诊断输出（不进源码目录）
└── 工具/
    ├── 注入文字.ps1            键盘注入脚本（纯 ASCII，PowerShell 解析陷阱见下）
    ├── 验证/                   端到端验证脚本（含"验证真机响铃.mjs"）
    ├── 诊断/                   抓信令、报文对比、注入诊断、HT801 字段总表
    ├── 研究与调试/             μ-law 探测、会话文件解析实验
    └── 历史工具/               已退役的脚本（保留备查）
```

## 八、这台机器上的两个环境陷阱

1. **PowerShell 5.1 按 GBK 读无 BOM 的 UTF-8 文件**。
   带中文的 `.ps1` 会被解析错乱 → 本项目的 ps1 一律**纯 ASCII**。
   另外块注释里不能再出现 `#>`。
2. **控制台默认 GBK**。Python 脚本打印 `✓`/`✗` 一旦被重定向就崩，
   已统一在入口 `sys.stdout.reconfigure(encoding='utf-8')`。

## 九、安全边界

- SIP/RTP **无 TLS、无认证、无媒体加密**，只能跑在直连或可信隔离网段。
  ⚠️ 把网关接到普通路由器/共享热点上，SIP 端口会对同网段其他设备暴露。
- 本机与网关是独立 /24 网段（172.50.1.2 ↔ 172.50.1.103），不连外网。
- 识别全程本地，语音与文本不出本机。

## 十、许可证

MIT（音频与 SIP 模块的部分实现思路来自 prikevs/codex-redline，同为 MIT）。
