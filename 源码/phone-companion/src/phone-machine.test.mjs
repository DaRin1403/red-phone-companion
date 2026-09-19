/**
 * phone-machine.test.mjs —— 电话状态机测试
 *
 * 全部依赖用假实现注入，把整条闭环跑干净：
 *   摘机 → 就绪音 → 收音频 → 挂机 → 识别 → 提交 → 回复完成 → 回铃 → 接听
 * 外加边界：录音过短、识别失败、空文本、线路忙、无人接听超时、DTMF 快捷提交。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { PhoneMachine, STATE, cleanTranscript, parseRingCadence, ringDurationMs } from './phone-machine.mjs';
import { tone, silence } from './phone-audio-lib.mjs';

// ---------------------------------------------------------------- 文本清洗

test('cleanTranscript：去掉打电话的试音词与结尾杂音', () => {
  // 真机实测的识别结果
  assert.equal(cleanTranscript('喂喂喂，可以听见吗？测试123。3。'), '测试123',
    '应去掉开头的"喂喂喂"、"可以听见吗"和结尾的"3。"');
  assert.equal(cleanTranscript('喂，帮我查一下天气。'), '帮我查一下天气');
  assert.equal(cleanTranscript('嗯，好的'), '好的');
  // "测试"不是废话，不能被删（曾误清成"一下麦克风"）
  assert.equal(cleanTranscript('哈喽，测试一下麦克风'), '测试一下麦克风');
});

test('cleanTranscript：正常句子不被误伤', () => {
  const cases = [
    '帮我查一下明天嘉兴的天气',
    '把今天的拍摄计划整理一下',
    '明天下午三点提醒我去图书馆还书',
  ];
  for (const c of cases) assert.equal(cleanTranscript(c), c, `不应改动：${c}`);
});

test('cleanTranscript：全废话时不返回空（宁可多提交也不丢话）', () => {
  const r = cleanTranscript('喂喂喂。');
  assert.ok(r.length > 0, '不能返回空串，否则用户说了话却被丢弃');
});

test('cleanTranscript：空输入与纯空白', () => {
  assert.equal(cleanTranscript(''), '');
  assert.equal(cleanTranscript('   '), '');
  assert.equal(cleanTranscript(null), '');
});

// ---------------------------------------------------------------- 假实现

class FakeSip extends EventEmitter {
  constructor({ ringTarget = '192.168.82.100' } = {}) {
    super();
    this.played = [];              // 播出的 μ-law
    this.outCalls = [];            // 主动呼叫记录
    this.hangups = 0;
    this._busy = false;
    this.ringConfig = { targetAddress: ringTarget, targetSipPort: 5060, targetUser: 'redline' };
  }

  get isBusy() { return this._busy; }

  callSnapshot() {
    return this._busy
      ? { handset: 'off_hook', lineBusy: true, id: 'fake-call' }
      : { handset: 'on_hook', lineBusy: false };
  }

  async playMuLaw(mulaw, { realtime = true } = {}) {
    this.played.push(Buffer.from(mulaw));
    if (realtime) await new Promise((r) => setTimeout(r, 1));   // 不为测试真的等
    return true;
  }

  stopPlayback() { this.stoppedPlayback = (this.stoppedPlayback ?? 0) + 1; }

  callOut(opts) {
    this.outCalls.push(opts);
    this._busy = true;
    return 'fake-out-call-id';
  }

  hangup() {
    this.hangups += 1;
    const was = this._busy;
    this._busy = false;
    // 真实 SipEndpoint 的 hangup() 会发出 call:ended（reason = local-bye）；
    // 假实现必须一致，否则会漏测"主动挂断后触发的后续动作"（如按 9 回铃）。
    if (was) {
      this.emit('call:ended', {
        id: 'fake-call', reason: 'local-bye', handset: 'on_hook', lineBusy: false,
      });
    }
    return was;
  }

  // ---- 测试辅助：模拟硬件事件
  simulateIncoming(id = 'c1') {
    this._busy = true;
    this.emit('call:incoming', { id, handset: 'off_hook', lineBusy: true, peer: { address: 'x', port: 1 } });
  }
  simulateAudio(seconds) {
    this.emit('audio:rx', tone(440, seconds));
  }
  /** 推一段**纯静音**（模拟"摘机后没说话"） */
  simulateSilence(seconds) {
    this.emit('audio:rx', silence(seconds));
  }
  simulateHangup({ reason = 'remote-bye' } = {}) {
    const snap = this.callSnapshot();
    this._busy = false;
    this.emit('call:ended', { ...snap, reason });
  }
  simulateRingAnswered() {
    this.emit('call:outgoing-answered', { id: 'fake-out-call-id', direction: 'outgoing', state: 'talking' });
  }
  simulateRingFailed(status = 408) {
    this.emit('call:failed', { id: 'fake-out-call-id', status });
  }
}

