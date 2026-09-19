/**
 * 幅值探测.mjs —— 实测 8k μ-law ↔ float32 转换后的真实幅值范围。
 * 用于校准测试阈值，避免把"信号本来就小"误判成"转换坏了"。
 */
import { tone, decodeMuLaw, encodeMuLaw } from '../../src/phone-audio-lib.mjs';
import { g711ToFloat32, float32ToG711 } from '../../src/phone-convert.mjs';

const cases = [
  ['tone 默认振幅 2500', tone(440, 0.05)],
  ['满幅正弦(31000)', (() => {
    const n = 400;
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = encodeMuLaw(31000 * Math.sin(2 * Math.PI * 440 * i / 8000));
    return b;
  })()],
];

for (const [name, mulaw] of cases) {
  const f16 = g711ToFloat32(mulaw, 8000, 16000);
  let peak = 0, sum = 0;
  for (const v of f16) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
  const rms = Math.sqrt(sum / f16.length);
  console.log(`${name}:`);
  console.log(`  μ-law 字节数 ${mulaw.length} → float32 ${f16.length} 个`);
  console.log(`  峰值 ${peak.toFixed(5)}   有效值 ${rms.toFixed(5)}`);
  console.log(`  首字节 decodeMuLaw=${decodeMuLaw(mulaw[0])} → /32767=${(decodeMuLaw(mulaw[0])/32767).toFixed(5)}`);
}

console.log('\n=== μ-law 可表示的最大电平 ===');
console.log('decodeMuLaw(0x80) =', decodeMuLaw(0x80), '→ float32', (decodeMuLaw(0x80) / 32768).toFixed(5));
console.log('decodeMuLaw(0x00) =', decodeMuLaw(0x00), '→ float32', (decodeMuLaw(0x00) / 32768).toFixed(5));

console.log('\n=== 往返：float32 → μ-law → float32 是否保持幅值 ===');
const src = new Float32Array(400);
for (let i = 0; i < 400; i++) src[i] = 0.9 * Math.sin(i / 10);
const back = g711ToFloat32(float32ToG711(src, 8000), 8000, 8000);
let rpeak = 0;
for (const v of back) rpeak = Math.max(rpeak, Math.abs(v));
console.log(`输入峰值 0.9 → 往返后峰值 ${rpeak.toFixed(4)}`);

console.log('\n结论：判定"有信号"的阈值应取 0.05 左右（μ-law 满幅约 0.98，tone 振幅 2500 约 0.076）');
