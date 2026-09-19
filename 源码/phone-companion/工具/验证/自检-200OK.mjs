/**
 * 自检-200OK.mjs —— 不依赖真机的端到端验证：服务实际发出的 200 OK 是否"能被设备接受"
 *
 * 为什么需要：真机联调时踩过一个坑 —— 200 OK 缺少 Contact 头，
 * 设备因此不回 ACK、通话建立不起来（表现为对方持续重拨 + 忙音）。
 * 这个自检把"能工作的报文应具备哪些字段"固化成断言，避免回归。
 *
 * 做法：起一个真的 SipEndpoint，用真实 UDP 套接字发一条 INVITE 进去，
 *      抓它回出来的 200 OK，逐项校验。
 *
 * 用法：node 工具/自检-200OK.mjs
 */
import dgram from 'node:dgram';
import { SipEndpoint } from '../../src/sip-endpoint.mjs';
import { parseSdp } from '../../src/sip-endpoint.mjs';

const CRLF = '\r\n';
const LOCAL = '127.0.0.1';

const checks = [];
const ok = (name, detail = '') => checks.push({ pass: true, name, detail });
const bad = (name, detail = '') => checks.push({ pass: false, name, detail });

// 造一台"假 ATA"
const ata = dgram.createSocket('udp4');
await new Promise((r) => ata.bind(0, LOCAL, r));
const ataSipPort = ata.address().port;

const ataRtp = dgram.createSocket('udp4');
await new Promise((r) => ataRtp.bind(0, LOCAL, r));
const ataRtpPort = ataRtp.address().port;

// 起真服务
const ep = new SipEndpoint({ localAddress: LOCAL, sipPort: 0, rtpPort: 0, user: 'companion' });
await ep.start();
const epSipPort = ep.sipPort;
const epRtpPort = ep.rtpPort;

console.log('=== 自检：服务版 200 OK 的可接受性 ===');
console.log(`假 ATA   SIP ${ataSipPort}  RTP ${ataRtpPort}`);
console.log(`被测服务 SIP ${epSipPort}  RTP ${epRtpPort}\n`);

// 发送 INVITE，等待 200 OK
const sdp = [
  'v=0', 'o=companion 8000 8000 IN IP4 127.0.0.1', 's=SIP Call',
  'c=IN IP4 127.0.0.1', 't=0 0',
  `m=audio ${ataRtpPort} RTP/AVP 0 8 101`,
  'a=sendrecv', 'a=rtpmap:0 PCMU/8000', 'a=ptime:20',
].join(CRLF) + CRLF;

const invite = [
  'INVITE sip:263@127.0.0.1 SIP/2.0',
  `Via: SIP/2.0/UDP 127.0.0.1:${ataSipPort};branch=z9hG4bKselftest;rport`,
  'From: "1503" <sip:companion@127.0.0.1>;tag=selftag',
  'To: <sip:263@127.0.0.1>',
  'Call-ID: selftest-call-1',
  'CSeq: 1 INVITE',
  'Contact: "1503" <sip:companion@127.0.0.1>',
  'Max-Forwards: 70',
  'Content-Type: application/sdp',
  `Content-Length: ${Buffer.byteLength(sdp)}`,
  '', sdp,
].join(CRLF);

const responsePromise = new Promise((resolve) => {
  ata.on('message', (buf) => resolve(buf.toString('utf8')));
});
ata.send(Buffer.from(invite), epSipPort, LOCAL);
const resp = await Promise.race([
  responsePromise,
  new Promise((r) => setTimeout(() => r(null), 3000)),
]);

