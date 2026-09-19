/**
 * server.mjs —— 红色座机语音终端 · 本地网页控制台
 *
 * 为什么做成"零依赖单文件"：
 *   这个项目的使用者是要**自己动手接线、配网关**的人。
 *   如果控制台需要 npm install 一堆前端框架，落地门槛立刻抬高一大截。
 *   所以这里只用 node:http 内置模块 + 一个自包含的 index.html（原生 JS，无构建步骤）。
 *   照抄一句 `node web/server.mjs` 就能用。
 *
 * 它做的事：
 *   · 读服务写的状态心跳（.runtime/phone-status.json，每 5 秒刷新）
 *   · 探活：本机网口 / 网关 / 识别服务 / 电话服务
 *   · 启停电话服务、跑自检、试响一声
 *   · 读写 phone.config.json 里的白名单配置项（避免网页把配置改坏）
 *   · 看服务日志尾部
 *
 * 它**不**做的事：不参与通话、不发 SIP、不碰音频 —— 通话全程在 phone-control 服务里，
 * 控制台只是"看和按"。所以控制台崩了也不影响打电话。
 *
 * 用法：
 *   node web/server.mjs            # 默认 http://127.0.0.1:8932
 *   node web/server.mjs --port 9000
 */
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, statSync, openSync, readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');                 // phone-companion/
const RUNTIME = join(PROJECT, '.runtime');
const CONFIG_FILE = join(PROJECT, 'phone.config.json');
const STATUS_FILE = join(RUNTIME, 'phone-status.json');
const LOG_FILE = join(RUNTIME, 'phone.log');
const CONTROL = join(PROJECT, 'src', 'phone-control.mjs');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', process.env.PHONE_WEB_PORT ?? 8932));
const HOST = argOf('--host', '127.0.0.1');       // 只监听本机：这是控制台，不该暴露到局域网

// ---------------------------------------------------------------- 配置读写

/** 允许网页修改的配置项白名单 —— 写死，避免前端出 bug 把整个配置改坏 */
const WRITABLE = {
  ringbackEnabled: { type: 'boolean', label: '响铃总开关' },
  ringCount: { type: 'int', min: 1, max: 20, label: '响几声' },
  ringCadenceOnMs: { type: 'int', min: 100, max: 10000, label: '铃音：响(ms)' },
  ringCadenceOffMs: { type: 'int', min: 100, max: 10000, label: '铃音：停(ms)' },
  silencePeakThreshold: { type: 'int', min: 0, max: 30000, label: '静音阈值' },
  ataAddress: { type: 'string', label: '网关地址' },
  ataSipPort: { type: 'int', min: 1, max: 65535, label: '网关 SIP 端口' },
  sipPort: { type: 'int', min: 1, max: 65535, label: '本机 SIP 端口' },
  rtpPort: { type: 'int', min: 1, max: 65535, label: '本机 RTP 端口' },
};

function readConfig() {
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeConfigPatch(patch) {
  const cfg = readConfig();
  if (!cfg) return { ok: false, error: '配置文件读不出来' };
  const applied = {};
  for (const [key, spec] of Object.entries(WRITABLE)) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (spec.type === 'boolean') {
      cfg[key] = Boolean(value);
    } else if (spec.type === 'int') {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: `${key} 不是数字` };
      // 夹到范围内，而不是报错 —— 前端滑块偶尔会送出边界外的值
      cfg[key] = Math.min(spec.max, Math.max(spec.min, Math.round(n)));
    } else {
      cfg[key] = String(value).trim();
    }
    applied[key] = cfg[key];
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { ok: true, applied, needRestart: Object.keys(applied).length > 0 };
}

// ---------------------------------------------------------------- 状态与探活

