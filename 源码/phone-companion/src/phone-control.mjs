/**
 * phone-control.mjs —— 装配入口：把各模块接成可运行的电话服务
 *
 * 闭环：
 *   摘机 → 就绪音 → 收音频 → 挂机 → 本地识别 → 注入 DSH 提交
 *   → 监听会话，等"我这一轮回复完成" → 主动呼叫电话响铃
 *
 * 子命令：
 *   start          启动服务（前台运行，Ctrl+C 退出）
 *   status         打印当前状态（读取运行时快照）
 *   selftest       不碰硬件的自检：SIP 端口能否绑定、识别服务是否在、会话目录能否找到、注入脚本能否定位窗口
 *   模拟来电        用软件模拟一台 ATA 摘机拨号，走完整闭环（不需要硬件即可验证整条链路）
 *
 * 用法：
 *   node src/phone-control.mjs selftest
 *   node src/phone-control.mjs start --config phone.config.json
 *   node src/phone-control.mjs 模拟来电 --seconds 3 --text "帮我查天气"
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import dgram from 'node:dgram';

import { SipEndpoint, buildSdp } from './sip-endpoint.mjs';
import { TranscriptionClient, DEFAULT_ASR_URL } from './phone-transcription.mjs';
import { DshInjector } from './phone-inject.mjs';
import { SessionWatcher, resolveSessionFile } from './phone-replies.mjs';
import { TtsClient } from './phone-tts.mjs';
import { PhoneMachine } from './phone-machine.mjs';
import { tone, makeRtp } from './phone-audio-lib.mjs';
// 会话目录名编码工具放在 工具/研究与调试/ 下（重组后的位置）
import { encodeWorkspace } from '../工具/研究与调试/会话目录命名.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
const RUNTIME_DIR = join(PROJECT_ROOT, '.runtime');

// ⚠️ 这里的地址是**早年演示网段的占位值**，不是本机实际配置。
//    正常运行时都会被 phone.config.json 覆盖（见 loadConfig）。
//    只有在配置文件缺失时才会用到，那时多半是连不通的 —— 别拿它当真相。
export const DEFAULT_CONFIG = {
  // 本机在电话网段上的地址（HT801 会往这里发 SIP/RTP）
  localAddress: '192.168.82.1',
  sipPort: 5090,
  rtpPort: 15004,
  sipUser: 'companion',

  // HT801/HT802 侧
  ataAddress: '192.168.82.100',
  ataSipPort: 5060,
  ataUser: 'redline',

  // 本地识别服务
  asrUrl: DEFAULT_ASR_URL,
  asrTimeoutMs: 30000,

  // DSH 工作区根目录 —— 用来定位会话文件（不能取 process.cwd()：
  // 从 源码\phone-companion 下运行时会得到子目录，导致编码出的会话目录名不对）
  // ⚠️ 这里**不设默认路径**：它是每个人自己的工作区，写死成作者的路径
  //    会让别人 clone 下来静默失效（回铃永远不响还查不出原因）。
  //    没配就在启动时明确报错并指路 phone.config.json。
  workspace: process.env.PHONE_WORKSPACE || '',
  injectTitleMatch: 'DeepSeek Harness|DSH|localhost:3080|127\\.0\\.0\\.1:3080',

  // 会话监听
  sessionPollMs: 1000,
  replyTimeoutMs: 900000,

  // 整段录音峰值低于此值 → 判定"没人说话"，不送识别（防止 ASR 在静音上凭空编字）
  silencePeakThreshold: 300,

  // 就绪音/回铃
  phrasesDir: join(PROJECT_ROOT, '产物', '缓存音频'),
  // 回铃总开关：false 时一声都不响
  ringbackEnabled: true,
  // 通知铃按【次数】算：响 ringCount 声就自动挂断，不需要用户接听
  ringCount: 1,
  // 网关实际铃音节奏（HT801 的 P4010），必须与网关一致，否则"响几次"会算错
  ringCadenceOnMs: 1000,
  ringCadenceOffMs: 1000,
  ringRings: 2,
  // 安全上限：节奏配错也不会一直响
  ringTimeoutSeconds: 10,
};

export function loadConfig(path = null) {
  const cfg = { ...DEFAULT_CONFIG };
  // ⚠️ 不传路径时读项目自带的 phone.config.json，**不要**直接返回 DEFAULT_CONFIG。
  //    早先这里是"不传就不读文件"，而 DEFAULT_CONFIG 里是 192.168.82.x 网段的占位值。
  //    调用方以为读到了真配置，实际把包打到一个不存在的地址上，现象是
  //    "INVITE 发出去了但一个响应都没有" —— 极容易被误判成网关拒绝。
  //    写"验证真机响铃"时真踩了这个坑，一次误判浪费了一轮排查。
  const file = path ?? join(PROJECT_ROOT, 'phone.config.json');
  if (existsSync(file)) {
    // 容错：某些 Windows 工具（如 PowerShell 的 Set-Content -Encoding UTF8）
    // 会在文件开头写入 UTF-8 BOM，而 JSON.parse 不接受 BOM。
    // 这里主动剥掉，避免"手动改配置"这个最常见的操作直接失败。
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    Object.assign(cfg, JSON.parse(raw));
  } else if (path) {
    console.warn(`[配置] 指定了 ${path} 但文件不存在，改用内置默认值（多为占位地址，未必能用）`);
  }
  // 环境变量覆盖（便于临时改地址试）
  for (const [env, key] of [
    ['PHONE_LOCAL_ADDRESS', 'localAddress'],
    ['PHONE_ATA_ADDRESS', 'ataAddress'],
    ['PHONE_SIP_PORT', 'sipPort'],
    ['PHONE_RTP_PORT', 'rtpPort'],
    ['PHONE_ASR_URL', 'asrUrl'],
    ['PHONE_WORKSPACE', 'workspace'],
  ]) {
    if (process.env[env]) cfg[key] = process.env[env];
  }
  cfg.sipPort = Number(cfg.sipPort);
  cfg.rtpPort = Number(cfg.rtpPort);
  cfg.ataSipPort = Number(cfg.ataSipPort);
  return cfg;
}

// ---------------------------------------------------------------- 组装

/**
 * 探测"从本机到网关，应该用哪个本机地址"。
 *
 * 为什么需要：多网卡机器（同时有 WiFi 和直连网线）上，
 * 若把 WiFi 地址写进 SDP 的 c= 行，网关会把音频发到错误的网卡 → 全程无声。
 * 用 UDP connect 技巧让内核按路由选出正确地址（不真的发包）。
 */
