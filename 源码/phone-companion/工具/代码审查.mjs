/**
 * 代码审查.mjs —— 静态检查项目的常见问题
 *
 * 检查项：
 *   1. 未使用的 import
 *   2. 空的 catch 块（可能吞掉错误）
 *   3. 可疑的 TODO/FIXME/XXX
 *   4. 硬编码的绝对路径（应走配置）
 *   5. 代码规模统计
 *
 * 用法：node 工具/代码审查.mjs
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'src');
const TOOLS = join(ROOT, '工具');

const issues = [];
const add = (kind, file, detail) => issues.push({ kind, file, detail });

function listFiles(dir, ext = '.mjs', recurse = true) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (recurse) out.push(...listFiles(p, ext, recurse)); }
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- 1) 未使用的 import

const importRe = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g;

for (const file of [...listFiles(SRC), ...listFiles(TOOLS)]) {
  const src = readFileSync(file, 'utf8');
  const rel = file.replace(ROOT + '\\', '');

  // 收集 import 的名字
  const names = [];
  for (const m of src.matchAll(importRe)) {
    for (const raw of m[1].split(',')) {
      const n = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.push(n);
    }
  }
  // 去掉 import 语句后的正文
  const body = src.replace(importRe, '');
  for (const n of names) {
    const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (!re.test(body)) add('未使用的 import', rel, n);
  }

  // ---------------------------------------------------------------- 2) 空 catch
  const emptyCatch = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
  const ec = [...src.matchAll(emptyCatch)].length;
  if (ec > 0) add('空的 catch（可能吞错误）', rel, `${ec} 处`);

  // ---------------------------------------------------------------- 3) TODO
  for (const m of src.matchAll(/\/\/\s*(TODO|FIXME|XXX|HACK)\b(.*)/g)) {
    add(`${m[1]} 标记`, rel, m[2].trim().slice(0, 60));
  }

  // ---------------------------------------------------------------- 4) 硬编码绝对路径
  for (const m of src.matchAll(/['"]([A-Z]:\\\\[^'"]{3,}|[A-Z]:\\[^'"]{3,})['"]/g)) {
    const p = m[1];
    if (p.includes('System32') || p.includes('Windows')) continue;
    add('硬编码绝对路径', rel, p.slice(0, 55));
  }
}

// ---------------------------------------------------------------- 汇总

console.log('=== 代码审查结果 ===\n');

const byKind = {};
for (const i of issues) (byKind[i.kind] ??= []).push(i);

for (const [kind, list] of Object.entries(byKind)) {
  console.log(`【${kind}】${list.length} 处`);
  for (const i of list.slice(0, 12)) console.log(`   ${i.file}  ${i.detail}`);
  if (list.length > 12) console.log(`   … 还有 ${list.length - 12} 处`);
  console.log('');
}

if (issues.length === 0) console.log('未发现问题。');

// ---------------------------------------------------------------- 规模

function countLines(files) {
  return files.reduce((a, f) => a + readFileSync(f, 'utf8').split('\n').length, 0);
}
const srcFiles = listFiles(SRC).filter((f) => !f.includes('.test.'));
const testFiles = listFiles(SRC).filter((f) => f.includes('.test.'));
console.log('=== 代码规模 ===');
console.log(`  功能代码: ${srcFiles.length} 个文件，${countLines(srcFiles)} 行`);
console.log(`  测试代码: ${testFiles.length} 个文件，${countLines(testFiles)} 行`);
console.log(`  工具脚本: ${listFiles(TOOLS).length} 个文件，${countLines(listFiles(TOOLS))} 行`);
console.log(`  测试/源码比: ${(countLines(testFiles) / countLines(srcFiles)).toFixed(2)}`);
