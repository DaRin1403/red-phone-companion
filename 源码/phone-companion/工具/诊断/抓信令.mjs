/**
 * 抓信令.mjs —— 独立抓包诊断：查看 HT801 到底发了什么
 *
 * 用途：当"信令看似通了但没有声音"时，用它直接看原始 SIP 与 RTP 内容。
 * 不改主服务，独立运行。
 *
 * 用法：
 *   node 工具/抓信令.mjs                 # 同时听 SIP 5090 与 RTP 15004
 *   node 工具/抓信令.mjs --sip-port 5090 --rtp-port 15004 --seconds 60
 */
import dgram from 'node:dgram';
import os from 'node:os';
import { buildSdp, parseSipMessage, parseVia, headerTag } from '../../src/sip-endpoint.mjs';
import { parseRtp, makeRtp, tone } from '../../src/phone-audio-lib.mjs';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const SIP_PORT = Number(getArg('--sip-port', 5090));
const RTP_PORT = Number(getArg('--rtp-port', 15004));
const SECONDS = Number(getArg('--seconds', 60));
// --respond：像真服务那样应答 INVITE 并发就绪音，用来验证完整握手
const RESPOND = args.includes('--respond');
const LOCAL_ADDRESS = getArg('--local', null);

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);

let sipCount = 0;
let rtpCount = 0;
const rtpFrom = new Map();
let currentCall = null;

// ---------------------------------------------------------------- SDP / SIP

/** 把抓到的 SDP 解析出来（复用 sip-endpoint 的实现，保证与实际服务一致） */
function sdpOf(text) {
  const sep = text.indexOf('\r\n\r\n');
  return sep === -1 ? '' : text.slice(sep + 4);
}

/** 组装 200 OK（与 sip-endpoint.mjs 同逻辑，便于排查差异） */
function buildOk(inviteText, rinfo, localAddress) {
  const req = parseSipMessage(inviteText);
  const via = parseVia(req.headers.via);
  const to = req.headers.to ?? '';
  const tag = headerTag(to) ?? 'comp' + Math.random().toString(16).slice(2, 8);
  const toWithTag = headerTag(to) ? to : `${to};tag=${tag}`;
  const sdp = buildSdp({ address: localAddress, rtpPort: RTP_PORT, sessionName: 'companion' });
  const lines = [
    'SIP/2.0 200 OK',
    `Via: ${via.raw}`,
    `From: ${req.headers.from}`,
    `To: ${toWithTag}`,
    `Call-ID: ${req.headers['call-id']}`,
    `CSeq: ${req.headers.cseq}`,
    `Contact: <sip:companion@${localAddress}:${SIP_PORT}>`,
    'User-Agent: phone-companion-diag/0.1',
    'Content-Type: application/sdp',
    `Content-Length: ${Buffer.byteLength(sdp)}`,
  ];
  return {
    text: lines.join('\r\n') + '\r\n\r\n' + sdp,
    sdp,
    callId: req.headers['call-id'],
    toTag: tag,
    fromRaw: req.headers.from,
    cseq: req.headers.cseq,
  };
}

