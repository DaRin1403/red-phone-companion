/**
 * phone-machine.mjs —— 电话业务状态机
 *
 * 闭环（用户已确认的范围，不含 TTS 播报）：
 *   摘机 → 播就绪音 → 收音频 → 挂机 → 本地识别 → 文字提交给 DSH
 *   （我在该轮回复完成）→ 电话响铃通知用户
 *
 * 设计原则：**全部依赖注入**，本文件不直接碰网络/文件/硬件，
 * 因此可以用假 ATA、假识别服务、假注入器把整条流程测干净。
 */
import { EventEmitter } from 'node:events';

import { tone, silence, muLawBufferToPcm16 } from './phone-audio-lib.mjs';

/**
 * 这段 μ-law 录音的**峰值电平**（PCM16 下的最大绝对值，0–32767）。
 *
 * 用来判断"到底有没有人说话"：静音时 ASR 会凭空编出「我。」这类单字，
 * 光看录音时长拦不住（静音也有时长），必须看电平。
 *
 * 取峰值而不是平均能量：说话是有起伏的，平均值会被大量静音拉低，
 * 峰值对"有人说过话"更敏感 —— 宁可放过一句噪音，也不能把用户的话丢掉。
 */
export function peakAmplitude(mulaw) {
  if (!mulaw || !mulaw.length) return 0;
  let pcm;
  try {
    pcm = muLawBufferToPcm16(mulaw);
  } catch {
    return Number.MAX_SAFE_INTEGER;      // 解不出来就别拦，交给识别去判断
  }
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * 解析网关的铃音节奏字符串（HT801 的 P4010 就是这个格式）。
 *   'c=1000/1000;' → { onMs: 1000, offMs: 1000 }   响 1 秒、停 1 秒
 * 做了容错：不带 c= / 分号、用逗号分隔、只给一个数字都认。
 * @returns {{onMs:number, offMs:number}|null}
 */
export function parseRingCadence(text) {
  if (typeof text !== 'string') return null;
  const pair = /(\d+)\s*[\/,]\s*(\d+)/.exec(text);
  if (pair) return { onMs: Number(pair[1]), offMs: Number(pair[2]) };
  const single = /^\D*(\d+)\D*$/.exec(text.trim());
  if (single) return { onMs: Number(single[1]), offMs: Number(single[1]) };
  return null;
}

/**
 * 按"响几次"算出该在多少毫秒后挂断。
 *
 * 为什么必须从节奏推算：SIP 只在对端**开始**振铃时回一次 `180 Ringing`，
 * 之后每响一声**没有任何通知** —— "响了几次"没法直接观测，
 * 只能按网关自己的铃音节奏（响 onMs / 停 offMs）算出来。
 *
 * 末尾留半个静音周期：这样最后一次响完就挂断，
 * 不会因为时序抖动漏出下一声（否则"响一次"偶尔会变成"响两次"）。
 *
 *   响 1 次 / 节奏 1000-1000  →  1500ms   （听到一声 1 秒的铃）
 *   响 2 次                   →  3500ms   （听到两声）
 */
export function ringDurationMs(count, { onMs = 1000, offMs = 1000 } = {}) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const cycle = onMs + offMs;
  return n * cycle - Math.round(offMs / 2);
}

// 电话场景的语音里，前后总有些"试音"性质的废话。
// 实测识别结果形如「喂喂喂，可以听见吗？测试123。3。」——
// 开头是拿起听筒的习惯性试音，结尾是挂机瞬间的杂音。
// 不清掉的话这些噪音会原样提交给 AI，白白污染上下文。
// 只清理"确定是废话"的开头：招呼语与语气词。
// 注意不要把"测试/那个/就是"当废话 —— 它们可能是有意义的内容
// （实测 "哈喽，测试一下麦克风" 曾被误清成 "一下麦克风"）。
const LEADING_FILLER = /^(?:\s*(?:喂+|哈喽|hello|hi|嗯+|呃+|啊+|哦+|[，,。.、！!？?；;])\s*)+/i;

/**
 * 开头的"线路试音话"。
 *
 * 用户拿起听筒的习惯是先确认线路通不通——「我在听」「听得到吗」「在吗」，
 * 然后才说正事。真机实测：「我在听嗯，总结一下这个项目」被整句提交了，
 * 前半截是试音、后半截才是正事。
 *
 * ⚠️ 只在这些词**后面跟着停顿/标点**时才清，不能见到就删：
 *    「我在听一下那个录音」里的"我在听"是正文（后面跟的是"一下…"），删了就成了"一下那个录音"。
 *    所以要求后面必须紧跟语气词或标点 —— 试音话说完人一定会停一下。
 *
 * 单独一句「我在听」（整句就是它）不会被清掉：
 * 清完为空时 cleanTranscript 会退回原文，这是刻意的保守行为。
 */
