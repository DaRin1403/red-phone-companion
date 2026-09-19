/**
 * 交叉验证 μ-law 编解码是否符合 G.711 (PCMU) 标准。
 * 重点检查极性：标准要求 0x00 = 最大正电平，0xFF = 静音(0)。
 */
import { decodeMuLaw, encodeMuLaw } from '../../src/phone-audio-lib.mjs';

const cases = [
  { pcm: 32124, expectByte: 0x00, why: '最大正电平' },
  { pcm: -32124, expectByte: 0x80, why: '最大负电平' },
  { pcm: 0, expectByte: 0xff, why: '静音' },
  { pcm: 1000, expectByte: 0xce, why: '小正值（标准表 0xCE≈+1004）' },
  { pcm: -1000, expectByte: 0x4e, why: '小负值' },
];

let pass = 0, fail = 0;
console.log('=== 编码器：PCM → μ-law 字节 ===');
for (const c of cases) {
  const got = encodeMuLaw(c.pcm);
  const ok = got === c.expectByte;
  ok ? pass++ : fail++;
  console.log(
    `${ok ? '✓' : '✗'} ${c.why.padEnd(22)} PCM=${String(c.pcm).padStart(7)} ` +
    `得到 0x${got.toString(16).padStart(2, '0').toUpperCase()} ` +
    `期望 0x${c.expectByte.toString(16).padStart(2, '0').toUpperCase()}`
  );
}

console.log('\n=== 与标准解码表交叉验证（AD&D / G.711 参考值）===');
// 几个权威参考点：字节 -> 期望的 16bit 线性值
const refDecode = [
  [0x00, 32124], [0x80, -32124], [0xff, 0], [0x7f, 0],
  [0xfe, 8], [0x01, -31100], [0x81, 31100],
];
for (const [byte, expect] of refDecode) {
  const got = decodeMuLaw(byte);
  const ok = got === expect;
  ok ? pass++ : fail++;
  console.log(
    `${ok ? '✓' : '✗'} decode(0x${byte.toString(16).padStart(2, '0').toUpperCase()}) = ${String(got).padStart(7)}  期望 ${String(expect).padStart(7)}`
  );
}

console.log('\n=== 往返一致性（编码后再解码应回到同一量化电平）===');
let rtFail = 0;
for (let s = -32000; s <= 32000; s++) {
  const b = encodeMuLaw(s);
  const back = decodeMuLaw(b);
  // 再编码同一个电平必须得到同一个字节（无振荡）
  if (encodeMuLaw(back) !== b) rtFail++;
}
console.log(rtFail === 0 ? '✓ 编解码无振荡' : `✗ 有 ${rtFail} 个取值出现编解码振荡`);

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 && rtFail === 0 ? 0 : 1);
