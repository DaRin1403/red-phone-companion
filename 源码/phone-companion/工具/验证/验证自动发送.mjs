/**
 * 验证自动发送.mjs —— 验证"注入 + 自动发送"是否真的把消息发出去
 *
 * 判据：注入后输入框里能看到文字；按回车后输入框被清空 = 发送成功。
 *
 * ⚠️ 这个脚本会真的发一条消息到你的对话里（否则无法验证）。消息内容带标记，
 *    便于你一眼看出是测试消息。
 *
 * 用法：node 工具/验证自动发送.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '注入文字.ps1');
const CRLF = '\r\n';

const PS = ['-NoProfile', '-ExecutionPolicy', 'Bypass'];

/** 读当前焦点输入框的值（UTF-8 安全：结果写成 JSON 再由 Node 读，避免控制台编码坑） */
async function readInputValue() {
  const tmp = join(os.tmpdir(), `uia-${Date.now()}.json`);
  const cmd = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$out = @{ ok = $false; value = ''; cls = '' }
try {
  $el = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($el) {
    $out.cls = $el.Current.ClassName
    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($vp) { $out.value = [string]$vp.Current.Value; $out.ok = $true }
  }
} catch { }
$json = $out | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText('${tmp.replace(/\\/g, '\\\\')}', $json, [System.Text.Encoding]::UTF8)
`;
  await execFileP('powershell', [...PS, '-Command', cmd], { windowsHide: true, timeout: 20000 });
  try {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(tmp, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { ok: false, value: '', cls: '' };
  }
}

const MARK = `[座机测试 ${new Date().toTimeString().slice(0, 5)}]`;
const TEXT = `${MARK} 自动发送验证，请忽略这条消息。`;

const checks = [];
const ok = (n, d = '') => checks.push({ p: true, n, d });
const bad = (n, d = '') => checks.push({ p: false, n, d });

console.log('=== 验证「注入 + 自动发送」 ===\n');
console.log(`测试消息: ${TEXT}\n`);

// 0) 先记下输入框原状，避免误判
const before = await readInputValue();
console.log(`[0] 注入前输入框: ok=${before.ok} class=${before.cls} 已有 ${before.value.length} 字`);

// 1) 注入（带 -Submit）
const tmp = join(os.tmpdir(), `send-test-${Date.now()}.txt`);
writeFileSync(tmp, TEXT, 'utf8');
const run = await new Promise((resolve) => {
  execFile('powershell', [...PS, '-File', SCRIPT,
    '-TextFile', tmp, '-TitleMatch', 'DeepSeek Harness|DSH|localhost:3080', '-Submit'],
  { windowsHide: true, timeout: 60000 },
  (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

console.log('\n[1] 注入脚本输出:');
for (const line of String(run.stdout).split(/\r?\n/)) {
  if (line.trim()) console.log(`    ${line.trim()}`);
}
if (String(run.stderr).trim()) console.log(`    stderr: ${String(run.stderr).trim().slice(0, 200)}`);

const out = String(run.stdout);
if (out.includes('pasted')) ok('文字已粘贴');
else bad('文字已粘贴', '输出里没有 pasted');

if (out.includes('input confirmed to contain the text')) {
  ok('粘贴后确认输入框里有我们的文字（说明焦点正确）');
} else if (out.includes('could not confirm the text is in the input')) {
  bad('粘贴后确认输入框里有我们的文字', '读不到输入内容（可能焦点不对）');
} else {
  ok('粘贴后确认（本版无该步骤输出，跳过）');
}

// 发送成功的判据（按新版脚本的输出文案）
if (out.includes('submit confirmed (input no longer holds the text)')) {
  ok('★ 消息已发送（一次回车，输入框随后清空）');
} else if (out.includes('submit confirmed after second attempt')) {
  ok('★ 消息已发送（第二次回车生效）');
} else if (out.includes('input cleared') || out.includes('input no longer readable')) {
  ok('★ 消息已发送');
} else if (out.includes('WARNING: input still contains')) {
  bad('★ 消息没发出去', '输入框里仍留着文字');
} else {
  bad('★ 发送结果未知', out.slice(-300));
}

// 2) 复查输入框（发送成功后应为空，或至少不含我们的标记）
await new Promise((r) => setTimeout(r, 800));
const after = await readInputValue();
console.log(`\n[2] 注入后输入框: ok=${after.ok} class=${after.cls} 内容长度 ${after.value.length}`);
if (after.value.includes(MARK)) {
  bad('★ 输入框里仍残留测试消息', '说明没发出去');
} else {
  ok('★ 输入框已不含测试消息（发送成功或已失焦）');
}

console.log('\n' + '='.repeat(56));
for (const c of checks) console.log(`${c.p ? '✓' : '✗'} ${c.n}${c.d ? `\n    ${c.d}` : ''}`);
const failed = checks.filter((c) => !c.p).length;
console.log(`\n通过 ${checks.length - failed}/${checks.length}`);
console.log(`\n提示：如果你的对话里出现了「${MARK}」开头的消息，说明整条注入链路完全正常。`);

try { (await import('node:fs')).unlinkSync(tmp); } catch { /* 忽略 */ }
process.exit(failed === 0 ? 0 : 1);
