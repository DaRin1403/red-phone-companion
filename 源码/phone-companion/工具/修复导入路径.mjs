/**
 * 修复工具子目录里的相对导入路径。
 *
 * 背景：工具脚本从 工具/ 移到了 工具/诊断/、工具/验证/、工具/研究与调试/ 等子目录，
 * 它们原本用 '../src/xxx' 引用源码，现在深了一层，必须改成 '../../src/xxx'。
 * 这个脚本把它一次性修正并校验。
 *
 * 用法：node 工具/修复导入路径.mjs
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBS = ['诊断', '验证', '研究与调试', '历史工具'];

let fixed = 0;
let checked = 0;

for (const sub of SUBS) {
  const dir = join(HERE, sub);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const file = join(dir, name);
    let src = readFileSync(file, 'utf8');
    const before = src;
    // 深了一层：../src/ → ../../src/
    src = src.replaceAll("from '../src/", "from '../../src/");
    src = src.replaceAll("import('../src/", "import('../../src/");
    src = src.replaceAll('from "../src/', 'from "../../src/');
    if (src !== before) {
      writeFileSync(file, src, 'utf8');
      console.log(`  修复: ${sub}/${name}`);
      fixed += 1;
    }
    checked += 1;
  }
}

console.log(`\n检查 ${checked} 个文件，修复 ${fixed} 个`);

// 复查：确认子目录里已无残留的 ../src/
let leftover = 0;
for (const sub of SUBS) {
  const dir = join(HERE, sub);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const src = readFileSync(join(dir, name), 'utf8');
    if (/from '\.\.\/src\/|import\('\.\.\/src\//.test(src)) {
      console.log(`  ⚠️ 仍有残留: ${sub}/${name}`);
      leftover += 1;
    }
  }
}
console.log(leftover === 0 ? '✓ 无残留旧路径' : `✗ 还有 ${leftover} 处残留`);