function fakeAsr({ text = '帮我查一下明天的天气', latencyMs = 120, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async transcribe(mulaw, opts) {
      calls.push({ bytes: mulaw.length, opts });
      if (fail) throw new Error(fail);
      return { text, seconds: mulaw.length / 8000, latencyMs };
    },
  };
}

/**
 * 假的会话监听器。
 * ⚠️ 必须实现 arm()/disarm()：真实实现靠 arm() 记录"从此刻起才关心回合完成"，
 *    早先因为它没被调用，出现过"输入链路全通但回复完不响铃"的静默故障。
 */
function fakeReplies() {
  const state = { armed: false, armedAt: null, armCalls: 0, disarmCalls: 0 };
  return {
    state,
    arm() { state.armed = true; state.armedAt = Date.now(); state.armCalls += 1; return state.armedAt; },
    disarm() { state.armed = false; state.disarmCalls += 1; },
    get armed() { return state.armed; },
  };
}

function fakeInjector({ fail = null } = {}) {
  const submitted = [];
  return {
    submitted,
    async submit(text) {
      if (fail) throw new Error(fail);
      submitted.push(text);
      return { ok: true };
    },
  };
}

function makeMachine(overrides = {}, opts = {}) {
  const sip = overrides.sip ?? new FakeSip();
  const asr = overrides.asr ?? fakeAsr();
  const injector = overrides.injector ?? fakeInjector();
  const replies = overrides.replies ?? fakeReplies();
  const machine = new PhoneMachine(
    { sip, asr, injector, replies, phrases: overrides.phrases ?? null }, opts);
  return { machine, sip, asr, injector, replies };
}

// ---------------------------------------------------------------- 回铃前置条件

test('提交成功后必须让监听器进入等待状态（否则永远不响铃）', async () => {
  // 这个断言是补一个真实踩过的坑：
  // 早先 machine 只保存了 replies 却从不调用 arm()，导致监听器一直待机、
  // completions 永远为 0 —— 表现为"输入链路全通，但我回复完电话不响"，
  // 且没有任何错误日志，排查了很久。
  const { machine, sip, replies } = makeMachine();
  assert.equal(replies.state.armCalls, 0, '初始不应处于等待');

  sip.simulateIncoming('c-arm');
  await settle();
  sip.simulateAudio(1.0);
  sip.simulateHangup();
  await settle();

  assert.equal(replies.state.armCalls, 1, '提交成功后必须恰好调用一次 arm()');
  assert.equal(replies.state.armed, true, '监听器应处于等待状态');
  machine.dispose();
});

test('提交失败时不应进入等待状态', async () => {
  const replies = fakeReplies();
  const { machine, sip } = makeMachine({ injector: fakeInjector({ fail: '找不到输入框' }), replies });
  sip.simulateIncoming('c-nofail');
  await settle();
  sip.simulateAudio(1.0);
  sip.simulateHangup();
  await settle();

  assert.equal(replies.state.armCalls, 0, '提交失败不该让监听器白等');
  machine.dispose();
});

test('回复未提交时不 arm（用户自己打字的场景不打扰）', async () => {
  const { machine, replies } = makeMachine();
  assert.equal(replies.state.armed, false);
  // 没有来电、没有提交，直接回铃应被拒
  const res = await machine.onReplyCompleted({ text: 'x' });
  assert.equal(res.rung, false);
  assert.equal(res.reason, 'no-pending-reply');
  machine.dispose();
});

/**
 * 事件循环推进助手。
 * 摘机流程里"播就绪音"是带 await 的异步操作，只用 setImmediate 会让断言
 * 跑在状态切换之前。这里显式留出一点时间，让异步链路跑完。
 */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 主流程

