/**
 * phone-replies.test.mjs —— DSH 会话监听测试
 *
 * 关键设计验证：**只对"进入等待之后完成"的回合响铃**，历史回合一律排除。
 * 这一点做错的话，用户每次打字都会被电话打扰。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findFrames, decompressSession, parseEvents, extractText, SessionWatcher,
} from './phone-replies.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 把若干 JSON 事件压成"一个事件一帧"的多 frame zstd 文件内容（贴近 DSH 的写法） */
function frameEvents(events) {
  return Buffer.concat(events.map((e) =>
    zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8'))));
}

function makeSessionDir(events) {
  const dir = mkdtempSync(join(tmpdir(), 'dshsess-'));
  const file = join(dir, 'session.jsonl.zstd');
  writeFileSync(file, frameEvents(events));
  return { dir, file };
}

const evTurnEnd = (turn, time, kind = 'completed') =>
  ({ type: 'turn/end', seq: turn * 1000, time, data: { turn, reason: { kind } } });
const evTurnStart = (turn) => ({ type: 'turn/start', seq: turn * 1000 - 1, data: { turn } });
const evAssistant = (turn, seq, text) => ({
  type: 'assistant/message', seq, data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});

// ---------------------------------------------------------------- 纯函数

test('findFrames：按魔数找出所有 frame 起点', () => {
  const a = zlib.zstdCompressSync(Buffer.from('x'));
  const b = zlib.zstdCompressSync(Buffer.from('y'));
  const buf = Buffer.concat([a, b]);
  const starts = findFrames(buf);
  assert.equal(starts.length, 2);
  assert.equal(starts[0], 0);
  assert.equal(starts[1], a.length);
});

test('decompressSession：多 frame 全部解出（Node 单次调用只能解第一帧）', () => {
  const events = [evTurnStart(1), evAssistant(1, 10, '第一轮'), evTurnEnd(1, 1000)];
  const buf = frameEvents(events);

  // 先确认"直接用 zstdDecompressSync 会漏"这个前提仍然成立，否则本测试失去意义
  const single = zlib.zstdDecompressSync(buf).toString('utf8');
  assert.ok(!single.includes('第一轮') || single.split('\n').filter(Boolean).length <= 1,
    '前提变化：Node 现在能一次解多帧，可简化实现');

  const { text, frames, failed } = decompressSession(buf);
  assert.equal(frames, 3);
  assert.equal(failed, 0);
  assert.ok(text.includes('第一轮'), '应解出全部内容');
  assert.equal(text.split('\n').filter(Boolean).length, 3);
});

test('decompressSession：正在写入的半截 frame 不会破坏已有内容', () => {
  // 实测行为：Node 的 zstd 对截断 frame 是**容错**的——不抛错，只返回已解出的部分。
  // 这意味着半个 JSON 行会被 parseEvents 自然跳过，等文件写完下次轮询自动补上。
  const good = frameEvents([evTurnStart(1), evTurnEnd(1, 1000)]);
  const half = zlib.zstdCompressSync(Buffer.from(JSON.stringify(evAssistant(2, 20, '半截'))))
    .subarray(0, 20);
  const { text } = decompressSession(Buffer.concat([good, half]));
  assert.ok(text.includes('turn/end'), '完整帧的内容必须完整保留');

  const { turns } = parseEvents(text);
  const t1 = turns.find((t) => t.turn === 1);
  assert.equal(t1.completed, true, '完整回合应被正确识别');
  // 半截的那条要么没被解析出来，要么解析成不完整的回合 —— 都不应误判为"已完成"
  const t2 = turns.find((t) => t.turn === 2);
  if (t2) assert.equal(t2.completed, false, '半截回合不能算完成');
});

test('decompressSession：真正损坏的 frame 被计入失败而不抛错', () => {
  const good = frameEvents([evTurnEnd(1, 1000)]);
  // 造一个魔数合法但内容是垃圾的 frame
  const garbage = Buffer.concat([MAGIC, Buffer.alloc(32, 0x5a)]);
  const { text, failed } = decompressSession(Buffer.concat([good, garbage]));
  assert.ok(failed >= 1, '垃圾帧应被计入失败');
  assert.ok(text.includes('turn/end'), '前面的正常帧仍要解出来');
});

test('parseEvents：取回合最后一条 assistant/message 作为最终回复', () => {
  const { text } = decompressSession(frameEvents([
    evTurnStart(1),
    evAssistant(1, 10, '中间步骤一'),
    evAssistant(1, 30, '中间步骤二'),
    evAssistant(1, 20, '乱序到达的较早消息'),
    evTurnEnd(1, 1000),
  ]));
  const { turns } = parseEvents(text);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].reply, '中间步骤二', '应按 seq 最大而非行序取最后一条');
  assert.equal(turns[0].completed, true);
});

test('parseEvents：未完成的回合 completed=false', () => {
  const { text } = decompressSession(frameEvents([
    evTurnStart(1), evAssistant(1, 10, '进行中'),
  ]));
  const { turns } = parseEvents(text);
  assert.equal(turns[0].completed, false);
  assert.equal(turns[0].endedAt, null);
});

test('parseEvents：非 completed 的结束原因不算完成', () => {
  const { text } = decompressSession(frameEvents([
    evTurnStart(1), evTurnEnd(1, 1000, 'interrupted'),
  ]));
  assert.equal(parseEvents(text).turns[0].completed, false);
});

