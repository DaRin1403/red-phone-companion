/**
 * 验证回铃链路.mjs —— 端到端验证"我回复完成 → 电话响铃"这条路径
 *
 * 背景：真机上出现过"输入链路全通，但我回复完电话不响"。
 * 根因是状态机保存了 replies 却从不调用 arm()，监听器一直待机（completions 恒为 0）。
 *
 * 这个脚本把整条路径串起来验证：
 *   真 SessionWatcher（监听真实会话目录结构）
 *     + 真 PhoneMachine（真就绪音、真呼叫逻辑）
 *     + 假 ATA（模拟 HT801 收 INVITE）
 *   → 人工制造一个"回合完成"事件 → 断言电话被呼叫
 *
 * 用法：node 工具/验证回铃链路.mjs
 */
import zlib from 'node:zlib';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { SessionWatcher } from '../../src/phone-replies.mjs';
import { PhoneMachine, STATE } from '../../src/phone-machine.mjs';
import { tone } from '../../src/phone-audio-lib.mjs';

const CRLF = '\r\n';
const checks = [];
const ok = (n, d = '') => checks.push({ p: true, n, d });
const bad = (n, d = '') => checks.push({ p: false, n, d });

// ---------------------------------------------------------------- 假 ATA

class FakeSip extends EventEmitter {
  constructor() {
    super();
    this.played = [];
    this.outCalls = [];
    this._busy = false;
    this.ringConfig = { targetAddress: '172.50.1.103', targetSipPort: 5060, targetUser: 'companion' };
  }
  get isBusy() { return this._busy; }
  callSnapshot() {
    return this._busy
      ? { handset: 'off_hook', lineBusy: true, id: 'c' }
      : { handset: 'on_hook', lineBusy: false };
  }
  async playMuLaw(mulaw) { this.played.push(Buffer.from(mulaw)); return true; }
  stopPlayback() { }
  callOut(opts) { this.outCalls.push(opts); this._busy = true; return 'ring-call-1'; }
  hangup() { const w = this._busy; this._busy = false; return w; }
  simulateIncoming(id = 'c1') {
    this._busy = true;
    this.emit('call:incoming', { id, handset: 'off_hook', lineBusy: true, peer: { address: 'x', port: 1 } });
  }
  simulateAudio(sec) { this.emit('audio:rx', tone(440, sec)); }
  simulateHangup() { const s = this.callSnapshot(); this._busy = false; this.emit('call:ended', { ...s, reason: 'remote-bye' }); }
}

