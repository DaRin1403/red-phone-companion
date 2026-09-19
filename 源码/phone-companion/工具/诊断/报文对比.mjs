/**
 * 报文对比.mjs —— 逐字节对比"能工作的诊断版 200 OK"与"服务版 200 OK"
 *
 * 背景：诊断脚本发 200 OK 后设备立刻回 ACK 并开始发 RTP；
 *       真服务发 200 OK 后设备毫无反应、持续重拨。
 *       两者实现看似相同，必须逐字节找出差异。
 */
import { buildSdp, parseSipMessage, parseVia, headerTag } from '../../src/sip-endpoint.mjs';

const CRLF = '\r\n';

// 一条真实抓到的 HT801 INVITE（来自实际抓包）
const INVITE = [
  'INVITE sip:263@172.50.1.2:5090 SIP/2.0',
  'Via: SIP/2.0/UDP 172.50.1.103:5060;branch=z9hG4bK1116045215;rport',
  'From: "1503" <sip:companion@172.50.1.2:5090>;tag=34360856',
  'To: <sip:263@172.50.1.2:5090>',
  'Call-ID: 267155984-5060-9@BHC.FA.B.BAD',
  'CSeq: 70 INVITE',
  'Contact: "1503" <sip:companion@172.50.1.103:5060>',
  'Max-Forwards: 70',
  'User-Agent: Grandstream HT801 1.0.3.2',
  'Content-Type: application/sdp',
].join(CRLF) + CRLF + CRLF + [
  'v=0',
  'o=companion 8000 8000 IN IP4 172.50.1.103',
  's=SIP Call',
  'c=IN IP4 172.50.1.103',
  't=0 0',
  'm=audio 5004 RTP/AVP 0 8 4 18 2 97 123 101',
  'a=sendrecv',
  'a=rtpmap:0 PCMU/8000',
  'a=ptime:20',
].join(CRLF) + CRLF;

const LOCAL = '172.50.1.2';
const RTP_PORT = 15004;
const SIP_PORT = 5090;

// ---------------------------------------------------------------- 诊断版（已验证可用）
function diagOk(inviteText) {
  const req = parseSipMessage(inviteText);
  const via = parseVia(req.headers.via);
  const to = req.headers.to ?? '';
  const tag = headerTag(to) ?? 'comp' + Math.random().toString(16).slice(2, 8);
  const toWithTag = headerTag(to) ? to : `${to};tag=${tag}`;
  const sdp = buildSdp({ address: LOCAL, rtpPort: RTP_PORT, sessionName: 'companion' });
  const lines = [
    'SIP/2.0 200 OK',
    `Via: ${via.raw}`,
    `From: ${req.headers.from}`,
    `To: ${toWithTag}`,
    `Call-ID: ${req.headers['call-id']}`,
    `CSeq: ${req.headers.cseq}`,
    `Contact: <sip:companion@${LOCAL}:${SIP_PORT}>`,
    'User-Agent: phone-companion-diag/0.1',
    'Content-Type: application/sdp',
    `Content-Length: ${Buffer.byteLength(sdp)}`,
  ];
  return lines.join(CRLF) + CRLF + CRLF + sdp;
}

// ---------------------------------------------------------------- 服务版（复刻 sip-endpoint._respond）
function serviceOk(inviteText) {
  const req = parseSipMessage(inviteText);
  const via = parseVia(req.headers.via);
  const callId = req.headers['call-id'] ?? '';
  const from = req.headers.from ?? '';
  let to = req.headers.to ?? '';
  const tag = headerTag(to) ?? 'comp99999';
  if (!headerTag(to)) to = `${to};tag=${tag}`;
  const sdp = buildSdp({ address: LOCAL, rtpPort: RTP_PORT, sessionName: 'companion' });
  const lines = [
    'SIP/2.0 200 OK',
    `Via: ${via.raw}`,
    `From: ${from}`,
    `To: ${to}`,
    `Call-ID: ${callId}`,
    `CSeq: ${req.headers.cseq ?? ''}`,
    'User-Agent: phone-companion/0.1',
  ];
  lines.push('Content-Type: application/sdp');
  lines.push(`Content-Length: ${Buffer.byteLength(sdp)}`);
  return lines.join(CRLF) + CRLF + CRLF + sdp;
}

const d = diagOk(INVITE);
const s = serviceOk(INVITE);

console.log('=== 字节数 ===');
console.log('诊断版:', Buffer.byteLength(d), '字节');
console.log('服务版:', Buffer.byteLength(s), '字节');
console.log('');
console.log('=== 诊断版完整报文（每行加行尾可见标记）===');
for (const line of d.split(CRLF)) console.log(`| ${line}`);
console.log('');
console.log('=== 服务版完整报文 ===');
for (const line of s.split(CRLF)) console.log(`| ${line}`);
console.log('');

// 逐行差异
const dl = d.split(CRLF);
const sl = s.split(CRLF);
console.log('=== 逐行差异 ===');
const n = Math.max(dl.length, sl.length);
let diffCount = 0;
for (let i = 0; i < n; i++) {
  if (dl[i] !== sl[i]) {
    diffCount += 1;
    console.log(`行 ${i}:`);
    console.log(`   诊断: ${JSON.stringify(dl[i])}`);
    console.log(`   服务: ${JSON.stringify(sl[i])}`);
  }
}
console.log(diffCount === 0 ? '✅ 两者完全一致（除随机 tag 外）' : `共 ${diffCount} 行不同`);

// 关键校验
console.log('');
console.log('=== 结构校验 ===');
for (const [name, msg] of [['诊断', d], ['服务', s]]) {
  const headEnd = msg.indexOf(CRLF + CRLF);
  const head = msg.slice(0, headEnd);
  const body = msg.slice(headEnd + 4);
  const cl = /Content-Length: (\d+)/i.exec(head)?.[1];
  const ok = Number(cl) === Buffer.byteLength(body);
  console.log(`${name}: Content-Length=${cl}  实际正文=${Buffer.byteLength(body)}  ${ok ? '✓ 一致' : '✗ 不一致！'}`);
  console.log(`  换行符: ${msg.includes('\r\n') ? 'CRLF ✓' : 'LF ✗'}   结尾: ${JSON.stringify(msg.slice(-4))}`);
}
