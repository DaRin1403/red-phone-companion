/**
 * phone-audio-lib.mjs —— 电话音频地基（μ-law / RTP / 提示音 / 重采样）
 *
 * 来源：参考实现 prikevs/codex-redline (MIT) 的 src/phone-audio.mjs，
 *      本项目重写并补齐单元可测的纯函数；参数与之保持一致：
 *      G.711 μ-law (PCMU)、8 kHz、单声道、20 ms RTP 帧。
 *
 * 设计原则：本文件不含任何 I/O 与网络，纯计算，方便直接在 Node 里跑测试。
 */

// ---------------------------------------------------------------- 常量

export const PHONE_RATE = 8000;          // 电话采样率
export const FRAME_MS = 20;              // RTP 帧长（毫秒）
export const SAMPLES_PER_FRAME = PHONE_RATE * FRAME_MS / 1000;   // 160
export const PCMU_PAYLOAD_TYPE = 0;      // G.711 μ-law 静态负载类型

// ---------------------------------------------------------------- G.711 μ-law

/** μ-law 字节 → 16-bit 线性 PCM */
export function decodeMuLaw(byte) {
  const value = (~byte) & 0xff;
  const sample = (((value & 0x0f) << 3) + 132) << ((value >> 4) & 7);
  return (value & 0x80) ? (132 - sample) : (sample - 132);
}

/** 16-bit 线性 PCM → μ-law 字节 */
export function encodeMuLaw(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  let value = Math.min(32635, Math.abs(Math.round(sample))) + 132;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(value & mask); mask >>= 1) exponent--;
  return (~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 0x0f))) & 0xff;
}

/** μ-law 缓冲 → Int16 PCM 缓冲（长度翻倍） */
export function muLawBufferToPcm16(mulaw) {
  const out = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) out.writeInt16LE(decodeMuLaw(mulaw[i]), i * 2);
  return out;
}

/** Int16 PCM 缓冲 → μ-law 缓冲（长度减半） */
export function pcm16BufferToMuLaw(pcm) {
  const n = pcm.length >> 1;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = encodeMuLaw(pcm.readInt16LE(i * 2));
  return out;
}

/**
 * μ-law 8k → 16-bit PCM 目标采样率（默认 24k，供云端/本地 STT 使用）
 * 用整数倍线性插值，避免引入额外依赖；比率非整数时按最近邻取值。
 */
export function muLawToPcmAtRate(mulaw, targetRate = 24000) {
  const ratio = targetRate / PHONE_RATE;          // 常见 2（16k）或 3（24k）
  const outFrames = mulaw.length;
  const outSamples = Math.floor(outFrames * ratio);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outFrames; i++) {
    const a = decodeMuLaw(mulaw[i]);
    const b = decodeMuLaw(mulaw[Math.min(i + 1, outFrames - 1)]);
    const base = Math.floor(i * ratio);
    const next = Math.floor((i + 1) * ratio);
    for (let j = base; j < next && j < outSamples; j++) {
      const t = ratio === 1 ? 0 : (j - i * ratio) / ratio;
      out.writeInt16LE(Math.round(a + (b - a) * t), j * 2);
    }
  }
  return out;
}

/** 16-bit PCM 任意采样率 → μ-law 8k（线性重采样，用于本地 TTS 输出） */
export function pcm16ToMuLaw8k(pcm, sourceRate) {
  if (sourceRate === PHONE_RATE) return pcm16BufferToMuLaw(pcm);
  const inSamples = pcm.length >> 1;
  const ratio = sourceRate / PHONE_RATE;
  const outSamples = Math.floor(inSamples / ratio);
  const out = Buffer.alloc(outSamples);
  for (let j = 0; j < outSamples; j++) {
    const pos = j * ratio;
    const i = Math.floor(pos);
    const t = pos - i;
    const a = pcm.readInt16LE(Math.min(i, inSamples - 1) * 2);
    const b = pcm.readInt16LE(Math.min(i + 1, inSamples - 1) * 2);
    out[j] = encodeMuLaw(a + (b - a) * t);
  }
  return out;
}