export async function detectLocalAddress(gatewayAddress, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { s.close(); } catch { /* 忽略 */ }
      resolve(v ?? null);
    };
    try {
      s.connect(9, gatewayAddress, () => finish(s.address()?.address));
    } catch {
      finish(null);
    }
    setTimeout(() => finish(null), timeoutMs);
  });
}

/** 把 config 变成一个可运行的 {machine, sip, watcher, ...} 组合 */
export function buildService(cfg, { asr = null, injector = null } = {}) {
  const sip = new SipEndpoint({
    localAddress: cfg.localAddress,
    sipPort: cfg.sipPort,
    rtpPort: cfg.rtpPort,
    user: cfg.sipUser,
  });
  sip.ringConfig = {
    targetAddress: cfg.ataAddress,
    targetSipPort: cfg.ataSipPort,
    targetUser: cfg.ataUser,
  };

  // 从实际来电中学习 HT801 的真实地址与端口：
  // 配置里写死的地址在换网段/换网关后可能失效，而"刚才谁打进来的"永远是对的。
  //
  // ⚠️ 但**必须排掉本机自己发出的呼叫**。
  //    验证脚本（工具/验证/验证在跑的服务.mjs）会从本机地址往 5090 打一条模拟 INVITE，
  //    它同样会触发 call:incoming —— 结果把回铃目标"学"成了本机地址 172.50.1.2。
  //    真机上看到过：跑完一次验证，紧接着回合完成时回铃被发给我们自己，
  //    电话当然不响，而且日志看起来一切正常（目标地址被悄悄改掉了）。
  //    判据：来源地址等于本机地址、或是回环地址 → 是自己人，不学。
  const isSelfOriginated = (addr) => addr === cfg.localAddress
    || addr === '127.0.0.1' || addr === 'localhost' || addr === '::1';

  sip.on('call:incoming', (snap) => {
    const from = snap?.remote ?? snap?.peer;
    if (!from?.address) return;
    if (isSelfOriginated(from.address)) {
      console.log(`[回铃] 来电来自本机 ${from.address}（多半是验证脚本），不据此更新回铃目标`);
      return;
    }
    if (sip.ringConfig.targetAddress !== from.address) {
      console.log(`[回铃] 目标地址从配置的 ${sip.ringConfig.targetAddress} 更新为来电实际地址 ${from.address}`);
    }
    sip.ringConfig.targetAddress = from.address;
    if (from.port) sip.ringConfig.targetSipPort = from.port;
  });

  const asrClient = asr ?? {
    async transcribe(mulaw) {
      const client = new TranscriptionClient({ url: cfg.asrUrl, timeoutMs: cfg.asrTimeoutMs });
      try {
        await client.connect();
        client.start();
        client.push(mulaw);
        return await client.finish();
      } finally {
        client.close();
      }
    },
  };

  const inject = injector ?? new DshInjector({ titleMatch: cfg.injectTitleMatch });

  const tts = new TtsClient({ cacheDir: cfg.phrasesDir });
  const phrases = {
    async get(key) {
      try { return await tts.cachedPhrase(key); } catch { return null; }
    },
  };

  const sessionRoot = join(os.homedir(), '.dsh', 'sessions', encodeWorkspace(cfg.workspace));

  const watcher = new SessionWatcher({ sessionDir: sessionRoot, pollMs: cfg.sessionPollMs });

  const machine = new PhoneMachine(
    { sip, asr: asrClient, injector: inject, replies: watcher, phrases },
    {
      silencePeakThreshold: cfg.silencePeakThreshold,
      ringbackEnabled: cfg.ringbackEnabled,
      ringCount: cfg.ringCount,
      ringCadenceOnMs: cfg.ringCadenceOnMs,
      ringCadenceOffMs: cfg.ringCadenceOffMs,
      ringRings: cfg.ringRings,
      ringTimeoutSeconds: cfg.ringTimeoutSeconds,
    },
  );

  // 回复完成 → 回铃。
  // ⚠️ 这里必须绑定：监听器只负责"检测到回合完成"，真正发起呼叫的是状态机。
  // 真机上出现过"输入链路全通但回复完不响铃"，根因是两个漏洞叠加：
  //   ① 状态机没调用 arm() → 监听器一直待机，永远检测不到完成
  //   ② 这个绑定缺失 → 即使检测到了也没人发起呼叫
  // 两处都补上了，并且用 _ringBound 防重复绑定（重复绑定会导致响铃多次）。
  const service = {
    sip, asr: asrClient, injector: inject, watcher, machine, sessionRoot, cfg,
  };
  service.ringHandler = async (info) => {
    console.log(`[回复] 第 ${info.turn} 轮完成（${info.chars} 字）`);
    const res = await machine.onReplyCompleted({ text: info.reply });
    if (res.reason === 'ringback-disabled') {
      console.log('[回铃] 响铃已暂停（config 里 ringbackEnabled=false），这一轮不响');
    } else if (!res.rung) {
      console.log(`[回铃] 未响铃：${res.reason}`);
    } else {
      console.log(`[回铃] 已呼叫 ${cfg.ataAddress}:${cfg.ataSipPort}`);
    }
    return res;
  };
  if (service._ringBound) watcher.off('reply-completed', service._ringBound);
  service._ringBound = service.ringHandler;
  watcher.on('reply-completed', service._ringBound);
  watcher.on('warn', (w) => console.warn(`[监听] ${JSON.stringify(w)}`));
  // 启动快照：必须能看到"几个回合已完成 / 几个还在进行"。
  // 早先监听器把未完成的当前回合也标成已见，导致它完成时被跳过、真机不响铃；
  // 而当时日志里没有任何一行能反映这件事，只能靠读源码猜。补上这行。
  watcher.on('ready', (i) => {
    service.watcherReady = i;
    const pending = i.turns - i.completed;
    const tail = cfg.ringbackEnabled === false
      ? '（响铃已暂停，完成也不会响）'
      : '（完成后会响铃）';
    console.log(
      `[监听] 会话已载入：${i.turns} 个回合，已完成 ${i.completed}（记为已见），进行中 ${pending}${tail}`,
    );
  });
  watcher.on('log', (i) => console.log(`[监听] ${i.msg}`));

  return service;
}

