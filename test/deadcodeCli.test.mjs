// deadcode CLI 集成测试
// 覆盖 --help / 缺快照 / 死代码检测 / --entry-point / --format json / --write-back

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

const FIXTURE = {
  _meta: { generatedAt: '2026-08-26T00:00:00.000Z', cycles: [], orphanCandidates: [], objectCounts: { Class: 2 } },
  Project: [{ id: 'proj:dct', name: 'dct' }],
  SourceFile: [
    { id: 'file:src/main.tsx', name: 'main.tsx', isEntry: true, importIds: [] },
  ],
  Class: [
    { id: 'class:src/A.tsx#A', name: 'A', filePath: 'src/A.tsx', line: 1, exported: true, fileId: 'file:src/A.tsx', methodIds: [] },
    { id: 'class:src/B.tsx#B', name: 'B', filePath: 'src/B.tsx', line: 1, exported: true, fileId: 'file:src/B.tsx', methodIds: [] },
  ],
  Method: [],
};

function runCli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI 超时\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, opts.timeoutMs ?? 10_000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on('error', reject);
  });
}

function mkFixture(snap = FIXTURE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-dc-'));
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(snap));
  return dir;
}

test('deadcode --help 正常输出', async () => {
  const r = await runCli(['deadcode', '--help']);
  assert.match(r.stdout, /不可达/);
  assert.match(r.stdout, /--entry-point/);
  assert.match(r.stdout, /--format/);
  assert.match(r.stdout, /--write-back/);
});

test('deadcode 缺快照报错', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-dc-nope-'));
  const r = await runCli(['deadcode', '--dir', empty]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /快照未找到/);
});

test('deadcode 表格模式找出 2 个 dead class（A/B 都不在 importIds）', async () => {
  const dir = mkFixture();
  const r = await runCli(['deadcode', '--dir', dir]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /死代码: 2 个/);
  // 注意：表格中可能输出 class:id（看具体格式）
  assert.match(r.stdout, /class:src\/A\.tsx#A/);
  assert.match(r.stdout, /class:src\/B\.tsx#B/);
});

test('deadcode --entry-point 显式声明 A 让 A 可达', async () => {
  const dir = mkFixture();
  const r = await runCli(['deadcode', '--dir', dir, '-e', 'class:src/A.tsx#A']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /死代码: 1 个/);
  assert.match(r.stdout, /class:src\/B\.tsx#B/);
  assert.doesNotMatch(r.stdout, /class:src\/A\.tsx#A.*A.*导出/);
});

test('deadcode --format json 输出结构化 envelope', async () => {
  const dir = mkFixture();
  const r = await runCli(['deadcode', '--dir', dir, '--format', 'json']);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.stats);
  assert.equal(out.deadClasses.length, 2);
  assert.equal(out.deadClasses[0].filePath, 'src/A.tsx');
  assert.equal(out.deadClasses[1].filePath, 'src/B.tsx');
  // timestamp 应是 ISO
  assert.match(out.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('deadcode --write-back 把 dead 标到 snapshot', async () => {
  const dir = mkFixture();
  const r = await runCli(['deadcode', '--dir', dir, '--write-back']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /已写回: 2 个/);
  // 重新读 snapshot 验证 deadCandidate 字段被写
  const updated = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf-8'));
  const aClass = updated.Class.find((c) => c.name === 'A');
  assert.equal(aClass.deadCandidate, true);
  assert.match(aClass.deadReason, /BFS 不可达/);
  const bClass = updated.Class.find((c) => c.name === 'B');
  assert.equal(bClass.deadCandidate, true);
});

test('deadcode --output 写文件', async () => {
  const dir = mkFixture();
  const outFile = path.join(dir, 'dead.txt');
  const r = await runCli(['deadcode', '--dir', dir, '--output', outFile]);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(outFile));
  const content = fs.readFileSync(outFile, 'utf-8');
  assert.match(content, /nice-aos deadcode/);
  assert.match(content, /死代码: 2 个/);
});

test('deadcode 没死代码输出友好提示', async () => {
  // 构造：所有 exported class 都被 import
  const snap = {
    _meta: { generatedAt: '2026-08-26T00:00:00.000Z', cycles: [], orphanCandidates: [], objectCounts: {} },
    Project: [{ id: 'proj:n', name: 'n' }],
    SourceFile: [
      { id: 'file:src/main.tsx', name: 'main.tsx', isEntry: true, importIds: ['file:src/A.tsx'] },
      { id: 'file:src/A.tsx', name: 'A.tsx', isEntry: false, importIds: [] },
    ],
    Class: [
      { id: 'class:src/A.tsx#A', name: 'A', filePath: 'src/A.tsx', line: 1, exported: true, fileId: 'file:src/A.tsx', methodIds: [] },
    ],
    Method: [],
  };
  const dir = mkFixture(snap);
  const r = await runCli(['deadcode', '--dir', dir]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /没有发现 dead exported class/);
});

test('deadcode 快照坏 JSON 报错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-dc-bad-'));
  fs.writeFileSync(path.join(dir, 'snapshot.json'), '{ broken');
  const r = await runCli(['deadcode', '--dir', dir]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /快照加载失败/);
});
