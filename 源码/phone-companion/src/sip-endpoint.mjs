/**
 * sip-endpoint.mjs —— 极简 SIP/RTP 终端（UDP）
 *
 * 只实现 HT802 这台 FXS 网关实际会用到的最小集合：
 *   · 接收 INVITE（摘机自动拨号触发）→ 应答 200 OK（带 SDP）
 *   · 处理 ACK / BYE / CANCEL
 *   · 通过 RTP 双向收发 G.711 μ-law 音频（8 kHz，20 ms 帧）
 *   · 主动发起 INVITE（用于"AI 回复完成 → 电话响铃叫用户接听"）
 *
 * 不实现：注册、鉴权、TLS、SDP 协商多编解码、SIP 分片。
 * 参考实现的约束一致：SIP/RTP 无加密，只能跑在直连或可信隔离网段。
 *
 * 设计：本模块只负责"信令 + 音频搬运"，业务状态机（就绪音、录音、提交）
 *      由调用方通过事件回调实现。
 */
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';

import {
  parseRtp, makeRtp, frameMuLaw, SAMPLES_PER_FRAME,
} from './phone-audio-lib.mjs';

const CRLF = '\r\n';

/** SIP 状态码 → 原因短语（只收本模块会用到的） */
export const SIP_REASONS = {
  100: 'Trying', 180: 'Ringing', 200: 'OK', 202: 'Accepted',
  401: 'Unauthorized', 404: 'Not Found', 408: 'Request Timeout',
  486: 'Busy Here', 487: 'Request Terminated', 501: 'Not Implemented',
  603: 'Decline',
};

// ---------------------------------------------------------------- SDP

/** 生成本端 SDP（只提供 PCMU） */
export function buildSdp({ address, rtpPort, sessionName = 'phone-companion' }) {
  return [
    'v=0',
    `o=- ${Date.now()} ${Date.now()} IN IP4 ${address}`,
    `s=${sessionName}`,
    `c=IN IP4 ${address}`,
    't=0 0',
    `m=audio ${rtpPort} RTP/AVP 0 101`,
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-15',
    'a=ptime:20',
    'a=sendrecv',
  ].join(CRLF) + CRLF;
}

/** 从对端 SDP 里取出媒体地址与端口 */
export function parseSdp(sdp) {
  const text = String(sdp ?? '');
  const out = { address: null, port: null, payloadTypes: [] };
  const conn = /^c=IN IP4 ([0-9.]+)/m.exec(text);
  if (conn) out.address = conn[1];
  const media = /^m=audio (\d+) [^ ]+ (.*)$/m.exec(text);
  if (media) {
    out.port = Number(media[1]);
    out.payloadTypes = media[2].trim().split(/\s+/).map(Number);
  }
  if (!out.address) {
    const origin = /^o=\S+ \S+ \S+ IN IP4 ([0-9.]+)/m.exec(text);
    if (origin) out.address = origin[1];
  }
  return out;
}

// ---------------------------------------------------------------- SIP 消息

/** 解析 SIP 文本消息（仅请求行/状态行 + 头部 + 原样保留的 body） */
export function parseSipMessage(text) {
  const sep = text.indexOf(CRLF + CRLF);
  const headRaw = sep === -1 ? text : text.slice(0, sep);
  const body = sep === -1 ? '' : text.slice(sep + 4);
  const lines = headRaw.split(CRLF).filter(Boolean);
  if (!lines.length) return null;
  const first = lines[0];
  const headers = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  if (first.startsWith('SIP/2.0')) {
    return { kind: 'response', status: Number(first.split(' ')[1]), headers, body };
  }
  const [method, uri, version] = first.split(' ');
  return { kind: 'request', method, uri, version, headers, body };
}

/**
 * 从头部里取出 SIP 用户名（用于识别呼叫方）。
 * 形如：<sip:redline@192.168.82.1:5090>;tag=xxx
 */
export function headerUser(value) {
  const m = /sip:([^@>;]+)@/i.exec(String(value ?? ''));
  return m ? m[1] : null;
}

/** 取 tag 参数 */
export function headerTag(value) {
  const m = /;tag=([^;>\s]+)/i.exec(String(value ?? ''));
  return m ? m[1] : null;
}

