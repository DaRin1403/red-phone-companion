/**
 * 启动.mjs —— 一键启动红色座机语音终端
 *
 * 为什么用 Node 而不是 PowerShell：
 *   Windows PowerShell 5.1 会把无 BOM 的 UTF-8 脚本按 ANSI(GBK) 读，
 *   脚本里任何中文字面量都会破坏语法解析。这个坑在本项目里踩过两次
 *   （注入文字.ps1、启动.ps1），所以启动器改用 Node 写，编码问题一次消除。
 *
 * 它负责把整套系统拉起来：
 *   1) CapsWriter 识别服务（本地离线 ASR，TCP 6016）
 *   2) phone-companion 电话服务（SIP 5090 / RTP 15004）
 *   3) 健康自检
 *
 * 用法：
 *   node 启动.mjs              启动全部
 *   node 启动.mjs --stop       停止全部
 *   node 启动.mjs --status     只看状态
 *   node 启动.mjs --debug      带诊断日志启动电话服务
 *   node 启动.mjs --no-asr     只起电话服务
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
// ⚠️ 本文件就在 phone-companion\ 里，所以 PROJECT 就是 HERE 本身。
//    这里曾经写的是 join(HERE, '..') —— 那是"假设本文件待在 源码\ 下"，
//    结果 PROJECT 变成 源码\，连锁出错：
//      · 拉起电话服务时 cwd=源码\ → 找不到 src/phone-control.mjs
//        （报错落在 源码\.runtime\phone.err.log 里：
//         Cannot find module '...\源码\src\phone-control.mjs'）
//      · CAPSWRITER 指向 红色座机语音终端\CapsWriter-Offline（不存在）
//      · .runtime 建在 源码\ 下，而服务自己把状态写在 phone-companion\.runtime\
//        → 启动器读不到心跳，明明在跑却报"已退出"
//    这个 bug 长期被误判成"detached spawn 在 DSH 里起不来"。
const PROJECT = HERE;                                   // phone-companion/
const CAPSWRITER = join(PROJECT, '..', 'CapsWriter-Offline');
const RUNTIME = join(PROJECT, '.runtime');
const PID_FILE = join(RUNTIME, 'pids.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

mkdirSync(RUNTIME, { recursive: true });

const C = {
  reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m',
  yellow: '\x1b[33m', gray: '\x1b[90m', white: '\x1b[1m',
};
const step = (m) => console.log(`${C.cyan}==>${C.reset} ${m}`);
const good = (m) => console.log(`  ${C.green}OK${C.reset}  ${m}`);
const warn = (m) => console.log(`  ${C.yellow}!!${C.reset}  ${m}`);

// ---------------------------------------------------------------- 端口探测

/** 端口是否有人监听（同时探 TCP 与 UDP） */
async function portBusy(port) {
  const tcp = await new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 600);
  });
  if (tcp) return true;
  // UDP 没有"连接"概念，用 Windows 的 netstat 辅助判断
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'UDP'], { encoding: 'utf8', windowsHide: true });
    return new RegExp(`:${port}\\s`).test(out);
  } catch {
    return false;
  }
}