/** 把状态写进 .runtime/phone-status.json 供 status 子命令读取 */
export function writeStatus(service, extra = {}) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    const snap = {
      at: new Date().toISOString(),
      pid: process.pid,
      ...service.machine.snapshot,
      watcher: { armed: service.watcher.armed, ...service.watcher.stats },
      injector: service.injector.stats,
      sessionRoot: service.sessionRoot,
      ...extra,
    };
    writeFileSync(join(RUNTIME_DIR, 'phone-status.json'), JSON.stringify(snap, null, 2), 'utf8');
    return snap;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 自检

async function cmdSelftest(cfg) {
  const results = [];
  const ok = (name, detail = '') => results.push({ ok: true, name, detail });
  const bad = (name, detail = '') => results.push({ ok: false, name, detail });

  // 1) SIP/RTP 端口状态
  //    注意：如果服务本身已经在运行，这两个端口就是被它占着的，
  //    此时"绑定失败"不是错误，而是"已经在正常工作"。要区分对待。
  {
    const busy = await new Promise((resolve) => {
      const s = dgram.createSocket('udp4');
      let done = false;
      const finish = (v) => { if (done) return; done = true; try { s.close(); } catch { /* 忽略 */ } resolve(v); };
      s.on('error', () => finish(false));
      try {
        s.bind(cfg.rtpPort, () => finish(true));   // true = 端口空闲可绑定
      } catch { finish(false); }
    });
    if (busy) {
      ok('SIP/RTP 端口可绑定', `${cfg.sipPort}/${cfg.rtpPort} 均空闲`);
    } else {
      // 端口被占：判断是不是我们自己的服务在跑
      const ourService = await new Promise((resolve) => {
        const probe = dgram.createSocket('udp4');
        let done = false;
        const finish = (v) => { if (done) return; done = true; try { probe.close(); } catch { /* 忽略 */ } resolve(v); };
        try {
          probe.send(Buffer.from('OPTIONS sip:probe SIP/2.0\r\n\r\n'), cfg.sipPort, '127.0.0.1', () => finish(true));
        } catch { finish(false); }
        setTimeout(() => finish(false), 800);
      });
      if (ourService) ok('SIP/RTP 端口', `${cfg.sipPort}/${cfg.rtpPort} 已被本机服务占用（说明服务正在运行）`);
      else bad('SIP/RTP 端口', `${cfg.rtpPort} 被其他程序占用，服务将无法启动`);
    }
  }

  // 2) 识别服务是否在线
  {
    try {
      const client = new TranscriptionClient({ url: cfg.asrUrl, timeoutMs: 3000 });
      await client.connect();
      client.close();
      ok('识别服务在线', cfg.asrUrl);
    } catch (err) {
      bad('识别服务在线', `${cfg.asrUrl} → ${String(err?.message ?? err)}`);
    }
  }

  // 3) 会话目录能否定位
  {
    const root = join(os.homedir(), '.dsh', 'sessions', encodeWorkspace(cfg.workspace));
    const file = resolveSessionFile(root);
    if (file) ok('会话文件定位', file);
    else if (existsSync(root)) bad('会话文件定位', `${root} 下没有找到任何会话文件`);
    else bad('会话文件定位', `找不到 ${root}`);
  }

  // 4) 注入脚本能否定位到 DSH 窗口
  {
    try {
      const inj = new DshInjector({ titleMatch: cfg.injectTitleMatch, timeoutMs: 30000 });
      const res = await inj.listWindows();
      const cands = res.windows.filter((w) => w.candidate);
      if (cands.length) {
        ok('注入目标窗口', `${cands.length} 个候选，如 [${cands[0].process}] ${cands[0].title.slice(0, 40)}`);
      } else {
        // 找不到时，把**浏览器窗口实际叫什么**报出来 —— 否则用户完全无从下手。
        // 真机踩过：DSH 页面开在后台标签页时，窗口标题跟着**当前激活的标签页**走，
        // 于是标题匹配落空。这时候光说"DSH 页面是否关掉了"是误导 —— 页面明明开着。
        const browsers = /msedge|chrome|firefox|brave|opera|vivaldi/i;
        const seen = res.windows.filter((w) => browsers.test(w.process));
        let detail = '未找到标题匹配的窗口';
        if (seen.length) {
          detail += `。当前浏览器窗口标题是「${seen[0].title.slice(0, 60)}」`
            + ' —— 窗口标题跟着【当前激活的标签页】走，'
            + '请把浏览器切回 DSH 那一页再试（注入是照着标题找窗口的）';
        } else {
          detail += '（一个浏览器窗口都没看到，DSH 页面是否关掉了？）';
        }
        detail += `\n    匹配规则: ${cfg.injectTitleMatch}`;
        bad('注入目标窗口', detail);
      }
    } catch (err) {
      bad('注入目标窗口', String(err?.message ?? err));
    }
  }

  // 5) 预渲染提示音缓存
  {
    const dir = cfg.phrasesDir;
    const idx = join(dir, 'index.json');
    if (existsSync(idx)) {
      const keys = Object.keys(JSON.parse(readFileSync(idx, 'utf8')));
      ok('提示音缓存', `${keys.length} 条：${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '…' : ''}`);
    } else {
      bad('提示音缓存', `没有 ${idx}（会退化为现场合成正弦音，不影响功能）`);
    }
  }

  // 6) HT801 是否可达（未到货时必然失败，属预期）
  {
    const reachable = await new Promise((resolve) => {
      const s = dgram.createSocket('udp4');
      const timer = setTimeout(() => { s.close(); resolve(false); }, 1200);
      s.on('error', () => { clearTimeout(timer); resolve(false); });
      try {
        s.send(Buffer.from('OPTIONS sip:x SIP/2.0\r\n\r\n'), cfg.ataSipPort, cfg.ataAddress, () => {
          clearTimeout(timer);
          s.close();
          resolve(true);   // UDP 发送成功即认为"本地可发"，真正可达要等硬件
        });
      } catch { clearTimeout(timer); resolve(false); }
    });
    if (reachable) ok('HT801 地址可发送', `${cfg.ataAddress}:${cfg.ataSipPort}（UDP 无连接，需硬件到货后确认应答）`);
    else bad('HT801 地址可发送', `${cfg.ataAddress}:${cfg.ataSipPort}`);
  }

  console.log('=== 电话服务自检 ===\n');
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `\n    ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n通过 ${results.length - failed}/${results.length}`);
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- 模拟来电（无需硬件）