// ---------------------------------------------------------------- RTP

/** 解析 RTP 包；非 RTP 或畸形返回 null */
export function parseRtp(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 12 || packet[0] >> 6 !== 2) return null;
  let offset = 12 + 4 * (packet[0] & 0x0f);
  if (offset > packet.length) return null;
  if (packet[0] & 0x10) {                                   // CSRC 之后的扩展头
    if (offset + 4 > packet.length) return null;
    offset += 4 + 4 * packet.readUInt16BE(offset + 2);
  }
  const padding = (packet[0] & 0x20) ? packet.at(-1) : 0;
  if (offset > packet.length - padding) return null;
  if ((packet[0] & 0x20) && !padding) return null;
  return {
    marker: Boolean(packet[1] & 0x80),
    payloadType: packet[1] & 0x7f,
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    payload: packet.subarray(offset, packet.length - padding),
  };
}

/** 组装 RTP 包 */
export function makeRtp(payload, sequence, timestamp, ssrc, { marker = false, payloadType = PCMU_PAYLOAD_TYPE } = {}) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;                                        // V=2，无扩展、无填充
  header[1] = (marker ? 0x80 : 0) | (payloadType & 0x7f);
  header.writeUInt16BE(sequence & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

/** 把一段 μ-law 音频切成 20ms 的 RTP 包序列 */
export function frameMuLaw(mulaw) {
  const frames = [];
  for (let i = 0; i < mulaw.length; i += SAMPLES_PER_FRAME) {
    frames.push(mulaw.subarray(i, Math.min(i + SAMPLES_PER_FRAME, mulaw.length)));
  }
  return frames;
}

// ---------------------------------------------------------------- 提示音

/**
 * 生成提示音（单频正弦，μ-law）。
 * 参考实现使用 660 Hz / 300 ms 作为"就绪音"，220 Hz / 600 ms 作为"错误音"。
 */
export function tone(frequency = 660, seconds = 0.3, amplitude = 2500) {
  const n = Math.round(PHONE_RATE * seconds);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    out[i] = encodeMuLaw(amplitude * Math.sin((2 * Math.PI * frequency * i) / PHONE_RATE));
  }
  return out;
}

/** μ-law 静音（μ-law 中 0xff 是静音） */
export function silence(seconds) {
  return Buffer.alloc(Math.round(PHONE_RATE * seconds), 0xff);
}

// ---------------------------------------------------------------- 文本预处理

/**
 * 把 Markdown 回复变成适合朗读的纯文本。
 * 代码块、图片、链接、标题符号都要处理，否则听筒里会念出一堆符号。
 */
export function speakable(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '。代码内容请查看对话。')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '链接见对话')
    .replace(/^[#>*\-+]+\s*/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')          // 表格行直接丢掉，念出来没意义
    .replace(/[`*_~]/g, '')
    .replace(/\n{2,}/g, '。')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 按句子切分，便于"边合成边播放"。
 * 优先在句末标点处切；超长无标点时按上限硬切。
 */
export function speechChunks(text, maxChars = 120) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('语音分段长度无效');
  const remaining = Array.from(text);
  const chunks = [];
  const endings = new Set(['。', '！', '？', '!', '?', '；', ';', '，', ',', '\n']);
  while (remaining.length) {
    let cut = Math.min(maxChars, remaining.length);
    if (remaining.length > maxChars) {
      const floor = Math.ceil(maxChars * 0.5);
      for (let i = cut - 1; i >= floor; i--) {
        if (endings.has(remaining[i])) { cut = i + 1; break; }
      }
    }
    chunks.push(remaining.splice(0, cut).join(''));
  }
  return chunks.filter((c) => c.trim().length > 0);
}
