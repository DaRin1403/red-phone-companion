/**
 * phone-transcription.test.mjs —— ASR 客户端与格式转换测试
 *
 * 用一个假的 WebSocket 服务端模拟 CapsWriter，验证协议字段与结果解析。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

import { g711ToFloat32, float32ToG711, pcm16ToFloat32 } from './phone-convert.mjs';
import {
  buildAudioMessage, parseRecognition, muLawToBase64Float32,
  TranscriptionClient, transcribe,
} from './phone-transcription.mjs';
import { tone, decodeMuLaw } from './phone-audio-lib.mjs';

// ---------------------------------------------------------------- 格式转换

test('g711ToFloat32：8k→16k 长度翻倍，幅值落在 −1..1', () => {
  const mulaw = tone(440, 0.05);                 // 400 采样
  const f = g711ToFloat32(mulaw, 8000, 16000);
  assert.equal(f.length, 800);
  for (const v of f) {
    assert.ok(v >= -1 && v <= 1, `幅值越界: ${v}`);
  }
  // 阈值按实测校准（工具/幅值探测.mjs）：
  //   μ-law 满幅 ≈ 0.98；tone 振幅 2500 对应的 float32 峰值 = 0.076
  assert.ok(Math.max(...f.map(Math.abs)) > 0.05, '应有实际信号');
});

test('g711ToFloat32：采样率相同时不做插值', () => {
  const mulaw = tone(440, 0.01);
  const f = g711ToFloat32(mulaw, 8000, 8000);
  assert.equal(f.length, mulaw.length);
  assert.ok(Math.abs(f[0] - decodeMuLaw(mulaw[0]) / 32768) < 1e-9);
});

test('g711ToFloat32：空输入返回空数组', () => {
  assert.equal(g711ToFloat32(Buffer.alloc(0)).length, 0);
  assert.equal(g711ToFloat32(null).length, 0);
});

test('float32ToG711：16k→8k 长度减半，且保留能量', () => {
  const n = 1600;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = 0.5 * Math.sin(i / 10);
  const mulaw = float32ToG711(src, 16000);
  assert.equal(mulaw.length, 800);
  assert.ok(mulaw.some((b) => b !== 0xff && b !== 0x7f), '不应全是静音');
});

test('float32ToG711：超范围输入被限幅而不是溢出', () => {
  const src = new Float32Array([5, -5, 0, 100]);
  const mulaw = float32ToG711(src, 8000);
  assert.equal(mulaw.length, 4);
  // 限幅后应是正负最大电平与静音
  assert.equal(mulaw[0], 0x80, '+5 应被限幅为最大正电平');
  assert.equal(mulaw[1], 0x00, '−5 应被限幅为最大负电平');
  assert.equal(mulaw[2], 0xff, '0 应为静音');
});

test('pcm16ToFloat32：小端 16bit 正确换算', () => {
  const buf = Buffer.alloc(6);
  buf.writeInt16LE(16384, 0);                    // 0.5
  buf.writeInt16LE(-16384, 2);                   // -0.5
  buf.writeInt16LE(0, 4);
  const f = pcm16ToFloat32(buf);
  assert.equal(f.length, 3);
  assert.ok(Math.abs(f[0] - 0.5) < 1e-4);
  assert.ok(Math.abs(f[1] + 0.5) < 1e-4);
  assert.equal(f[2], 0);
});

// ---------------------------------------------------------------- 协议构造

test('buildAudioMessage：字段与 CapsWriter 协议一致', () => {
  const mulaw = tone(440, 0.02);
  const msg = JSON.parse(buildAudioMessage({
    taskId: 'T1', mulaw, isFinal: false, timeStart: 123.5,
    segDuration: 5, segOverlap: 1, language: 'chinese',
  }));
  assert.equal(msg.task_id, 'T1');
  assert.equal(msg.source, 'mic');
  assert.equal(msg.is_final, false);
  assert.equal(msg.time_start, 123.5);
  assert.equal(msg.seg_duration, 5);
  assert.equal(msg.seg_overlap, 1);
  assert.equal(msg.language, 'chinese');
  // data 必须是 float32 的 base64：
  // 8k μ-law N 字节 → 16k float32 上采样 2 倍采样点 → 2N 个 float32 → 2N×4 字节
  const bytes = Buffer.from(msg.data, 'base64');
  assert.equal(bytes.length, mulaw.length * 2 * 4,
    '8k μ-law N 字节 → 16k float32 应为 N*2*4 字节');
  // 每个 float32 都应是合法幅值（这条能揪出 byteOffset 错位导致的垃圾数据）
  for (let i = 0; i < bytes.length; i += 4) {
    const v = bytes.readFloatLE(i);
    assert.ok(Number.isFinite(v) && v >= -1 && v <= 1,
      `第 ${i / 4} 个采样越界：${v}`);
  }
});

test('buildAudioMessage：结束包 data 为空', () => {
  const msg = JSON.parse(buildAudioMessage({ taskId: 'T2', isFinal: true }));
  assert.equal(msg.is_final, true);
  assert.equal(msg.data, '');
});

test('muLawToBase64Float32：解回来是 float32 波形（防 byteOffset 错位）', () => {
  const mulaw = tone(660, 0.01);
  const bytes = Buffer.from(muLawToBase64Float32(mulaw), 'base64');
  assert.equal(bytes.length % 4, 0, '应是 4 字节对齐的 float32');
  assert.equal(bytes.length, mulaw.length * 2 * 4, '长度应为 N*2*4');
  // 逐个校验幅值：若实现用了 Buffer.from(Float32Array) 的共享视图，
  // 会把内存池里的无关数据编进来，这里会立刻报出 1e31 量级的垃圾值。
  for (let i = 0; i < bytes.length; i += 4) {
    const v = bytes.readFloatLE(i);
    assert.ok(Number.isFinite(v) && v >= -1 && v <= 1, `采样越界：${v}`);
  }
  assert.ok(Math.max(...[...Array(bytes.length / 4)].map((_, i) => Math.abs(bytes.readFloatLE(i * 4)))) > 0.05,
    '应有实际信号而不是全零');
});

test('parseRecognition：解析服务端结果与时延', () => {
  const r = parseRecognition(JSON.stringify({
    task_id: 'T3', is_final: true, text: '帮我查天气。', text_accu: '帮我查天气。',
    duration: 3.2, time_submit: 100.0, time_complete: 100.25,
  }));
  assert.equal(r.taskId, 'T3');
  assert.equal(r.isFinal, true);
  assert.equal(r.text, '帮我查天气。');
  assert.equal(r.latencyMs, 250);
});

test('parseRecognition：字段缺失时不崩', () => {
  const r = parseRecognition('{"task_id":"x","is_final":false}');
  assert.equal(r.text, '');
  assert.equal(r.latencyMs, null);
});

// ---------------------------------------------------------------- 端到端（假服务端）

test('TranscriptionClient：对假 CapsWriter 服务端完成一次识别', async (t) => {
  const received = [];
  const wss = new WebSocketServer({ port: 0, handleProtocols: () => 'binary' });
  await new Promise((r) => wss.on('listening', r));
  const port = wss.address().port;

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (msg.is_final) {
        // 模拟服务端：先回中间结果再回最终结果
        socket.send(JSON.stringify({
          task_id: msg.task_id, is_final: false, text: '帮我查', text_accu: '',
          duration: 1.0, time_submit: 1, time_complete: 1.1,
        }));
        setTimeout(() => {
          socket.send(JSON.stringify({
            task_id: msg.task_id, is_final: true,
            text: '帮我查一下明天的天气。', text_accu: '帮我查一下明天的天气。',
            duration: 3.0, time_submit: 2, time_complete: 2.13,
          }));
        }, 30);
      }
    });
  });

  t.after(async () => {
    await new Promise((r) => wss.close(r));
  });

  const client = new TranscriptionClient({ url: `ws://127.0.0.1:${port}`, timeoutMs: 5000 });
  const partials = [];
  client.on('partial', (p) => partials.push(p.text));

  await client.connect();
  client.start();
  client.push(tone(440, 0.2));                   // 0.2 秒音频
  client.push(tone(660, 0.1));
  const result = await client.finish();
  client.close();

  assert.equal(result.text, '帮我查一下明天的天气。');
  assert.equal(result.latencyMs, 130);
  assert.equal(result.seconds, 0.3, '合计 0.3 秒音频');
  assert.deepEqual(partials, ['帮我查'], '应收到中间结果');

  // 校验发出的两条消息：音频包 + 结束包
  assert.equal(received.length, 2);
  assert.equal(received[0].is_final, false);
  assert.equal(received[0].source, 'mic');
  assert.ok(received[0].data.length > 0);
  assert.equal(received[1].is_final, true);
  assert.equal(received[1].task_id, received[0].task_id, '两条消息 task_id 必须一致');
});

test('TranscriptionClient：识别超时会报错而不是永久挂着', async (t) => {
  const wss = new WebSocketServer({ port: 0, handleProtocols: () => 'binary' });
  await new Promise((r) => wss.on('listening', r));
  const port = wss.address().port;
  wss.on('connection', (socket) => {
    socket.on('message', () => { /* 故意不回 */ });
  });
  t.after(async () => { await new Promise((r) => wss.close(r)); });

  const client = new TranscriptionClient({ url: `ws://127.0.0.1:${port}`, timeoutMs: 300 });
  await client.connect();
  client.start();
  client.push(tone(440, 0.05));
  await assert.rejects(() => client.finish(), /识别超时/);
  client.close();
});

test('transcribe 便捷函数：一次调用完成整段识别', async (t) => {
  const wss = new WebSocketServer({ port: 0, handleProtocols: () => 'binary' });
  await new Promise((r) => wss.on('listening', r));
  const port = wss.address().port;
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.is_final) {
        socket.send(JSON.stringify({
          task_id: msg.task_id, is_final: true, text: '好的。', text_accu: '好的。',
          duration: 0.5, time_submit: 1, time_complete: 1.05,
        }));
      }
    });
  });
  t.after(async () => { await new Promise((r) => wss.close(r)); });

  const r = await transcribe(tone(440, 0.5), { url: `ws://127.0.0.1:${port}`, timeoutMs: 3000 });
  assert.equal(r.text, '好的。');
});
