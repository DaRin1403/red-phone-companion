/**
 * 回归测试：配置加载与"服务是否已在运行"的判定。
 *
 * 两个都是真机上踩出来的坑，而且都属于"静默出错"——不报错、但行为完全不对：
 *
 * ① loadConfig() 不传参数时曾经**不读文件**，直接返回内置 DEFAULT_CONFIG，
 *    而默认值是 192.168.82.x 网段的早年占位值。
 *    调用方以为拿到了真配置，实际把 INVITE 打到一个不存在的地址上，
 *    现象是"包发出去了但一个响应都没有"，极像被网关拒绝。
 *    （写 工具/验证/验证真机响铃.mjs 时就是这么被误导了一轮。）
 *
 * ② 重复启动服务时只报 dgram 的 EADDRINUSE，看起来像程序坏了，
 *    实际只是开了两份。readRunningStatus() 负责把它翻译成人话。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, readRunningStatus, DEFAULT_CONFIG } from './phone-control.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('loadConfig() 不传参数时必须读项目自带的 phone.config.json，而不是返回占位默认值', () => {
  const cfg = loadConfig();

  // 断言"读到了文件"而不是"等于某个写死的值"：
  // 早先这里写死过作者自己的工作区路径，开源后别人一 clone 测试就挂。
  // 正确做法是拿配置文件的真实内容来对照。
  const file = JSON.parse(
    readFileSync(join(HERE, '..', 'phone.config.json'), 'utf8').replace(/^\uFEFF/, ''),
  );

  assert.equal(cfg.ataAddress, file.ataAddress, '网关地址应来自配置文件');
  assert.equal(cfg.workspace, file.workspace, '工作区应来自配置文件');
  assert.notEqual(
    cfg.ataAddress,
    DEFAULT_CONFIG.ataAddress,
    'loadConfig() 又退回默认占位值了 —— 说明它没读配置文件，'
    + '所有调用方都会把包打到 192.168.82.x 这个不存在的网段上',
  );
  // 工作区决定去哪个目录找会话文件，写错就永远检测不到回复完成（表现为"电话永远不响"）
  assert.ok(cfg.workspace, 'workspace 必须有值 —— 它是回铃检测的定位依据');
});

test('显式传入配置文件路径时以该文件为准（而不是项目自带那份）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-cfg-'));
  const file = join(dir, 'alt.json');
  writeFileSync(file, JSON.stringify({ ataAddress: '10.9.9.9', sipPort: 6077 }), 'utf8');

  const cfg = loadConfig(file);
  assert.equal(cfg.ataAddress, '10.9.9.9');
  assert.equal(cfg.sipPort, 6077);
  // 文件里没写的项应保留默认值（合并而不是替换）
  assert.equal(cfg.rtpPort, DEFAULT_CONFIG.rtpPort);
});

test('配置文件带 UTF-8 BOM 时也要能读（PowerShell Set-Content 会写 BOM）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-cfg-bom-'));
  const file = join(dir, 'bom.json');
  writeFileSync(file, '\uFEFF' + JSON.stringify({ ataAddress: '10.1.1.1' }), 'utf8');

  const cfg = loadConfig(file);
  assert.equal(cfg.ataAddress, '10.1.1.1', 'BOM 没剥掉，JSON.parse 会直接抛错');
});

test('传入不存在的路径时回落到默认值，不抛异常', () => {
  const cfg = loadConfig(join(tmpdir(), '绝对不存在的配置.json'));
  assert.equal(cfg.ataAddress, DEFAULT_CONFIG.ataAddress);
});

test('readRunningStatus()：探测到自己的 PID 时不算"已在运行"', () => {
  // 状态文件里写的是本测试进程的 PID —— 说明是陈迹或误读，不该挡住启动。
  // 这里只断言契约：返回 null 或一个 pid 确实活着的快照，绝不返回死进程。
  const snap = readRunningStatus();
  if (snap !== null) {
    assert.equal(typeof snap.pid, 'number');
    assert.doesNotThrow(
      () => process.kill(snap.pid, 0),
      'readRunningStatus() 返回了一个已经死掉的 PID —— 会误报"已在运行"挡住正常启动',
    );
    assert.notEqual(snap.pid, process.pid, '不该把自己当成"已在运行的服务"');
  }
});
