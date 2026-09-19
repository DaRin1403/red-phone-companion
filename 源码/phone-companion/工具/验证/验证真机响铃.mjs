/**
 * 验证真机响铃.mjs —— 直接让红色座机响起来，不需要打电话、不需要 DSH 回合。
 *
 * 为什么需要单独一个工具：
 *   整条回铃链路里，"我们发 INVITE → HT801 真的响铃"是唯一没法用离线测试证明的一环。
 *   离线验证（验证回铃链路.mjs）用的是假 ATA，它必然收下我们的 INVITE；
 *   真机可能因为来源地址不是它配置的 SIP 服务器、或者 To 头用户名不对而直接拒绝。
 *
 * 用法（推荐：不用停服务，换个端口即可）：
 *   $env:PHONE_SIP_PORT=5091; $env:PHONE_RTP_PORT=15005
 *   node 工具/验证/验证真机响铃.mjs 10
 *
 *   实测结论：HT801 **不校验来源端口**，从 5091 发 INVITE 照样振铃。
 *   所以验证回铃不需要停掉正在跑的语音服务，随便挑个空闲端口就行。
 *   （传 0 可以让系统自动分配端口，但那样 SDP 里的地址仍按 config 里通告。）
 *
 * 如果要连 5090 一起测（怀疑端口相关问题时才需要）：
 *   1. node src/phone-control.mjs status      # 确认没在跑
 *   2. node 工具/验证/验证真机响铃.mjs 10      # 座机应当振铃
 *   3. node src/phone-control.mjs start       # 重新起服务
 *
 * 判读：
 *   ← +33ms  100 Trying         HT801 收到了，正在处理
 *   ← +33ms  180 Ringing        ★ 话机正在振铃（这一行就是我们要的证据）
 *   ← 紧跟着 200 OK             有人接起来了
 *   180 之后再无响应            正常：响着但没人接（脚本到点自动挂断）
 *   ← 4xx/5xx/6xx               被拒；看状态码判断是认证、还是地址不对
 *   什么都没收到                地址不对，或话机没接在同网段
 *
 * ⚠️ 一个踩过的坑：如果 180 之后**几毫秒内**就来了 200，那不是"响了两秒有人接"，
 *    而是话筒没挂好（网关处于摘机状态，来电被直接接通）。
 *    红色老式话机的叉簧容易卡住，检查时手动按一下再松开。
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, detectLocalAddress } from '../../src/phone-control.mjs';
import { SipEndpoint } from '../../src/sip-endpoint.mjs';

const RING_SECONDS = Number(process.argv[2] ?? 12);

// ⚠️ 必须显式给出配置路径：loadConfig() 不传参时**不读文件**，只返回内置默认值
//    （默认值是早年 192.168.82.x 网段的占位，会打到一个根本不存在的地址上，
//     现象是"包发出去了但一个响应都没有"，很容易被误判成网关拒绝）。
const PROJECT_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const cfg = loadConfig(join(PROJECT_ROOT, 'phone.config.json'));
// 和 cmdStart 用完全一样的探测逻辑：config 写 auto 时按"通往网关的那张网卡"来定。
let local = cfg.localAddress;
if (!local || local === 'auto') {
  local = await detectLocalAddress(cfg.ataAddress);
  if (!local) {
    console.error(`✗ 探测不到通往网关 ${cfg.ataAddress} 的本机地址。`);
    console.error('  确认网线插好、网口配了同网段 IP，或在 phone.config.json 里写死 localAddress。');
    process.exit(2);
  }
  console.log(`[网络] 自动探测到本机在网关网段的地址：${local}`);
}

console.log('════════ 真机响铃验证 ════════');
// 端口可被环境变量覆盖：这样服务开着的时候也能用别的端口试一次
// （用来判断"网关是否只接受来自它配置的 SIP 服务器端口"的包）
const sipPort = Number(process.env.PHONE_SIP_PORT ?? cfg.sipPort);
const rtpPort = Number(process.env.PHONE_RTP_PORT ?? cfg.rtpPort);
console.log(`本机     : ${local}:${sipPort}（RTP ${rtpPort}）`);
console.log(`呼叫目标 : ${cfg.ataAddress}:${cfg.ataSipPort}  用户名 ${cfg.ataUser}`);
console.log(`响铃时长 : ${RING_SECONDS}s（无人接听就自动挂断）`);
console.log('───────────────────────────────');

const sip = new SipEndpoint({
  localAddress: local,
  sipPort,
  rtpPort,
  user: cfg.sipUser,
});

let bindFailed = null;
try {
  await sip.start();
} catch (err) {
  bindFailed = err;
}

if (bindFailed) {
  const msg = String(bindFailed?.message ?? bindFailed);
  console.error(`\n✗ 绑定 ${local}:${sipPort} 失败：${msg}`);
  console.error('  十有八九是电话服务还开着。两个选择：');
  console.error('    ① 停掉服务：node src/phone-control.mjs stop（或 taskkill 那个 node 进程）');
  console.error('    ② 换个端口试：$env:PHONE_SIP_PORT=5091; $env:PHONE_RTP_PORT=15005; node 工具/验证/验证真机响铃.mjs');
  process.exit(3);
}

const seen = [];
const responses = [];
let got180 = false;
let got200 = false;
let t0 = 0;
let t180 = 0;
let t200 = 0;

sip.on('sip', ({ msg }) => {
  if (msg.kind === 'response') {
    const dt = t0 ? Date.now() - t0 : 0;
    seen.push(msg.status);
    console.log(`← +${String(dt).padStart(5)}ms  ${msg.status}`);
    responses.push(msg);
    if ((msg.status === 180 || msg.status === 183) && !t180) { got180 = true; t180 = dt; }
    if (msg.status === 200 && !t200) { got200 = true; t200 = dt; }
  } else if (msg.kind === 'request') {
    console.log(`← ${msg.method}（对端主动发来的请求）`);
  }
});
sip.on('call:outgoing', (e) => console.log(`→ INVITE 已发出，目标 ${e.target}`));
sip.on('call:outgoing-answered', () => console.log('★ 对端接听（200 OK + ACK 已回）'));
sip.on('call:failed', (e) => console.log(`✗ 呼叫被拒：${e.status} ${e.reason}`));
sip.on('debug', (d) => {
  if (d.error) console.log(`[调试] ${d.where} 出错：${d.error}`);
});
sip.on('error', (err) => console.log(`[错误] ${err?.message ?? err}`));

t0 = Date.now();
const callId = sip.callOut({
  targetAddress: cfg.ataAddress,
  targetSipPort: cfg.ataSipPort,
  targetUser: cfg.ataUser,
});
console.log(`→ 已发出 INVITE（Call-ID ${callId.slice(0, 24)}…）`);

// 给足时间：HT801 收到 INVITE 后一般几十毫秒回 100，然后按 P4010 的响铃节奏走
await new Promise((r) => setTimeout(r, RING_SECONDS * 1000));

try { sip.hangup(); } catch { /* 忽略 */ }
await new Promise((r) => setTimeout(r, 300));
try { sip.stop(); } catch { /* 忽略 */ }