// ---------------------------------------------------------------- 造会话文件

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const frame = (obj) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'));
const evTurnStart = (t) => ({ type: 'turn/start', seq: t * 1000, data: { turn: t } });
const evAssistant = (t, seq, text) => ({
  type: 'assistant/message', seq, data: { turn: t, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const evTurnEnd = (t, time) => ({ type: 'turn/end', seq: t * 1000 + 500, time, data: { turn: t, reason: { kind: 'completed' } } });

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 开始

console.log('=== 回铃链路端到端验证 ===\n');

const dir = mkdtempSync(join(tmpdir(), 'ring-verify-'));
const sessionFile = join(dir, 'session.jsonl.zstd');
// 先写一个"历史回合"，用来验证不会被误触发
writeFileSync(sessionFile, Buffer.concat([frame(evTurnStart(1)), frame(evTurnEnd(1, 1000))]));

const sip = new FakeSip();
const watcher = new SessionWatcher({ sessionDir: dir, pollMs: 60, autoResolve: false, sessionFile });
const injector = { submitted: [], async submit(t) { this.submitted.push(t); return { ok: true }; } };
const asr = { async transcribe() { return { text: '帮我查一下明天的天气', seconds: 2, latencyMs: 100 }; } };

const machine = new PhoneMachine({ sip, asr, injector, replies: watcher, phrases: null });

// 按 buildService 的方式接线：监听器检测到"回复完成"后，交由状态机发起呼叫。
// 真机上缺的就是这一步（以及状态机里缺 arm 调用），两处都补。
watcher.on('reply-completed', async (info) => {
  await machine.onReplyCompleted({ text: info.reply });
});

const events = [];
machine.on('state', (e) => events.push(`state:${e.from}->${e.to}`));
machine.on('ringing', () => events.push('ringing'));
machine.on('error', (e) => events.push(`error:${e.error}`));

watcher.start();
await settle(60);

// ---- 1) 起始状态：不应处于等待
console.log('[1] 服务刚启动（未接电话）');
if (!watcher.armed) ok('监听器未处于等待状态');
else bad('监听器未处于等待状态', '不该在没人打电话时就等着');

// ---- 2) 模拟一次完整的电话提交
console.log('[2] 模拟摘机 → 说话 → 挂机');
sip.simulateIncoming('call-A');
await settle(60);
sip.simulateAudio(2.0);
sip.simulateHangup();
await settle(80);

if (injector.submitted.length === 1) ok('文字已提交给 DSH', injector.submitted[0]);
else bad('文字已提交给 DSH', `提交 ${injector.submitted.length} 次`);

if (watcher.armed) ok('★ 提交后监听器进入等待状态（arm 已调用）');
else bad('★ 提交后监听器进入等待状态', '这是真机上漏掉的调用，会导致永远不响铃');

if (machine.pendingReply) ok('已登记待回复任务');
else bad('已登记待回复任务', '没有它就永远不会响铃');

// ---- 3) 制造"我这一轮回复完成"
console.log('[3] 制造一个"回合完成"事件（模拟我回复完毕）');
const ringsBefore = sip.outCalls.length;
appendFileSync(sessionFile, Buffer.concat([
  frame(evTurnStart(2)),
  frame(evAssistant(2, 2100, '明天嘉兴晴，气温 22 到 30 度。')),
  frame(evTurnEnd(2, Date.now())),
]));

// 等监听器轮询到（pollMs=60，给足余量）
for (let i = 0; i < 30 && sip.outCalls.length === ringsBefore; i++) await settle(60);

if (sip.outCalls.length > ringsBefore) {
  ok('★★ 电话被呼叫（回铃触发成功）');
  const call = sip.outCalls[sip.outCalls.length - 1];
  console.log(`     呼叫目标: ${call.targetAddress}:${call.targetSipPort}  用户: ${call.targetUser}`);
  if (call.targetAddress === '172.50.1.103') ok('呼叫目标地址正确');
  else bad('呼叫目标地址正确', call.targetAddress);
  if (call.targetUser === 'companion') ok('呼叫用户名与设备 SIP 用户 ID 一致');
  else bad('呼叫用户名一致', call.targetUser);
} else {
  bad('★★ 电话被呼叫（回铃触发成功）', '回合完成后没有发起呼叫 —— 回铃链路断了');
}

if (machine.state === STATE.RINGING) ok('状态机进入 ringing');
else bad('状态机进入 ringing', `当前 ${machine.state}`);

if (!watcher.armed) ok('触发后自动解除等待（避免重复响铃）');
else bad('触发后自动解除等待', '仍处于等待状态');

// ---- 4) 用户接听
console.log('[4] 模拟用户接听');
sip.emit('call:outgoing-answered', { id: 'ring-call-1', direction: 'outgoing', state: 'talking' });
await settle(300);
if (machine.stats.answered === 1) ok('记录到用户接听');
else bad('记录到用户接听', `answered=${machine.stats.answered}`);
if (machine.pendingReply === null) ok('接听后清掉待回复标记');
else bad('接听后清掉待回复标记', '未清除');

// ---- 5) 历史回合不应误触发
console.log('[5] 再制造一个回合完成，但本次未经过电话提交');
const before = sip.outCalls.length;
watcher.arm();          // 手工 arm 模拟"又打了一次电话"
await settle(60);
watcher.disarm();       // 但立刻放弃（模拟用户自己打字，不该打扰）
appendFileSync(sessionFile, Buffer.concat([
  frame(evTurnStart(3)),
  frame(evTurnEnd(3, Date.now())),
]));
await settle(300);
if (sip.outCalls.length === before) ok('未等待时不响铃（用户打字不会被电话打扰）');
else bad('未等待时不响铃', '被误触发了');

// ---------------------------------------------------------------- 汇总
machine.dispose();
watcher.stop();
console.log('\n' + '='.repeat(60));
for (const c of checks) console.log(`${c.p ? '✓' : '✗'} ${c.n}${c.d ? `\n      ${c.d}` : ''}`);
const failed = checks.filter((c) => !c.p).length;
console.log(`\n通过 ${checks.length - failed}/${checks.length}`);
console.log(`\n关键事件序列: ${events.join(' → ')}`);
process.exit(failed === 0 ? 0 : 1);
