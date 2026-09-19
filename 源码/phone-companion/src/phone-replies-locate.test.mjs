/**
 * 回归测试：多标签页场景下"该盯哪个会话文件"。
 *
 * 真实风险：一个工作区下有很多会话，**可能好几份同时在写**（用户开着多个标签页）。
 * 监听器启动时只能按"最后写入时间"挑一个，挑错的后果是盯着别人的会话等回复 ——
 * 表现就是那个查了很多轮的"我回复完电话不响"，而且日志一切正常。
 *
 * 解法：注入之后按"这句话被哪个会话当成用户消息收下了"来定位。
 * 这里锁住三条：
 *   ① 能找到真正收下这句话的会话
 *   ② 只认 user/message —— 撞上工具输出/引用文字**不算**
 *   ③ 换会话时必须清掉已见集合并重新 priming（回合号跨会话没有可比性）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SessionWatcher, findSessionContaining, findSessionAndTurnContaining, parseEvents, decompressSession,
} from './phone-replies.mjs';

const frame = (o) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(o) + '\n', 'utf8'));

const evTurnStart = (t) => ({ type: 'turn/start', seq: t * 1000, data: { turn: t } });
const evAssistant = (t, seq, text) => ({
  type: 'assistant/message', seq, data: { turn: t, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const evTurnEnd = (t, time) => ({
  type: 'turn/end', seq: t * 1000 + 500, time, data: { turn: t, reason: { kind: 'completed' } },
});
/** 用户消息：实测**没有 turn 字段**，所以只能按内容认 */
const evUser = (seq, text) => ({
  type: 'user/message', seq, data: { role: 'user', content: [{ type: 'text', text }] },
});
/** 工具输出：不该被当成"用户说过的话" */
const evToolResult = (t, seq, text) => ({
  type: 'tool/result', seq, data: { turn: t, result: { content: [{ type: 'text', text }] } },
});

/** 造一个会话目录：root/<会话名>/session.jsonl.zstd
 *  ⚠️ 传进来的 events 必须**已经是 frame() 压好的 Buffer**。
 *     早先这里写成 events.map(frame)，等于把帧又压了一遍 ——
 *     文件里存的是 {"type":"Buffer","data":[...]}，解析出来一个用户消息都没有。 */
function makeSessions(defs) {
  const root = mkdtempSync(join(tmpdir(), 'phone-sessions-'));
  for (const [name, frames] of Object.entries(defs)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.jsonl.zstd'), Buffer.concat(frames));
  }
  return root;
}

// ---------------------------------------------------------------- 按内容定位

test('parseEvents 会单独收集用户消息（它们没有 turn 字段）', () => {
  const buf = Buffer.concat([
    frame(evTurnStart(1)),
    frame(evUser(10, '帮我查一下明天嘉兴的天气')),
    frame(evAssistant(1, 20, '好的')),
    frame(evTurnEnd(1, Date.now())),
  ]);
  const { turns, userTexts } = parseEvents(decompressSession(buf).text);
  assert.equal(turns.length, 1);
  assert.deepEqual(userTexts, ['帮我查一下明天嘉兴的天气']);
});

test('能找到真正收下这句话的会话（两个会话同时在写也不会认错）', () => {
  const root = makeSessions({
    'session-aaa': [
      frame(evTurnStart(1)), frame(evUser(10, '帮我查一下明天嘉兴的天气')),
      frame(evAssistant(1, 20, '好的')), frame(evTurnEnd(1, Date.now())),
    ],
    'session-bbb': [
      frame(evTurnStart(1)), frame(evUser(10, '把今天的拍摄计划整理一下')),
      frame(evAssistant(1, 20, '整理好了')), frame(evTurnEnd(1, Date.now())),
    ],
  });

  assert.match(findSessionContaining(root, '帮我查一下明天嘉兴的天气'), /session-aaa/);
  assert.match(findSessionContaining(root, '把今天的拍摄计划整理一下'), /session-bbb/);
});

test('只认用户消息：文本只出现在工具输出里时不算命中', () => {
  const root = makeSessions({
    'session-aaa': [
      frame(evTurnStart(1)),
      // 这句话出现在工具输出里（比如脚本回显、引用别人的话），但没人把它当消息说过
      frame(evToolResult(1, 15, '屏幕上打印了：把今天的拍摄计划整理一下')),
      frame(evAssistant(1, 20, '好的')), frame(evTurnEnd(1, Date.now())),
    ],
  });

  assert.equal(
    findSessionContaining(root, '把今天的拍摄计划整理一下'),
    null,
    '工具输出里出现过不算 —— 否则会盯着一个根本不是目标会话的文件',
  );
});