async function cmdSimulate(cfg, { seconds = 3, text = null, drySubmit = false }) {
  // drySubmit: 演练整条链路但不真的往 DSH 输入框打字（避免留下测试消息）
  const service = buildService(cfg, drySubmit
    ? {
      injector: {
        submitted: [],
        stats: { attempts: 0, ok: 0, failed: 0 },
        async submit(t) { this.submitted.push(t); return { ok: true, dryRun: true }; },
      },
    }
    : {});
  const { sip, machine, watcher } = service;

  const log = (...a) => console.log('   ', ...a);
  machine.on('state', (e) => log(`状态 ${e.from} → ${e.to}${e.reason ? ` (${e.reason})` : ''}`));
  machine.on('transcribed', (e) => log(`识别结果: ${JSON.stringify(e.text)}（时延 ${e.latencyMs ?? '?'}ms）`));
  machine.on('submitted', () => log('已提交给 DSH'));
  machine.on('ringing', () => log('★ 发起回铃'));
  machine.on('error', (e) => log(`错误: ${e.where} → ${e.error}`));
  machine.on('warn', (e) => log(`警告: ${e.where} → ${e.error}`));

  await sip.start();
  watcher.start();
  console.log(`电话服务已在 ${sip.sipPort}/RTP ${sip.rtpPort} 上监听`);
  console.log(`会话目录: ${service.sessionRoot}\n`);

  // 模拟一台 ATA：摘机 → 发 INVITE → 推音频 → 挂机
  const ataSip = dgram.createSocket('udp4');
  const ataRtp = dgram.createSocket('udp4');
  await new Promise((r) => ataSip.bind(0, '127.0.0.1', r));
  await new Promise((r) => ataRtp.bind(0, '127.0.0.1', r));
  const ataSipPort = ataSip.address().port;
  const ataRtpPort = ataRtp.address().port;

  // ⚠️ 回铃目标必须改成这台**假 ATA**，不能沿用配置里的真网关地址。
  //    不然后果是：跑一次本该纯离线的演练，**真座机会响** —— 而且工具自己
  //    还会报"假 ATA 收到回铃 INVITE: 否 ✗"，因为 INVITE 打到真网关去了。
  //    实测踩过：全链路测试时把电话弄响了两次，还以为是回铃功能在正常工作。
  sip.ringConfig = {
    targetAddress: '127.0.0.1',
    targetSipPort: ataSipPort,
    targetUser: cfg.ataUser,
  };

  const epSipPort = sip.sipPort;
  const epRtpPort = sip.rtpPort;
  let localTag = null;

  ataSip.on('message', (buf) => {
    const m = /;tag=([^;\s>]+)/.exec(buf.toString())?.[1];
    if (m && buf.toString().startsWith('SIP/2.0 200')) localTag = m;
  });

  console.log('模拟 ATA 摘机拨号…');
  const sdp = buildSdp({ address: '127.0.0.1', rtpPort: ataRtpPort });
  const invite = [
    'INVITE sip:companion@127.0.0.1 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${ataSipPort};branch=z9hG4bKsim;rport`,
    'From: <sip:redline@127.0.0.1>;tag=simtag',
    `To: <sip:companion@${cfg.localAddress}:${epSipPort}>`,
    'Call-ID: sim-call-1',
    'CSeq: 1 INVITE',
    'Content-Type: application/sdp',
    `Content-Length: ${Buffer.byteLength(sdp)}`,
    '', sdp,
  ].join('\r\n');
  ataSip.send(Buffer.from(invite), epSipPort, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 400));

  // ACK
  if (localTag) {
    const ack = [
      'ACK sip:companion@127.0.0.1 SIP/2.0',
      `Via: SIP/2.0/UDP 127.0.0.1:${ataSipPort};branch=z9hG4bKsimack`,
      'From: <sip:redline@127.0.0.1>;tag=simtag',
      `To: <sip:companion@127.0.0.1>;tag=${localTag}`,
      'Call-ID: sim-call-1', 'CSeq: 1 ACK', 'Content-Length: 0', '',
    ].join('\r\n');
    ataSip.send(Buffer.from(ack), epSipPort, '127.0.0.1');
  }
  await new Promise((r) => setTimeout(r, 500));

  console.log(`推送 ${seconds} 秒模拟音频（含真实识别）…`);
  const chunk = tone(440, 0.02);
  const frames = Math.round(seconds / 0.02);
  for (let i = 0; i < frames; i++) {
    ataRtp.send(makeRtp(chunk, i, i * 160, 0x9999), epRtpPort, '127.0.0.1');
    await new Promise((r) => setTimeout(r, 2));
  }
  await new Promise((r) => setTimeout(r, 300));

  console.log('模拟挂机…');
  const bye = [
    'BYE sip:companion@127.0.0.1 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${ataSipPort};branch=z9hG4bKsimbye`,
    'From: <sip:redline@127.0.0.1>;tag=simtag',
    `To: <sip:companion@127.0.0.1>${localTag ? `;tag=${localTag}` : ''}`,
    'Call-ID: sim-call-1', 'CSeq: 2 BYE', 'Content-Length: 0', '',
  ].join('\r\n');
  ataSip.send(Buffer.from(bye), epSipPort, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 800));

  console.log('\n=== 已提交，现在模拟"我回复完成 → 回铃" ===');
  if (!machine.pendingReply) {
    console.log('没有待回复任务，跳过回铃验证');
  } else {
    // 让假 ATA 自动接听我们发出的回铃 INVITE，把最后一段也跑通
    const waitOutgoing = new Promise((resolve) => {
      const onMsg = (buf) => {
        const text = buf.toString();
        if (!text.startsWith('INVITE ')) return;
        const via = /Via: ([^\r\n]+)/.exec(text)?.[1] ?? '';
        const from = /From: ([^\r\n]+)/.exec(text)?.[1] ?? '';
        const callId = /Call-ID: ([^\r\n]+)/.exec(text)?.[1] ?? '';
        const cseq = /CSeq: ([^\r\n]+)/.exec(text)?.[1] ?? '';
        const to = /To: ([^\r\n]+)/.exec(text)?.[1] ?? '';
        const body = text.slice(text.indexOf('\r\n\r\n') + 4);
        // 回 200 OK（表示"电话被接起来了"）
        const resp = [
          'SIP/2.0 200 OK',
          `Via: ${via}`,
          `From: ${from}`,
          `To: ${to};tag=ataring`,
          `Call-ID: ${callId}`,
          `CSeq: ${cseq}`,
          'Content-Type: application/sdp',
          `Content-Length: ${Buffer.byteLength(body)}`,
          '', body,
        ].join('\r\n');
        ataSip.send(Buffer.from(resp), epSipPort, '127.0.0.1');
        resolve(text);
      };
      ataSip.on('message', onMsg);
      setTimeout(() => resolve(null), 5000);
    });

    const res = await machine.onReplyCompleted({ text: '（模拟回复内容）' });
    console.log(`回铃发起: ${res.rung ? '是' : `否（${res.reason}）`}`);
    const invite = await waitOutgoing;
    console.log(`假 ATA 收到回铃 INVITE: ${invite ? '是 ✓' : '否 ✗'}`);
    await new Promise((r) => setTimeout(r, 800));
    const snap2 = machine.snapshot;
    console.log(`回铃后统计: rings=${snap2.stats.rings} answered=${snap2.stats.answered}`);
    console.log(`待回复任务: ${snap2.pendingReply ? '仍在' : '已清（通知送达）'}`);
  }

  const snap = machine.snapshot;
  console.log('\n=== 模拟结果 ===');
  console.log(`状态: ${snap.state}`);
  console.log(`统计: ${JSON.stringify(snap.stats)}`);
  console.log(`待回复任务: ${snap.pendingReply ? '有（等我说完就会响铃）' : '无'}`);
  console.log(`\n说明：识别用的是真实 CapsWriter 服务；`);
  console.log(`      若 stats.submitted = 1，说明闭环前半段（到提交）已经打通。`);

  ataSip.close(); ataRtp.close();
  watcher.stop();
  await sip.stop();
  return snap.stats.submitted > 0 ? 0 : 2;
}