const LEADING_CHECK = /^(?:\s*(?:我?在听|在听吗|听着|听到了|听得见|能听到|能听见|可以听到|可以听见|听得到|听不到|在吗|有人吗|有人么)\s*(?:吗|嘛|吧|了|呢|嗯|呃|啊|哦)?\s*[，,。.、！!？?；;]\s*)+/i;
const TRAILING_JUNK = /[\s，,。.、！!？?；;：:]+$/;

/**
 * 清洗识别文本：去掉开头的试音词、结尾的标点与孤字。
 *
 * 原则是**保守**：只在"清理后仍剩下有意义的句子"时才清理，
 * 否则保留原文 —— 宁可多提交一句废话，也不要丢掉用户真正说的话。
 */
export function cleanTranscript(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return '';

  let text = original;
  text = text.replace(LEADING_FILLER, '');
  // 去掉开头的线路试音话（「我在听，…」「听得到吗，…」）
  text = text.replace(LEADING_CHECK, '');
  // 去掉"可以听见吗/能听见吗"这类纯试音句
  text = text.replace(/^(?:可以|能)?(?:听见|听到)?(?:吗|嘛|吧)[\s，,。.、！!？?；;]*/i, '');
  text = text.replace(TRAILING_JUNK, '');
  // 结尾孤零零的短数字（挂机瞬间的杂音）
  text = text.replace(/[\s，,。.、]*[0-9]{1,2}$/, '').trim();

  // 清理后若几乎没内容，退回原文
  const meaningful = text.replace(/[\s，,。.、！!？?；;：:]/g, '');
  return meaningful.length >= 2 ? text : original;
}

// 状态常量
export const STATE = {
  IDLE: 'idle',              // 挂机待命
  READY: 'ready',            // 已摘机、播完就绪音、正在收音
  LISTENING: 'listening',    // 收音中（与 READY 同阶段，便于外部观察）
  TRANSCRIBING: 'transcribing',
  SUBMITTING: 'submitting',
  RINGING: 'ringing',        // 正在回铃（等待用户接听）
  ANSWERED: 'answered',      // 用户接听了回铃
  ERROR: 'error',
};

const DEFAULTS = {
  readyToneFreq: 660,          // 就绪音：参考实现用 660Hz
  readyToneSeconds: 0.3,
  errorToneFreq: 220,          // 错误音：220Hz
  errorToneSeconds: 0.6,
  // 挂机前静音多久算"用户说完了"（此值也用于丢弃尾部的线路噪声）
  trailingSilenceSeconds: 0.2,
  // 一段通话最长录多久，防止忘记挂机把内存吃满（10 分钟）
  maxRecordSeconds: 600,
  // 录音太短就丢弃（多半是误触）
  minRecordSeconds: 0.35,
  // 整段录音的峰值低于这个数，就认为**没人说话**，直接丢掉、不送识别。
  // 为什么需要：静音时 ASR 会凭空编字（真机上连续把静音识别成「我。」「你。」并提交）。
  // 取值很保守（PCM16 满量程 32767，说话峰值通常在几千以上），
  // 宁可放过一句噪音，也绝不丢掉用户真正说的话。
  silencePeakThreshold: 300,
  // 回铃参数
  // 总开关：false 时完全不会响铃（用户可随时暂停通知铃）
  ringbackEnabled: true,
  // **按次数算**：响几声就挂断（用户要求"一次响铃就行，不按时间算"）
  ringCount: 1,
  // 网关实际的铃音节奏（HT801 的 P4010），必须和网关里配的一致，
  // 否则"响 N 次"会算错。用 python ht801.py inspect 可以核对。
  ringCadenceOnMs: 1000,
  ringCadenceOffMs: 1000,
  // 安全上限：万一节奏配错，也不会一直响下去
  ringRings: 2,
  ringTimeoutSeconds: 10,
  // 提交给 DSH 后等待回复完成的超时
  replyTimeoutSeconds: 600,
};