function readStatus() {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

const isAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** 电话服务是不是活着（以它自己的心跳为准） */
function serviceInfo() {
  const snap = readStatus();
  if (!snap || !isAlive(snap.pid)) return { running: false, snap: null };
  return { running: true, snap };
}

/** 端口探活（UDP 没有连接概念，用 netstat 兜） */
function portBusy(port, proto = 'tcp') {
  return new Promise((resolve) => {
    if (proto === 'tcp') {
      const s = net.createConnection({ port, host: '127.0.0.1' });
      const done = (v) => { s.destroy(); resolve(v); };
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
      setTimeout(() => done(false), 600);
      return;
    }
    execFile('netstat', ['-ano', '-p', 'UDP'], { windowsHide: true }, (err, out) => {
      resolve(!err && new RegExp(`:${port}\\s`).test(String(out)));
    });
  });
}

/** 网关能不能通（UDP 没连接，只能看 ping；ping 不通也不代表一定坏，所以标成"未知"而不是"失败"） */
function pingGateway(host) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    execFile('ping', isWin ? ['-n', '1', '-w', '1200', host] : ['-c', '1', '-W', '1', host],
      { windowsHide: true, timeout: 3000 }, (err) => resolve(!err));
  });
}

/**
 * 本机网卡情况。
 *
 * ⚠️ 关键：不能把"存在 169.254.x 地址"直接当成网口异常 ——
 * 蓝牙、Tailscale、Hyper-V 这些虚拟网卡常年都是自动私有地址，
 * 按"数量>0"判断会让每台机器都报红。真正要识别的是
 * **"整张网卡只有自动私有地址"**（= 静态 IP 没配上，USB 网卡拔插后就是这个症状）。
 */
function readNicAddress(config) {
  const nets = os.networkInterfaces();
  const all = [];
  const unconfigured = [];

  for (const [name, list] of Object.entries(nets)) {
    const v4 = (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal);
    if (!v4.length) continue;
    const real = v4.filter((a) => !a.address.startsWith('169.254.'));
    if (real.length) {
      for (const a of real) all.push({ name, address: a.address });
    } else {
      unconfigured.push({ name, address: v4[0].address });
    }
  }

  // 报"可疑网卡"时优先提有物理面孔的，别一上来就说蓝牙网卡没配好
  const looksVirtual = (n) => /蓝牙|bluetooth|tailscale|hyper-v|vethernet|vmware|virtualbox|回环|loopback/i.test(n);
  const suspicious = unconfigured.filter((x) => !looksVirtual(x.name));

  const gw = String(config?.ataAddress ?? '');
  const sameSubnet = (addr) => addr.split('.').slice(0, 3).join('.') === gw.split('.').slice(0, 3).join('.');
  const matchingGateway = all.find((x) => sameSubnet(x.address)) ?? null;

  return { all, unconfigured, suspicious, matchingGateway };
}

async function collectState() {
  const config = readConfig();
  const { running, snap } = serviceInfo();
  const [sipPort, rtpPort, asr] = await Promise.all([
    portBusy(config?.sipPort ?? 5090, 'udp'),
    portBusy(config?.rtpPort ?? 15004, 'udp'),
    portBusy(6016, 'tcp'),
  ]);
  const gatewayReachable = config?.ataAddress ? await pingGateway(config.ataAddress) : false;
  const nic = readNicAddress(config);

  return {
    at: new Date().toISOString(),
    service: {
      running,
      pid: snap?.pid ?? null,
      state: snap?.state ?? null,
      handset: snap?.call?.handset ?? null,
      lineBusy: snap?.call?.lineBusy ?? null,
      stats: snap?.stats ?? null,
      pendingReply: snap?.pendingReply ?? null,
      watcher: snap?.watcher ?? null,
      uptimeSec: snap?.at ? Math.round((Date.now() - Date.parse(snap.at)) / 1000) : null,
      ports: { sip: sipPort, rtp: rtpPort },
      stale: snap ? (Date.now() - Date.parse(snap.at) > 15000) : false,
    },
    asr: { online: asr },
    gateway: { address: config?.ataAddress ?? null, reachable: gatewayReachable },
    nic,
    config,
    writable: WRITABLE,
  };
}

function tailLog(lines = 120) {
  try {
    const st = statSync(LOG_FILE);
    const size = Math.min(st.size, 256 * 1024);
    const buf = readFileSync(LOG_FILE);
    const text = buf.subarray(buf.length - size).toString('utf8');
    const arr = text.split('\n');
    return arr.slice(Math.max(0, arr.length - lines - 1)).join('\n');
  } catch {
    return '（还没有日志 —— 服务可能没启动过）';
  }
}

// ---------------------------------------------------------------- 动作

