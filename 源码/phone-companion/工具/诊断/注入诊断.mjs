/**
 * 注入诊断.mjs —— 逐步验证"文字注入 DSH 输入框"到底卡在哪一环
 *
 * 背景：注入脚本每次都报成功（pasted N chars / sent ENTER），
 * 但用户看不到文字。需要把每一步都单独验证，找出真正失效的环节。
 *
 * 步骤：
 *   1. 目标窗口能否找到（标题匹配）
 *   2. SetForegroundWindow 之后，前台窗口是否真的是它
 *   3. 剪贴板是否真的写入了我们的文字
 *   4. 粘贴后剪贴板是否还在（用来判断是否被还原/被抢）
 *   5. 输入框是否真的收到了文字（通过 UIA 读焦点控件的值，尽力而为）
 *
 * 用法：node 工具/注入诊断.mjs
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
// 本工具在 工具/诊断/ 下，而脚本在上一级 工具/ —— 重构挪目录时漏了这个 '..'，
// 结果它去 工具/诊断/注入文字.ps1 找，PowerShell 报"无法识别为 cmdlet"。
const SCRIPT = join(HERE, '..', '注入文字.ps1');

const MARK = `【注入诊断-${Date.now().toString(36)}】`;
const TEXT = `${MARK} 这条文字是座机项目注入的测试内容，请忽略。`;

const results = [];
const ok = (n, d = '') => results.push({ p: true, n, d });
const bad = (n, d = '') => results.push({ p: false, n, d });

// ---------------------------------------------------------------- 工具

async function ps(command) {
  const { stdout } = await execFileP('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return stdout.trim();
}

/** 读剪贴板（原始文本） */
async function readClipboard() {
  try {
    return await ps('[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw');
  } catch (e) {
    return `(读取失败: ${e.message})`;
  }
}

/** 当前前台窗口信息 */
async function foregroundInfo() {
  const cmd = `
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class Fgi {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string Info() {
    IntPtr h = GetForegroundWindow();
    var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
    uint pid; GetWindowThreadProcessId(h, out pid);
    string p=""; try { p = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
    return p + "|" + sb.ToString() + "|" + h.ToInt64();
  }
}
'@
[Console]::OutputEncoding=[Text.Encoding]::UTF8
[Fgi]::Info()`;
  try { return await ps(cmd); } catch (e) { return `(失败: ${e.message})`; }
}

// ---------------------------------------------------------------- 开始

console.log('=== 注入链路逐步诊断 ===\n');

// 1) 找到目标窗口
console.log('[1] 查找目标窗口');
const listOut = await ps(`& '${SCRIPT}' -ListWindows -TitleMatch 'DeepSeek Harness|DSH|localhost:3080'`);
const cands = listOut.split('\n').filter((l) => l.includes('<== candidate'));
if (cands.length === 0) {
  bad('找到候选窗口', '没有标题匹配的窗口');
  console.log(listOut.slice(0, 800));
} else {
  ok('找到候选窗口', `${cands.length} 个`);
  for (const c of cands) console.log(`    ${c.trim()}`);
}
const targetLine = cands[0] ?? '';
const handleMatch = /0x([0-9A-Fa-f]+)/.exec(targetLine);
const targetHandle = handleMatch ? handleMatch[1] : null;
console.log(`    目标句柄: ${targetHandle ?? '(无)'}`);

// 2) 注入前的前台窗口
console.log('\n[2] 注入前的前台窗口');
const fgBefore = await foregroundInfo();
console.log(`    ${fgBefore}`);
// 注意：脚本输出的句柄是十六进制（0x000407C6），而 Win32 返回的是十进制字符串（264134），
// 必须统一成十进制再比较，否则会误判（这个假阴性别再犯）。
const targetDec = targetHandle ? String(parseInt(targetHandle, 16)) : null;
const [procBefore, titleBefore, handleBefore] = fgBefore.split('|');
if (targetDec && handleBefore === targetDec) ok('注入前目标已是前台');
else ok('注入前目标不是前台（正常，脚本会切）', `${procBefore} / ${(titleBefore ?? '').slice(0, 50)}`);