test('闭环：摘机→就绪音→收音→挂机→识别→提交→回复完成→回铃', async () => {
  const { machine, sip, injector } = makeMachine();
  const events = [];
  for (const ev of ['state', 'transcribed', 'submitted', 'ringing']) {
    machine.on(ev, () => events.push(ev));
  }

  // 1) 摘机
  sip.simulateIncoming('c1');
  await settle();
  assert.equal(sip.played.length, 1, '应播了就绪音');
  assert.ok(sip.played[0].length > 0);
  assert.equal(machine.state, STATE.LISTENING, '就绪音播完应进入收音状态');

  // 2) 说话 2 秒
  sip.simulateAudio(1.0);
  sip.simulateAudio(1.0);
  assert.equal(machine.call.bytes, 16000, '应累计到 2 秒音频');

  // 3) 挂机 → 识别 → 提交
  sip.simulateHangup();
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(injector.submitted, ['帮我查一下明天的天气'], '文字应被提交给 DSH');
  assert.equal(machine.stats.submitted, 1);
  assert.ok(machine.pendingReply, '应登记待回复任务');
  assert.equal(machine.state, STATE.IDLE);

  // 4) 回复完成 → 回铃
  const res = await machine.onReplyCompleted({ text: '好的，明天晴。' });
  assert.equal(res.rung, true);
  assert.equal(sip.outCalls.length, 1, '应发起一次主动呼叫');
  assert.equal(sip.outCalls[0].targetAddress, '192.168.82.100');
  assert.equal(machine.state, STATE.RINGING);
  assert.ok(events.includes('transcribed'));
  assert.ok(events.includes('submitted'));
  assert.ok(events.includes('ringing'));

  // 5) 用户接听
  sip.simulateRingAnswered();
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(machine.stats.answered, 1);
  assert.equal(sip.hangups >= 1, true, '接听播完确认音后应挂断');
  assert.equal(machine.state, STATE.IDLE);
  assert.equal(machine.pendingReply, null, '通知已送达，待回复标记应清掉');

  machine.dispose();
});

test('没有待回复任务时不回铃（避免用户打字时被电话打扰）', async () => {
  const { machine, sip } = makeMachine();
  const res = await machine.ring();
  assert.equal(res.rung, false);
  assert.equal(res.reason, 'no-pending-reply');
  assert.equal(sip.outCalls.length, 0);
  machine.dispose();
});

test('线路忙时不回铃，并如实告知原因', async () => {
  const { machine, sip } = makeMachine();
  machine.pendingReply = { text: 'x', requestedAt: Date.now() };
  sip._busy = true;                       // 用户正占着线路
  const res = await machine.ring();
  assert.equal(res.rung, false);
  assert.equal(res.reason, 'line-busy');
  machine.dispose();
});

test('未配置回铃目标地址时不回铃', async () => {
  const sip = new FakeSip();
  sip.ringConfig = {};
  const { machine } = makeMachine({ sip });
  machine.pendingReply = { text: 'x', requestedAt: Date.now() };
  const res = await machine.ring();
  assert.equal(res.rung, false);
  assert.equal(res.reason, 'no-ring-target');
  machine.dispose();
});

// ---------------------------------------------------------------- 边界

test('录音过短（误触）被忽略，不提交也不识别', async () => {
  const asr = fakeAsr();
  const injector = fakeInjector();
  const { machine, sip } = makeMachine({ asr, injector });

  sip.simulateIncoming('c-short');
  await settle();
  sip.simulateAudio(0.1);                 // 只有 0.1 秒，低于 0.35s 阈值
  sip.simulateHangup();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(asr.calls.length, 0, '不应调用识别');
  assert.equal(injector.submitted.length, 0, '不应提交');
  assert.equal(machine.state, STATE.IDLE);
  machine.dispose();
});

test('识别失败：播错误音、不提交、状态回 idle', async () => {
  const asr = fakeAsr({ fail: '识别服务未连接' });
  const injector = fakeInjector();
  const { machine, sip } = makeMachine({ asr, injector });
  const errors = [];
  machine.on('error', (e) => errors.push(e));

  sip.simulateIncoming('c-fail');
  await settle();
  sip.simulateAudio(1.0);
  sip.simulateHangup();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(injector.submitted.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /识别失败/);
  assert.equal(machine.state, STATE.IDLE);
  assert.ok(sip.played.length >= 2, '应播了就绪音之外的错误音');
  machine.dispose();
});

test('识别出空文本：不提交，播错误提示', async () => {
  const asr = fakeAsr({ text: '   ' });
  const injector = fakeInjector();
  const { machine, sip } = makeMachine({ asr, injector });

  sip.simulateIncoming('c-empty');
  await settle();
  sip.simulateAudio(1.0);
  sip.simulateHangup();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(injector.submitted.length, 0, '空文本不应提交');
  assert.equal(machine.state, STATE.IDLE);
  machine.dispose();
});