if (!resp) {
  bad('收到 200 OK', '3 秒内没有任何应答');
} else {
  console.log('--- 服务回出的报文 ---');
  for (const line of resp.split(CRLF)) console.log(`| ${line}`);
  console.log('');

  const headEnd = resp.indexOf(CRLF + CRLF);
  const head = resp.slice(0, headEnd);
  const body = resp.slice(headEnd + 4);

  // 1) 状态行
  /^SIP\/2\.0 200 OK/.test(resp)
    ? ok('状态行是 "SIP/2.0 200 OK"')
    : bad('状态行是 "SIP/2.0 200 OK"', resp.split(CRLF)[0]);

  // 2) Via 必须原样回填
  const viaLine = /^Via:\s*(.+)$/mi.exec(head)?.[1] ?? '';
  viaLine.includes('z9hG4bKselftest') && viaLine.includes(`${ataSipPort}`)
    ? ok('Via 原样回填（含 branch 与来源端口）', viaLine)
    : bad('Via 原样回填', viaLine);

  // 3) To 必须带 tag
  const toLine = /^To:\s*(.+)$/mi.exec(head)?.[1] ?? '';
  /;tag=/.test(toLine)
    ? ok('To 带上了 tag', toLine)
    : bad('To 带上了 tag', toLine);

  // 4) Contact —— 就是这次踩的坑
  const contactLine = /^Contact:\s*(.+)$/mi.exec(head)?.[1] ?? '';
  if (contactLine && contactLine.includes(`:${epSipPort}`)) {
    ok('★ Contact 存在且指向本端 SIP 地址', contactLine);
  } else if (contactLine) {
    bad('★ Contact 指向本端端口', `期望含 :${epSipPort}，实际 ${contactLine}`);
  } else {
    bad('★ Contact 存在', '缺少 Contact 头 —— 设备不会回 ACK，通话建立不起来');
  }

  // 5) Call-ID / CSeq 原样回填
  /^Call-ID:\s*selftest-call-1\s*$/mi.test(head)
    ? ok('Call-ID 原样回填')
    : bad('Call-ID 原样回填', head.match(/^Call-ID:.*$/mi)?.[0]);
  /^CSeq:\s*1 INVITE\s*$/mi.test(head)
    ? ok('CSeq 原样回填')
    : bad('CSeq 原样回填', head.match(/^CSeq:.*$/mi)?.[0]);

  // 6) Content-Type / Content-Length 一致
  const ct = /^Content-Type:\s*(.+)$/mi.exec(head)?.[1] ?? '';
  ct.includes('application/sdp')
    ? ok('Content-Type 是 application/sdp', ct)
    : bad('Content-Type 是 application/sdp', ct);
  const cl = Number(/^Content-Length:\s*(\d+)/mi.exec(head)?.[1] ?? -1);
  cl === Buffer.byteLength(body)
    ? ok('Content-Length 与实际正文一致', `${cl} 字节`)
    : bad('Content-Length 与实际正文一致', `声明 ${cl}，实际 ${Buffer.byteLength(body)}`);

  // 7) SDP 关键行
  const parsed = parseSdp(body);
  parsed.address === LOCAL
    ? ok('SDP c= 是本机地址', parsed.address)
    : bad('SDP c= 是本机地址', `期望 ${LOCAL}，实际 ${parsed.address}`);
  parsed.port === epRtpPort
    ? ok('SDP m= 是本端实际 RTP 端口', String(parsed.port))
    : bad('SDP m= 是本端实际 RTP 端口', `期望 ${epRtpPort}，实际 ${parsed.port}`);
  parsed.payloadTypes.includes(0)
    ? ok('SDP 提供 PCMU(pt=0)', JSON.stringify(parsed.payloadTypes))
    : bad('SDP 提供 PCMU(pt=0)', JSON.stringify(parsed.payloadTypes));
}

// 顺便验证：ACK 之后能进入 talking，且能收到 RTP 并回调
ep.on('call:incoming', () => { /* 已在上方间接验证 */ });
let gotAudio = false;
ep.on('audio:rx', () => { gotAudio = true; });

// 发 ACK
const ack = [
  `ACK sip:companion@${LOCAL}:${epSipPort} SIP/2.0`,
  `Via: SIP/2.0/UDP ${LOCAL}:${ataSipPort};branch=z9hG4bKack;rport`,
  'From: "1503" <sip:companion@127.0.0.1>;tag=selftag',
  `To: <sip:263@127.0.0.1>;tag=selftagresp`,
  'Call-ID: selftest-call-1',
  'CSeq: 1 ACK',
  'Content-Length: 0', '',
].join(CRLF);
// 用服务实际给出的 To tag 才严谨，这里宽松处理（服务接受任意 tag 的 ACK）
ata.send(Buffer.from(ack), epSipPort, LOCAL);
await new Promise((r) => setTimeout(r, 150));
ep.isBusy && ep.call?.state === 'talking'
  ? ok('收到 ACK 后进入 talking')
  : bad('收到 ACK 后进入 talking', `state=${ep.call?.state ?? 'null'}`);

// 发一个 RTP 包，验证音频回调
const { makeRtp, tone } = await import('../../src/phone-audio-lib.mjs');
ataRtp.send(makeRtp(tone(440, 0.02), 1, 0, 0x1111), epRtpPort, LOCAL);
await new Promise((r) => setTimeout(r, 150));
gotAudio ? ok('能接收 RTP 音频并回调') : bad('能接收 RTP 音频并回调');

// ---------------------------------------------------------------- 汇总
console.log('\n' + '═'.repeat(60));
for (const c of checks) console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? `\n    ${c.detail}` : ''}`);
const failed = checks.filter((c) => !c.pass).length;
console.log(`\n通过 ${checks.length - failed}/${checks.length}`);

ata.close(); ataRtp.close();
await ep.stop();
process.exit(failed === 0 ? 0 : 1);
