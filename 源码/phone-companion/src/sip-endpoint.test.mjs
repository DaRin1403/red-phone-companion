/**
 * sip-endpoint.test.mjs —— SIP/RTP 终端自测
 *
 * 用真实 UDP 套接字模拟一台 ATA（假 HT802），跑通完整信令流程：
 *   INVITE → 200 OK → ACK → RTP 双向 → BYE
 * 以及主动呼叫（回铃）路径：我们发 INVITE → 对端 200 OK → 我们回 ACK。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import {
  buildSdp, parseSdp, parseSipMessage, headerUser, headerTag, parseVia,
  SipEndpoint, decodeDtmf, SIP_REASONS,
} from './sip-endpoint.mjs';
import { makeRtp, parseRtp, tone, PHONE_RATE } from './phone-audio-lib.mjs';

const CRLF = '\r\n';

// ---------------------------------------------------------------- 纯函数

test('SDP：生成与解析往返一致', () => {
  const sdp = buildSdp({ address: '192.168.82.1', rtpPort: 15004, sessionName: 'companion' });
  assert.match(sdp, /^v=0/m);
  assert.match(sdp, /m=audio 15004 RTP\/AVP 0 101/);
  assert.match(sdp, /a=rtpmap:0 PCMU\/8000/);
  assert.match(sdp, /a=ptime:20/);

  const parsed = parseSdp(sdp);
  assert.equal(parsed.address, '192.168.82.1');
  assert.equal(parsed.port, 15004);
  assert.deepEqual(parsed.payloadTypes, [0, 101]);
});

test('SDP：只有会话级 c= 也能取到地址', () => {
  const sdp = ['v=0', 'o=- 1 1 IN IP4 10.0.0.7', 's=x', 'c=IN IP4 10.0.0.9',
    't=0 0', 'm=audio 4000 RTP/AVP 0'].join(CRLF) + CRLF;
  const parsed = parseSdp(sdp);
  assert.equal(parsed.address, '10.0.0.9', 'm= 行的 c= 优先');
  assert.equal(parsed.port, 4000);
});

test('SIP 消息解析：请求与应答', () => {
  const invite = [
    'INVITE sip:companion@192.168.82.1:5090 SIP/2.0',
    'Via: SIP/2.0/UDP 192.168.82.100:5060;branch=z9hG4bK123;rport',
    'From: <sip:redline@192.168.82.100>;tag=abc',
    'To: <sip:companion@192.168.82.1:5090>',
    'Call-ID: test-call-1',
    'CSeq: 1 INVITE',
    'Content-Type: application/sdp',
    'Content-Length: 5',
    '',
    'v=0\r\n',
  ].join(CRLF);
  const parsed = parseSipMessage(invite);
  assert.equal(parsed.kind, 'request');
  assert.equal(parsed.method, 'INVITE');
  assert.equal(parsed.headers['call-id'], 'test-call-1');
  assert.equal(parsed.headers['cseq'], '1 INVITE');
  assert.equal(headerUser(parsed.headers.from), 'redline');
  assert.equal(headerTag(parsed.headers.from), 'abc');
  assert.equal(parseVia(parsed.headers.via).branch, 'z9hG4bK123');
  assert.equal(parseVia(parsed.headers.via).sentBy, '192.168.82.100:5060');

  const resp = parseSipMessage('SIP/2.0 200 OK' + CRLF + 'Call-ID: x' + CRLF + CRLF);
  assert.equal(resp.kind, 'response');
  assert.equal(resp.status, 200);
});

test('SIP 消息解析：重复头部合并、畸形输入不崩', () => {
  const multi = 'INVITE sip:a@b SIP/2.0' + CRLF +
    'Via: SIP/2.0/UDP 1.1.1.1' + CRLF + 'Via: SIP/2.0/UDP 2.2.2.2' + CRLF + CRLF;
  assert.equal(parseSipMessage(multi).headers.via, 'SIP/2.0/UDP 1.1.1.1, SIP/2.0/UDP 2.2.2.2');
  assert.equal(parseSipMessage(''), null);
  assert.equal(headerUser(undefined), null);
  assert.equal(headerTag('no tag here'), null);
});

test('DTMF：RFC 2833 载荷解析', () => {
  const payload = Buffer.from([5, 10, 0x00, 0xc8]);   // 数字 5，时长 200
  const ev = decodeDtmf(payload);
  assert.equal(ev.rawDigit, 5);
  assert.equal(ev.symbol, '5');
  assert.equal(ev.duration, 200);

  assert.equal(decodeDtmf(Buffer.from([10, 10, 0, 100])).symbol, '*');
  assert.equal(decodeDtmf(Buffer.from([11, 10, 0, 100])).symbol, '#');
  assert.equal(decodeDtmf(Buffer.alloc(2)), null, '不足 4 字节应返回 null');
});

// ---------------------------------------------------------------- 集成：模拟 ATA

/** 造一台假 HT802：能收我们的 SIP、能发 INVITE、能收发 RTP */
async function makeFakeAta({ name = 'fake-ata' } = {}) {
  const sip = dgram.createSocket('udp4');
  const rtp = dgram.createSocket('udp4');
  const received = { sip: [], rtp: [] };
  const waiters = [];

  sip.on('message', (buf) => {
    const text = buf.toString('utf8');
    received.sip.push(text);
    for (const w of [...waiters]) {
      if (w.predicate(text)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(text); }
    }
  });
  rtp.on('message', (buf) => received.rtp.push(buf));

  await new Promise((r) => sip.bind(0, '127.0.0.1', r));
  await new Promise((r) => rtp.bind(0, '127.0.0.1', r));
  const sipPort = sip.address().port;
  const rtpPort = rtp.address().port;

  const waitFor = (predicate, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waiters.findIndex((w) => w.resolve === resolve);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(new Error(`${name}: 等待超时`));
    }, timeoutMs);
    waiters.push({
      predicate, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject,
    });
  });

  const send = (text, port, host = '127.0.0.1') =>
    new Promise((r) => sip.send(Buffer.from(text), port, host, r));

  return {
    sipPort, rtpPort, received, waitFor, send,
    /** 把 RTP 发到指定端口（端点用随机端口时必需） */
    sendRtpTo: (payload, targetPort, seq = 1, ts = 0) =>
      new Promise((r) => rtp.send(makeRtp(payload, seq, ts, 0x1234), targetPort, '127.0.0.1', r)),
    close: () => { sip.close(); rtp.close(); },
  };
}