test('句子末尾被清洗/有细微差异时，靠前缀也能命中', () => {
  const root = makeSessions({
    'session-aaa': [
      frame(evTurnStart(1)), frame(evUser(10, '帮我查一下明天嘉兴的天气怎么样')),
      frame(evAssistant(1, 20, '好的')), frame(evTurnEnd(1, Date.now())),
    ],
  });
  assert.match(findSessionContaining(root, '帮我查一下明天嘉兴的天气'), /session-aaa/);
});

test('空文本、不存在的目录、找不到都不抛异常', () => {
  const root = makeSessions({ 'session-aaa': [frame(evUser(10, '你好'))] });
  assert.equal(findSessionContaining(root, ''), null);
  assert.equal(findSessionContaining(root, '   '), null);
  assert.equal(findSessionContaining(root, null), null);
  assert.equal(findSessionContaining(join(tmpdir(), '根本不存在的目录-xyz'), '你好'), null);
  assert.equal(findSessionContaining(root, '这句话谁都没说过'), null);
});

test('传进来的就是单个会话目录时也能查', () => {
  const root = makeSessions({ 'session-aaa': [frame(evUser(10, '你好呀'))] });
  assert.match(findSessionContaining(join(root, 'session-aaa'), '你好呀'), /session-aaa/);
  assert.equal(findSessionContaining(join(root, 'session-aaa'), '没说过的话'), null);
});

test('按内容定位要取"最后一次出现"：短文本极容易和旧消息撞上', () => {
  // 真机踩过：注入的是「我。」，而更早那条消息里也含「我。」——
  // 从头往后找就锁到了旧回合，等待回合号彻底错位。
  const root = makeSessions({
    'session-aaa': [
      frame(evTurnStart(10)), frame(evUser(1, '测试测试123我。23喂喂喂')),
      frame(evAssistant(10, 2, '旧回复')), frame(evTurnEnd(10, Date.now() - 60_000)),
      frame(evTurnStart(11)), frame(evUser(3, '我。')),
      frame(evAssistant(11, 4, '新回复')),
    ],
  });

  const r = findSessionAndTurnContaining(root, '我。');
  assert.ok(r, '应当找得到');
  assert.equal(
    r.turn, 11,
    '必须锁到最新那条（第 11 轮），不能被更早消息里的「我。」骗到第 10 轮',
  );
});

// ---------------------------------------------------------------- 锁定等待回合

test('锁定等待回合：我还没回复完时用户又说话了，等待不能被"正在生成的那条回复"消耗掉', async () => {
  // 真机场景：用户在我生成回复的过程中又对着座机说了一句。
  //   提交 → arm()；紧接着**上一条还在生成的回复**完成了 →
  //   旧逻辑会把这次等待消耗掉、提前响铃，而真正属于用户的那一轮完成时反而不会响。
  const file = 'session-bbb';
  const turnStart = (t) => frame(evTurnStart(t));
  const userMsg = (seq, t, text) => frame(evUser(seq, text));

  const build = ({ complete41, complete42 }) => Buffer.concat([
    turnStart(40), frame(evUser(1, 40, '更早的一句')), frame(evAssistant(40, 2, '旧回复')), frame(evTurnEnd(40, Date.now() - 120_000)),
    turnStart(41), frame(evUser(3, 41, '我上一条消息')), frame(evAssistant(41, 4, '正在生成的那条')),
    ...(complete41 ? [frame(evTurnEnd(41, Date.now() - 1000))] : []),
    turnStart(42), userMsg(5, 42, '电话里新说的那句'), frame(evAssistant(42, 6, '回答新问题')),
    ...(complete42 ? [frame(evTurnEnd(42, Date.now() + 1000))] : []),
  ]);

  const root = makeSessions({ [file]: [build({ complete41: false, complete42: false })] });
  const target = join(root, file, 'session.jsonl.zstd');

  const watcher = new SessionWatcher({ sessionDir: root, sessionFile: target, pollMs: 50 });
  const fired = [];
  watcher.on('reply-completed', (i) => fired.push(i));
  const logs = [];
  watcher.on('log', (l) => logs.push(l.msg));
  await watcher.poll();

  watcher.arm();
  watcher.followText('电话里新说的那句');
  await watcher.poll();

  assert.ok(logs.some((m) => m.includes('锁定等待回合') && m.includes('42')),
    '应明确锁定到第 42 轮（那句电话里说的话所在回合）');

  // 上一条（第 41 轮）完成了 —— 这不是我们要等的
  writeFileSync(target, build({ complete41: true, complete42: false }));
  await watcher.poll();
  assert.equal(fired.length, 0, '第 41 轮完成不该响铃 —— 那不是用户刚说的那句话');
  assert.equal(watcher.armed, true, '等待必须保留，不能被我自己的上一条回复消耗掉');

  // 真正要等的那一轮完成了
  writeFileSync(target, build({ complete41: true, complete42: true }));
  await watcher.poll();
  watcher.stop();

  assert.equal(fired.length, 1, '轮到第 42 轮完成时必须响铃');
  assert.equal(fired[0].turn, 42);
});

