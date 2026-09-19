/**
 * phone-tts.test.mjs —— TTS 客户端测试
 *
 * 用假的 TTS 服务端（含 chunked 响应）验证：
 *  · 逐句流式产出（关键：不能等全部算完才给第一句）
 *  · s16le → μ-law 转换正确
 *  · 预热缓存读取
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { TtsClient, ttsPcmToMuLaw, readChunked } from './phone-tts.mjs';

// ---------------------------------------------------------------- 转换

test('ttsPcmToMuLaw：16k s16le → 8k μ-law，长度符合预期', () => {
  const n = 16000;                              // 1 秒 @16k
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    pcm.writeInt16LE(Math.round(12000 * Math.sin(i / 20)), i * 2);
  }
  const mulaw = ttsPcmToMuLaw(pcm, 16000);
  assert.equal(mulaw.length, 8000, '1 秒 16k → 8k 应为 8000 字节');
  assert.ok(mulaw.some((b) => b !== 0xff && b !== 0x7f), '不应全是静音');
});

test('ttsPcmToMuLaw：24k → 8k', () => {
  const n = 24000;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 15)), i * 2);
  assert.equal(ttsPcmToMuLaw(pcm, 24000).length, 8000);
});

test('ttsPcmToMuLaw：空输入返回空', () => {
  assert.equal(ttsPcmToMuLaw(Buffer.alloc(0), 16000).length, 0);
});

// ---------------------------------------------------------------- chunked 解析

test('readChunked：正确拆出多个数据块', async () => {
  const parts = [Buffer.from('AAA'), Buffer.from('BBBB')];
  const wire = Buffer.concat([
    Buffer.from('3\r\n'), parts[0], Buffer.from('\r\n'),
    Buffer.from('4\r\n'), parts[1], Buffer.from('\r\n'),
    Buffer.from('0\r\n\r\n'),
  ]);
  const stream = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(wire)); c.close(); },
  });
  const got = [];
  for await (const c of readChunked(stream)) got.push(c.toString());
  assert.deepEqual(got, ['AAA', 'BBBB']);
});

test('readChunked：分多次到达的块也能正确拼装', async () => {
  const wire = Buffer.concat([
    Buffer.from('5\r\n'), Buffer.from('HELLO'), Buffer.from('\r\n'),
    Buffer.from('0\r\n\r\n'),
  ]);
  // 每次只吐 3 字节，模拟网络碎片
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < wire.length; i += 3) {
        c.enqueue(new Uint8Array(wire.subarray(i, i + 3)));
      }
      c.close();
    },
  });
  const got = [];
  for await (const c of readChunked(stream)) got.push(c.toString());
  assert.deepEqual(got, ['HELLO']);
});

// ---------------------------------------------------------------- 客户端

/** 起一个假 TTS 服务端 */
async function fakeTts({ chunked = true, delayMs = 0 } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model_ready: true, sample_rate: 16000 }));
      return;
    }
    if (req.url.startsWith('/tts')) {
      // 读掉请求体
      for await (const _ of req) { /* drain */ }
      const pcmA = Buffer.alloc(16000 * 2);     // 1 秒
      const pcmB = Buffer.alloc(8000 * 2);      // 0.5 秒
      for (let i = 0; i < pcmA.length / 2; i++) pcmA.writeInt16LE(Math.round(9000 * Math.sin(i / 20)), i * 2);
      for (let i = 0; i < pcmB.length / 2; i++) pcmB.writeInt16LE(Math.round(9000 * Math.sin(i / 25)), i * 2);

      if (chunked) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'X-Sample-Rate': '16000',
          'Transfer-Encoding': 'chunked',
        });
        const writeChunk = (buf) => {
          res.write(`${buf.length.toString(16)}\r\n`);
          res.write(buf);
          res.write('\r\n');
        };
        writeChunk(pcmA);
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        writeChunk(pcmB);
        res.write('0\r\n\r\n');
        res.end();
      } else {
        const all = Buffer.concat([pcmA, pcmB]);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'X-Sample-Rate': '16000',
          'Content-Length': String(all.length),
        });
        res.end(all);
      }
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('TtsClient：chunked 响应逐句产出，第一句不必等第二句', async (t) => {
  const { server, url } = await fakeTts({ chunked: true, delayMs: 120 });
  t.after(() => new Promise((r) => server.close(r)));

  const client = new TtsClient({ url });
  const health = await client.health();
  assert.equal(health.model_ready, true);

  const t0 = Date.now();
  const chunks = [];
  const times = [];
  for await (const c of client.synthesizeStream('第一句。第二句。')) {
    chunks.push(c);
    times.push(Date.now() - t0);
  }
  assert.equal(chunks.length, 2, '应产出两个句子块');
  assert.equal(chunks[0].mulaw.length, 8000, '第一句 1 秒');
  assert.equal(chunks[1].mulaw.length, 4000, '第二句 0.5 秒');
  assert.ok(times[0] < times[1], '第一句必须先到');
  assert.ok(times[0] < 120, `第一句应在服务端发第二句之前就到了，实际 ${times[0]}ms`);
  assert.equal(client.lastSampleRate, 16000);
});

test('TtsClient：非 chunked 响应也能处理（退化为整块）', async (t) => {
  const { server, url } = await fakeTts({ chunked: false });
  t.after(() => new Promise((r) => server.close(r)));

  const client = new TtsClient({ url });
  const chunks = [];
  for await (const c of client.synthesizeStream('整块。')) chunks.push(c);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].mulaw.length, 12000, '1.5 秒合计');
});

test('TtsClient：服务端报错时抛出带信息的异常', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '模型加载失败：显存不足' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const client = new TtsClient({ url: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(
    async () => { for await (const _ of client.synthesizeStream('x')) { /* 应抛错 */ } },
    /模型加载失败/,
  );
});

test('TtsClient：预热缓存读取', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'phoncache-'));
  await writeFile(path.join(dir, 'ready.mulaw'), Buffer.alloc(1600, 0xaa));
  await writeFile(path.join(dir, 'index.json'),
    JSON.stringify({ ready: { text: '我在听。', duration: 0.2 } }));

  const client = new TtsClient({ cacheDir: dir });
  assert.deepEqual(await client.cachedKeys(), ['ready']);
  const buf = await client.cachedPhrase('ready');
  assert.equal(buf.length, 1600);
  assert.equal(await client.cachedPhrase('missing'), null);
  assert.deepEqual(await new TtsClient({}).cachedKeys(), []);
});
