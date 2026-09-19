/**
 * phone-inject.mjs —— 把识别出的文字送进 DSH 输入框并提交
 *
 * 实际动作委托给 工具/注入文字.ps1（Win32 窗口聚焦 + 剪贴板粘贴 + 回车），
 * 因为 Node 没有可靠的"找窗口并聚焦"能力。本模块负责：
 *   · 组装命令行参数（并把文字安全地传进去）
 *   · 解析脚本输出、区分失败原因（找不到窗口 / 聚焦失败 / 粘贴失败）
 *   · 超时与重试
 *
 * 注意：**文字通过临时文件传递**，不走命令行参数。
 * 原因：识别结果可能很长、含引号/换行/特殊字符，走 argv 会被 PowerShell
 * 的引用规则和命令长度上限坑到。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCRIPT = join(HERE, '..', '工具', '注入文字.ps1');

/** 默认标题匹配：DSH 网页在浏览器里的标题特征 */
export const DEFAULT_TITLE_MATCH = 'DeepSeek Harness|DSH|localhost:3080|127\\.0\\.0\\.1:3080';

/**
 * 组装 PowerShell 命令行（导出便于单测）。
 * @param {object} o
 * @param {string} o.script
 * @param {string} o.textFile  含注入文字的临时文件路径
 * @param {boolean} o.submit
 * @param {string} o.titleMatch
 * @param {boolean} o.listWindows
 */
export function buildArgs({ script, textFile = null, submit = true, titleMatch = DEFAULT_TITLE_MATCH, listWindows = false }) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  if (listWindows) {
    args.push('-ListWindows', '-TitleMatch', titleMatch);
    return args;
  }
  // 用 -Text 传一个占位，真实内容由 -TextFile 覆盖（脚本读取文件内容）
  args.push('-TextFile', textFile, '-TitleMatch', titleMatch);
  if (submit) args.push('-Submit');
  return args;
}

/**
 * 解析脚本输出，判断成败。
 * @returns {{ok: boolean, reason?: string, detail?: string}}
 */
export function parseResult({ code, stdout, stderr }) {
  const out = `${stdout ?? ''}`;
  const err = `${stderr ?? ''}`;
  if (code === 0) {
    if (out.includes('pasted')) {
      return { ok: true, submitted: out.includes('sent ENTER'), detail: out.trim() };
    }
    return { ok: true, submitted: false, detail: out.trim() };
  }
  if (code === 2 || /No window title matched/.test(err)) {
    return { ok: false, reason: 'window-not-found', detail: err.trim() || out.trim() };
  }
  if (code === 3 || /Could not bring/.test(err)) {
    return { ok: false, reason: 'focus-failed', detail: err.trim() || out.trim() };
  }
  if (code === 1) {
    return { ok: false, reason: 'empty-text', detail: err.trim() || out.trim() };
  }
  return { ok: false, reason: 'unknown', detail: (err || out).trim().slice(0, 400) };
}

/**
 * 解析 -ListWindows 的输出，返回候选窗口列表。
 */
export function parseWindowList(stdout) {
  const windows = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const m = /^0x([0-9A-Fa-f]+)\s+(\S+)\s+(.*?)(\s+<== candidate)?\s*$/.exec(line.trim());
    if (!m) continue;
    windows.push({
      handle: `0x${m[1].toUpperCase()}`,
      process: m[2],
      title: m[3].trim(),
      candidate: Boolean(m[4]),
    });
  }
  return windows;
}

export class DshInjector {
  /**
   * @param {object} opts
   * @param {string} [opts.script]     注入脚本路径
   * @param {string} [opts.titleMatch] 目标窗口标题匹配
   * @param {number} [opts.timeoutMs]
   * @param {Function} [opts.run]      自定义执行器（测试用），签名 (args) => {code, stdout, stderr}
   * @param {number} [opts.retries]
   */
  constructor({
    script = DEFAULT_SCRIPT,
    titleMatch = DEFAULT_TITLE_MATCH,
    timeoutMs = 15000,
    run = null,
    retries = 1,
  } = {}) {
    this.script = script;
    this.titleMatch = titleMatch;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this._run = run ?? this._spawnRun.bind(this);
    this.stats = { attempts: 0, ok: 0, failed: 0, lastError: null };
  }

  _spawnRun(args) {
    return new Promise((resolve) => {
      const ps = spawn('powershell', args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { ps.kill(); } catch { /* 忽略 */ }
      }, this.timeoutMs);
      ps.stdout.on('data', (d) => { stdout += d.toString(); });
      ps.stderr.on('data', (d) => { stderr += d.toString(); });
      ps.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
      ps.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err?.message ?? err) }); });
    });
  }

  /** 列出可见窗口，找出候选（用于排查"为什么没找到 DSH 窗口"） */
  async listWindows() {
    const res = await this._run(buildArgs({ script: this.script, listWindows: true, titleMatch: this.titleMatch }));
    return { ...res, windows: parseWindowList(res.stdout) };
  }

  /**
   * 把文字送进 DSH。文字经临时文件传递，规避 argv 引号/长度问题。
   * @param {string} text
   * @returns {Promise<{ok:boolean, reason?:string, detail?:string}>}
   */
  async submit(text) {
    const content = String(text ?? '');
    if (!content.trim()) return { ok: false, reason: 'empty-text' };

    let last = null;
    for (let attempt = 1; attempt <= Math.max(1, this.retries); attempt++) {
      this.stats.attempts += 1;
      const tmp = join(process.env.TEMP ?? '/tmp', `phone-inject-${randomUUID()}.txt`);
      try {
        writeFileSync(tmp, content, 'utf8');
        const res = await this._run(buildArgs({
          script: this.script, textFile: tmp, submit: true, titleMatch: this.titleMatch,
        }));
        last = parseResult(res);
        if (last.ok) {
          this.stats.ok += 1;
          return last;
        }
        this.stats.lastError = `${last.reason}: ${last.detail ?? ''}`.slice(0, 300);
      } finally {
        try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* 忽略 */ }
      }
      if (attempt < this.retries) await new Promise((r) => setTimeout(r, 300));
    }
    this.stats.failed += 1;
    return last ?? { ok: false, reason: 'unknown' };
  }
}