// ---------------------------------------------------------------- status

/**
 * 读上一次运行写下的状态，判断"是不是已经有一个服务活着"。
 *
 * 用 process.kill(pid, 0) 探活：不真的发信号，只问系统"这个进程还在吗"。
 * 但 PID 会复用 —— 所以再确认一下它的状态记录是不是很旧
 * （超过 1 天没更新就当成陈迹，避免误报"已在运行"而挡住正常启动）。
 *
 * @returns {object|null} 活着的话返回状态快照，否则 null
 */
export function readRunningStatus() {
  const file = join(RUNTIME_DIR, 'phone-status.json');
  if (!existsSync(file)) return null;
  let snap;
  try { snap = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const pid = snap?.pid;
  if (!pid || pid === process.pid) return null;
  try {
    process.kill(pid, 0);                       // 探活，不发信号
  } catch {
    return null;                                // 进程没了
  }
  const at = Date.parse(snap.at ?? '');
  if (Number.isFinite(at) && Date.now() - at > 24 * 3600 * 1000) return null;
  return snap;
}

function cmdStatus() {
  const file = join(RUNTIME_DIR, 'phone-status.json');
  if (!existsSync(file)) {
    console.log('没有运行记录（服务未启动过，或从未写过状态）。');
    return 1;
  }
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  console.log(JSON.stringify(snap, null, 2));
  return 0;
}

// ---------------------------------------------------------------- start

async function cmdStart(cfg) {
  // 工作区没配就直接停下来说清楚 —— 它决定去哪找 DSH 会话文件，
  // 缺了的话服务能跑、电话能打通，但"我回复完电话不响"，而且没有任何报错。
  // 这种"静默失效"最难查，所以宁可在启动时就拦住。
  if (!cfg.workspace) {
    console.error('✗ 还没配工作区（phone.config.json 里的 workspace）。');
    console.error('  它决定去哪个目录找 DSH 会话文件 —— 回铃检测全靠它，缺了会表现为「电话永远不响」。');
    console.error('  填你的 DSH 工作区根目录，例如：  "workspace": "C:\\\\Users\\\\you\\\\my-project"');
    return 1;
  }

  // localAddress 写 'auto' 时自动探测（多网卡机器强烈建议用 auto，
  // 否则 WiFi 地址会被写进 SDP，导致网关把音频发给错误的网卡而全程无声）
  if (!cfg.localAddress || cfg.localAddress === 'auto') {
    const detected = await detectLocalAddress(cfg.ataAddress);
    if (!detected) {
      console.error(`✗ 无法探测到通往网关 ${cfg.ataAddress} 的本机地址。`);
      console.error(`  请确认网线已接好、网口已配同网段 IP，或在 phone.config.json 里显式写死 localAddress。`);
      return 1;
    }
    console.log(`[网络] 自动探测到本机在网关网段的地址：${detected}`);
    cfg.localAddress = detected;
  }

  // 前置检查：已经有一个服务在跑时，直接给出人话提示。
  // 不做这一步的话，用户重复启动只会看到一句 dgram 的 EADDRINUSE，
  // 很像"程序坏了"，其实只是开了两份。
  const running = readRunningStatus();
  if (running) {
    console.error(`✗ 已经有一个电话服务在跑了（PID ${running.pid}，状态 ${running.state ?? '未知'}）。`);
    console.error('  同一个端口不可能起两份。要么先用它，要么先停掉：');
    console.error(`    taskkill /PID ${running.pid} /F`);
    return 1;
  }

  const service = buildService(cfg);
  const { sip, machine, watcher } = service;

  machine.on('state', (e) => console.log(`[状态] ${e.from} → ${e.to}${e.reason ? ` (${e.reason})` : ''}`));
  machine.on('call:started', () => console.log('[电话] 摘机，开始收音'));
  machine.on('transcribed', (e) => console.log(`[识别] ${e.text}`));
  machine.on('submitted', (e) => console.log(`[提交] ${e.text}`));
  machine.on('error', (e) => console.error(`[错误] ${e.where}: ${e.error}`));
  machine.on('warn', (e) => console.warn(`[警告] ${e.where}: ${e.error}`));
  machine.on('ring:answered', () => console.log('[回铃] 用户接听'));
  machine.on('ring:timeout', () => console.log('[回铃] 无人接听，已取消'));

  // ---- 诊断输出：排查"信令通了但没声音"这类问题全靠这些日志 ----
  // 平时不必开；卡住时打开能一眼看出断在哪一环。
  const DEBUG = process.env.PHONE_DEBUG === '1' || process.argv.includes('--debug');
  if (DEBUG) {
    sip.on('debug', (d) => {
      if (d.where === 'invite') {
        console.log(`[诊断] 来电来自 ${d.remote}`);
        console.log(`[诊断]   对端要求音频发到 ${d.peerSdp.address}:${d.peerSdp.port}  负载类型=${d.peerSdp.payloadTypes}`);
        console.log(`[诊断]   我通告的本机音频地址 ${d.localSdpAddress}:${d.localRtpPort}`);
      } else if (d.where === 'sendSip') {
        if (d.ok) console.log(`[诊断] → 发出 ${d.first}  (${d.bytes}B → ${d.to})`);
        else console.log(`[诊断] ✗ 发送失败 → ${d.to}：${d.error}`);
      }
    });
    sip.on('sip', ({ msg }) => {
      if (msg.kind === 'request') console.log(`[诊断] ← ${msg.method} from ${msg.headers.from?.slice(0, 60)}`);
      else console.log(`[诊断] ← ${msg.status}`);
    });
    let rtpCount = 0;
    sip.on('audio:rx', () => {
      rtpCount += 1;
      if (rtpCount === 1) console.log('[诊断] ★ 收到第一个 RTP 音频包 —— 上行音频已到达');
      if (rtpCount % 100 === 0) console.log(`[诊断] 已收 ${rtpCount} 个 RTP 包`);
    });
    machine.on('audio:progress', (p) => {
      if (Math.round(p.seconds * 10) % 10 === 0) console.log(`[诊断] 已录制 ${p.seconds.toFixed(1)}s`);
    });
  }

  // 回铃的"检测到回复完成 → 发起呼叫"绑定已在 buildService 里完成。
  // 这里不要再绑一次，否则一次回复完成会触发两次响铃。
  // （buildService 里用 service._ringBound 做了幂等保护。）

  try {
    await sip.start();
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      console.error(`✗ 端口 ${err.port ?? cfg.sipPort} 已被占用，起不来。`);
      console.error('  最常见的原因：已经有一个电话服务在跑（比如启动器点了两次）。');
      console.error('  查进程：Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" |');
      console.error('          Where-Object { $_.CommandLine -like \'*phone-control*\' }');
      console.error('  停服务：node src/phone-control.mjs status 看 PID，再 taskkill /PID <PID> /F');
    } else {
      console.error(`✗ 启动失败：${err?.message ?? err}`);
    }
    return 1;
  }
  watcher.start();
  console.log('════════ 红色座机语音终端 已启动 ════════');
  console.log(`SIP 监听 : ${cfg.localAddress}:${sip.sipPort}`);
  console.log(`RTP 监听 : ${cfg.localAddress}:${sip.rtpPort}`);
  console.log(`识别服务 : ${cfg.asrUrl}`);
  console.log(`目标网关 : ${cfg.ataAddress}:${cfg.ataSipPort}（摘机自动拨号目标 ${cfg.ataUser}）`);
  console.log(`会话目录 : ${service.sessionRoot}`);
  console.log(`工作区   : ${cfg.workspace}`);
  console.log('════════════════════════════════════════');
  console.log('等摘机…（Ctrl+C 退出）\n');

  // 定时写状态 + 顺手清理僵死通话。
  // 清理必须周期做：对端异常消失不会发 BYE，留着 call 对象会让 isBusy 恒为 true，
  // 之后所有回铃都被 line-busy 挡掉 —— 用户看到的就是"电话再也不响了"。
  const statusTimer = setInterval(() => {
    try { sip.sweepStaleCall(); } catch (err) { console.warn(`[SIP] 清理僵死通话出错：${err?.message ?? err}`); }
    writeStatus(service);
  }, 5000);
  if (statusTimer.unref) statusTimer.unref();

  const shutdown = async () => {
    console.log('\n正在退出…');
    clearInterval(statusTimer);
    watcher.stop();
    await sip.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 常驻
  await new Promise(() => {});
}

// ---------------------------------------------------------------- CLI

async function main() {
  const [cmd = 'selftest', ...rest] = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--config') opts.config = rest[++i];
    else if (rest[i] === '--seconds') opts.seconds = Number(rest[++i]);
    else if (rest[i] === '--text') opts.text = rest[++i];
    else if (rest[i] === '--workspace') opts.workspace = rest[++i];
    else if (rest[i] === '--no-submit') opts.drySubmit = true;
  }
  const cfg = loadConfig(opts.config ?? join(PROJECT_ROOT, 'phone.config.json'));
  if (opts.workspace) cfg.workspace = opts.workspace;

  switch (cmd) {
    case 'selftest': return cmdSelftest(cfg);
    case 'status': return cmdStatus();
    case 'start': return cmdStart(cfg);
    case '模拟来电': return cmdSimulate(cfg, {
      seconds: opts.seconds ?? 3, text: opts.text, drySubmit: opts.drySubmit,
    });
    default:
      console.log('用法: node src/phone-control.mjs <selftest|start|status|模拟来电> [选项]');
      console.log('  --config <路径>     指定配置文件（默认 phone.config.json）');
      console.log('  --seconds <秒>      模拟来电时的音频时长（默认 3）');
      console.log('  --workspace <路径>  指定工作区（用于定位 DSH 会话目录）');
      console.log('  --no-submit         模拟时演练整条链路但不真的往输入框打字');
      return 1;
  }
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`
    || process.argv[1]?.endsWith('phone-control.mjs')) {
  main().then((code) => process.exit(code ?? 0)).catch((err) => {
    console.error('致命错误:', err);
    process.exit(1);
  });
}
