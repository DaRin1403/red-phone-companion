/**
 * 验证通知铃.mjs —— 确认"回铃响 N 次后自动挂断、不用接听"在真机上成立。
 *
 * 为什么需要它：
 *   改配置只是改几个数字，真正要保证的是 **话机确实响了那么多声、然后服务主动挂断**
 *   （而不是一直响到响铃超时）。这条只有真机 + 真状态机跑一遍才能确认。
 *
 * ⚠️ 关于"次数"：SIP 只在对端**开始**振铃时回一次 180 Ringing，
 *    之后每响一声**没有任何通知** —— 所以响了几声没法直接观测，
 *    只能按网关的铃音节奏（HT801 的 P4010）推算期望时长，再看实测对不对。
 *    网关节奏与 config 里的 ringCadence* 必须一致（python ht801.py inspect 可核对）。
 *
 * 用的都是真家伙：真 SipEndpoint、真 PhoneMachine、真网关、真话机。
 * 只有端口用临时的（默认 5091/15005），所以**不影响正在跑的服务**。
 *
 * 用法：
 *   node 工具/验证/验证通知铃.mjs          # 按 config 里的 ringCount
 *   node 工具/验证/验证通知铃.mjs 2        # 指定期望响几声
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, detectLocalAddress } from '../../src/phone-control.mjs';
import { SipEndpoint } from '../../src/sip-endpoint.mjs';
import { PhoneMachine, ringDurationMs } from '../../src/phone-machine.mjs';

const PROJECT_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const cfg = loadConfig(join(PROJECT_ROOT, 'phone.config.json'));

const cadence = {
  onMs: Number(cfg.ringCadenceOnMs) || 1000,
  offMs: Number(cfg.ringCadenceOffMs) || 1000,
};
const expected = Math.max(1, Math.floor(Number(process.argv[2] ?? cfg.ringCount ?? 1)));
const expectedMs = ringDurationMs(expected, cadence);

const sipPort = Number(process.env.PHONE_SIP_PORT ?? 5091);
const rtpPort = Number(process.env.PHONE_RTP_PORT ?? 15005);

let local = cfg.localAddress;
if (!local || local === 'auto') local = await detectLocalAddress(cfg.ataAddress);
if (!local) {
  console.error(`✗ 探测不到通往网关 ${cfg.ataAddress} 的本机地址`);
  process.exit(2);
}

console.log('════════ 通知铃验证 ════════');
console.log(`本机     : ${local}:${sipPort}（临时端口，不影响在跑的服务）`);
console.log(`呼叫目标 : ${cfg.ataAddress}:${cfg.ataSipPort}  用户名 ${cfg.ataUser}`);
console.log(`期望响铃 : ${expected} 次（网关节奏 ${cadence.onMs}/${cadence.offMs} ms → 约 ${expectedMs}ms 后挂断）`);
console.log('───────────────────────────────');
console.log('★ 座机现在会响，留意听响了几声');
console.log('');

const sip = new SipEndpoint({ localAddress: local, sipPort, rtpPort, user: cfg.sipUser });
sip.ringConfig = {
  targetAddress: cfg.ataAddress,
  targetSipPort: cfg.ataSipPort,
  targetUser: cfg.ataUser,
};
sip.on('call:failed', (e) => console.log(`✗ 呼叫被拒：${e.status} ${e.reason}`));
await sip.start();

const machine = new PhoneMachine(
  { sip, phrases: { async get() { return null; } } },
  {
    ringRings: cfg.ringRings,
    ringTimeoutSeconds: cfg.ringTimeoutSeconds,
    ringCount: cfg.ringCount,
    ringCadenceOnMs: cadence.onMs,
    ringCadenceOffMs: cadence.offMs,
  },
);

machine.pendingReply = { text: '（验证用）', requestedAt: Date.now() };

const events = [];
machine.on('ringing', () => events.push({ what: 'ringing', at: Date.now() }));
machine.on('ring:timeout', () => events.push({ what: 'ring:timeout', at: Date.now() }));
machine.on('ring:answered', () => events.push({ what: 'ring:answered', at: Date.now() }));

const res = await machine.ring();
if (!res.rung) {
  console.error(`✗ 没能发起回铃：${res.reason}`);
  process.exit(1);
}

// 等它自己收线
const limit = expectedMs + 8000;
const t0 = Date.now();
while (Date.now() - t0 < limit) {
  if (machine.state !== 'ringing') break;
  await new Promise((r) => setTimeout(r, 50));
}

const ringing = events.find((e) => e.what === 'ringing');
const timeout = events.find((e) => e.what === 'ring:timeout');
const answered = events.find((e) => e.what === 'ring:answered');

console.log('');
for (const e of events) {
  console.log(`  +${String(ringing ? e.at - ringing.at : 0).padStart(5)}ms  ${e.what}`);
}

let failed = 0;
const check = (pass, name, detail = '') => {
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!pass) failed += 1;
};

console.log('\n=== 结论 ===');
check(Boolean(ringing), '已发起回铃（话机应已振铃）');
check(Boolean(timeout), '到点自动收线（没人接也挂断）');
check(!answered, '整个过程没有人接听（所以量到的是纯响铃）', answered ? '有人接听了，时长没意义' : '');

if (ringing && timeout) {
  const ms = timeout.at - ringing.at;
  const drift = Math.abs(ms - expectedMs);
  check(
    drift <= 400,
    `实测收线时刻与"响 ${expected} 次"吻合`,
    `期望约 ${expectedMs}ms，实测 ${ms}ms（偏差 ${drift}ms）。`
    + ' 偏差大就把 config 里的 ringCadence* 和网关 P4010 对齐（python ht801.py inspect）。',
  );
}
check(machine.pendingReply === null, '待回复标记已清掉（status 不会一直显示"有待回复"）');
check(machine.state !== 'ringing', '状态已离开 ringing', `当前 ${machine.state}`);

await sip.stop();
machine.dispose();

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`);
process.exit(failed === 0 ? 0 : 1);
