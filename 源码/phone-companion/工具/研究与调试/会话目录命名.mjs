/**
 * 会话目录命名.mjs —— 反推 DSH 把工作区路径编码成会话目录名的规则。
 *
 * 已知样本（实测）：
 *   工作区 D:\work\my project
 *   → 目录 --D-work-my~0020project--
 *
 * 规则（已由本脚本验证）：
 *   · 整体用 "--" 包裹
 *   · 路径分隔符 \ 或 / → "-"
 *   · 空格 → "~0020"（空格的 Unicode 码点 0x20，四位十六进制）
 *   · 盘符的冒号 → 直接丢弃
 *
 * 自检用法（不传参数就用当前项目配置里的工作区）：
 *   node 工具/研究与调试/会话目录命名.mjs "D:\\work\\my project"
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';

const SESSIONS_ROOT = join(os.homedir(), '.dsh', 'sessions');

/** 按猜测规则编码工作区路径 */
export function encodeWorkspace(workspacePath) {
  let s = String(workspacePath ?? '').trim();
  // 去掉盘符冒号
  s = s.replace(/^([A-Za-z]):/, '$1');
  // 统一分隔符并转成 "-"
  s = s.replace(/[\\/]+/g, '-');
  // 去掉首尾多余的 "-"
  s = s.replace(/^-+|-+$/g, '');
  // 空格 → ~0020
  s = s.replace(/ /g, '~0020');
  return `--${s}--`;
}

/** 列出磁盘上实际存在的会话目录，便于对照 */
export function listSessionDirs(root = SESSIONS_ROOT) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** 判断某个编码结果是否真实存在 */
export function resolveSessionRoot(workspacePath, root = SESSIONS_ROOT) {
  const guess = encodeWorkspace(workspacePath);
  const candidate = join(root, guess);
  return { guess, candidate, exists: existsSync(candidate) };
}

// ---------------------------------------------------------------- 自检
// ⚠️ 判断"是不是被直接运行"必须用 pathToFileURL 转换。
//    早先写的是 file://${process.argv[1]}，在 Windows 上永远不成立
//    （路径是 E:\... ，要变成 file:///E:/... 才对），于是自检一直是哑的。
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // 要查的工作区：命令行 > 环境变量 > 项目配置。都不给就只看磁盘上有哪些。
  let workspace = process.argv[2] || process.env.PHONE_WORKSPACE || '';
  if (!workspace) {
    try {
      const cfgPath = join(import.meta.dirname, '..', '..', 'phone.config.json');
      const raw = readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '');
      workspace = JSON.parse(raw)?.workspace ?? '';
    } catch { /* 读不到就算了 */ }
  }

  const dirs = listSessionDirs();

  if (workspace) {
    const r = resolveSessionRoot(workspace);
    console.log('=== 推测结果 ===');
    console.log(`工作区: ${workspace}`);
    console.log(`推测目录名: ${r.guess}`);
    console.log(`磁盘上是否存在: ${r.exists ? '是 ✓' : '否 ✗（工作区没在 DSH 里开过会话，或路径写错了）'}`);
  } else {
    console.log('（没给工作区路径，也没读到配置里的 workspace —— 只列磁盘现状）');
    console.log('用法: node 工具/研究与调试/会话目录命名.mjs "D:\\work\\my project"');
  }

  console.log('\n=== 磁盘上的实际目录（前 10 个）===');
  for (const d of dirs.slice(0, 10)) console.log(`   ${d}`);
  console.log(`   共 ${dirs.length} 个目录`);
}
