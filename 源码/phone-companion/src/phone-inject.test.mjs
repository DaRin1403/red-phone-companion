/**
 * phone-inject.test.mjs —— DSH 文字注入器测试
 *
 * 单测覆盖命令组装与输出解析（不真的操作系统窗口）；
 * 另有一条**真实脚本干跑**测试，验证 PowerShell 侧参数与窗口查找确实工作。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildArgs, parseResult, parseWindowList, DshInjector, DEFAULT_SCRIPT,
} from './phone-inject.mjs';

// ---------------------------------------------------------------- 命令组装

test('buildArgs：注入模式带上 TextFile / Submit / TitleMatch', () => {
  const args = buildArgs({ script: 'S.ps1', textFile: 'C:\\t.txt', submit: true, titleMatch: 'DSH' });
  assert.deepEqual(args, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'S.ps1',
    '-TextFile', 'C:\\t.txt', '-TitleMatch', 'DSH', '-Submit',
  ]);
});

test('buildArgs：不提交时没有 -Submit', () => {
  const args = buildArgs({ script: 'S.ps1', textFile: 'x', submit: false, titleMatch: 'DSH' });
  assert.ok(!args.includes('-Submit'));
});

test('buildArgs：列窗口模式', () => {
  const args = buildArgs({ script: 'S.ps1', listWindows: true, titleMatch: 'DSH' });
  assert.ok(args.includes('-ListWindows'));
  assert.ok(!args.includes('-TextFile'));
});

// ---------------------------------------------------------------- 输出解析

test('parseResult：成功（含提交）', () => {
  const r = parseResult({ code: 0, stdout: 'target: [msedge] title\npasted 12 chars\nsent ENTER\n', stderr: '' });
  assert.equal(r.ok, true);
  assert.equal(r.submitted, true);
});

test('parseResult：成功但没提交', () => {
  const r = parseResult({ code: 0, stdout: 'pasted 3 chars\n', stderr: '' });
  assert.equal(r.ok, true);
  assert.equal(r.submitted, false);
});

test('parseResult：找不到窗口 → window-not-found', () => {
  const r = parseResult({ code: 2, stdout: '', stderr: 'No window title matched X' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'window-not-found');
});

test('parseResult：聚焦失败 → focus-failed', () => {
  const r = parseResult({ code: 3, stdout: '', stderr: 'Could not bring the target window to the foreground.' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'focus-failed');
});

test('parseResult：空文字 → empty-text', () => {
  const r = parseResult({ code: 1, stdout: '', stderr: 'No text to inject' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty-text');
});

test('parseResult：未知失败不吞掉，保留细节', () => {
  const r = parseResult({ code: 99, stdout: 'boom', stderr: 'something odd' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown');
  assert.ok(r.detail.includes('something odd'));
});

// ---------------------------------------------------------------- 窗口列表解析

test('parseWindowList：解析句柄/进程/标题/候选标记', () => {
  const stdout = [
    '=== visible top-level windows ===',
    '0x000609F4  msedge   座机接入微信语音输入 — DeepSeek Harness 和另外 30 个页面 <== candidate',
    '0x00110E60  Weixin   微信',
  ].join('\n');
  const wins = parseWindowList(stdout);
  assert.equal(wins.length, 2);
  assert.equal(wins[0].handle, '0x000609F4');
  assert.equal(wins[0].process, 'msedge');
  assert.equal(wins[0].candidate, true);
  assert.match(wins[0].title, /DeepSeek Harness/);
  assert.equal(wins[1].candidate, false);
  assert.equal(wins[1].title, '微信');
});

test('parseWindowList：忽略表头与空行', () => {
  assert.deepEqual(parseWindowList('=== x ===\n\n'), []);
  assert.deepEqual(parseWindowList(''), []);
});

// ---------------------------------------------------------------- 注入器

test('DshInjector：空文字直接拒绝，不启动任何进程', async () => {
  let called = false;
  const inj = new DshInjector({ run: async () => { called = true; return { code: 0, stdout: '', stderr: '' }; } });
  const r = await inj.submit('   ');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty-text');
  assert.equal(called, false, '不应执行外部命令');
});

test('DshInjector：文字经临时文件传递，且用完即删', async () => {
  const seen = [];
  const inj = new DshInjector({
    run: async (args) => {
      const i = args.indexOf('-TextFile');
      const file = args[i + 1];
      seen.push({ file, exists: existsSync(file), content: null });
      // 读一下内容，确认文字确实写进去了
      const { readFileSync } = await import('node:fs');
      seen[seen.length - 1].content = readFileSync(file, 'utf8');
      return { code: 0, stdout: 'pasted 5 chars\nsent ENTER\n', stderr: '' };
    },
  });
  const r = await inj.submit('帮我查天气');
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].exists, true);
  assert.equal(seen[0].content, '帮我查天气', '临时文件应含 UTF-8 原文');
  assert.equal(existsSync(seen[0].file), false, '临时文件应被清理');
});

test('DshInjector：失败后按 retries 重试，次数正确', async () => {
  let n = 0;
  const inj = new DshInjector({
    retries: 3,
    run: async () => { n += 1; return { code: 2, stdout: '', stderr: 'No window title matched' }; },
  });
  const r = await inj.submit('x');
  assert.equal(r.ok, false);
  assert.equal(n, 3, '应重试到上限');
  assert.equal(inj.stats.failed, 1);
});

test('DshInjector：首次失败第二次成功则算成功', async () => {
  let n = 0;
  const inj = new DshInjector({
    retries: 2,
    run: async () => {
      n += 1;
      return n === 1
        ? { code: 2, stdout: '', stderr: 'No window title matched' }
        : { code: 0, stdout: 'pasted 1 chars\nsent ENTER\n', stderr: '' };
    },
  });
  const r = await inj.submit('x');
  assert.equal(r.ok, true);
  assert.equal(inj.stats.ok, 1);
  assert.equal(inj.stats.failed, 0);
});

test('DshInjector：含引号与换行的文字也能安全传递', async () => {
  const tricky = '他说："明天下午三点"，然后\n换行了\'单引号\'也在';
  let got = null;
  const inj = new DshInjector({
    run: async (args) => {
      const { readFileSync } = await import('node:fs');
      got = readFileSync(args[args.indexOf('-TextFile') + 1], 'utf8');
      return { code: 0, stdout: 'pasted\nsent ENTER\n', stderr: '' };
    },
  });
  const r = await inj.submit(tricky);
  assert.equal(r.ok, true);
  assert.equal(got, tricky, '特殊字符应原样传递，不受 argv 转义影响');
});

// ---------------------------------------------------------------- 真实脚本

test('真实脚本：-ListWindows 能跑通并返回窗口列表', async () => {
  if (!existsSync(DEFAULT_SCRIPT)) {
    assert.fail(`注入脚本不存在: ${DEFAULT_SCRIPT}`);
  }
  const inj = new DshInjector({ timeoutMs: 60000 });
  const res = await inj.listWindows();
  assert.equal(res.code, 0, `脚本退出码应为 0，实际 ${res.code}；stderr=${res.stderr}`);
  assert.ok(res.windows.length > 0, '应至少枚举到一个可见窗口');
  // 标题匹配用默认值时，本机通常能找到 DSH 页面；找不到也不算错（用户可能关掉了）
  const candidates = res.windows.filter((w) => w.candidate);
  console.log(`    枚举到 ${res.windows.length} 个窗口，其中候选 ${candidates.length} 个`);
  for (const c of candidates.slice(0, 3)) console.log(`      候选: [${c.process}] ${c.title.slice(0, 60)}`);
});

test('真实脚本：对不存在的窗口标题匹配应返回 window-not-found', async () => {
  const inj = new DshInjector({ titleMatch: 'NoSuchWindow_zzz_12345', timeoutMs: 60000, retries: 1 });
  const r = await inj.submit('测试');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'window-not-found');
});
