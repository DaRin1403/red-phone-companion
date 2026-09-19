/**
 * 回归测试：撤销"还没被接听"的去电（CANCEL）
 *
 * 真实踩过的坑：hangup() 只处理"已经接听"的通话（this.call），
 * 没被接听的去电从来没被取消过。后果是双向的：
 *   · 对端（HT801）一直把话机振铃，线路一直显示忙
 *   · 之后**所有**呼叫都被回 486 Busy Here ——
 *     连续试铃几次后电话就"再也打不通了"，而网关状态页显示话机明明是挂好的
 *
 * 这条路径正是"通知铃响 5 秒自动挂断"要走的（没人接也要收线），
 * 所以不修的话，用户要的功能本身就跑不起来。
 *
 * RFC 3261：CANCEL 必须与要撤销的 INVITE **同 branch、同 Call-ID、同 CSeq 序号**，
 * 否则对端对应不上，会当成一条新请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SipEndpoint } from './sip-endpoint.mjs';

const CRLF = '\r\n';

/** 造一个不发真包的端点：把 _sendSip 换成记录器 */
function makeSpySip() {
  const sip = new SipEndpoint({
    localAddress: '127.0.0.1', sipPort: 5090, rtpPort: 15004, user: 'companion',
  });
  const sent = [];
  sip._sendSip = (text, rinfo) => sent.push({ text, rinfo });
  return { sip, sent };
}

const headerOf = (text, name) => {
  const m = new RegExp(`^${name}:\\s*(.+)$`, 'mi').exec(text);
  return m ? m[1].trim() : '';
};
const branchOf = (via) => (/branch=([^;,\s]+)/.exec(via) ?? [])[1];

/** 发起一条去向网关的呼叫（未被接听，所以 this.call 仍是 null） */
function ringThePhone(sip) {
  return sip.callOut({
    targetAddress: '172.50.1.103', targetSipPort: 5060, targetUser: 'companion',
  });
}

test('去电还没被接听时挂断：必须发出 CANCEL（不能是空操作）', () => {
  const { sip, sent } = makeSpySip();
  ringThePhone(sip);

  assert.equal(sip.isBusy, false, '前提：还没接听，所以不算占线');

  const ok = sip.hangup();

  assert.equal(ok, true, 'hangup() 必须真的做事 —— 早先这里直接 return false，什么都没发');
  const cancel = sent.find((s) => s.text.startsWith('CANCEL'));
  assert.ok(cancel, '必须发出 CANCEL，否则对端会一直振铃、线路一直忙');
  assert.equal(cancel.rinfo.address, '172.50.1.103');
  assert.equal(cancel.rinfo.port, 5060);
});

test('CANCEL 与它撤销的 INVITE 必须同 branch / 同 Call-ID / 同 CSeq 序号', () => {
  const { sip, sent } = makeSpySip();
  ringThePhone(sip);
  sip.hangup();

  const invite = sent.find((s) => s.text.startsWith('INVITE')).text;
  const cancel = sent.find((s) => s.text.startsWith('CANCEL')).text;

  assert.equal(headerOf(cancel, 'Call-ID'), headerOf(invite, 'Call-ID'), 'Call-ID 必须一致');
  assert.equal(
    branchOf(headerOf(cancel, 'Via')),
    branchOf(headerOf(invite, 'Via')),
    'branch 必须一致 —— 不一致对端就认不出这是撤销哪条邀请',
  );
  assert.equal(
    headerOf(cancel, 'CSeq').split(/\s+/)[0],
    headerOf(invite, 'CSeq').split(/\s+/)[0],
    'CSeq 序号必须一致（只有方法名从 INVITE 变成 CANCEL）',
  );
  assert.match(headerOf(cancel, 'CSeq'), /CANCEL$/);
});

test('重复挂断不会重复发 CANCEL', () => {
  const { sip, sent } = makeSpySip();
  ringThePhone(sip);

  assert.equal(sip.hangup(), true);
  assert.equal(sip.hangup(), false, '第二次不应该再撤一次');
  assert.equal(sent.filter((s) => s.text.startsWith('CANCEL')).length, 1);
});

test('撤销后收到 487：补 ACK，且不当成"呼叫失败"上报', () => {
  const { sip, sent } = makeSpySip();
  const callId = ringThePhone(sip);
  const failed = [];
  sip.on('call:failed', (f) => failed.push(f));

  sip.hangup();

  // 模拟对端对那条 INVITE 回的 487 Request Terminated
  sip._onResponse({
    kind: 'response',
    status: 487,
    reason: 'Request Terminated',
    headers: { 'call-id': callId, to: '<sip:companion@172.50.1.103>;tag=ht801tag' },
    body: '',
  }, { address: '172.50.1.103', port: 5060 });

  assert.equal(failed.length, 0, '这是我们要取消的，不该报成呼叫失败');
  const ack = sent.find((s) => s.text.startsWith('ACK'));
  assert.ok(ack, '非 2xx 的最终应答按 RFC 也要 ACK，否则对端会一直重传');
  assert.equal(headerOf(ack.text, 'Call-ID'), callId);
});

test('撤销后的上下文会被清理，不会永远占着 _outgoing', () => {
  const { sip } = makeSpySip();
  ringThePhone(sip);
  sip.hangup();

  // 假装这次撤销已经过去很久，且对端始终没回任何东西
  for (const ctx of sip._outgoing.values()) ctx.cancelledAt = Date.now() - 60_000;
  sip.sweepStaleCall();

  assert.equal(sip._outgoing.size, 0, '超时未应答的撤销上下文应被清掉');
});

test('已接听的通话仍然走 BYE（别把两种情况搞混）', () => {
  const { sip, sent } = makeSpySip();
  const callId = ringThePhone(sip);
  sip._onResponse({
    kind: 'response',
    status: 200,
    reason: 'OK',
    headers: { 'call-id': callId, to: '<sip:companion@172.50.1.103>;tag=ht801tag' },
    body: 'v=0\r\no=- 1 1 IN IP4 172.50.1.103\r\nc=IN IP4 172.50.1.103\r\nt=0 0\r\nm=audio 5004 RTP/AVP 0\r\n',
  }, { address: '172.50.1.103', port: 5060 });

  assert.equal(sip.isBusy, true, '接听后应进入通话');
  sent.length = 0;

  assert.equal(sip.hangup(), true);
  assert.ok(sent.some((s) => s.text.startsWith('BYE')), '已接听应发 BYE');
  assert.equal(sent.some((s) => s.text.startsWith('CANCEL')), false, '已接听就不该发 CANCEL 了');
  assert.equal(sip.isBusy, false);
});

test('没有通话也没有去电时，挂断是安全的空操作', () => {
  const { sip, sent } = makeSpySip();
  assert.equal(sip.hangup(), false);
  assert.equal(sent.length, 0);
});

test('CRLF 拼装正确（SIP 消息头必须以 CRLF 分隔、以空行结束）', () => {
  const { sip, sent } = makeSpySip();
  ringThePhone(sip);
  sip.hangup();
  const cancel = sent.find((s) => s.text.startsWith('CANCEL')).text;
  assert.ok(cancel.includes(CRLF + CRLF), '必须有结束用的空行');
  assert.match(cancel, /^CANCEL sip:companion@172\.50\.1\.103:5060 SIP\/2\.0/);
});
