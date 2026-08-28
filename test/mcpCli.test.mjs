// mcp 子命令冒烟测试：
//   - mcp --help 正常输出（含 "MCP server" 描述）
//   - mcp --dir /path/with/no/snapshot 报错退出（fail-fast 验证）
//   - mcp --dir /path/with/snapshot 能启动 + stderr 输出"就绪"（spawn + 短延迟 + SIGTERM）
//   - mcp --bad-flag 报错

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

function runCli(args, { timeoutMs = 15_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI 超时（${timeoutMs}ms）\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('mcp --help 正常输出 + 描述含 "MCP server"', async () => {
  const r = await runCli(['mcp', '--help']);
  // commander 把帮助打到 stdout
  assert.match(r.stdout, /MCP server/i, `mcp --help 应含 "MCP server"。实际:\n${r.stdout}`);
  // 选项说明
  assert.match(r.stdout, /--root/, '应列 --root 选项');
  assert.match(r.stdout, /--dir/, '应列 --dir 选项');
});

test('mcp --dir 快照不存在时报错并退出（fail-fast）', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mcp-nope-'));
  const r = await runCli(['mcp', '--dir', emptyDir]);
  assert.notEqual(r.code, 0, '缺快照应非零退出');
  assert.match(r.stderr, /快照未找到/, `stderr 应含 "快照未找到"。实际:\n${r.stderr}`);
  assert.match(r.stderr, /refreshRepo/, 'stderr 应提示先跑 refreshRepo');
});

test('mcp --dir 快照 JSON 损坏时报错并退出', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mcp-bad-'));
  fs.writeFileSync(path.join(dir, 'snapshot.json'), '{ this is not valid JSON');
  const r = await runCli(['mcp', '--dir', dir]);
  assert.notEqual(r.code, 0, '坏 JSON 应非零退出');
  assert.match(r.stderr, /快照加载失败|PARSE_FAILED/, `stderr 应含解析错误。实际:\n${r.stderr}`);
});

test('mcp --dir 合法快照能启动 + stderr 包含 "就绪" + 工具数 + 工具名', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-mcp-ok-'));
  // 写一个最小合法快照
  const snap = {
    _meta: { generatedAt: '2026-08-26T00:00:00.000Z', cycles: [], orphanCandidates: [], objectCounts: { SourceFile: 1 } },
    Project: [{ id: 'proj:test', name: 'mcp-smoke', framework: 'react', branch: 'main' }],
    SourceFile: [{ id: 'file:a.ts' }],
  };
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(snap));

  // spawn 启动，给 1.5s 让 server 注册工具到 stderr，然后 SIGTERM
  const child = spawn(process.execPath, [CLI, 'mcp', '--dir', dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  // 轮询 stderr 直到出现 "就绪" 再 SIGTERM（固定 1.5s 在全量测试并行负载下会时序抖动；上限 8s）
  const readyDeadline = Date.now() + 8000;
  while (Date.now() < readyDeadline && !/就绪/.test(stderr)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');

  await new Promise((resolve) => {
    child.on('close', () => resolve());
    setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
  });

  // 验证 stderr 含启动信息
  assert.match(stderr, /启动中/, 'stderr 应含 "启动中"');
  assert.match(stderr, /就绪/, 'stderr 应含 "就绪"');
  assert.match(stderr, /\d+ 个工具/, 'stderr 应说明注册的工具数');
  assert.match(stderr, /get_stats/, 'stderr 应列工具名（get_stats）');
  assert.match(stderr, /query_objects/, 'stderr 应列工具名（query_objects）');
  // v0.33.0 精简：detect_dead_code / query_graph 已从工具列表移除
  assert.doesNotMatch(stderr, /detect_dead_code/, 'v0.33.0+ 不应再列 detect_dead_code');
  assert.match(stderr, /\b7\b/, 'stderr 应说明工具数为 7');
});