test('提交失败：报错、不登记待回复任务', async () => {
  const injector = fakeInjector({ fail: '找不到输入框' });
  const { machine, sip } = makeMachine({ injector });
  const errors = [];
  machine.on('error', (e) => errors.push(e));

  sip.simulateIncoming('c-injfail');
  await settle();
  sip.simulateAudio(1.0);
  sip.simulateHangup();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /提交失败/);
  assert.equal(machine.pendingReply, null, '提交失败不应留下待回复任务');
  machine.dispose();
});

test('对方取消（CANCEL）不算一次有效通话', async () => {
  const asr = fakeAsr();
  const { machine, sip } = makeMachine({ asr });
  sip.simulateIncoming('c-cancel');
  await settle();
  sip.simulateAudio(1.0);
  sip.simulateHangup({ reason: 'cancel' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asr.calls.length, 0, '取消的通话不应触发识别');
  machine.dispose();
});

test('超过最长录音时长后丢弃后续音频并告警', async () => {
  const { machine, sip } = makeMachine({}, { maxRecordSeconds: 2 });
  const warns = [];
  machine.on('warn', (w) => warns.push(w));
  sip.simulateIncoming('c-long');
  await settle();
  for (let i = 0; i < 6; i++) sip.simulateAudio(0.5);   // 共 3 秒，超过 2 秒上限
  assert.equal(machine.call.bytes, 2 * 8000, '应停在 2 秒上限');
  assert.equal(machine.call.truncated, true);
  assert.ok(warns.some((w) => w.where === 'record'));
  machine.dispose();
});

// ---------------------------------------------------------------- DTMF 与提示音

test('DTMF 按 1 立即提交，不必等挂机', async () => {
  const injector = fakeInjector();
  const { machine, sip } = makeMachine({ injector });
  sip.simulateIncoming('c-dtmf');
  await settle();
  sip.simulateAudio(1.0);

  const ok = await machine._doFinish('test');
  assert.equal(ok, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(injector.submitted, ['帮我查一下明天的天气']);
  assert.ok(sip.hangups >= 1, '立即提交应顺带挂断');
  machine.dispose();
});

test('DTMF 按 9 可主动回铃（调试用）', async () => {
  const { machine, sip } = makeMachine();
  sip.simulateIncoming('c-9');
  await settle();
  sip.emit('dtmf', { symbol: '9' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sip.outCalls.length, 1, '按 9 应发起回铃');
  machine.dispose();
});

test('就绪音优先用预渲染缓存（零延迟）', async () => {
  const cached = Buffer.from([0xab, 0xcd, 0xef]);
  const { machine, sip } = makeMachine({
    phrases: { async get(key) { return key === 'ready' ? cached : null; } },
  });
  sip.simulateIncoming('c-cache');
  await settle();
  assert.deepEqual(sip.played[0], cached, '应播放缓存音频而不是现场合成');
  machine.dispose();
});

test('预渲染缓存读取失败时退化为现场生成提示音', async () => {
  const { machine, sip } = makeMachine({
    phrases: { async get() { throw new Error('缓存损坏'); } },
  });
  sip.simulateIncoming('c-cachefail');
  await settle();
  assert.equal(sip.played.length, 1, '仍应播出提示音');
  assert.ok(sip.played[0].length > 0);
  machine.dispose();
});

// ---------------------------------------------------------------- 回铃超时

test('通知铃无人接听：到点自动取消、回到 idle，并清掉待回复标记', async () => {
  const { machine, sip } = makeMachine({}, { ringTimeoutSeconds: 0.15 });
  machine.pendingReply = { text: 'x', requestedAt: Date.now() };
  await machine.ring();
  assert.equal(machine.state, STATE.RINGING);
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(sip.hangups >= 1, '超时应主动挂断');
  assert.equal(machine.state, STATE.IDLE);
  // 这是"通知铃"不是等人接的电话：响够时间就代表通知已送达（用户要求响 5 秒自动关）。
  // 不清掉的话 status 会永远显示"有（等我说完就会响铃）"，看着像卡住了。
  assert.equal(machine.pendingReply, null, '超时即视为通知已送达，应清掉待回复标记');
  machine.dispose();
});

test('回铃被拒（如 486 忙）：记录失败并回到 idle', async () => {
  const { machine, sip } = makeMachine();
  machine.pendingReply = { text: 'x', requestedAt: Date.now() };
  await machine.ring();
  const failed = [];
  machine.on('ring:failed', (f) => failed.push(f));
  sip.simulateRingFailed(486);
  assert.equal(failed.length, 1);
  assert.equal(machine.state, STATE.IDLE);
  machine.dispose();
});

// ---------------------------------------------------------------- 响铃总开关

test('响铃总开关关闭：一声都不响，也不留待回复标记', async () => {
  const { machine, sip } = makeMachine({}, { ringbackEnabled: false });
  machine.pendingReply = { text: 'x', requestedAt: Date.now() };

  const res = await machine.onReplyCompleted({ text: '我说完了' });

  assert.equal(res.rung, false);
  assert.equal(res.reason, 'ringback-disabled');
  assert.equal(sip.outCalls.length, 0, '关掉开关后绝不能真的发起呼叫');
  assert.equal(machine.state, STATE.IDLE, '不应进入 ringing');
  // 不响也照样清标记，否则 status 会一直显示"有（等我说完就会响铃）"，看着像卡住了
  assert.equal(machine.pendingReply, null);
  machine.dispose();
});

test('响铃总开关默认开启：没配这一项时照平常响', async () => {
  const { machine, sip } = makeMachine({}, {});          // 不传 ringbackEnabled
  machine.pendingReply = { text: 'x', requestedAt: Date.now() };

  const res = await machine.ring();

  assert.equal(res.rung, true, '默认必须能响，否则会静默丢掉通知功能');
  assert.equal(sip.outCalls.length, 1);
  machine.dispose();
});

test('测试用的 force 可以绕过总开关（手动触发响铃时用）', async () => {
  const { machine, sip } = makeMachine({}, { ringbackEnabled: false });
  const res = await machine.ring({ force: true });
  assert.equal(res.rung, true);
  assert.equal(sip.outCalls.length, 1);
  machine.dispose();
});

// ---------------------------------------------------------------- 按次数响铃

test('parseRingCadence：认得网关那几种写法', () => {
  assert.deepEqual(parseRingCadence('c=1000/1000;'), { onMs: 1000, offMs: 1000 });
  assert.deepEqual(parseRingCadence('c=2000/4000;'), { onMs: 2000, offMs: 4000 });
  assert.deepEqual(parseRingCadence('1000/1000'), { onMs: 1000, offMs: 1000 });
  assert.deepEqual(parseRingCadence('c=500,500;'), { onMs: 500, offMs: 500 });
  assert.deepEqual(parseRingCadence('c=2000;'), { onMs: 2000, offMs: 2000 });
  assert.equal(parseRingCadence(''), null);
  assert.equal(parseRingCadence(null), null);
  assert.equal(parseRingCadence('c=;'), null);
});

test('ringDurationMs：响 N 次 = N 个周期 − 半个静音期（末尾留余量，不会漏出下一声）', () => {
  const cadence = { onMs: 1000, offMs: 1000 };
  assert.equal(ringDurationMs(1, cadence), 1500, '响一次：1s 铃 + 0.5s 余量');
  assert.equal(ringDurationMs(2, cadence), 3500);
  assert.equal(ringDurationMs(3, cadence), 5500);
  // 换节奏（如 2000/4000）也要跟着变，不能写死
  assert.equal(ringDurationMs(1, { onMs: 2000, offMs: 4000 }), 4000, '2s 铃 + 2s 余量');
  // 脏数据兜底：至少响一次
  assert.equal(ringDurationMs(0, cadence), 1500);
  assert.equal(ringDurationMs(-5, cadence), 1500);
  assert.equal(ringDurationMs(null, cadence), 1500);
  assert.equal(ringDurationMs('2', cadence), 3500, '字符串数字也认');
});

test('按次数响铃：配 ringCount=1 时约 1.5 秒后自动收线', async () => {
  const { machine, sip } = makeMachine({}, {
    ringCount: 1, ringCadenceOnMs: 1000, ringCadenceOffMs: 1000, ringTimeoutSeconds: 10,
  });
  machine.pendingReply = { text: 'x', requestedAt: Date.now() };

  // ⚠️ 要量的是"铃响了多久"，所以从 ring:timeout 事件取真实时刻，
  //    不能拿外面 sleep 的时长当结果（第一版就是这么写错的）。
  const t0 = Date.now();
  let timedOutAt = 0;
  machine.on('ring:timeout', () => { timedOutAt = Date.now() - t0; });

  await machine.ring();
  assert.equal(machine.state, STATE.RINGING);

  await new Promise((r) => setTimeout(r, 2200));

  assert.ok(sip.hangups >= 1, '响够一次就该挂断');
  assert.equal(machine.state, STATE.IDLE);
  assert.ok(
    timedOutAt >= 1400 && timedOutAt <= 1750,
    `应在约 1.5 秒收线（1s 铃 + 0.5s 余量），实测 ${timedOutAt}ms`,
  );
  machine.dispose();
});

test('按次数响铃：次数受 ringTimeoutSeconds 上限约束（节奏配错也不会一直响）', async () => {
  const { machine } = makeMachine({}, {
    ringCount: 999, ringCadenceOnMs: 1000, ringCadenceOffMs: 1000, ringTimeoutSeconds: 0.2,
  });
  machine.pendingReply = { text: 'x', requestedAt: Date.now() };
  await machine.ring();
  assert.equal(machine.state, STATE.RINGING);
  // 999 次按节奏算出来是 1997.5 秒，但上限 0.2 秒必须先把它压住
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(machine.state, STATE.IDLE, '应被安全上限收线');
  machine.dispose();
});

test('按次数响铃：ringing 事件里报的次数与配置一致', async () => {
  const { machine } = makeMachine({}, { ringCount: 3, ringTimeoutSeconds: 60 });
  machine.pendingReply = { text: 'x', requestedAt: Date.now() };
  const seen = [];
  machine.on('ringing', (e) => seen.push(e.rings));
  await machine.ring();
  assert.deepEqual(seen, [3]);
  machine.dispose();
});

// ---------------------------------------------------------------- 静音不送识别

test('整段没有语音（纯静音）：不送识别、不提交，直接忽略', async () => {
  const asr = fakeAsr({ text: '我。' });          // ASR 在静音上就会编出这种单字
  const submitted = [];
  const injector = { async submit(t) { submitted.push(t); return { ok: true }; }, stats: {} };
  const { machine, sip } = makeMachine({ asr, injector });

  const reasons = [];
  machine.on('state', (e) => reasons.push(e.reason));

  sip.simulateIncoming('c-silent');
  await settle();
  sip.simulateSilence(2.0);                     // 摘机后没说话
  sip.simulateHangup();
  await settle(80);

  assert.equal(asr.calls.length, 0, '静音不该送去识别 —— 否则 ASR 会凭空编出「我。」并提交');
  assert.equal(submitted.length, 0, '静音不该变成一条消息');
  assert.ok(reasons.includes('no-speech'), `应记录 no-speech，实际 ${JSON.stringify(reasons)}`);
  assert.equal(machine.state, STATE.IDLE);
  machine.dispose();
});

test('真说话（有电平）不受影响：照常识别与提交', async () => {
  const asr = fakeAsr({ text: '帮我查一下明天嘉兴的天气' });
  const submitted = [];
  const injector = { async submit(t) { submitted.push(t); return { ok: true }; }, stats: {} };
  const { machine, sip } = makeMachine({ asr, injector });

  sip.simulateIncoming('c-voice');
  await settle();
  sip.simulateAudio(1.0);                       // tone() 峰值约 2500，远高于静音阈值
  sip.simulateHangup();
  await settle(80);

  assert.equal(asr.calls.length, 1, '正常说话必须照常送识别 —— 这条是防误杀的反向断言');
  assert.deepEqual(submitted, ['帮我查一下明天嘉兴的天气']);
  machine.dispose();
});

test('静音阈值可配：把阈值调到 0 时静音也照送识别（保留调节余地）', async () => {
  const asr = fakeAsr({ text: '我。' });
  const { machine, sip } = makeMachine({ asr }, { silencePeakThreshold: 0 });

  sip.simulateIncoming('c-x');
  await settle();
  sip.simulateSilence(1.0);
  sip.simulateHangup();
  await settle(80);

  assert.equal(asr.calls.length, 1);
  machine.dispose();
});

test('快照包含状态、通话与统计，供 status 命令展示', async () => {
  const { machine, sip } = makeMachine();
  const snap = machine.snapshot;
  assert.equal(snap.state, STATE.IDLE);
  assert.equal(snap.call.handset, 'on_hook');
  assert.equal(typeof snap.stats.calls, 'number');

  sip.simulateIncoming('c-snap');
  await settle();
  assert.equal(machine.snapshot.state, STATE.LISTENING);
  assert.equal(machine.snapshot.stats.calls, 1);
  machine.dispose();
});