function loadPids() {
  try { return JSON.parse(readFileSync(PID_FILE, 'utf8')); } catch { return {}; }
}
function savePids(o) {
  try { writeFileSync(PID_FILE, JSON.stringify(o, null, 2), 'utf8'); } catch { /* 忽略 */ }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 读电话服务自己写的状态心跳（.runtime/phone-status.json，每 5 秒刷新一次）。
 *
 * 为什么需要它：pids.json 只记录"本启动器拉起来的那个进程"。
 * 如果服务是被别的方式起的（手动 node、或上次启动器被强杀），
 * pids.json 里就是个死 PID，而 --status 会显示"已退出"——
 * 明明在跑却报已退出，很容易让人重复启动或误杀。
 *
 * @returns {{pid:number, state:string, at:string, armed:boolean}|null}
 */
function readServiceStatus() {
  const file = join(RUNTIME, 'phone-status.json');
  if (!existsSync(file)) return null;
  let snap;
  try { snap = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (!isAlive(snap?.pid)) return null;
  return snap;
}

/** 等端口真正释放（stop 之后端口不会立刻空出来，不等就会让紧接着的 start 误判"已在运行"） */
async function waitPortFree(port, seconds = 12) {
  for (let i = 0; i < seconds; i++) {
    if (!(await portBusy(port))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return !(await portBusy(port));
}

// ---------------------------------------------------------------- 停

async function stopAll() {
  step('停止服务');
  const pids = loadPids();
  const living = new Set();
  for (const [name, info] of Object.entries(pids)) {
    if (info?.pid && isAlive(info.pid)) {
      try { process.kill(info.pid); living.add(info.pid); console.log(`  已终止 ${name} (PID ${info.pid})`); }
      catch (e) { warn(`终止 ${name} 失败：${e.message}`); }
    }
  }
  // 状态心跳里记的进程也要停：它是"真正在跑的电话服务"，
  // 可能不是本启动器拉起来的（pids.json 里就没有它）。
  const snap = readServiceStatus();
  if (snap && !living.has(snap.pid)) {
    try { process.kill(snap.pid); console.log(`  已终止 电话服务 (PID ${snap.pid}，来自状态心跳)`); }
    catch (e) { warn(`终止状态心跳里的进程失败：${e.message}`); }
  }
  // 兜底：按命令行特征清理残留（覆盖 pids.json 过期、服务被别的方式起的情况）
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*phone-control*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ], { encoding: 'utf8', windowsHide: true });
    if (out.trim()) console.log(out.trim());
  } catch { /* 忽略 */ }
  savePids({});

  // 等端口真的空出来再报成功 —— 否则用户紧接着 start 会被误判成"已在运行"
  step('等端口释放');
  let allFree = true;
  for (const port of [5090, 15004, 6016]) {
    const freed = await waitPortFree(port);
    console.log(`  ${freed ? `${C.green}已释放${C.reset}` : `${C.yellow}仍被占用${C.reset}`}  端口 ${port}`);
    if (!freed) allFree = false;
  }
  if (allFree) good('已停止');
  else warn('有端口没释放，可能还有残留进程：Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'"');
}

// ---------------------------------------------------------------- 启动

function spawnLogged(name, file, args, cwd, env = {}) {
  const out = openSync(join(RUNTIME, `${name}.log`), 'a');
  const err = openSync(join(RUNTIME, `${name}.err.log`), 'a');
  const child = spawn(file, args, {
    cwd, env: { ...process.env, ...env }, detached: true,
    stdio: ['ignore', out, err], windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function waitPort(port, seconds) {
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await portBusy(port)) return true;
  }
  return false;
}

async function startAll({ noAsr, debug }) {
  console.log(`${C.white}======== 红色座机语音终端 ========${C.reset}\n`);
  const pids = loadPids();

  // ---- 1) 识别服务
  if (!noAsr) {
    step('识别服务（本地离线 ASR，端口 6016）');
    if (await portBusy(6016)) {
      good('已在运行');
    } else {
      const py = join(CAPSWRITER, '.venv', 'Scripts', 'python.exe');
      const srv = join(CAPSWRITER, 'start_server.py');
      if (!existsSync(py)) { warn(`找不到 Python 环境：${py}`); return 1; }
      if (!existsSync(srv)) { warn(`找不到服务入口：${srv}`); return 1; }
      pids.asr = { pid: spawnLogged('asr', py, [srv], CAPSWRITER, { PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }) };
      savePids(pids);
      console.log(`  启动中（PID ${pids.asr.pid}），等待模型加载…`);
      if (await waitPort(6016, 90)) good('已启动并开始监听');
      else { warn(`90 秒内没起来，看 .runtime\\asr.err.log`); return 1; }
    }
  } else {
    step('识别服务：按参数跳过');
  }

  // ---- 2) 电话服务
  step('电话服务（SIP 5090 / RTP 15004）');
  if (await portBusy(5090)) {
    // 端口忙不等于"我们的服务在跑" —— 可能是别的程序，也可能是上次没清干净的残留。
    // 用服务自己写的心跳来确认，避免用户以为在跑、实际是个僵着的进程。
    const live = readServiceStatus();
    if (live) {
      good(`已在运行（PID ${live.pid}，状态 ${live.state ?? '未知'}${live.armed ? '，正在等回复' : ''}）`);
    } else {
      warn('端口 5090 被占用，但不是我们的电话服务（状态心跳里没有存活进程）。');
      warn('可能是上一次的残留进程，或别的程序占了这个端口。先跑：node 启动.mjs --stop');
      return 1;
    }
  } else {
    const args = ['src/phone-control.mjs', 'start'];
    if (debug) args.push('--debug');
    pids.phone = { pid: spawnLogged('phone', 'node', args, PROJECT, debug ? { PHONE_DEBUG: '1' } : {}) };
    savePids(pids);
    await new Promise((r) => setTimeout(r, 3000));
    if (await portBusy(5090)) good(`已启动（PID ${pids.phone.pid}）`);
    else { warn('启动失败，看 .runtime\\phone.err.log'); return 1; }
  }

  // ---- 3) 自检
  console.log('');
  step('健康自检');
  try {
    const out = execFileSync('node', ['src/phone-control.mjs', 'selftest'],
      { cwd: PROJECT, encoding: 'utf8', windowsHide: true });
    for (const line of out.split('\n')) if (line.trim()) console.log(`  ${line}`);
  } catch (e) {
    console.log(`  ${e.stdout ?? ''}`);
    warn('自检有失败项');
  }

  console.log(`\n${C.white}就绪${C.reset}`);
  console.log('  拿起听筒  ->  听一声嘀  ->  说一句话  ->  放下');
  console.log(`  日志： ${C.gray}.runtime\\phone.log${C.reset}`);
  console.log(`  停止： ${C.gray}node 启动.mjs --stop${C.reset}\n`);
  return 0;
}

// ---------------------------------------------------------------- 状态

async function status() {
  console.log(`${C.white}======== 状态 ========${C.reset}\n`);
  const rows = [
    ['识别服务 (TCP 6016)', 6016],
    ['电话服务 SIP (UDP 5090)', 5090],
    ['电话服务 RTP (UDP 15004)', 15004],
  ];
  for (const [name, port] of rows) {
    const busy = await portBusy(port);
    console.log(`  ${busy ? `${C.green}运行中${C.reset}` : `${C.yellow}未运行${C.reset}`}  ${name}`);
  }

  // 电话服务的真实进程以"状态心跳"为准：pids.json 只记得本启动器拉起的那个，
  // 服务被别的方式起过的话，那里就是一条过期记录（显示"已退出"但服务其实活着）。
  const live = readServiceStatus();
  const pids = loadPids();
  console.log('');
  if (live) {
    console.log(`  电话服务: PID ${live.pid} (${C.green}存活${C.reset})  状态 ${live.state ?? '未知'}`
      + `  等回复: ${live.armed ? '是' : '否'}  已处理回合: ${live.watcher?.completions ?? 0}`);
    if (pids.phone?.pid && pids.phone.pid !== live.pid) {
      console.log(`  ${C.gray}（pids.json 里记的是 PID ${pids.phone.pid}，那是启动器上次拉的进程，已不是当前服务）${C.reset}`);
    }
  } else {
    console.log(`  电话服务: ${C.yellow}没在跑${C.reset}`);
  }
  for (const [k, v] of Object.entries(pids)) {
    if (k === 'phone' && live) continue;              // 上面已经用心跳报过了
    console.log(`  ${k}: PID ${v.pid} ${isAlive(v.pid) ? `(${C.green}存活${C.reset})` : `(${C.yellow}已退出${C.reset})`}`);
  }

  const cfgPath = join(PROJECT, 'phone.config.json');
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    console.log('');
    console.log(`  网关地址: ${cfg.ataAddress}:${cfg.ataSipPort}`);
    console.log(`  本机地址: ${cfg.localAddress}`);
    console.log(`  工作区  : ${cfg.workspace}`);
  }
}

// ---------------------------------------------------------------- main

const code = has('--stop') ? (await stopAll(), 0)
  : has('--status') ? (await status(), 0)
    : await startAll({ noAsr: has('--no-asr'), debug: has('--debug') });
process.exit(code);
