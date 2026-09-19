/**
 * phone-tts.mjs —— 本地 TTS 客户端
 *
 * 对接 tts/tts-server.py：POST /tts 拿 16k 单声道 s16le 裸 PCM 的 chunked 响应，
 * 每个 chunk 对应一句话，**收到一句就能开始播一句**（流式播报的关键）。
 *
 * 另有预热缓存（固定话术提前渲染好的 μ-law 文件）读取能力，
 * 让"就绪音""错误提示"这类固定台词零延迟播放。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { float32ToG711, pcm16ToFloat32 } from './phone-convert.mjs';

export const DEFAULT_TTS_URL = 'http://127.0.0.1:8123';

/**
 * 把 TTS 服务返回的 s16le 裸 PCM 转成电话 μ-law。
 * @param {Buffer} pcm 16bit 小端 PCM
 * @param {number} sampleRate 该 PCM 的采样率
 */
export function ttsPcmToMuLaw(pcm, sampleRate) {
  const f32 = pcm16ToFloat32(pcm);
  return float32ToG711(f32, sampleRate);
}

/**
 * 从 chunked 响应体里逐块解析（按 HTTP chunked 传输编码）。
 * 简化实现：只处理形如 "<hex>\r\n<data>\r\n" 的块，支持结束块。
 */
export async function* readChunked(body) {
  const reader = body.getReader();
  let buf = Buffer.alloc(0);
  let finished = false;
  while (!finished) {
    const { done, value } = await reader.read();
    if (value) buf = Buffer.concat([buf, Buffer.from(value)]);
    if (done) finished = true;

    while (true) {
      const nl = buf.indexOf('\r\n');
      if (nl === -1) break;
      const sizeLine = buf.subarray(0, nl).toString('ascii').trim();
      const size = parseInt(sizeLine, 16);
      if (!Number.isFinite(size)) {           // 不是 chunked，直接交出剩余
        if (finished && buf.length) { yield buf; buf = Buffer.alloc(0); }
        break;
      }
      if (size === 0) { finished = true; buf = Buffer.alloc(0); break; }
      if (buf.length < nl + 2 + size + 2) break;   // 数据还没收全
      const data = buf.subarray(nl + 2, nl + 2 + size);
      buf = buf.subarray(nl + 2 + size + 2);
      yield Buffer.from(data);
    }
  }
  if (buf.length) yield buf;
}

export class TtsClient {
  constructor({ url = DEFAULT_TTS_URL, fetchImpl = globalThis.fetch, cacheDir = null } = {}) {
    this.url = url;
    this.fetch = fetchImpl;
    this.cacheDir = cacheDir;
    this._cacheIndex = null;
  }

  /** 探测服务是否可用（服务端懒加载模型，所以 model_ready 可能先是 false） */
  async health() {
    const res = await this.fetch(`${this.url}/health`);
    if (!res.ok) throw new Error(`TTS 健康检查失败 HTTP ${res.status}`);
    return res.json();
  }

  /**
   * 合成并**逐句**产出电话音频。
   * @param {string} text
   * @param {object} opts {speaker, instruct, signal}
   * @yields {{mulaw: Buffer, index: number}}
   */
  async *synthesizeStream(text, opts = {}) {
    const body = JSON.stringify({
      text,
      speaker: opts.speaker,
      language: opts.language,
      instruct: opts.instruct,
    });
    const res = await this.fetch(`${this.url}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: opts.signal,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { /* 忽略 */ }
      throw new Error(`TTS 合成失败 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
    }
    const sampleRate = Number(res.headers.get('X-Sample-Rate') || 24000);
    this.lastSampleRate = sampleRate;

    let index = 0;
    // 优先按 chunked 解析；若对方不是 chunked（比如测试桩），退化为整块处理
    const transfer = res.headers.get('Transfer-Encoding') || '';
    const chunks = transfer.includes('chunked')
      ? readChunked(res.body)
      : (async function* oneShot() { yield Buffer.from(await res.arrayBuffer()); })();

    for await (const pcm of chunks) {
      if (!pcm.length) continue;
      yield { mulaw: ttsPcmToMuLaw(pcm, sampleRate), index: index++ };
    }
  }

  /**
   * 取预热缓存里的固定话术（μ-law）。命中返回 Buffer，未命中返回 null。
   * @param {string} key 缓存键，如 'ready'
   */
  async cachedPhrase(key) {
    if (!this.cacheDir) return null;
    const file = path.join(this.cacheDir, `${key}.mulaw`);
    if (!existsSync(file)) return null;
    return readFile(file);
  }

  /** 列出缓存里有哪些键 */
  async cachedKeys() {
    if (!this.cacheDir) return [];
    const idx = path.join(this.cacheDir, 'index.json');
    if (!existsSync(idx)) return [];
    try {
      const raw = JSON.parse(await readFile(idx, 'utf8'));
      return Object.keys(raw);
    } catch {
      return [];
    }
  }
}
