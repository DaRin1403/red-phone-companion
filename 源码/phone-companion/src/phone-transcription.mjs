/**
 * phone-transcription.mjs —— 把电话音频送进 CapsWriter 服务端做识别
 *
 * 复用 P0 已经跑通的本地识别链路（CapsWriter + SenseVoice，实测时延 0.13–0.38s），
 * 不引入任何云端依赖。
 *
 * 协议（逆向自 CapsWriter 客户端 core/client/audio/recorder.py）：
 *   · WebSocket ws://127.0.0.1:6016，子协议 "binary"
 *   · 每条消息是 JSON：{task_id, source:'mic', data:<base64>, is_final, time_start,
 *     seg_duration, seg_overlap, context, language}
 *   · data 是 **16kHz 单声道 float32** 的 base64（不是 int16！）
 *   · 发完音频后要再发一条 is_final:true 的空包，服务端才会出最终结果
 *   · 服务端回 {is_final:false} 的中间结果与 {is_final:true} 的最终结果
 *
 * 采样率换算：电话是 8kHz μ-law，需先转成 16k float32。
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { g711ToFloat32 } from './phone-convert.mjs';

export const DEFAULT_ASR_URL = 'ws://127.0.0.1:6016';

/**
 * 把 8kHz μ-law 音频转成 CapsWriter 要的 16k float32 base64。
 * 用线性插值上采样（电话侧本来就只有 300–3400Hz，插值足够）。
 *
 * ⚠️ 必须走 Uint8Array 再 base64：
 *    Node 的 Buffer.from(typedArray) 是"共享同一块内存的视图"，
 *    而 Float32Array 若来自内存池会带非零 byteOffset。
 *    直接 Buffer.from(f32).toString('base64') 会把 byteOffset 之前的
 *    无关内存一起编进去 —— 实测过：本该 1280 字节变成了 3427 字节，
 *    且解出来的 float 是 1e31 量级的垃圾值，识别必然失效。
 */
export function muLawToBase64Float32(mulaw) {
  const f32 = g711ToFloat32(mulaw, 8000, 16000);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  return Buffer.from(bytes).toString('base64');
}

/** 构造一条 AudioMessage（导出便于单测） */
export function buildAudioMessage({
  taskId, mulaw, isFinal = false, timeStart = 0,
  segDuration = 5, segOverlap = 1, context = '', language = 'chinese',
}) {
  return JSON.stringify({
    task_id: taskId,
    source: 'mic',
    data: isFinal ? '' : muLawToBase64Float32(mulaw ?? Buffer.alloc(0)),
    is_final: isFinal,
    time_start: timeStart,
    seg_duration: segDuration,
    seg_overlap: segOverlap,
    context,
    language,
  });
}

/** 解析服务端返回的识别结果 */
export function parseRecognition(raw) {
  const obj = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  return {
    taskId: obj.task_id,
    isFinal: Boolean(obj.is_final),
    text: typeof obj.text === 'string' ? obj.text : '',
    textAccu: typeof obj.text_accu === 'string' ? obj.text_accu : '',
    duration: Number(obj.duration ?? 0),
    // 服务端给的时延：提交到完成
    latencyMs: obj.time_submit && obj.time_complete
      ? Math.round((obj.time_complete - obj.time_submit) * 1000)
      : null,
  };
}

/**
 * 一次识别的会话：把整段通话录音一次性送进去。
 *
 * 之所以不做"边收边发"：CapsWriter 服务端会按 seg_duration 切片，
 * 而电话通话本身就是一段话说完才挂机提交，整段送更简单也更准。
 * （若以后要做"边说边出字"，改成边收边 append 即可，接口已按此设计。）
 */
export class TranscriptionClient extends EventEmitter {
  constructor({ url = DEFAULT_ASR_URL, timeoutMs = 30000, language = 'chinese' } = {}) {
    super();
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.language = language;
    this.ws = null;
    this.taskId = null;
    this.chunks = [];        // 收集 μ-law 片段
    this.bytes = 0;
    this.timeStart = 0;
    this._resolve = null;
    this._reject = null;
    this._timer = null;
  }

  get isConnected() {
    return Boolean(this.ws && this.ws.readyState === 1);
  }