console.log('───────────────────────────────');
console.log('=== 结论 ===');
if (got180 && !got200) {
  console.log(`✓ +${t180}ms 收到 180 Ringing，之后一直没人接 —— 座机正在响，回铃链路真机通过。`);
} else if (got180 && got200) {
  const gap = t200 - t180;
  console.log(`✓ 收到 180 Ringing（+${t180}ms），${gap}ms 后收到 200 OK。`);
  if (gap < 400) {
    console.log('⚠ 但 180 → 200 只隔了' + gap + 'ms —— 这不是"响了两秒有人接"，是**立刻被接起**。');
    console.log('  最可能的原因：话筒没挂好（一直处于摘机状态），网关把来电直接接通了。');
    console.log('  请检查：');
    console.log('    · 话筒是否稳稳压在叉簧上（红色老式话机的叉簧容易卡住）');
    console.log('    · 叉簧开关是否复位（手按一下再松开，看有没有"咔"的一声）');
    console.log(`    · 网关状态页的端口挂机状态（本工具只看信令，判断不了硬件叉簧）`);
    console.log('  摘机状态下还会有个副作用：网关会不停地"摘机自动拨号"，占用线路。');
  } else {
    console.log(`✓ 180 到 200 隔了 ${gap}ms，是正常的"响铃→接听"过程。`);
  }
} else if (got200) {
  console.log('✓ 收到 200 OK —— 对方接听了（可能响铃阶段太快没抓到）。');
} else if (seen.length) {
  console.log(`✗ 收到响应 ${seen.join(' / ')}，但没有 180 Ringing。`);
  const last = seen[seen.length - 1];
  if (last === 401 || last === 407) {
    console.log('  → 需要对端认证。HT801 一般要关掉「SIP 认证」或把我们的地址列入信任。');
  } else if (last === 403 || last === 404) {
    console.log('  → 被拒/找不到用户。检查 Request-URI 的用户名是否等于 HT801 的 SIP User ID。');
  } else if (last === 480 || last === 486) {
    console.log('  → 对端忙或不可用（话机可能没挂好、或已被占用）。');
  }
} else {
  console.log('✗ 一个响应都没收到 —— 包发出去了但对端没理。');
  console.log('  检查项：');
  console.log(`    ① HT801 的 P47（SIP 服务器）是不是 ${local}:${cfg.sipPort}`);
  console.log('       —— 它只接受来自"自己配置的服务器"的呼叫，来源端口不一致会被静默丢弃');
  console.log(`    ② 座机 IP 是否还是 ${cfg.ataAddress}（ping 一下）`);
  console.log('    ③ 网口是否还通（本机 172.50.1.2/24 那张网卡）');
}
process.exit(got180 || got200 ? 0 : 1);
