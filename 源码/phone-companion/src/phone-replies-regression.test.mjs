/**
 * 回归测试：监听器启动时"正在进行、尚未完成"的回合，
 * 在它真正完成后必须能被检测到。
 *
 * 真实踩过的坑：start() 曾无差别地把**所有**回合都标记为"已见"，
 * 包括那个还没完成的当前回合。等它真正完成时被当成"见过了"跳过，
 * 于是永远检测不到 → 表现为"我回复完电话不响"。
 *
 * 离线测试之所以漏掉它：测试造的会话文件里事件都是完整的，
 * 不存在"启动时正处于半截"的状态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionWatcher } from './phone-replies.mjs';

const frame = (o) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(o) + '\n', 'utf8'));
const evTurnStart = (t) => ({ type: 'turn/start', seq: t * 1000, data: { turn: t } });
const evAssistant = (t, seq, text) => ({
  type: 'assistant/message', seq, data: { turn: t, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const evTurnEnd = (t, time) => ({
  type: 'turn/end', seq: t * 1000 + 500, time, data: { turn: t, reason: { kind: 'completed' } },
});

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('启动时未完成的回合，完成后必须被检测到（真机踩过的 bug）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ring-regress-'));
  const sessionFile = join(dir, 'session.jsonl.zstd');

  // 造一个"历史已完成回合 + 一个正在进行中的回合" —— 正是服务启动时的真实状态
  writeFileSync(sessionFile, Buffer.concat([
    frame(evTurnStart(1)), frame(evAssistant(1, 1100, '历史回复')), frame(evTurnEnd(1, 1000)),
    frame(evTurnStart(2)), frame(evAssistant(2, 2100, '正在进行中…')),   // 注意：没有 turn/end
  ]));

  const w = new SessionWatcher({ sessionDir: dir, pollMs: 30, autoResolve: false, sessionFile });
  const fired = [];
  w.on('reply-completed', (i) => fired.push(i));
  let readyInfo = null;
  w.on('ready', (i) => { readyInfo = i; });
  w.start();
  await settle(80);

  assert.ok(readyInfo, '应触发 ready 事件');
  assert.equal(readyInfo.turns, 2, '应解析出两个回合');
  assert.equal(readyInfo.completed, 1, '只有一个回合是已完成的');
  assert.equal(readyInfo.seen, 1, '★ 只能把已完成的那一个标记为已见（未完成的不能标记）');

  // 现在让第 2 个回合真正完成
  w.arm();
  appendFileSync(sessionFile, frame(evTurnEnd(2, Date.now())));
  await settle(200);

  assert.equal(fired.length, 1, '★ 启动时就在进行的那个回合，完成后必须被检测到');
  assert.equal(fired[0].turn, 2);
  assert.equal(fired[0].reply, '正在进行中…');
  w.stop();
});

test('实例级：两个监听器互不干扰（会话切换场景）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ring-two-'));
  const fileA = join(dir, 'a.jsonl.zstd');
  const fileB = join(dir, 'b.jsonl.zstd');
  writeFileSync(fileA, Buffer.concat([frame(evTurnStart(1)), frame(evTurnEnd(1, 1000))]));
  writeFileSync(fileB, Buffer.concat([frame(evTurnStart(1)), frame(evTurnEnd(1, 1000))]));

  const wA = new SessionWatcher({ sessionDir: dir, pollMs: 30, autoResolve: false, sessionFile: fileA });
  const wB = new SessionWatcher({ sessionDir: dir, pollMs: 30, autoResolve: false, sessionFile: fileB });
  const firedA = [];
  const firedB = [];
  wA.on('reply-completed', (i) => firedA.push(i));
  wB.on('reply-completed', (i) => firedB.push(i));
  wA.start(); wB.start();
  await settle(60);
  wA.arm(); wB.arm();

  // 只有 A 有新完成
  appendFileSync(fileA, Buffer.concat([frame(evTurnStart(2)), frame(evTurnEnd(2, Date.now()))]));
  await settle(200);

  assert.equal(firedA.length, 1, 'A 应检测到');
  assert.equal(firedB.length, 0, '★ B 不该被 A 的事件影响（seen 集合必须是实例级的）');
  wA.stop(); wB.stop();
});