export class PhoneMachine extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.sip         SipEndpoint 实例（需有 playMuLaw / callOut / hangup / callSnapshot）
   * @param {object} deps.asr         {transcribe(mulaw, opts) -> {text, seconds, latencyMs}}
   * @param {object} deps.injector    {submit(text) -> Promise}  把文字送进 DSH 并提交
   * @param {object} deps.replies     {waitForReply({timeoutMs, signal, after}) -> Promise<{text}>}
   * @param {object} [deps.phrases]   {get(key) -> Buffer|null}  预渲染的固定台词（μ-law）
   * @param {object} [opts]
   */
  constructor(deps, opts = {}) {
    super();
    this.sip = deps.sip;
    this.asr = deps.asr;
    this.injector = deps.injector;
    this.replies = deps.replies;
    this.phrases = deps.phrases ?? null;
    this.cfg = { ...DEFAULTS, ...opts };

    this.state = STATE.IDLE;
    this.call = null;             // 当前通话上下文
    this.pendingReply = null;     // 已提交、等待回复的任务
    this.stats = {
      calls: 0, submitted: 0, rings: 0, answered: 0,
      lastTranscript: null, lastError: null, lastSubmittedAt: null,
    };

    // Node 的 EventEmitter 有个陷阱：emit('error') 若没有任何监听器会**抛异常**，
    // 在常驻服务里等于"一个错误事件就把进程干掉"。这里挂一个兜底监听器，
    // 保证出错时只是记录，不会让服务退出。
    this.on('error', () => { /* 由外部监听器负责展示；这里只为防止抛出 */ });

    this._bindSip();
  }

  // ------------------------------------------------------------ 事件绑定

  _bindSip() {
    this.sip.on('call:incoming', (snap) => this._onIncoming(snap));
    this.sip.on('call:answered', () => this._onCallAnswered());
    this.sip.on('audio:rx', (mulaw) => this._onAudio(mulaw));
    this.sip.on('call:ended', (snap) => this._onCallEnded(snap));
    this.sip.on('dtmf', (ev) => this._onDtmf(ev));
    this.sip.on('call:outgoing-answered', () => this._onRingAnswered());
    this.sip.on('call:failed', (info) => this._onRingFailed(info));
  }

  // ------------------------------------------------------------ 状态

  _setState(next, extra = {}) {
    const prev = this.state;
    this.state = next;
    this.emit('state', { from: prev, to: next, ...extra });
  }

  get snapshot() {
    return {
      state: this.state,
      call: this.sip.callSnapshot(),
      stats: { ...this.stats },
      pendingReply: this.pendingReply
        ? { requestedAt: this.pendingReply.requestedAt, chars: this.pendingReply.text?.length ?? 0 }
        : null,
    };
  }

  // ------------------------------------------------------------ 摘机

  async _onIncoming(snap) {
    this.stats.calls += 1;
    this.call = {
      id: snap.id,
      startedAt: Date.now(),
      chunks: [],
      bytes: 0,
      truncated: false,
      submitted: false,
      // 收音频必须等就绪音播完，否则会把提示音自己录进去。
      // 用 pending 而非状态判断，避免"用户播提示音期间就挂机"时信号丢失。
      readyToneDone: false,
      pending: [],
    };
    this._setState(STATE.READY, { callId: snap.id });
    this.emit('call:started', snap);

    // 播就绪音：优先用预渲染缓存（零延迟）。
    // 注意：缓存读取失败必须**回退到现场合成**，否则缓存文件一坏就变成
    // "摘机后完全没声音"，用户根本不知道链路是否工作。
    let audio = null;
    try {
      audio = await this.phrases?.get?.('ready');
    } catch (err) {
      this.emit('warn', { where: 'phraseCache', error: String(err?.message ?? err) });
    }
    if (!audio?.length) {
      audio = tone(this.cfg.readyToneFreq, this.cfg.readyToneSeconds);
    }
    try {
      await this.sip.playMuLaw(audio, { realtime: true });
    } catch (err) {
      this.emit('warn', { where: 'readyTone', error: String(err?.message ?? err) });
    }

    const ctx = this.call;
    if (!ctx) {
      // 提示音播放期间通话就结束了：此时不能丢音频，但也没有意义继续收音
      this.emit('log', { msg: '就绪音播放期间通话已结束' });
      return;
    }
    ctx.readyToneDone = true;
    // 把提示音期间到达的音频补进来（真实链路上极少，但不能丢）
    if (ctx.pending.length) {
      for (const chunk of ctx.pending) this._storeChunk(ctx, chunk);
      ctx.pending.length = 0;
    }
    if (this.state === STATE.READY) {
      this._setState(STATE.LISTENING, { callId: ctx.id });
    }
  }

  _onCallAnswered() {
    // 摘机后对端 ACK，说明链路已通；无需额外动作
    this.emit('log', { msg: '通话已建立，开始收音' });
  }

  _onAudio(mulaw) {
    if (!this.call) return;
    const ctx = this.call;
    // 就绪音还没播完：先攒着，播完再入库（避免把自己的提示音录进去，也不丢数据）
    if (!ctx.readyToneDone) {
      ctx.pending.push(mulaw);
      return;
    }
    this._storeChunk(ctx, mulaw);
  }

  _storeChunk(ctx, mulaw) {
    if (ctx.bytes / 8000 >= this.cfg.maxRecordSeconds) {
      if (!ctx.truncated) {
        ctx.truncated = true;
        this.emit('warn', { where: 'record', error: '超过最长录音时长，后续音频被丢弃' });
      }
      return;
    }
    ctx.chunks.push(mulaw);
    ctx.bytes += mulaw.length;
    this.emit('audio:progress', { seconds: ctx.bytes / 8000 });
  }

  _onDtmf(ev) {
    // 方便调试与将来的快捷操作：1 立刻提交 / 9 主动回铃测试
    this.emit('dtmf', ev);
    if (!ev?.symbol) return;
    if (ev.symbol === '1' && this.call) this._doFinish('dtmf-1');
    if (ev.symbol === '9') {
      // 注意：此时用户还握着听筒，线路是忙的。
      // 必须先挂断释放线路，否则回铃会被"线路忙"规则挡掉、永远不生效。
      this._ringAfterHangup = true;
      try { this.sip.hangup(); } catch { /* 忽略 */ }
    }
  }

  // ------------------------------------------------------------ 挂机 → 提交

  async _onCallEnded(snap) {
    const ctx = this.call;
    this.call = null;
    const ringAfter = this._ringAfterHangup === true;
    this._ringAfterHangup = false;

    if (!ctx) {
      this._setState(STATE.IDLE, { reason: 'ended-without-context' });
      if (ringAfter) await this.ring({ force: true }).catch(() => {});
      return;
    }
    const seconds = ctx.bytes / 8000;
    this.emit('call:ended', { ...snap, seconds });

    if (snap.reason === 'cancel') {
      this._setState(STATE.IDLE, { reason: 'cancelled' });
      if (ringAfter) await this.ring({ force: true }).catch(() => {});
      return;
    }
    if (seconds < this.cfg.minRecordSeconds) {
      this._setState(STATE.IDLE, { reason: 'too-short', seconds });
      this.emit('log', { msg: `录音过短（${seconds.toFixed(2)}s），已忽略` });
      if (ringAfter) await this.ring({ force: true }).catch(() => {});
      return;
    }
    await this._transcribeAndSubmit(ctx, seconds);
    if (ringAfter) await this.ring({ force: true }).catch(() => {});
  }

  /** 拆分出来便于 DTMF 触发与测试直接调用 */
  async _doFinish(reason) {
    const ctx = this.call;
    if (!ctx) return false;
    this.call = null;
    this._stopPlayback();
    try { this.sip.hangup(); } catch { /* 忽略 */ }
    const seconds = ctx.bytes / 8000;
    if (seconds < this.cfg.minRecordSeconds) {
      this._setState(STATE.IDLE, { reason: 'too-short', seconds });
      return false;
    }
    await this._transcribeAndSubmit(ctx, seconds);
    this.emit('finish', { reason });
    return true;
  }

  async _transcribeAndSubmit(ctx, seconds) {
    const mulaw = Buffer.concat(ctx.chunks);
    if (ctx.truncated) {
      // 被截断的录音去掉最后一点，避免半句话
      this.emit('warn', { where: 'record', error: '录音被截断' });
    }

    // ---- 先看这段录音里到底有没有人说话。
    // 线路静音时 ASR 会**凭空编一个字**出来：真机上连着两次把"摘机后没说话"的静音
    // 识别成「我。」「你。」并当成消息提交了。光靠录音时长拦不住（静音也有时长），
    // 必须看电平。这里在**送识别之前**就拦掉，既省一次识别，也避免幻觉落在输入框里。
    const peak = peakAmplitude(mulaw);
    if (peak < (this.cfg.silencePeakThreshold ?? 300)) {
      this.stats.lastError = null;
      this._setState(STATE.IDLE, { reason: 'no-speech', seconds, peak });
      this.emit('log', { msg: `整段没有语音（峰值 ${peak}），已忽略，不送识别` });
      this.emit('no-speech', { seconds, peak });
      return;
    }

    // ---- 识别
    this._setState(STATE.TRANSCRIBING, { seconds });
    let result;
    try {
      result = await this.asr.transcribe(mulaw, { context: '' });
    } catch (err) {
      this.stats.lastError = `识别失败：${err?.message ?? err}`;
      this._setState(STATE.ERROR, { error: this.stats.lastError });
      this.emit('error', { where: 'asr', error: this.stats.lastError });
      await this._playErrorTone();
      this._setState(STATE.IDLE);
      return;
    }
    const rawText = (result?.text ?? '').trim();
    const text = cleanTranscript(rawText);
    this.emit('transcribed', { text, raw: rawText, seconds, latencyMs: result?.latencyMs ?? null });
    this.stats.lastTranscript = text;

    if (!text) {
      this._setState(STATE.IDLE, { reason: 'empty-text' });
      await this._playErrorTone();
      return;
    }

    // ---- 提交给 DSH
    this._setState(STATE.SUBMITTING, { text });
    try {
      await this.injector.submit(text);
    } catch (err) {
      this.stats.lastError = `提交失败：${err?.message ?? err}`;
      this._setState(STATE.ERROR, { error: this.stats.lastError });
      this.emit('error', { where: 'inject', error: this.stats.lastError });
      await this._playErrorTone();
      this._setState(STATE.IDLE);
      return;
    }
    ctx.submitted = true;
    this.stats.submitted += 1;
    this.stats.lastSubmittedAt = Date.now();
    this.emit('submitted', { text });

    // ---- 登记"等下要回铃"的任务
    this.pendingReply = {
      text,
      requestedAt: Date.now(),
      callId: ctx.id,
    };

    // ⚠️ 关键一步：必须让会话监听器进入"等待回复"状态（arm）。
    // 它只对 arm() 之后完成的回合响铃，这样用户自己打字时不会被电话打扰。
    // 早先漏了这一句 —— 结果是监听器一直待机、completions 永远为 0，
    // 表现为"输入链路全通但我回复完电话不响"，且没有任何报错，极难发现。
    try {
      this.replies?.arm?.();
      // 再告诉监听器"我刚注入的是这句话"：工作区里可能有多个会话同时在写
      // （用户开着好几个标签页），而监听器启动时是按"最后写入时间"挑会话的，
      // 挑错就会盯着别人的会话等回复 —— 又变成"我回复完电话不响"。
      // 交给它按内容定位，谁收下了这句话就盯谁。
      this.replies?.followText?.(text);
      this.emit('armed', { at: this.pendingReply.requestedAt });
    } catch (err) {
      this.emit('warn', { where: 'armWatcher', error: String(err?.message ?? err) });
    }

    this._setState(STATE.IDLE, { reason: 'submitted', waitingReply: true });
  }

  async _playErrorTone() {
    try {
      const cached = await this.phrases?.get?.('error_empty');
      const audio = cached?.length
        ? cached
        : Buffer.concat([tone(this.cfg.errorToneFreq, this.cfg.errorToneSeconds), silence(0.05)]);
      await this.sip.playMuLaw(audio, { realtime: true });
    } catch { /* 提示音失败不影响主流程 */ }
  }

  _stopPlayback() {
    try { this.sip.stopPlayback?.(); } catch { /* 忽略 */ }
  }

  // ------------------------------------------------------------ 回铃

  /**
   * 主动回铃：通知用户"我在那一轮的回复完成了"。
   * 仅在存在待回复任务时才响（避免用户自己打字时被电话打扰）。
   * @returns {Promise<{rung:boolean, reason?:string}>}
   */
  async ring({ force = false } = {}) {
    if (!force && !this.pendingReply) {
      return { rung: false, reason: 'no-pending-reply' };
    }
    // 总开关关闭时一声都不响（force 用于测试/手动触发，可绕过）
    if (!force && this.cfg.ringbackEnabled === false) {
      return { rung: false, reason: 'ringback-disabled' };
    }
    if (this.sip.isBusy) {
      // 线路忙（用户可能正在打电话进来），等它空下来再试
      return { rung: false, reason: 'line-busy' };
    }
    const cfg = this.sip.ringConfig ?? {};
    if (!cfg.targetAddress) {
      return { rung: false, reason: 'no-ring-target' };
    }
    this._setState(STATE.RINGING, { rings: this._ringCount() });
    this.stats.rings += 1;
    this.emit('ringing', { rings: this._ringCount() });

    const callId = this.sip.callOut({
      targetAddress: cfg.targetAddress,
      targetSipPort: cfg.targetSipPort ?? 5060,
      targetUser: cfg.targetUser ?? 'redline',
    });

    // 定时挂断：响够次数就收线。
    // 这是**通知铃**，不是等人接的电话 —— 响完就是"我这一轮说完了"的信号。
    // 所以超时即视为通知已送达，顺手清掉待回复标记：
    // 不清的话 status 里会永远显示"有（等我说完就会响铃）"，看着像卡住了。
    this._ringTimer = setTimeout(() => {
      this.emit('ring:timeout');
      try { this.sip.hangup(); } catch { /* 忽略 */ }
      this.pendingReply = null;
      if (this.state === STATE.RINGING) this._setState(STATE.IDLE, { reason: 'ring-timeout' });
    }, this._ringDurationMs());

    return { rung: true, callId };
  }

  /** 这次该响几声（有效值，至少 1） */
  _ringCount() {
    const n = Math.floor(Number(this.cfg.ringCount));
    return Number.isFinite(n) && n > 0 ? n : (this.cfg.ringRings ?? 1);
  }

  /**
   * 这次响铃该持续多少毫秒。
   *
   * 优先**按次数算**（配置 ringCount）：次数 × 网关铃音周期 − 半个静音期，
   * 这样"响一次"就真的只响一声，和网关的节奏快慢无关。
   * 没配 ringCount 时退回按时间算（ringTimeoutSeconds）。
   * 两种情况都受 ringTimeoutSeconds 这个上限约束 —— 节奏配错了也不会一直响。
   */
  _ringDurationMs() {
    const capMs = (this.cfg.ringTimeoutSeconds ?? 20) * 1000;
    const n = Math.floor(Number(this.cfg.ringCount));
    if (!Number.isFinite(n) || n <= 0) return capMs;

    const cadence = {
      onMs: Number(this.cfg.ringCadenceOnMs) || 1000,
      offMs: Number(this.cfg.ringCadenceOffMs) || 1000,
    };
    return Math.min(ringDurationMs(n, cadence), capMs);
  }

  async _onRingAnswered() {
    clearTimeout(this._ringTimer);
    this.stats.answered += 1;
    this._setState(STATE.ANSWERED);
    this.emit('ring:answered');
    // 用户接起来了 —— 说明通知已送达，清掉待回复标记
    this.pendingReply = null;

    // 播一句回铃确认音，然后挂断（回复内容用户在屏幕上看）
    try {
      const cached = await this.phrases?.get?.('reply_done');
      const audio = cached?.length ? cached : tone(this.cfg.readyToneFreq, this.cfg.readyToneSeconds);
      await this.sip.playMuLaw(audio, { realtime: true });
    } catch { /* 忽略 */ }
    // 挂断，把线路让出来
    setTimeout(() => {
      try { this.sip.hangup(); } catch { /* 忽略 */ }
      if (this.state === STATE.ANSWERED) this._setState(STATE.IDLE, { reason: 'ring-ack-done' });
    }, 200);
  }

  _onRingFailed(info) {
    clearTimeout(this._ringTimer);
    this.emit('ring:failed', info);
    if (this.state === STATE.RINGING) {
      this._setState(STATE.IDLE, { reason: 'ring-failed', status: info?.status });
    }
  }

  /** 由外部（DSH 回复监听）在检测到回复完成时调用 */
  async onReplyCompleted({ text } = {}) {
    if (!this.pendingReply) {
      return { rung: false, reason: 'no-pending-reply' };
    }
    this.emit('reply:completed', { chars: text?.length ?? 0 });

    // 响铃被暂停（config 里 ringbackEnabled=false）：一声不响，也不留待回复标记。
    // 不清标记的话 status 会一直显示"有（等我说完就会响铃）"，看着像卡住了。
    if (this.cfg.ringbackEnabled === false) {
      this.pendingReply = null;
      return { rung: false, reason: 'ringback-disabled' };
    }
    return this.ring();
  }

  dispose() {
    clearTimeout(this._ringTimer);
    this.removeAllListeners();
  }
}
