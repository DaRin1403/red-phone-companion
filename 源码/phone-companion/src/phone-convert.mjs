/**
 * phone-convert.mjs —— 电话音频与识别/合成链路之间的格式转换
 *
 * 这一层的存在意义：电话侧是 8kHz μ-law（1 字节 1 采样），
 * 而识别端要 16kHz 单声道 float32、播报端各模型采样率不一。
 * 把换算集中在这里，避免到处复制粘贴采样率常量。
 */
import { decodeMuLaw, PHONE_RATE } from './phone-audio-lib.mjs';

/**
 * 8kHz μ-law → 目标采样率的 float32（范围 −1..1）。
 * 线性插值上采样；电话带宽本来只有 300–3400Hz，插值足够。
 *
 * @param {Buffer} mulaw  8kHz μ-law 字节流
 * @param {number} sourceRate 源采样率，默认 8000
 * @param {number} targetRate 目标采样率，默认 16000
 * @returns {Float32Array}
 */
export function g711ToFloat32(mulaw, sourceRate = PHONE_RATE, targetRate = 16000) {
  if (!mulaw || mulaw.length === 0) return new Float32Array(0);
  const inSamples = mulaw.length;
  if (sourceRate === targetRate) {
    const out = new Float32Array(inSamples);
    for (let i = 0; i < inSamples; i++) out[i] = decodeMuLaw(mulaw[i]) / 32768;
    return out;
  }
  const ratio = targetRate / sourceRate;
  const outSamples = Math.floor(inSamples * ratio);
  const out = new Float32Array(outSamples);
  for (let j = 0; j < outSamples; j++) {
    const pos = j / ratio;
    const i = Math.floor(pos);
    const t = pos - i;
    const a = decodeMuLaw(mulaw[Math.min(i, inSamples - 1)]);
    const b = decodeMuLaw(mulaw[Math.min(i + 1, inSamples - 1)]);
    out[j] = (a + (b - a) * t) / 32768;
  }
  return out;
}

/**
 * float32（任意采样率）→ 8kHz μ-law。
 * 用于把 TTS 输出转成电话可播的格式。
 */
export function float32ToG711(samples, sourceRate) {
  const src = samples instanceof Float32Array ? samples : Float32Array.from(samples);
  if (src.length === 0) return Buffer.alloc(0);
  const ratio = sourceRate / PHONE_RATE;
  const outSamples = Math.floor(src.length / ratio);
  const out = Buffer.alloc(outSamples);
  for (let j = 0; j < outSamples; j++) {
    const pos = j * ratio;
    const i = Math.floor(pos);
    const t = pos - i;
    const a = src[Math.min(i, src.length - 1)];
    const b = src[Math.min(i + 1, src.length - 1)];
    const v = Math.max(-1, Math.min(1, a + (b - a) * t));
    out[j] = encodeMu(v);
  }
  return out;
}

/** 就地限幅的 μ-law 编码（float32 −1..1 → μ-law 字节） */
function encodeMu(value) {
  const sample = Math.round(value * 32767);
  const sign = sample < 0 ? 0x80 : 0;
  let v = Math.min(32635, Math.abs(sample)) + 132;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(v & mask); mask >>= 1) exponent--;
  return (~(sign | (exponent << 4) | ((v >> (exponent + 3)) & 0x0f))) & 0xff;
}

/**
 * 16bit 小端 PCM → float32（TTS 服务返回 s16le 裸流时用）
 */
export function pcm16ToFloat32(pcm) {
  const n = pcm.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}