test('没锁定回合时（找不到注入的文字）退回旧行为：下一个完成的回合就响', async () => {
  const root = makeSessions({
    'session-aaa': [
      frame(evTurnStart(1)), frame(evUser(10, '别的会话')),
      frame(evAssistant(1, 20, 'x')), frame(evTurnEnd(1, Date.now())),
      frame(evTurnStart(2)), frame(evAssistant(2, 30, 'y')),
    ],
  });
  const target = join(root, 'session-aaa', 'session.jsonl.zstd');
  const watcher = new SessionWatcher({ sessionDir: root, sessionFile: target, pollMs: 50 });
  const fired = [];
  watcher.on('reply-completed', (i) => fired.push(i));
  await watcher.poll();

  watcher.arm();
  watcher.followText('这句话哪都没有');       // 定位不到 → 不锁定回合
  await watcher.poll();

  writeFileSync(target, Buffer.concat([
    frame(evTurnStart(1)), frame(evUser(10, '别的会话')), frame(evAssistant(1, 20, 'x')), frame(evTurnEnd(1, Date.now() - 60_000)),
    frame(evTurnStart(2)), frame(evAssistant(2, 30, 'y')), frame(evTurnEnd(2, Date.now() + 1000)),
  ]));
  await watcher.poll();
  watcher.stop();

  assert.equal(fired.length, 1, '定位不到时不能卡死，仍应响铃');
  assert.equal(fired[0].turn, 2);
});

test('followText → 轮询时切到正确会话，并清空已见集合重新 priming', async () => {
  const root = makeSessions({
    'session-aaa': [
      frame(evTurnStart(1)), frame(evUser(10, '别的会话的话')),
      frame(evAssistant(1, 20, '回复')), frame(evTurnEnd(1, Date.now())),
    ],
    'session-bbb': [
      frame(evTurnStart(1)), frame(evUser(10, '帮我查天气')),
      frame(evAssistant(1, 20, '回复')), frame(evTurnEnd(1, Date.now())),
      frame(evTurnStart(2)), frame(evUser(30, '电话里说的那句')),
      // 回合 2 故意不给 turn/end —— 表示"正在进行、尚未完成"
    ],
  });

  const watcher = new SessionWatcher({ sessionDir: root, sessionFile: join(root, 'session-aaa', 'session.jsonl.zstd'), pollMs: 50 });
  const logs = [];
  watcher.on('log', (l) => logs.push(l.msg));
  await watcher.poll();                                  // priming：aaa 的回合 1 已见
  assert.equal(watcher.sessionFile.includes('session-aaa'), true);

  watcher.arm();
  watcher.followText('电话里说的那句');
  await watcher.poll();                                  // 应切到 bbb

  assert.equal(watcher.sessionFile.includes('session-bbb'), true, '应切到真正收下这句话的会话');
  assert.ok(logs.some((m) => m.includes('重新定位会话')), '切换要有日志，否则又变成"静默盯错会话"');
  assert.ok(watcher.stats.relocates >= 1);

  // 切换后必须重新 priming：bbb 里回合 1 已完成 → 已见；回合 2 未完成 → 未标记
  const fired = [];
  watcher.on('reply-completed', (i) => fired.push(i));
  writeFileSync(
    join(root, 'session-bbb', 'session.jsonl.zstd'),
    Buffer.concat([
      frame(evTurnStart(1)), frame(evUser(10, '帮我查天气')),
      frame(evAssistant(1, 20, '回复')), frame(evTurnEnd(1, Date.now() - 60_000)),
      frame(evTurnStart(2)), frame(evUser(30, '电话里说的那句')),
      frame(evAssistant(2, 40, '我说完了')), frame(evTurnEnd(2, Date.now() + 1000)),
    ]),
  );
  await watcher.poll();

  watcher.stop();
  assert.equal(fired.length, 1, '切会话后，那个未完成的回合真正完成时必须被检测到');
  assert.equal(fired[0].turn, 2);
});
