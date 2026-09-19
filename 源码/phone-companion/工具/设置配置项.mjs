/**
 * 设置配置项.mjs —— 安全地修改 phone.config.json（避开 PowerShell 的 BOM 与引号转义坑）
 *
 * 用法：
 *   node 工具/设置配置项.mjs ataUser companion
 *   node 工具/设置配置项.mjs localAddress auto
 *   node 工具/设置配置项.mjs --show
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, '..', 'phone.config.json');

function load() {
  // 主动剥 BOM：Windows 上的工具很容易写出带 BOM 的 UTF-8，而 JSON.parse 不接受
  return JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
}

function save(obj) {
  writeFileSync(CONFIG, JSON.stringify(obj, null, 2) + '\n', 'utf8');   // 无 BOM
}

const [key, value] = process.argv.slice(2);

if (!key || key === '--show') {
  const cfg = load();
  const shown = ['localAddress', 'sipPort', 'rtpPort', 'sipUser',
    'ataAddress', 'ataSipPort', 'ataUser', 'asrUrl', 'workspace'];
  console.log('=== 当前关键配置 ===');
  for (const k of shown) console.log(`  ${k.padEnd(14)} = ${JSON.stringify(cfg[k])}`);
  process.exit(0);
}

if (value === undefined) {
  console.error('用法: node 工具/设置配置项.mjs <键> <值>');
  process.exit(1);
}

const cfg = load();
const before = cfg[key];
// 数字型键自动转数字
const portKeys = ['sipPort', 'rtpPort', 'ataSipPort', 'asrTimeoutMs', 'sessionPollMs', 'replyTimeoutMs', 'ringRings'];
const next = portKeys.includes(key) ? Number(value) : value;
cfg[key] = next;
save(cfg);

console.log(`已更新 ${key}: ${JSON.stringify(before)} → ${JSON.stringify(next)}`);
