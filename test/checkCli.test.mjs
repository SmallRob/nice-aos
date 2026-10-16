// check 把 deadcode / duplicates / io 收成子命令；顶层同名命令保持可用。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI 超时\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 10_000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on('error', reject);
  });
}

test('顶层帮助列出 check，不并列 deadcode / duplicates / io', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\bcheck\b/);
  assert.doesNotMatch(r.stdout, /^\s+deadcode\b/m);
  assert.doesNotMatch(r.stdout, /^\s+duplicates\b/m);
  assert.doesNotMatch(r.stdout, /^\s+io\b/m);
});

test('check --help 列出三个体检子命令', async () => {
  const r = await runCli(['check', '--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\bdeadcode\b/);
  assert.match(r.stdout, /\bduplicates\b/);
  assert.match(r.stdout, /\bio\b/);
});

test('check deadcode 与顶层 deadcode 都能跑', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-check-'));
  const nested = await runCli(['check', 'deadcode', '--dir', dir]);
  const top = await runCli(['deadcode', '--dir', dir]);
  assert.equal(nested.code, 1);
  assert.equal(top.code, 1);
  assert.match(nested.stderr, /快照未找到/);
  assert.match(top.stderr, /快照未找到/);
});

test('ask --help 只把四个常用旗标放进选项表', async () => {
  const r = await runCli(['ask', '--help']);
  assert.equal(r.code, 0);
  const options = r.stdout.split('Commands:')[0];
  for (const flag of ['--agent', '--json', '--since', '--save']) {
    assert.match(options, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(options, /--tool-call/);
  assert.doesNotMatch(options, /--agent-cmd/);
  assert.match(r.stdout, /--session/);
  assert.match(r.stdout, /--tool-call/);
});