/** 取出 Via 的 branch 与 host:port（应答必须原样回填） */
export function parseVia(via) {
  const parts = String(via ?? '').split(CRLF)[0].trim();
  const m = /SIP\/2\.0\/UDP\s+([^;]+)/i.exec(parts);
  return {
    raw: parts,
    sentBy: m ? m[1].trim() : null,
    branch: (/;branch=([^;>\s]+)/i.exec(parts) ?? [])[1] ?? null,
  };
}

// ---------------------------------------------------------------- 终端

export class SipEndpoint extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.localAddress  本端地址（HT802 看到并回音的地址）
   * @param {number} opts.sipPort       本端 SIP 端口
   * @param {number} opts.rtpPort       本端 RTP 端口
   * @param {string} opts.user          本端 SIP 用户名（HT802 的 Off Hook Auto Dial 目标）
   */
  constructor({ localAddress, sipPort = 5090, rtpPort = 15004, user = 'companion' }) {
    super();
    // localAddress 有两个作用，而且都必须正确：
    //   1) SDP 里的 c= 行 —— 告诉对端"音频发到哪个地址"（写错会全程无声）
    //   2) 主动呼叫时的 Via / From / Contact —— 对端的应答按这个地址回
    // 注意：套接字绑在 0.0.0.0，"收得到包"不等于"通告的地址对"。
    // 多网卡机器上必须显式指定网关所在网段的本机地址。
    this.localAddress = localAddress;
    this.sipPort = sipPort;
    this.rtpPort = rtpPort;
    this.user = user;

    this.sipSocket = null;
    this.rtpSocket = null;

    this.call = null;          // { id, remote, remoteTag, peer, sdp, state, ... }
    this._rtpSeq = 0;
    this._rtpTs = 0;
    this._rtpSsrc = (Math.random() * 0xffffffff) >>> 0;
    this._outgoing = new Map(); // 我们主动发起的呼叫：callId → 上下文
  }

  async start() {
    await this._startSip();
    await this._startRtp();
    // 端口传 0 时由操作系统分配，必须把真实端口回填，
    // 否则 SDP 里会写出 port=0，对端无法回送 RTP。
    this.sipPort = this.sipSocket.address().port;
    this.rtpPort = this.rtpSocket.address().port;
    this.emit('ready', { sipPort: this.sipPort, rtpPort: this.rtpPort });
    return this;
  }

  async stop() {
    this._stopPlayback();
    for (const sock of [this.sipSocket, this.rtpSocket]) {
      if (!sock) continue;
      await new Promise((resolve) => sock.close(resolve));
    }
    this.sipSocket = this.rtpSocket = null;
    this.call = null;
  }

  // ------------------------------------------------------------ 套接字

  _startSip() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.on('error', reject);
      sock.on('message', (buf, rinfo) => this._onSipMessage(buf.toString('utf8'), rinfo));
      sock.bind(this.sipPort, '0.0.0.0', () => {
        this.sipSocket = sock;
        resolve();
      });
    });
  }

  _startRtp() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.on('error', reject);
      sock.on('message', (buf, rinfo) => this._onRtpPacket(buf, rinfo));
      sock.bind(this.rtpPort, '0.0.0.0', () => {
        this.rtpSocket = sock;
        resolve();
      });
    });
  }

  // ------------------------------------------------------------ 信令分发

  _onSipMessage(text, rinfo) {
    const msg = parseSipMessage(text);
    if (!msg) return;
    if (msg.kind === 'request') {
      this.emit('sip', { msg, rinfo });
      switch (msg.method) {
        case 'INVITE': return this._onInvite(msg, rinfo);
        case 'ACK': return this._onAck(msg);
        case 'BYE': return this._onBye(msg, rinfo);
        case 'CANCEL': return this._onCancel(msg, rinfo);
        case 'OPTIONS': return this._respond(msg, rinfo, 200, 'OK');
        default: return this._respond(msg, rinfo, 501, 'Not Implemented');
      }
    }
    if (msg.kind === 'response') {
      this.emit('sip', { msg, rinfo });
      return this._onResponse(msg, rinfo);
    }
  }

  _respond(req, rinfo, status, reason, { toTag, body, extraHeaders = [] } = {}) {
    const via = parseVia(req.headers.via);
    const callId = req.headers['call-id'] ?? '';
    const from = req.headers.from ?? '';
    let to = req.headers.to ?? '';
    const tag = toTag ?? headerTag(to) ?? this.call?.localTag ?? SipEndpoint._randomTag();
    if (!headerTag(to)) to = `${to};tag=${tag}`;
    const lines = [
      `SIP/2.0 ${status} ${reason}`,
      `Via: ${via.raw}`,
      `From: ${from}`,
      `To: ${to}`,
      `Call-ID: ${callId}`,
      `CSeq: ${req.headers.cseq ?? ''}`,
    ];
    // ⚠️ 2xx 应答必须带 Contact：对端靠它确定"后续请求（ACK/BYE）发到哪个地址"。
    // 缺了它，设备不会回 ACK，通话建立不起来 —— 表现为对方一直重拨并放忙音。
    // （这个 bug 就是靠"逐字节对比能工作的版本"才找到的，见 工具/报文对比.mjs）
    if (status >= 200 && status < 300) {
      lines.push(`Contact: <sip:${this.user}@${this.localAddress}:${this.sipPort}>`);
    }
    lines.push('User-Agent: phone-companion/0.1', ...extraHeaders);
    if (body) {
      lines.push('Content-Type: application/sdp');
      lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    } else {
      lines.push('Content-Length: 0');
    }
    this._sendSip(lines.join(CRLF) + CRLF + CRLF + (body ?? ''), rinfo);
  }

  _sendSip(text, rinfo) {
    if (!this.sipSocket || !rinfo) {
      this.emit('debug', { where: 'sendSip', error: 'socket 或 rinfo 缺失', rinfo });
      return;
    }
    const buf = Buffer.from(text, 'utf8');
    // 诊断：把发出的报文原样落盘，便于与"能工作的版本"逐字节对比
    if (process.env.PHONE_DUMP_SIP === '1') {
      try {
        appendFileSync(process.env.PHONE_DUMP_FILE || 'sip-sent.log',
          `\n===== ${new Date().toISOString()} → ${rinfo.address}:${rinfo.port} (${buf.length}B) =====\n${text}\n`);
      } catch { /* 忽略 */ }
    }
    try {
      this.sipSocket.send(buf, rinfo.port, rinfo.address, (err) => {
        // 发送失败必须暴露出来：早先这里没有回调，
        // 导致"200 OK 没发出去"这类问题被静默吞掉，排查非常困难。
        if (err) this.emit('debug', { where: 'sendSip', error: String(err?.message ?? err), to: `${rinfo.address}:${rinfo.port}` });
        else this.emit('debug', { where: 'sendSip', ok: true, bytes: buf.length, first: text.split(CRLF)[0], to: `${rinfo.address}:${rinfo.port}` });
      });
    } catch (err) {
      this.emit('debug', { where: 'sendSip', error: `抛出异常: ${err?.message ?? err}` });
    }
  }

  static _randomTag() {
    return Math.random().toString(16).slice(2, 10);
  }

  // ------------------------------------------------------------ 来电流程

  _onInvite(msg, rinfo) {
    // 重复 INVITE（重传）时复用同一通话
    const callId = msg.headers['call-id'];
    if (this.call && this.call.id === callId) {
      return this._respond(msg, rinfo, 200, 'OK', {
        toTag: this.call.localTag, body: this.call.localSdp,
      });
    }

    const peer = parseSdp(msg.body);
    const localTag = SipEndpoint._randomTag();
    const localSdp = buildSdp({
      address: this.localAddress,
      rtpPort: this.rtpPort,
      sessionName: this.user,
    });

    this.call = {
      id: callId,
      localTag,
      remoteTag: headerTag(msg.headers.from),
      fromUser: headerUser(msg.headers.from),
      remote: rinfo,
      peer: { address: peer.address ?? rinfo.address, port: peer.port ?? 0 },
      localSdp,
      state: 'ringing',          // ringing → answered → ended
      startedAt: Date.now(),
      answeredAt: null,
      audioRxFrames: 0,
      audioRxBytes: 0,
      lastRxAt: null,
    };

    // 立即应答：HT802 摘机拨号后期望马上接通（参考实现也是 200 OK 直接应答）
    this.call.state = 'answered';
    this.call.answeredAt = Date.now();
    this._respond(msg, rinfo, 200, 'OK', { toTag: localTag, body: localSdp });
    this.emit('call:incoming', this.callSnapshot());

    // 诊断：把对端发来的 SDP（尤其是 c= 和 m= 行）打出来。
    // 排查"信令通了但没有声音"时，这里是唯一能看出"音频该往哪发"的地方。
    this.emit('debug', {
      where: 'invite',
      remote: `${rinfo.address}:${rinfo.port}`,
      peer: this.call.peer,
      peerSdp: { address: peer.address, port: peer.port, payloadTypes: peer.payloadTypes },
      localSdpAddress: this.localAddress,
      localRtpPort: this.rtpPort,
      rawInvite: msg.body,
    });
  }

  _onAck(msg) {
    if (!this.call || msg.headers['call-id'] !== this.call.id) return;
    this.call.state = 'talking';
    this.emit('call:answered', this.callSnapshot());
  }

  _onBye(msg, rinfo) {
    if (!this.call || msg.headers['call-id'] !== this.call.id) {
      // 未知通话也回 200，避免对端重传
      return this._respond(msg, rinfo, 200, 'OK');
    }
    this._respond(msg, rinfo, 200, 'OK', { toTag: this.call.localTag });
    const snap = this.callSnapshot();
    this._stopPlayback();
    this.call = null;
    this.emit('call:ended', { ...snap, reason: 'remote-bye' });
  }

  _onCancel(msg, rinfo) {
    this._respond(msg, rinfo, 200, 'OK');
    if (this.call && msg.headers['call-id'] === this.call.id) {
      const snap = this.callSnapshot();
      this.call = null;
      this.emit('call:ended', { ...snap, reason: 'cancel' });
    }
  }

  _onResponse(msg, rinfo) {
    // 处理我们主动发起呼叫（回铃）时的应答
    const callId = msg.headers['call-id'];
    const ctx = this._outgoing.get(callId);
    if (!ctx) return;

    // 我们已经撤销过这条邀请（发过 CANCEL）：对端会回 487 Request Terminated。
    // 非 2xx 的最终应答按 RFC 3261 也要 ACK 一下，否则对端会一直重传。
    // 不处理这种情况的话，撤销后的 487 会掉进下面的 `status >= 300` 分支，
    // 被当成"呼叫失败"上报 —— 明明是我们要取消的，却报了个失败。
    if (ctx.cancelled) {
      if (msg.status >= 300) {
        this._sendAck(ctx, msg, rinfo);
        this._outgoing.delete(callId);
      }
      return;
    }

    if (msg.status === 200 && ctx.expect === 'INVITE') {
      // 对端接听：回 ACK，进入通话
      this._outgoing.delete(callId);
      ctx.remoteTag = headerTag(msg.headers.to);
      ctx.peer = (() => {
        const p = parseSdp(msg.body);
        return { address: p.address ?? rinfo.address, port: p.port ?? 0 };
      })();
      this.call = {
        id: callId,
        localTag: ctx.localTag,
        remoteTag: ctx.remoteTag,
        remote: rinfo,
        peer: ctx.peer,
        state: 'talking',
        direction: 'outgoing',
        startedAt: ctx.startedAt,
        answeredAt: Date.now(),
        audioRxFrames: 0,
        audioRxBytes: 0,
        lastRxAt: null,
      };
      this._sendAck(ctx, msg, rinfo);
      this.emit('call:outgoing-answered', this.callSnapshot());
    } else if (msg.status >= 300) {
      this._outgoing.delete(callId);
      this.emit('call:failed', {
        id: callId,
        status: msg.status,
        reason: SIP_REASONS[msg.status] ?? String(msg.status),
      });
    }
  }

  // ------------------------------------------------------------ 主动呼叫（响铃）

  /**
   * 主动向 HT802 发起 INVITE，让话机响铃。
   * @param {object} opts
   * @param {string} opts.targetAddress HT802 地址
   * @param {number} opts.targetSipPort HT802 SIP 端口（默认 5060）
   * @param {string} opts.targetUser    被叫用户名（HT802 的 SIP User ID）
   */
  callOut({ targetAddress, targetSipPort = 5060, targetUser = 'redline' }) {
    const callId = `${SipEndpoint._randomTag()}@${this.localAddress}`;
    const localTag = SipEndpoint._randomTag();
    const branch = `z9hG4bK${SipEndpoint._randomTag()}`;
    const from = `<sip:${this.user}@${this.localAddress}:${this.sipPort}>;tag=${localTag}`;
    const to = `<sip:${targetUser}@${targetAddress}:${targetSipPort}>`;
    const cseq = 1;
    const ctx = {
      callId, localTag, targetAddress, targetSipPort, targetUser, expect: 'INVITE',
      startedAt: Date.now(), branch, from, to, cseq,
    };
    this._outgoing.set(callId, ctx);

    const sdp = buildSdp({
      address: this.localAddress,
      rtpPort: this.rtpPort,
      sessionName: this.user,
    });
    const msg = [
      `INVITE sip:${targetUser}@${targetAddress}:${targetSipPort} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localAddress}:${this.sipPort};branch=${branch};rport`,
      'Max-Forwards: 70',
      `From: ${from}`,
      `To: ${to}`,
      `Call-ID: ${callId}`,
      `CSeq: ${cseq} INVITE`,
      `Contact: <sip:${this.user}@${this.localAddress}:${this.sipPort}>`,
      'User-Agent: phone-companion/0.1',
      'Content-Type: application/sdp',
      `Content-Length: ${Buffer.byteLength(sdp)}`,
    ].join(CRLF) + CRLF + CRLF + sdp;

    this._sendSip(msg, { address: targetAddress, port: targetSipPort });
    this.emit('call:outgoing', { id: callId, target: `${targetAddress}:${targetSipPort}` });
    return callId;
  }

  _sendAck(ctx, response, rinfo) {
    const ack = [
      `ACK sip:${ctx.to.match(/sip:([^>]+)/)?.[1] ?? ''} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localAddress}:${this.sipPort};branch=z9hG4bK${SipEndpoint._randomTag()}`,
      `From: ${ctx.from}`,
      `To: ${response.headers.to}`,
      `Call-ID: ${ctx.callId}`,
      `CSeq: ${ctx.cseq} ACK`,
      'Content-Length: 0',
    ].join(CRLF) + CRLF + CRLF;
    this._sendSip(ack, rinfo);
  }

  /**
   * 主动挂断。
   *
   * 分两种情况，**两种都必须处理**：
   *   ① 已经接听（this.call 存在）      → 发 BYE 结束会话
   *   ② 呼叫还没被接听（只存在于 _outgoing）→ 必须发 CANCEL 撤销邀请
   *
   * ② 曾是个真 bug：早先这里只有 `if (!this.call) return false`，
   * 没被接听的去电就**从来没被取消过**。对端（HT801）会一直把话机振铃、
   * 线路一直显示忙，接下来所有呼叫都被回 486 Busy Here。
   * 真机现象：连续试铃几次之后，再呼叫就永远是 486，而话机明明是挂好的
   * （网关状态页显示"挂机"，说明不是话机的问题）。
   *
   * 这条路径正是用户要的"响 5 秒自动挂断"（没人接也要收线），所以必须修：
   * 不修的话，通知铃会一直响到网关自己的超时，而且把线路长期占死。
   *
   * @returns {boolean} 是否真的发出了挂断/取消请求
   */
  hangup() {
    if (this.call) {
      const c = this.call;
      const bye = [
        `BYE sip:${c.peer.address}:${c.peer.port} SIP/2.0`,
        `Via: SIP/2.0/UDP ${this.localAddress}:${this.sipPort};branch=z9hG4bK${SipEndpoint._randomTag()}`,
        `From: <sip:${this.user}@${this.localAddress}:${this.sipPort}>;tag=${c.localTag}`,
        `To: <sip:${c.fromUser ?? 'redline'}@${c.remote.address}>;tag=${c.remoteTag ?? ''}`,
        `Call-ID: ${c.id}`,
        `CSeq: ${(c.cseqOut ?? 1)} BYE`,
        'Content-Length: 0',
      ].join(CRLF) + CRLF + CRLF;
      c.cseqOut = (c.cseqOut ?? 1) + 1;
      this._sendSip(bye, c.remote);
      this._stopPlayback();
      const snap = this.callSnapshot();
      this.call = null;
      this.emit('call:ended', { ...snap, reason: 'local-bye' });
      return true;
    }

    // ② 撤销还没接听的去电
    let cancelled = false;
    for (const [, ctx] of this._outgoing) {
      if (ctx.cancelled) continue;
      this._sendCancel(ctx);
      // 先不删：对端会为这条邀请回 487 Request Terminated，
      // 按 RFC 我们还得给那个 487 补一个 ACK（见 _onResponse）。
      ctx.cancelled = true;
      ctx.cancelledAt = Date.now();
      cancelled = true;
      this.emit('call:cancelled', {
        id: ctx.callId,
        target: `${ctx.targetAddress}:${ctx.targetSipPort}`,
      });
    }
    return cancelled;
  }

  /**
   * 发送 CANCEL 撤销一个未被接听的 INVITE。
   *
   * RFC 3261 要求：CANCEL 必须与它要撤销的 INVITE
   * **同 branch、同 Call-ID、同 CSeq 序号**（只有方法名从 INVITE 变成 CANCEL），
   * 否则对端无法把它对应到那条邀请上，会当成新请求处理。
   */
  _sendCancel(ctx) {
    const cancel = [
      `CANCEL sip:${ctx.targetUser ?? 'redline'}@${ctx.targetAddress}:${ctx.targetSipPort} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localAddress}:${this.sipPort};branch=${ctx.branch}`,
      'Max-Forwards: 70',
      `From: ${ctx.from}`,
      `To: ${ctx.to}`,
      `Call-ID: ${ctx.callId}`,
      `CSeq: ${ctx.cseq} CANCEL`,
      'Content-Length: 0',
    ].join(CRLF) + CRLF + CRLF;
    this._sendSip(cancel, { address: ctx.targetAddress, port: ctx.targetSipPort });
  }

  // ------------------------------------------------------------ 僵死通话清理

  /**
   * 清理"僵住的通话"。
   *
   * 为什么必须有：对端异常消失（拔网线、断电、丢包）时**不会发 BYE**，
   * 这个 call 对象就会一直留着 → isBusy 恒为 true →
   * 后续所有回铃都被 `line-busy` 挡掉，表现为**"打过一次电话之后，电话就再也不响了"**。
   *
   * 真机踩过一次：验证脚本发完 INVITE 拿到 200 OK 就直接退出（没发 ACK/BYE），
   * 于是服务里留了一个"已接听但一个音频包都没有"的幽灵通话，永久占线。
   *
   * 判据刻意保守，避免误杀正常通话：
   *   · 建立后**一个音频包都没收到**、且已超过 noAudioMs  → 对端根本没在发音频，确定是坏的
   *   · 曾经收到过音频、之后完全静默超过 silentMs        → 对端中途消失了
   * 只判断"完全没有任何 RTP"，不做静音检测，所以用户中途不说话不会被误杀
   * （除非对端开了静音抑制，那也由给足余量的 silentMs 兜住）。
   *
   * @returns {string|null} 清掉了就返回原因，否则 null
   */
  sweepStaleCall({ noAudioMs = 120000, silentMs = 300000, cancelledMs = 30000 } = {}) {
    // 顺带清掉"撤销了但一直没等到最终应答"的去电上下文，避免长期占着 _outgoing
    const now0 = Date.now();
    for (const [callId, ctx] of [...this._outgoing]) {
      if (ctx.cancelled && now0 - (ctx.cancelledAt ?? now0) > cancelledMs) {
        this._outgoing.delete(callId);
      }
    }

    const c = this.call;
    if (!c) return null;

    const now = Date.now();
    const since = c.answeredAt ?? c.startedAt ?? now;
    let reason = null;

    if (!c.audioRxFrames && now - since > noAudioMs) {
      reason = 'stale-no-audio';
    } else if (c.lastRxAt && now - c.lastRxAt > silentMs) {
      reason = 'stale-silent';
    }
    if (!reason) return null;

    console.warn(`[SIP] 清理僵死通话（${reason}）：建起 ${Math.round((now - since) / 1000)}s，`
      + `收到 ${c.audioRxFrames} 个音频包，最后收包 ${c.lastRxAt ? Math.round((now - c.lastRxAt) / 1000) + 's 前' : '从未'}`);
    // 不真的发 BYE —— 对端多半已经不在了，发了也没人收。
    // 直接本地清掉，并照常抛 call:ended 让状态机收尾（否则它会永远卡在 listening）。
    const snap = this.callSnapshot();
    this._stopPlayback();
    this.call = null;
    this.emit('call:ended', { ...snap, reason });
    return reason;
  }

  // ------------------------------------------------------------ 音频

  _onRtpPacket(buf, rinfo) {
    const pkt = parseRtp(buf);
    if (!pkt) return;
    if (pkt.payloadType === 101) {
      // DTMF：把按键事件抛给上层（可用于"1 继续 / 2 重听"这类交互）
      const ev = decodeDtmf(pkt.payload);
      if (ev && this.call) this.emit('dtmf', ev);
      return;
    }
    if (pkt.payloadType !== 0) return;               // 只处理 PCMU
    if (!this.call) return;
    this.call.audioRxFrames++;
    this.call.audioRxBytes += pkt.payload.length;
    this.call.lastRxAt = Date.now();
    if (!this.call.peer.port) this.call.peer = { address: rinfo.address, port: rinfo.port };
    this.emit('audio:rx', pkt.payload, pkt);
  }

  /** 发送一段 μ-law 音频（自动按 20ms 分帧，按实时节奏发包） */
  playMuLaw(mulaw, { realtime = true } = {}) {
    if (!this.call || !this.rtpSocket) return Promise.resolve(false);
    const frames = frameMuLaw(mulaw);
    const interval = realtime ? 20 : 0;
    let i = 0;
    this._playing = true;
    return new Promise((resolve) => {
      const tick = () => {
        if (!this._playing || !this.call) { resolve(false); return; }
        if (i >= frames.length) { this._playing = false; resolve(true); return; }
        this._sendRtpFrame(frames[i++]);
        if (interval) this._playTimer = setTimeout(tick, interval);
        else tick();
      };
      tick();
    });
  }

  _sendRtpFrame(payload) {
    if (!this.call?.peer?.port || !this.rtpSocket) return;
    const pkt = makeRtp(payload, this._rtpSeq++, this._rtpTs, this._rtpSsrc);
    this._rtpTs += SAMPLES_PER_FRAME;
    this.rtpSocket.send(pkt, this.call.peer.port, this.call.peer.address);
  }

  _stopPlayback() {
    this._playing = false;
    if (this._playTimer) { clearTimeout(this._playTimer); this._playTimer = null; }
  }

  /** 公开的停止播放（供状态机在挂机等场景调用） */
  stopPlayback() {
    this._stopPlayback();
  }

  // ------------------------------------------------------------ 快照

  callSnapshot() {
    if (!this.call) return { handset: 'on_hook', lineBusy: false };
    const c = this.call;
    return {
      id: c.id,
      state: c.state,
      direction: c.direction ?? 'incoming',
      fromUser: c.fromUser,
      peer: { ...c.peer },
      // 对端（网关）的实际来源地址：用于"回铃时该往哪儿打"。
      // 比配置里写死的地址更可靠——换网段后自动跟上。
      remote: c.remote ? { address: c.remote.address, port: c.remote.port } : null,
      handset: 'off_hook',
      lineBusy: true,
      durationMs: c.answeredAt ? Date.now() - c.answeredAt : 0,
      audioRxFrames: c.audioRxFrames,
      audioRxBytes: c.audioRxBytes,
      lastRxAgoMs: c.lastRxAt ? Date.now() - c.lastRxAt : null,
    };
  }

  get isBusy() {
    return Boolean(this.call);
  }
}

// ---------------------------------------------------------------- DTMF

/** 解析 RFC 2833 电话事件载荷（用于识别用户按了哪个数字键） */
export function decodeDtmf(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 4) return null;
  const digit = payload[0];
  const volume = payload[1];
  const duration = payload.readUInt16BE(2);
  const map = '0123456789*#ABCD';
  const end = Boolean(payload[1] & 0x80) || duration > 0;
  return {
    digit: map[digit] ?? String(digit),
    rawDigit: digit,
    volume,
    duration,
    end,
    // RFC 2833 用 10 表示 '*'、11 表示 '#'
    symbol: digit <= 9 ? String(digit) : (digit === 10 ? '*' : digit === 11 ? '#' : map[digit]),
  };
}