  async connect(WebSocketImpl = globalThis.WebSocket) {
    if (this.isConnected) return;
    if (!WebSocketImpl) throw new Error('运行环境没有 WebSocket，请用 Node 20+ 或在测试里注入实现');
    await new Promise((resolve, reject) => {
      const ws = new WebSocketImpl(this.url, ['binary']);
      const onOpen = () => { cleanup(); this.ws = ws; resolve(); };
      const onError = (err) => { cleanup(); reject(new Error(`连接识别服务失败：${err?.message ?? err}`)); };
      const cleanup = () => {
        ws.removeEventListener?.('open', onOpen);
        ws.removeEventListener?.('error', onError);
      };
      ws.addEventListener?.('open', onOpen);
      ws.addEventListener?.('error', onError);
      if (!ws.addEventListener) {            // 兼容 ws 库风格
        ws.on?.('open', onOpen);
        ws.on?.('error', onError);
      }
    });
    this.ws.addEventListener?.('message', (ev) => this._onMessage(ev.data));
    this.ws.on?.('message', (data) => this._onMessage(data));
    this.ws.addEventListener?.('close', () => this.emit('close'));
    this.ws.on?.('close', () => this.emit('close'));
  }

  /** 开始一段新的识别 */
  start() {
    this.taskId = randomUUID();
    this.chunks = [];
    this.bytes = 0;
    this.timeStart = Date.now() / 1000;
    this.emit('start', { taskId: this.taskId });
    return this.taskId;
  }

  /** 追加一段 8kHz μ-law 音频 */
  push(mulaw) {
    if (!this.taskId) throw new Error('尚未 start()');
    if (!mulaw || !mulaw.length) return;
    this.chunks.push(mulaw);
    this.bytes += mulaw.length;
    this.emit('audio', { bytes: this.bytes, seconds: this.bytes / 8000 });
  }

  /** 结束并等待最终识别结果 */
  async finish() {
    if (!this.taskId) throw new Error('尚未 start()');
    if (!this.isConnected) await this.connect();
    const mulaw = Buffer.concat(this.chunks);
    const seconds = mulaw.length / 8000;

    const done = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
      this._timer = setTimeout(() => {
        this._reject?.(new Error(`识别超时（已等待 ${this.timeoutMs}ms）`));
      }, this.timeoutMs);
    });

    // 一次性发送整段音频 + 结束标记
    this._send(buildAudioMessage({
      taskId: this.taskId, mulaw, isFinal: false,
      timeStart: this.timeStart, language: this.language,
    }));
    this._send(buildAudioMessage({
      taskId: this.taskId, isFinal: true, timeStart: this.timeStart,
      language: this.language,
    }));
    this.emit('sent', { seconds, bytes: mulaw.length });

    const result = await done;
    return { ...result, seconds };
  }

  _send(text) {
    if (!this.ws) throw new Error('未连接');
    if (this.ws.readyState === 1) this.ws.send(text);
    else throw new Error('连接已断开');
  }

  _onMessage(data) {
    let parsed;
    try {
      parsed = parseRecognition(data);
    } catch {
      return;
    }
    if (parsed.taskId && this.taskId && parsed.taskId !== this.taskId) return;
    if (parsed.isFinal) {
      clearTimeout(this._timer);
      this.emit('final', parsed);
      this._resolve?.(parsed);
      this._resolve = this._reject = null;
    } else {
      this.emit('partial', parsed);
    }
  }

  close() {
    clearTimeout(this._timer);
    try { this.ws?.close(); } catch { /* 忽略 */ }
    this.ws = null;
  }
}

/**
 * 便捷函数：把一整段电话录音识别成文字。
 * @param {Buffer} mulaw 8kHz μ-law
 * @param {object} opts
 * @returns {Promise<{text:string, seconds:number, latencyMs:number|null}>}
 */
export async function transcribe(mulaw, opts = {}) {
  const client = new TranscriptionClient(opts);
  try {
    await client.connect(opts.WebSocketImpl ?? globalThis.WebSocket);
    client.start();
    client.push(mulaw);
    return await client.finish();
  } finally {
    client.close();
  }
}
