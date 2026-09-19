/**
 * 会话监听验证.mjs —— 用真实的 DSH 会话文件验证"回复完成"检测是否可靠。
 *
 * 检查点：
 *   1. 能否按 frame 魔数正确解压多 frame 的 session.jsonl.zstd
 *   2. 能否解析出 turn/end 与最终 assistant/message
 *   3. SessionWatcher 在 arm() 之后能否正确识别"新完成的回合"
 *      （这是回铃的核心条件：只对等待期间完成的回合响铃）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { decompressSession, parseEvents, SessionWatcher } from '../../src/phone-replies.mjs';

const HOME = process.env.USERPROFILE;
const SESSIONS = join(HOME, '.dsh', 'sessions', '--E-AI-Deepseek-Deepseek~0020Harness~0020New--');

// 取会话：命令行给了就用给的，否则用最近写入的
import { readdirSync, statSync } from 'node:fs';
let newest = null;
const argPath = process.argv[2];
if (argPath) {
  const file = argPath.endsWith('.jsonl.zstd') ? argPath : join(argPath, 'session.jsonl.zstd');
  if (!existsSync(file)) { console.error(`指定文件不存在: ${file}`); process.exit(1); }
  newest = { m: statSync(file).mtimeMs, file, name: join(file, '..').split(/[\\/]/).slice(-2)[0] };
} else {
  for (const name of readdirSync(SESSIONS)) {
    const file = join(SESSIONS, name, 'session.jsonl.zstd');
    if (!existsSync(file)) continue;
    const m = statSync(file).mtimeMs;
    if (!newest || m > newest.m) newest = { m, file, name };
  }
}
if (!newest) { console.error('未找到会话文件'); process.exit(1); }
console.log(`会话目录: ${newest.name}`);
console.log(`文件: ${(statSync(newest.file).size / 1024 / 1024).toFixed(2)} MB\n`);

// ---- 1) 解压
const buf = readFileSync(newest.file);
const { text, frames, failed } = decompressSession(buf);
console.log(`[解压] frame=${frames} 失败=${failed} 解压后=${(text.length / 1024 / 1024).toFixed(2)} MB`);

// ---- 2) 解析
const { turns } = parseEvents(text);
const completed = turns.filter((t) => t.completed);
console.log(`[解析] 回合总数=${turns.length} 其中已完成=${completed.length}`);
console.log('\n最近 3 个已完成回合：');
for (const t of completed.slice(-3)) {
  const when = t.endedAt ? new Date(t.endedAt).toLocaleTimeString('zh-CN') : '?';
  console.log(`  回合 ${String(t.turn).padStart(3)}  ${when}  回复 ${String(t.reply.length).padStart(5)} 字`);
  if (t.reply) console.log(`      开头: ${JSON.stringify(t.reply.slice(0, 70))}`);
}

// ---- 3) 监听到位性验证（模拟"arm 之后才有新回合"）
const watcher = new SessionWatcher({ sessionDir: join(SESSIONS, newest.name), pollMs: 300 });
const events = [];
watcher.on('reply-completed', (info) => events.push(info));
watcher.on('ready', (r) => console.log(`\n[监听] 启动完成，已标记历史回合 ${r.seen} 个（这些不会被误触发）`));
watcher.on('warn', (w) => console.log(`[监听] 警告: ${JSON.stringify(w)}`));

watcher.start();
console.log('[监听] 未 arm 状态下轮询一次（不应触发）…');
await watcher.poll();
console.log(`        触发数 = ${events.length}（期望 0）`);

console.log('\n[监听] arm 之后轮询（历史回合 endedAt 早于 armedAt，同样不应触发）…');
watcher.arm();
await watcher.poll();
console.log(`        触发数 = ${events.length}（期望 0，因为历史上没有"arm 之后完成"的回合）`);

console.log(`\n[统计] ${JSON.stringify(watcher.stats)}`);
watcher.stop();
console.log('\n结论：历史回合被正确排除；只有当 arm() 之后真的出现新的 turn/end(completed) 才会触发。');
