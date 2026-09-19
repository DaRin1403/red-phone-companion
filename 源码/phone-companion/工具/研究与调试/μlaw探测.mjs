/**
 * 探测 μ-law 编解码的实际量化特性，用于校准测试基准。
 * 用法：node 工具/μlaw探测.mjs
 */
import { decodeMuLaw, encodeMuLaw } from '../../src/phone-audio-lib.mjs';

console.log('=== 端点真值表 ===');
for (const b of [0x00, 0x01, 0x7f, 0x80, 0x81, 0xfe, 0xff]) {
  console.log('0x' + b.toString(16).padStart(2, '0'), '->', decodeMuLaw(b));
}

let worst = 0, worstAt = 0;
const hist = new Map();
for (let s = -32768; s <= 32767; s++) {
  const back = decodeMuLaw(encodeMuLaw(s));
  const e = Math.abs(back - s);
  if (e > worst) { worst = e; worstAt = s; }
  const bucket = e === 0 ? 0 : 2 ** Math.floor(Math.log2(e));
  hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
}
console.log('\n=== 全量往返误差 ===');
console.log('最大误差 =', worst, '出现在', worstAt, '→ 解码回', decodeMuLaw(encodeMuLaw(worstAt)));
console.log('误差分布（区间下界 -> 次数）：');
for (const k of [...hist.keys()].sort((a, b) => a - b)) {
  console.log('   ', String(k).padStart(5), '->', hist.get(k));
}

console.log('\n=== 量化步长（相邻可表示电平的间距）抽样 ===');
let prev = decodeMuLaw(0x00);
for (let b = 1; b <= 0xff; b++) {
  const cur = decodeMuLaw(b);
  const step = prev - cur;
  if (b <= 4 || b >= 0x7c && b <= 0x84 || b >= 0xfc) {
    console.log(`0x${b.toString(16).padStart(2, '0')} 电平=${String(cur).padStart(6)} 与上一档间距=${step}`);
  }
  prev = cur;
}

const maxErr = (() => {
  let m = 0;
  for (let s = -32768; s <= 32767; s++) m = Math.max(m, Math.abs(decodeMuLaw(encodeMuLaw(s)) - s));
  return m;
})();
console.log('\n最大往返误差 =', maxErr);

console.log('\n=== 电平稳定性（真正的"无振荡"不变量）===');
// 注意：encode(decode(b)) !== b 并非错误。μ-law 里 0x7F 与 0xFF 都解码为 0，
// 属于合法的编码歧义。真正要保证的是"电平不再漂移"：
//   decode(encode(decode(b))) === decode(b)
let levelDrift = 0;
const ambiguous = [];
for (let b = 0; b <= 0xff; b++) {
  const level = decodeMuLaw(b);
  const back = decodeMuLaw(encodeMuLaw(level));
  if (back !== level) levelDrift++;
  if (encodeMuLaw(level) !== b) ambiguous.push([b, encodeMuLaw(level), level]);
}
console.log(levelDrift === 0 ? '✓ 所有 256 个码字的电平都稳定（无漂移）' : `✗ ${levelDrift} 个码字电平漂移`);
console.log(`编码歧义（多字节映射到同一电平）：${ambiguous.length} 个`);
for (const [from, to, level] of ambiguous.slice(0, 10)) {
  console.log(`   0x${from.toString(16).padStart(2, '0').toUpperCase()} → 重编码为 0x${to.toString(16).padStart(2, '0').toUpperCase()}  (电平 ${level})`);
}
if (ambiguous.length > 10) console.log(`   ... 共 ${ambiguous.length} 个`);

console.log('\n结论：测试中应断言"电平稳定"，而不是"字节可还原"。');