test('集成：来电 INVITE → 200 OK → ACK → RTP 双向 → BYE', async (t) => {
  const ep = new SipEndpoint({
    localAddress: '127.0.0.1', sipPort: 0, rtpPort: 0, user: 'companion',
  });
  // 用随机端口避免与本机其他服务冲突
  ep.sipPort = 0; ep.rtpPort = 0;
  await ep.start();
  const epSipPort = ep.sipSocket.address().port;
  const epRtpPort = ep.rtpSocket.address().port;

  const ata = await makeFakeAta();
  t.after(async () => { await ep.stop(); ata.close(); });

  const events = [];
  ep.on('call:incoming', (s) => events.push(['incoming', s]));
  ep.on('call:answered', (s) => events.push(['answered', s]));
  ep.on('call:ended', (s) => events.push(['ended', s]));
  ep.on('audio:rx', () => events.push(['audio']));

  // ---- 1) ATA 摘机 → 发 INVITE
  const sdp = buildSdp({ address: '127.0.0.1', rtpPort: ata.rtpPort });
  await ata.send([
    'INVITE sip:companion@127.0.0.1 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${ata.sipPort};branch=z9hG4bKaaa;rport`,
    'From: <sip:redline@127.0.0.1>;tag=fromtag1',
    'To: <sip:companion@127.0.0.1>',
    'Call-ID: itest-1',
    'CSeq: 1 INVITE',
    'Content-Type: application/sdp',
    `Content-Length: ${Buffer.byteLength(sdp)}`,
    '', sdp,
  ].join(CRLF), epSipPort);

  const ok = await ata.waitFor((t) => t.startsWith('SIP/2.0 200'));
  assert.match(ok, /To: .*;tag=/, '200 OK 必须带 To tag');
  // 必须带 Contact：对端靠它决定把 ACK/BYE 发到哪。
  // 缺了它设备不会回 ACK，通话建立不起来（真机上表现为对方持续重拨 + 忙音）。
  const contact = /^Contact:\s*(.+)$/mi.exec(ok);
  assert.ok(contact, '200 OK 必须带 Contact 头');
  assert.match(contact[1], new RegExp(`sip:companion@127\\.0\\.0\\.1:${epSipPort}`),
    'Contact 应指向本端 SIP 地址与端口');
  const okSdp = parseSdp(ok.slice(ok.indexOf(CRLF + CRLF) + 4));
  assert.equal(okSdp.port, epRtpPort, 'SDP 里的 RTP 端口应是本端实际端口');
  assert.ok(ep.isBusy, '通话应处于忙状态');

  const incoming = events.find((e) => e[0] === 'incoming');
  assert.ok(incoming, '应触发 call:incoming');
  assert.equal(incoming[1].handset, 'off_hook');
  assert.equal(incoming[1].peer.port, ata.rtpPort, '应从 SDP 学到对端 RTP 端口');

  // ---- 2) ATA 发 ACK
  await ata.send([
    'ACK sip:companion@127.0.0.1 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${ata.sipPort};branch=z9hG4bKbbb`,
    'From: <sip:redline@127.0.0.1>;tag=fromtag1',
    `To: <sip:companion@127.0.0.1>;tag=${headerTag(ok)}`,
    'Call-ID: itest-1',
    'CSeq: 1 ACK',
    'Content-Length: 0', '',
  ].join(CRLF), epSipPort);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ep.call.state, 'talking', '收到 ACK 后应进入 talking');

  // ---- 3) ATA 发来音频（模拟用户说话），端点应收到
  await ata.sendRtpTo(tone(440, 0.02), epRtpPort, 7, 160);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(events.some((e) => e[0] === 'audio'), '应收到 RTP 音频事件');
  assert.equal(ep.call.audioRxFrames, 1);

  // ---- 4) 端点播音频给 ATA
  const played = await ep.playMuLaw(tone(660, 0.06), { realtime: false });
  assert.equal(played, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ata.received.rtp.length, 3, '0.06 秒应发出 3 个 20ms 包');
  const first = parseRtp(ata.received.rtp[0]);
  assert.equal(first.payloadType, 0, '负载类型应为 PCMU');
  assert.ok(first.payload.length <= 160);

  // ---- 5) ATA 挂机 BYE
  await ata.send([
    'BYE sip:companion@127.0.0.1 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${ata.sipPort};branch=z9hG4bKccc`,
    'From: <sip:redline@127.0.0.1>;tag=fromtag1',
    `To: <sip:companion@127.0.0.1>;tag=${headerTag(ok)}`,
    'Call-ID: itest-1',
    'CSeq: 2 BYE',
    'Content-Length: 0', '',
  ].join(CRLF), epSipPort);
  await ata.waitFor((t) => t.startsWith('SIP/2.0 200'));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ep.isBusy, false, 'BYE 后应释放通话');
  assert.ok(events.some((e) => e[0] === 'ended'), '应触发 call:ended');
  assert.equal(ep.callSnapshot().handset, 'on_hook');
});