/** 拉起电话服务（detached：控制台关了它也继续跑） */
function startService() {
  const { running } = serviceInfo();
  if (running) return { ok: false, error: '已经在跑了' };
  const out = openSync(join(RUNTIME, 'phone.log'), 'a');
  const err = openSync(join(RUNTIME, 'phone.err.log'), 'a');
  const child = spawn(process.execPath, [CONTROL, 'start'], {
    cwd: PROJECT, detached: true, stdio: ['ignore', out, err], windowsHide: true,
  });
  child.unref();
  return { ok: true, pid: child.pid };
}

function stopService() {
  const { running, snap } = serviceInfo();
  if (!running) return { ok: false, error: '没在跑' };
  try {
    process.kill(snap.pid);
    return { ok: true, killed: snap.pid };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

function runCli(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CONTROL, ...args], {
      cwd: PROJECT, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout ?? ''), err: String(stderr ?? '') });
    });
  });
}

/** 试响一声：跑真机验收脚本（它绑临时端口，不影响正在跑的服务） */
function ringTest() {
  const script = join(PROJECT, '工具', '验证', '验证通知铃.mjs');
  if (!existsSync(script)) return Promise.resolve({ ok: false, error: '找不到 验证通知铃.mjs' });
  return new Promise((resolve) => {
    execFile(process.execPath, [script, '1'], {
      cwd: PROJECT, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? '') });
    });
  });
}

// ---------------------------------------------------------------- 最近说过的话

/**
 * 状态文件只有"最后一句"，看不出历史。
 * 这里由控制台自己记住变化 —— 每分钟轮询一次心跳，发现 lastTranscript 变了就记下来。
 * 只在控制台开着的期间有效，够用（重启控制台就重新开始）。
 */
const transcriptHistory = [];
let lastSeenTranscript = null;
setInterval(() => {
  const { snap } = serviceInfo();
  const t = snap?.stats?.lastTranscript;
  if (t && t !== lastSeenTranscript) {
    lastSeenTranscript = t;
    transcriptHistory.unshift({ text: t, at: snap.stats.lastSubmittedAt ?? Date.now() });
    if (transcriptHistory.length > 50) transcriptHistory.length = 50;
  }
}, 2000).unref?.();

// ---------------------------------------------------------------- HTTP

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', () => {
    try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); }
  });
});

const INDEX = join(HERE, 'index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = readFileSync(INDEX);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && path === '/api/state') {
      json(res, 200, {
        ...await collectState(),
        transcripts: transcriptHistory.slice(0, 20),
      });
      return;
    }

    if (req.method === 'GET' && path === '/api/log') {
      json(res, 200, { log: tailLog(Number(url.searchParams.get('n')) || 120) });
      return;
    }

    if (req.method === 'POST' && path === '/api/service/start') {
      json(res, 200, startService());
      return;
    }

    if (req.method === 'POST' && path === '/api/service/stop') {
      json(res, 200, stopService());
      return;
    }

    if (req.method === 'POST' && path === '/api/selftest') {
      json(res, 200, await runCli(['selftest']));
      return;
    }

    if (req.method === 'POST' && path === '/api/ring-test') {
      json(res, 200, await ringTest());
      return;
    }

    if (req.method === 'GET' && path === '/api/config') {
      json(res, 200, { config: readConfig(), writable: WRITABLE });
      return;
    }

    if (req.method === 'POST' && path === '/api/config') {
      const body = await readBody(req);
      if (body === null) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
      json(res, 200, writeConfigPatch(body));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (err) {
    json(res, 500, { ok: false, error: String(err?.message ?? err) });
  }
});

// .runtime 可能还不存在（服务从没启动过）
try { readdirSync(RUNTIME); } catch { /* 读不到也没关系，各处都做了兜底 */ }

server.listen(PORT, HOST, () => {
  console.log('════════ 红色座机语音终端 · 网页控制台 ════════');
  console.log(`  地址   : http://${HOST}:${PORT}`);
  console.log(`  项目   : ${PROJECT}`);
  console.log(`  只监听本机 —— 这是控制台，不对外网开放`);
  console.log('  停止   : Ctrl+C');
  console.log('══════════════════════════════════════════════');
});