// 3) 剪贴板写入测试
console.log('\n[3] 剪贴板写入测试');
const sentinel = `SENTINEL-${Date.now()}`;
await ps(`Set-Clipboard -Value '${sentinel}'`);
const cbAfterSet = await readClipboard();
if (cbAfterSet.includes(sentinel)) ok('能写入剪贴板', sentinel);
else bad('能写入剪贴板', JSON.stringify(cbAfterSet.slice(0, 80)));

// 4) 执行注入（不提交，避免污染对话）
console.log('\n[4] 执行注入（本次不按回车）');
const tmp = join(os.tmpdir(), `inject-diag-${Date.now()}.txt`);
writeFileSync(tmp, TEXT, 'utf8');
const argList = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
  '-TextFile', tmp, '-TitleMatch', 'DeepSeek Harness|DSH|localhost:3080'];
const runOut = await new Promise((resolve) => {
  const child = spawn('powershell', argList, { windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('close', (c) => resolve({ code: c, out, err }));
});
console.log(`    退出码: ${runOut.code}`);
console.log(`    输出: ${runOut.out.trim().replace(/\r?\n/g, ' | ')}`);
if (runOut.err.trim()) console.log(`    stderr: ${runOut.err.trim().slice(0, 300)}`);
if (runOut.code === 0 && runOut.out.includes('pasted')) ok('注入脚本执行完成');
else bad('注入脚本执行完成', `退出码 ${runOut.code}`);

// 5) 注入后的前台窗口
console.log('\n[5] 注入后的前台窗口');
const fgAfter = await foregroundInfo();
console.log(`    ${fgAfter}`);
const handleAfter = fgAfter.split('|')[2];
if (targetDec && handleAfter === targetDec) ok('★ 注入后目标窗口确实在前台');
else bad('★ 注入后目标窗口确实在前台', `实际是: ${fgAfter.split('|')[1]?.slice(0, 60)}`);

// 6) 关键验证：读输入框内容（这才是"文字有没有真的进去"的唯一证据）
//    剪贴板会被脚本还原成原内容，所以不能拿剪贴板当判据。
console.log('\n[6] 读输入框内容（最终判据）');
const uiaCmd = `
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($root) {
    $cls  = $root.Current.ClassName
    $type = $root.Current.ControlType.ProgrammaticName
    $val = ''
    try { $vp = $root.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $val = $vp.Current.Value } catch {}
    Write-Output ("CLASS=$cls|TYPE=$type|VALUE=" + $val)
  } else { Write-Output "NOFOCUS" }
} catch { Write-Output ("UIAERR: " + $_.Exception.Message) }`;
try {
  const uia = await ps(uiaCmd);
  console.log(`    ${uia.slice(0, 300)}`);
  // 用实际注入的文字判定（不是 MARK —— 脚本内部会重新生成时间戳）
  if (uia.includes('注入诊断') && uia.includes('请忽略')) {
    ok('★★ 输入框里确实收到了注入的文字（这就是成功判据）');
  } else if (uia.startsWith('NOFOCUS')) {
    bad('读输入框内容', '拿不到焦点元素');
  } else {
    bad('★★ 输入框里没读到注入的文字', uia.slice(0, 200));
  }
} catch (e) {
  bad('读输入框内容', e.message);
}

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(60));
for (const r of results) console.log(`${r.p ? '✓' : '✗'} ${r.n}${r.d ? `\n    ${r.d}` : ''}`);
const failed = results.filter((r) => !r.p).length;
console.log(`\n通过 ${results.length - failed}/${results.length}`);

try { (await import('node:fs')).unlinkSync(tmp); } catch { /* 忽略 */ }
process.exit(failed === 0 ? 0 : 1);
