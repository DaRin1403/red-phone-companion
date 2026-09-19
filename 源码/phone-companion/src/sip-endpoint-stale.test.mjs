/**
 * 回归测试：僵死通话清理（sweepStaleCall）
 *
 * 真实踩过的坑：验证脚本向运行中的服务发了一条模拟 INVITE，拿到 200 OK 就直接退出了
 * （没发 ACK、没发 BYE）。服务这边 call 对象就一直留着：
 *   · isBusy 恒为 true
 *   · 之后**所有回铃**都被 `line-busy` 挡掉
 *   · 状态机也永远卡在 listening（因为只有收到对端 BYE 才会收尾）
 * 用户能观察到的现象是："打过一次电话之后，电话就再也不响了。"
 *
 * 对端异常消失（拔线、断电、丢包）不会发 BYE —— 这类情况真实存在，
 * 所以必须有本地兜底，不能只依赖对端守规矩。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SipEndpoint } from './sip-endpoint.mjs';

/** 造一个不启套接字的最小端点（sweepStaleCall 只动 this.call 和事件） */
const makeEndpoint = () => new SipEndpoint({
  localAddress: '127.0.0.1', sipPort: 5090, rtpPort: 15004, user: 'test',
});

const fakeCall = (over = {}) => ({
  id: 'test-call',
  localTag: 'ltag',
  remoteTag: 'rtag',
  remote: { address: '127.0.0.1', port: 5060 },
  peer: { address: '127.0.0.1', port: 5000 },
  state: 'talking',
  direction: 'incoming',
  startedAt: Date.now(),
  answeredAt: Date.now(),
  audioRxFrames: 0,
  audioRxBytes: 0,
  lastRxAt: null,
  ...over,
});

test('建立后长时间一个音频包都没收到 → 判定僵死、清掉占线', () => {
  const sip = makeEndpoint();
  const old = Date.now() - 200_000;                 // 200 秒前建立，全程无音频
  sip.call = fakeCall({ startedAt: old, answeredAt: old });

  const ended = [];
  sip.on('call:ended', (e) => ended.push(e));

  assert.equal(sip.isBusy, true, '前提：确实处于占线状态');
  const reason = sip.sweepStaleCall();

  assert.equal(reason, 'stale-no-audio');
  assert.equal(sip.isBusy, false, '清掉之后必须不再占线，否则回铃会被 line-busy 永久挡住');
  assert.equal(ended.length, 1, '必须抛 call:ended，否则状态机永远卡在 listening');
  assert.equal(ended[0].reason, 'stale-no-audio');
});

test('刚建立、音频还没到的通话不能被误杀（正常通话建立后本来就有一段空窗）', () => {
  const sip = makeEndpoint();
  sip.call = fakeCall();                            // just now

  assert.equal(sip.sweepStaleCall(), null);
  assert.equal(sip.isBusy, true, '不能把正常通话清掉');
});

test('收到过音频、之后长时间完全静默 → 清理（对端中途消失）', () => {
  const sip = makeEndpoint();
  const longAgo = Date.now() - 400_000;
  sip.call = fakeCall({
    startedAt: longAgo,
    answeredAt: longAgo,
    audioRxFrames: 500,
    audioRxBytes: 80_000,
    lastRxAt: longAgo,                              // 音频停在 400 秒前
  });

  assert.equal(sip.sweepStaleCall(), 'stale-silent');
  assert.equal(sip.isBusy, false);
});

test('收到过音频、刚刚还在收 → 不清理（用户只是没说话，不能把他踢掉）', () => {
  const sip = makeEndpoint();
  const longAgo = Date.now() - 400_000;
  sip.call = fakeCall({
    startedAt: longAgo,
    answeredAt: longAgo,
    audioRxFrames: 500,
    audioRxBytes: 80_000,
    lastRxAt: Date.now() - 2_000,                   // 2 秒前还在收包
  });

  assert.equal(sip.sweepStaleCall(), null);
  assert.equal(sip.isBusy, true);
});

test('没有通话时清理是空操作（可安全地周期性调用）', () => {
  const sip = makeEndpoint();
  assert.equal(sip.sweepStaleCall(), null);
  assert.equal(sip.isBusy, false);
});