test('extractText：兼容字符串与 block 数组两种 content', () => {
  assert.equal(extractText('直接字符串'), '直接字符串');
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(extractText([{ content: 'c' }]), 'c');
  assert.equal(extractText(null), '');
  assert.equal(extractText(42), '');
});

// ---------------------------------------------------------------- 监听器行为

test('启动时不响铃：历史回合全部被标记为已见', async () => {
  const { dir } = makeSessionDir([
    evTurnStart(1), evAssistant(1, 10, '历史回复'), evTurnEnd(1, 1000),
  ]);
  const w = new SessionWatcher({ sessionDir: dir, pollMs: 50 });
  const fired = [];
  w.on('reply-completed', (i) => fired.push(i));
  w.start();
  await new Promise((r) => setTimeout(r, 30));
  await w.poll();
  assert.equal(fired.length, 0, '历史回合不应触发');
  w.stop();
});

test('arm 之后新完成的回合才响铃', async () => {
  const { dir } = makeSessionDir([
    evTurnStart(1), evAssistant(1, 10, '历史回复'), evTurnEnd(1, 1000),
  ]);
  const w = new SessionWatcher({ sessionDir: dir, pollMs: 50 });
  const fired = [];
  w.on('reply-completed', (i) => fired.push(i));
  w.start();
  await new Promise((r) => setTimeout(r, 20));

  // 进入等待
  w.arm();
  await new Promise((r) => setTimeout(r, 20));

  // 追加一个"现在完成"的回合
  appendFileSync(w.sessionFile, frameEvents([
    evTurnStart(2), evAssistant(2, 20, '这一轮的回复'), evTurnEnd(2, Date.now()),
  ]));
  await w.poll();

  assert.equal(fired.length, 1, '应触发一次');
  assert.equal(fired[0].turn, 2);
  assert.equal(fired[0].reply, '这一轮的回复');
  assert.equal(w.armed, false, '触发后应自动解除等待');
  w.stop();
});

test('未 arm 时完成新回合不响铃，但会被记为已见', async () => {
  const { dir } = makeSessionDir([evTurnStart(1), evTurnEnd(1, 1000)]);
  const w = new SessionWatcher({ sessionDir: dir, pollMs: 50 });
  const fired = [];
  w.on('reply-completed', (i) => fired.push(i));
  w.start();
  await new Promise((r) => setTimeout(r, 20));

  appendFileSync(w.sessionFile, frameEvents([
    evTurnStart(2), evAssistant(2, 20, '用户自己打字触发的回复'), evTurnEnd(2, Date.now()),
  ]));
  await w.poll();
  assert.equal(fired.length, 0, '不在等待状态不应响铃');

  // 之后 arm 也不该补偿触发（回合已经完成过了）
  w.arm();
  await w.poll();
  assert.equal(fired.length, 0, '已完成的旧回合在 arm 后也不应补响');
  w.stop();
});

test('waitForReply：事件到达即 resolve', async () => {
  const { dir } = makeSessionDir([]);
  const w = new SessionWatcher({ sessionDir: dir, pollMs: 50 });
  w.start();
  const p = w.waitForReply({ timeoutMs: 2000 });
  await new Promise((r) => setTimeout(r, 20));
  appendFileSync(w.sessionFile, frameEvents([
    evTurnStart(1), evAssistant(1, 10, '回复来了'), evTurnEnd(1, Date.now()),
  ]));
  // 轮询由计时器驱动
  const info = await p;
  assert.equal(info.reply, '回复来了');
  w.stop();
});

test('waitForReply：超时抛错并解除等待', async () => {
  const { dir } = makeSessionDir([]);
  const w = new SessionWatcher({ sessionDir: dir, pollMs: 50 });
  await assert.rejects(() => w.waitForReply({ timeoutMs: 80 }), /等待回复超时/);
  assert.equal(w.armed, false);
  w.stop();
});

test('waitForReply：可被 AbortSignal 取消', async () => {
  const { dir } = makeSessionDir([]);
  const w = new SessionWatcher({ sessionDir: dir, pollMs: 50 });
  const ac = new AbortController();
  const p = w.waitForReply({ timeoutMs: 5000, signal: ac.signal });
  ac.abort();
  await assert.rejects(() => p, /已取消等待回复/);
  assert.equal(w.armed, false);
  w.stop();
});

test('会话文件不存在时不崩，只是没有事件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnone-'));
  const w = new SessionWatcher({ sessionDir: dir, pollMs: 50 });
  w.start();
  const r = await w.poll();
  assert.equal(r, null);
  assert.equal(w.stats.completions, 0);
  w.stop();
});

test('文件未变化时跳过重复解压（省 CPU）', async () => {
  const { dir } = makeSessionDir([evTurnStart(1), evTurnEnd(1, 1000)]);
  const w = new SessionWatcher({ sessionDir: dir, pollMs: 10_000 });   // 拉长自动轮询避免抢跑
  w.start();
  await new Promise((r) => setTimeout(r, 50));   // 等 start() 里的首次读取完成
  const before = w.stats.decodes;
  assert.ok(before >= 1, 'start() 应做过一次初始读取');

  await w.poll();
  await w.poll();
  assert.equal(w.stats.decodes, before, '文件未变化不应重复解压');

  // 文件一变就应该重新解压
  appendFileSync(w.sessionFile, frameEvents([evTurnStart(2), evTurnEnd(2, Date.now())]));
  await w.poll();
  assert.equal(w.stats.decodes, before + 1, '文件变化后应重新解压');
  w.stop();
});