test('集成：主动呼叫（回铃）→ 对端 200 OK → 我们回 ACK', async (t) => {
  const ep = new SipEndpoint({ localAddress: '127.0.0.1', sipPort: 0, rtpPort: 0, user: 'companion' });
  await ep.start();
  const epSipPort = ep.sipSocket.address().port;
  const ata = await makeFakeAta();
  t.after(async () => { await ep.stop(); ata.close(); });

  let answered = null;
  ep.on('call:outgoing-answered', (s) => { answered = s; });

  ep.callOut({ targetAddress: '127.0.0.1', targetSipPort: ata.sipPort, targetUser: 'redline' });

  const invite = await ata.waitFor((t) => t.startsWith('INVITE '));
  assert.match(invite, /^INVITE sip:redline@127\.0\.0\.1:\d+ SIP\/2\.0/);
  assert.match(invite, /m=audio \d+ RTP\/AVP 0 101/);
  const callId = /Call-ID: (\S+)/.exec(invite)[1];

  // 对端 200 OK
  const sdp = buildSdp({ address: '127.0.0.1', rtpPort: ata.rtpPort });
  await ata.send([
    'SIP/2.0 200 OK',
    `Via: SIP/2.0/UDP 127.0.0.1:${epSipPort};branch=z9hG4bKignored`,
    `From: ${/From: (.*)/.exec(invite)[1]}`,
    `To: <sip:redline@127.0.0.1>;tag=totag9`,
    `Call-ID: ${callId}`,
    'CSeq: 1 INVITE',
    'Content-Type: application/sdp',
    `Content-Length: ${Buffer.byteLength(sdp)}`,
    '', sdp,
  ].join(CRLF), epSipPort);

  const ack = await ata.waitFor((t) => t.startsWith('ACK '));
  assert.match(ack, /CSeq: 1 ACK/);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(answered, '应触发 call:outgoing-answered');
  assert.equal(answered.direction, 'outgoing');
  assert.equal(answered.state, 'talking');
});

test('集成：通话中主动挂断会发 BYE 并释放', async (t) => {
  const ep = new SipEndpoint({ localAddress: '127.0.0.1', sipPort: 0, rtpPort: 0, user: 'companion' });
  await ep.start();
  const epSipPort = ep.sipSocket.address().port;
  const ata = await makeFakeAta();
  t.after(async () => { await ep.stop(); ata.close(); });

  const sdp = buildSdp({ address: '127.0.0.1', rtpPort: ata.rtpPort });
  await ata.send([
    'INVITE sip:companion@127.0.0.1 SIP/2.0',
    `Via: SIP/2.0/UDP 127.0.0.1:${ata.sipPort};branch=z9hG4bKddd;rport`,
    'From: <sip:redline@127.0.0.1>;tag=t1',
    'To: <sip:companion@127.0.0.1>',
    'Call-ID: itest-bye', 'CSeq: 1 INVITE',
    'Content-Type: application/sdp',
    `Content-Length: ${Buffer.byteLength(sdp)}`, '', sdp,
  ].join(CRLF), epSipPort);
  await ata.waitFor((t) => t.startsWith('SIP/2.0 200'));

  assert.equal(ep.isBusy, true);
  assert.equal(ep.hangup(), true);
  const bye = await ata.waitFor((t) => t.startsWith('BYE '));
  assert.match(bye, /CSeq: \d+ BYE/);
  assert.equal(ep.isBusy, false);
  assert.equal(ep.hangup(), false, '无通话时挂断应返回 false');
});

test('状态码原因短语表可用', () => {
  assert.equal(SIP_REASONS[200], 'OK');
  assert.equal(SIP_REASONS[486], 'Busy Here');
});
