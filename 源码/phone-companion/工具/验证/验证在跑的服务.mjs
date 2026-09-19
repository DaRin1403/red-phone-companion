/**
 * 验证在跑的服务.mjs —— 向**正在运行的**电话服务发一条模拟 INVITE，检查它的 200 OK
 *
 * 与 自检-200OK.mjs 的区别：那个是起一个临时实例；这个是打真实运行中的服务，
 * 验证"现场"发出的报文是否合规（尤其是 Contact —— 缺它设备就不回 ACK）。
 *
 * 用法：node 工具/验证在跑的服务.mjs
 */
import dgram from 'node:dgram';
import { parseSdp } from '../../src/sip-endpoint.mjs';

const CRLF = '\r\n';
const TARGET = process.argv[2] ?? '172.50.1.2';
const SIP_PORT = Number(process.argv[3] ?? 5090);

const results = [];
const ok = (n, d = '') => results.push({ p: true, n, d });
const bad = (n, d = '') => results.push({ p: false, n, d });

const sock = dgram.createSocket('udp4');
await new Promise((r) => sock.bind(0, '0.0.0.0', r));
const myPort = sock.address().port;

const sdp = [
  'v=0', 'o=companion 8000 8000 IN IP4 127.0.0.1', 's=SIP Call',
  'c=IN IP4 127.0.0.1', 't=0 0',
  'm=audio 5004 RTP/AVP 0 8 101',
  'a=sendrecv', 'a=rtpmap:0 PCMU/8000', 'a=ptime:20',
].join(CRLF) + CRLF;

const invite = [
  `INVITE sip:263@${TARGET}:${SIP_PORT} SIP/2.0`,
  `Via: SIP/2.0/UDP 127.0.0.1:${myPort};branch=z9hG4bKverify;rport`,
  'From: "1503" <sip:companion@127.0.0.1>;tag=verifytag',
  `To: <sip:263@${TARGET}:${SIP_PORT}>`,
  'Call-ID: verify-call-1',
  'CSeq: 1 INVITE',
  'Contact: "1503" <sip:companion@127.0.0.1>',
  'Max-Forwards: 70',
  'Content-Type: application/sdp',
  `Content-Length: ${Buffer.byteLength(sdp)}`,
  '', sdp,
].join(CRLF);

console.log(`向 ${TARGET}:${SIP_PORT} 发模拟 INVITE（本端 ${myPort}）…\n`);

const respPromise = new Promise((resolve) => {
  sock.on('message', (buf) => resolve(buf.toString('utf8')));
});
sock.send(Buffer.from(invite), SIP_PORT, TARGET);
const resp = await Promise.race([respPromise, new Promise((r) => setTimeout(() => r(null), 4000))]);

if (!resp) {
  bad('服务有应答', '4 秒内无任何回应 —— 确认服务在运行、地址端口对不对');
} else {
  console.log('--- 服务回出的报文 ---');
  for (const line of resp.split(CRLF)) console.log(`| ${line}`);
  console.log('');

  const headEnd = resp.indexOf(CRLF + CRLF);
  const head = resp.slice(0, headEnd);
  const body = resp.slice(headEnd + 4);

  /^SIP\/2\.0 200 OK/.test(resp) ? ok('状态行 200 OK') : bad('状态行 200 OK', resp.split(CRLF)[0]);

  const via = /^Via:\s*(.+)$/mi.exec(head)?.[1] ?? '';
  via.includes('z9hG4bKverify') ? ok('Via 原样回填', via) : bad('Via 原样回填', via);

  const to = /^To:\s*(.+)$/mi.exec(head)?.[1] ?? '';
  /;tag=/.test(to) ? ok('To 带 tag', to) : bad('To 带 tag', to);

  const contact = /^Contact:\s*(.+)$/mi.exec(head)?.[1] ?? '';
  if (!contact) {
    bad('★ Contact 存在', '缺失 —— 设备不会回 ACK，通话建立不起来（就是这次修的 bug）');
  } else if (contact.includes(TARGET) && contact.includes(String(SIP_PORT))) {
    ok('★ Contact 指向本端服务地址', contact);
  } else {
    bad('★ Contact 地址正确', `期望含 ${TARGET}:${SIP_PORT}，实际 ${contact}`);
  }

  /^Call-ID:\s*verify-call-1\s*$/mi.test(head) ? ok('Call-ID 原样回填') : bad('Call-ID 原样回填');
  /^CSeq:\s*1 INVITE\s*$/mi.test(head) ? ok('CSeq 原样回填') : bad('CSeq 原样回填');

  const cl = Number(/^Content-Length:\s*(\d+)/mi.exec(head)?.[1] ?? -1);
  cl === Buffer.byteLength(body)
    ? ok('Content-Length 与正文一致', `${cl} 字节`)
    : bad('Content-Length 与正文一致', `声明 ${cl} 实际 ${Buffer.byteLength(body)}`);

  const parsed = parseSdp(body);
  parsed.address === TARGET ? ok('SDP c= 是本机服务地址', parsed.address) : bad('SDP c= 是本机服务地址', parsed.address);
  parsed.payloadTypes.includes(0) ? ok('SDP 提供 PCMU') : bad('SDP 提供 PCMU', JSON.stringify(parsed.payloadTypes));

  // ---- 收尾：必须补发 ACK + BYE ----
  // 只发 INVITE 拿到 200 就走，服务那边会留下一个"已接听但没有任何音频"的通话，
  // isBusy 恒为 true → 之后所有回铃都被 line-busy 挡掉。
  // 真实后果：跑完这个脚本，电话就再也不响了（排查了很久才定位到是脚本没收拾干净）。
  if (/^SIP\/2\.0 200 OK/.test(resp)) {
    const toHeader = /^To:\s*(.+)$/mi.exec(head)?.[1] ?? '';
    const branch = () => `z9hG4bK${Math.random().toString(36).slice(2, 12)}`;
    const from = 'From: "1503" <sip:companion@127.0.0.1>;tag=verifytag';
    const base = (cseq, method) => [
      `Via: SIP/2.0/UDP 127.0.0.1:${myPort};branch=${branch()};rport`,
      from,
      `To: ${toHeader}`,
      'Call-ID: verify-call-1',
      `CSeq: ${cseq} ${method}`,
      'Content-Length: 0', '', '',
    ].join(CRLF);

    sock.send(Buffer.from(`ACK sip:263@${TARGET}:${SIP_PORT} SIP/2.0${CRLF}${base(1, 'ACK')}`), SIP_PORT, TARGET);
    await new Promise((r) => setTimeout(r, 200));
    sock.send(Buffer.from(`BYE sip:263@${TARGET}:${SIP_PORT} SIP/2.0${CRLF}${base(2, 'BYE')}`), SIP_PORT, TARGET);
    await new Promise((r) => setTimeout(r, 500));
    console.log('\n已补发 ACK + BYE 收尾（不在服务里留幽灵占线）');
  } else if (resp) {
    console.log('\n（没接到 200 OK，不需要收尾）');
  }
}

console.log('═'.repeat(56));
for (const r of results) console.log(`${r.p ? '✓' : '✗'} ${r.n}${r.d ? `\n    ${r.d}` : ''}`);
const failed = results.filter((r) => !r.p).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);
sock.close();
process.exit(failed === 0 ? 0 : 1);
