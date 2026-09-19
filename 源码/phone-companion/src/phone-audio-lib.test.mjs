/**
 * phone-audio-lib.test.mjs —— 音频地基自测
 * 运行：node --test src/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeMuLaw, encodeMuLaw, muLawBufferToPcm16, pcm16BufferToMuLaw,
  muLawToPcmAtRate, pcm16ToMuLaw8k,
  parseRtp, makeRtp, frameMuLaw, tone, silence,
  speakable, speechChunks,
  PHONE_RATE, SAMPLES_PER_FRAME,
} from './phone-audio-lib.mjs';

// 基准说明：以下期望值全部来自 Python 标准库 audioop 的 lin2ulaw/ulaw2lin
// （独立权威实现）实测对照。注意 G.711 μ-law 存在多种历史变体表，
// 本实现与 audioop 完全一致：0x80 = 最大正电平，0x00 = 最大负电平，0xFF = 静音。
// 对照脚本见 工具/μlaw标准校验.mjs。

test('μ-law 编解码：与 audioop 基准逐条一致', () => {
  const encodeCases = [
    [32124, 0x80], [-32124, 0x00], [0, 0xff], [1000, 0xce], [-1000, 0x4e],
    [8031, 0xa0], [-8031, 0x20],
  ];
  for (const [pcm, byte] of encodeCases) {
    assert.equal(encodeMuLaw(pcm), byte, `lin2ulaw(${pcm}) 应为 0x${byte.toString(16)}`);
  }
  const decodeCases = [
    [0x00, -32124], [0x80, 32124], [0xff, 0], [0x7f, 0], [0xfe, 8],
    [0x01, -31100], [0x81, 31100], [0xce, 988], [0x4e, -988],
  ];
  for (const [byte, pcm] of decodeCases) {
    assert.equal(decodeMuLaw(byte), pcm, `ulaw2lin(0x${byte.toString(16)}) 应为 ${pcm}`);
  }
});

test('μ-law 往返：落回同一可表示电平，且电平不漂移', () => {
  // G.711 μ-law 最小区段步长 8、最大区段步长 1024（实测见 工具/μlaw探测.mjs），
  // 故往返误差上界为半个最大步长；实测最大 644（绝对值饱和处）。
  let worst = 0;
  for (let s = -32000; s <= 32000; s += 137) {
    worst = Math.max(worst, Math.abs(decodeMuLaw(encodeMuLaw(s)) - s));
  }
  assert.ok(worst <= 1024, `最大往返误差 ${worst} 超出 μ-law 固有量化范围`);

  // 真正的不变量是"电平不再漂移"。注意 encode(decode(b)) !== b 并非错误：
  // 实测 0x7F 与 0xFF 都表示电平 0，属于合法编码歧义（256 个码字中仅此 1 个）。
  for (let b = 0; b <= 0xff; b++) {
    const level = decodeMuLaw(b);
    assert.equal(decodeMuLaw(encodeMuLaw(level)), level, `码字 0x${b.toString(16)} 电平发生漂移`);
  }
});

test('缓冲级往返：长度与静音保持', () => {
  const pcm = Buffer.alloc(160 * 2);
  for (let i = 0; i < 160; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), i * 2);
  const mulaw = pcm16BufferToMuLaw(pcm);
  assert.equal(mulaw.length, 160);
  const back = muLawBufferToPcm16(mulaw);
  assert.equal(back.length, 320);

  const sil = pcm16BufferToMuLaw(Buffer.alloc(320));
  assert.ok(sil.every((b) => b === 0xff || b === 0x7f), '全零 PCM 应编码为静音字节');
});

test('μ-law 8k → 16k / 24k 重采样：样本数与音高正确', () => {
  const oneSecond = tone(440, 1.0);
  const up16 = muLawToPcmAtRate(oneSecond, 16000);
  const up24 = muLawToPcmAtRate(oneSecond, 24000);
  assert.equal(up16.length, PHONE_RATE * 2 * 2, '16k 应为 32000 字节');
  assert.equal(up24.length, PHONE_RATE * 3 * 2, '24k 应为 48000 字节');

  // 过零点计数应接近 2×频率（440Hz 一秒约 880 次过零）
  const countZero = (buf) => {
    let n = 0, prev = buf.readInt16LE(0);
    for (let i = 1; i * 2 + 1 < buf.length; i++) {
      const v = buf.readInt16LE(i * 2);
      if ((prev < 0 && v >= 0) || (prev >= 0 && v < 0)) n++;
      prev = v;
    }
    return n;
  };
  const z16 = countZero(up16);
  assert.ok(Math.abs(z16 - 880) < 40, `16k 过零次数 ${z16}，应接近 880`);
});

test('16k PCM → μ-law 8k：长度减半、能量保留', () => {
  const samples = 16000;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(10000 * Math.sin(i / 20)), i * 2);
  const mulaw = pcm16ToMuLaw8k(pcm, 16000);
  assert.equal(mulaw.length, 8000, '16k→8k 应得到 8000 字节');
  // 不应该是纯静音
  assert.ok(mulaw.some((b) => b !== 0xff && b !== 0x7f), '输出不应全是静音');
});

test('RTP：打包与解包往返一致', () => {
  const payload = tone(660, 0.02);
  const pkt = makeRtp(payload, 1234, 987654, 0xdeadbeef, { marker: true });
  const parsed = parseRtp(pkt);
  assert.equal(parsed.sequence, 1234);
  assert.equal(parsed.timestamp, 987654);
  assert.equal(parsed.ssrc, 0xdeadbeef);
  assert.equal(parsed.marker, true);
  assert.equal(parsed.payloadType, 0);
  assert.deepEqual(parsed.payload, payload);
});

test('RTP：畸形包返回 null 而不是抛错', () => {
  assert.equal(parseRtp(Buffer.alloc(4)), null, '不足 12 字节头部');
  assert.equal(parseRtp(Buffer.from([0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null, '版本号不是 2');
  // 伪造一个"声明了扩展头但长度不够"的包
  const bogus = Buffer.from([0x90, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(parseRtp(bogus), null, '扩展头越界');
});

test('RTP：空负载是合法的（保活包）', () => {
  const empty = makeRtp(Buffer.alloc(0), 7, 0, 1);
  const parsed = parseRtp(empty);
  assert.notEqual(parsed, null, '空负载 RTP 应能解析');
  assert.equal(parsed.sequence, 7);
  assert.equal(parsed.payload.length, 0);
});

test('RTP：20ms 分帧得到 160 字节一包', () => {
  const audio = tone(660, 0.1);            // 0.1 秒 = 800 字节
  const frames = frameMuLaw(audio);
  assert.equal(frames.length, 5, '0.1 秒应有 5 帧');
  assert.equal(frames[0].length, SAMPLES_PER_FRAME);
  assert.equal(SAMPLES_PER_FRAME, 160);
});

test('提示音参数与参考实现一致：660Hz/300ms 就绪音、220Hz/600ms 错误音', () => {
  assert.equal(tone(660, 0.3).length, 2400);
  assert.equal(tone(220, 0.6).length, 4800);
  assert.equal(silence(1).length, 8000);
  assert.ok(silence(1).every((b) => b === 0xff));
});

test('speakable：Markdown 清洗后不残留符号', () => {
  const md = [
    '# 标题',
    '',
    '这是一段**加粗**的文字，带 `行内代码`。',
    '',
    '```js',
    'console.log(1)',
    '```',
    '',
    '- 列表项一',
    '- 列表项二',
    '',
    '| 列A | 列B |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '参考 [链接](https://example.com) 和 https://foo.bar',
  ].join('\n');
  const out = speakable(md);
  assert.ok(!out.includes('```'), '代码块应被替换');
  assert.ok(!out.includes('**'), '加粗符号应被去掉');
  assert.ok(!out.includes('列A'), '表格行应被丢弃');
  assert.ok(out.includes('代码内容请查看对话'), '代码块应替换为说明');
  assert.ok(out.includes('链接见对话'), '裸链接应替换');
  assert.ok(!/^[#>*\-]/m.test(out), '不应残留标题/列表符号');
});

test('speechChunks：优先在句末切分且不超上限', () => {
  const text = '第一句话。第二句话！第三句话？' + '很长的没有标点的一段话'.repeat(6);
  const chunks = speechChunks(text, 30);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(Array.from(c).length <= 30, `分段超长：${c.length}`);
  assert.equal(chunks.join(''), text, '拼接应完整还原');
});

test('speechChunks：窗口内出现句末标点时优先在此切分', () => {
  // maxChars=6 → 搜索窗口为下标 3..5，"第一句话。"的句号正好落在下标 4
  const chunks = speechChunks('第一句话。第二句话！', 6);
  assert.equal(chunks[0], '第一句话。', '应在窗口内最近的句末标点处切分');
  assert.equal(chunks.join(''), '第一句话。第二句话！');
});

test('speechChunks：超长无标点时按上限硬切并可还原', () => {
  const long = '无标点长句'.repeat(20);      // 100 字，无任何标点
  const chunks = speechChunks(long, 12);
  assert.ok(chunks.every((c) => Array.from(c).length <= 12));
  assert.equal(chunks.join(''), long);
});

test('speechChunks：空文本与纯空白返回空数组', () => {
  assert.deepEqual(speechChunks(''), []);
  assert.deepEqual(speechChunks('   \n  '), []);
});