// ---------------------------------------------------------------- SIP
const sip = dgram.createSocket('udp4');
sip.on('message', (buf, rinfo) => {
  sipCount += 1;
  const text = buf.toString('utf8');
  const firstLine = text.split('\r\n')[0];
  const isRetransmit = currentCall && /Call-ID:\s*([^\r\n]+)/i.exec(text)?.[1] === currentCall.callId;
  log(`SIP#${sipCount} 来自 ${rinfo.address}:${rinfo.port}  ← ${firstLine}${isRetransmit ? '  【重传】' : ''}`);

  if (!isRetransmit || sipCount <= 2) {
    for (const h of ['Via', 'From', 'To', 'Call-ID', 'CSeq', 'Contact']) {
      const m = new RegExp(`^${h}:\\s*(.*)$`, 'mi').exec(text);
      if (m) console.log(`         ${h}: ${m[1].trim()}`);
    }
    const body = sdpOf(text);
    if (body) {
      console.log('         ---- 对端 SDP ----');
      for (const line of body.trim().split(/\r?\n/)) {
        console.log(`         ${/^(c=|m=)/.test(line) ? ' ★' : '  '} ${line}`);
      }
      const conn = /^c=IN IP4 ([\d.]+)/m.exec(body);
      const media = /^m=audio (\d+)/m.exec(body);
      if (conn && media) log(`         ⇒ 对端要求把音频发到 ${conn[1]}:${media[1]}`);
    }
  }

  // 应答（只在 --respond 时）
  if (RESPOND && firstLine.startsWith('INVITE ')) {
    const local = LOCAL_ADDRESS || (() => {
      // 选和网关同网段的本机地址
      for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list ?? []) {
          if (ni.family === 'IPv4' && ni.address.startsWith(rinfo.address.split('.').slice(0, 3).join('.'))) {
            return ni.address;
          }
        }
      }
      return os.networkInterfaces().Ethernet?.[0]?.address ?? '172.50.1.2';
    })();

    const ok = buildOk(text, rinfo, local);
    currentCall = { ...ok, peer: null };
    const conn = /^c=IN IP4 ([\d.]+)/m.exec(sdpOf(text));
    const media = /^m=audio (\d+)/m.exec(sdpOf(text));
    if (conn && media) currentCall.peer = { address: conn[1], port: Number(media[1]) };

    if (sipCount <= 2 || !isRetransmit) {
      console.log('         ---- 我发出的 200 OK ----');
      for (const line of ok.text.split('\r\n')) {
        console.log(`         ${/^(c=|m=|o=)/.test(line) ? ' ★' : '  '} ${line}`);
      }
    }
    sip.send(Buffer.from(ok.text), rinfo.port, rinfo.address);
    log(`         已回 200 OK（通告本机音频地址 ${local}:${RTP_PORT}）`);

    // 回完 OK 后播一段就绪音，验证下行音频能不能到话机
    if (!isRetransmit) {
      setTimeout(() => {
        if (!currentCall?.peer) return;
        const ready = tone(660, 0.3);
        const frames = [];
        for (let i = 0; i < ready.length; i += 160) frames.push(ready.subarray(i, i + 160));
        frames.forEach((f, idx) => {
          setTimeout(() => {
            const pkt = makeRtp(f, idx, idx * 160, 0x12345678);
            sip.send(pkt, rtpPort(), currentCall.peer.address);
          }, idx * 20);
        });
        log(`         已向 ${currentCall.peer.address}:${currentCall.peer.port} 发送 ${frames.length} 个就绪音 RTP 包`);
      }, 300);
    }
  }
});
sip.on('error', (e) => log('SIP socket 错误:', e.message));
const rtpPort = () => (currentCall?.peer?.port ?? 5004);

// ---------------------------------------------------------------- RTP
const rtp = dgram.createSocket('udp4');
rtp.on('message', (buf, rinfo) => {
  rtpCount += 1;
  const key = `${rinfo.address}:${rinfo.port}`;
  rtpFrom.set(key, (rtpFrom.get(key) ?? 0) + 1);
  const pkt = parseRtp(buf);
  if (rtpCount <= 5 || rtpCount % 100 === 0) {
    if (pkt) {
      log(`RTP#${rtpCount} 来自 ${key}  pt=${pkt.payloadType} seq=${pkt.sequence} 负载=${pkt.payload.length}字节`);
    } else {
      log(`RTP#${rtpCount} 来自 ${key}  （非标准 RTP，hex=${buf.subarray(0, 16).toString('hex')}）`);
    }
  }
});
rtp.on('error', (e) => log('RTP socket 错误:', e.message));

sip.bind(SIP_PORT, '0.0.0.0', () => log(`监听 SIP 0.0.0.0:${SIP_PORT}`));
rtp.bind(RTP_PORT, '0.0.0.0', () => log(`监听 RTP 0.0.0.0:${RTP_PORT}`));
log(`抓包 ${SECONDS} 秒${RESPOND ? '（含自动应答）' : '（只监听不应答）'} —— 现在请拿起听筒说话\n`);

setTimeout(() => {
  console.log('═'.repeat(60));
  log(`汇总：SIP ${sipCount} 条，RTP ${rtpCount} 个包`);
  if (rtpFrom.size) {
    log('RTP 来源：');
    for (const [k, v] of rtpFrom) log(`   ${k} → ${v} 个包`);
  } else {
    log('⚠️ 未收到任何 RTP —— 上行音频没来');
    if (RESPOND) log('   （若已回 200 OK 仍无音频，问题在话机侧：检查听筒线/话筒）');
  }
  try { sip.close(); } catch { /* 忽略 */ }
  try { rtp.close(); } catch { /* 忽略 */ }
  process.exit(0);
}, SECONDS * 1000);
