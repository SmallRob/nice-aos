// duplicates 子命令测试：
//   - --help 正常输出
//   - 缺快照报错
//   - 含重复 method 的快照能找出组
//   - --min-size 过滤
//   - --format json 输出结构化 envelope
//   - --output 写文件

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

// 构造一个含重复函数的快照
const SNAP = {
  _meta: { generatedAt: '2026-08-26T00:00:00.000Z', cycles: [], orphanCandidates: [], objectCounts: { Method: 5 } },
  Project: [{ id: 'proj:dup-test', name: 'dup-test', framework: 'react' }],
  Method: [
    // 组 1: 3 个相同 fetch 骨架
    { id: 'method:a.ts#fetchA', name: 'fetchA', filePath: 'src/a.ts', line: 10, astFingerprint: 'fp_aaa_aaa', astFingerprintNodes: 30 },
    { id: 'method:b.ts#fetchB', name: 'fetchB', filePath: 'src/b.ts', line: 20, astFingerprint: 'fp_aaa_aaa', astFingerprintNodes: 30 },
    { id: 'method:c.ts#fetchC', name: 'fetchC', filePath: 'src/c.ts', line: 30, astFingerprint: 'fp_aaa_aaa', astFingerprintNodes: 30 },
    // 组 2: 2 个相同
    { id: 'method:d.ts#formatX', name: 'formatX', filePath: 'src/d.ts', line: 5, astFingerprint: 'fp_bbb_bbb', astFingerprintNodes: 50 },
    { id: 'method:e.ts#formatY', name: 'formatY', filePath: 'src/e.ts', line: 8, astFingerprint: 'fp_bbb_bbb', astFingerprintNodes: 50 },
    // 单例：唯一
    { id: 'method:f.ts#onlyOne', name: 'onlyOne', filePath: 'src/f.ts', line: 1, astFingerprint: 'fp_ccc_ccc', astFingerprintNodes: 20 },
    // 小于 min-size 默认值 15（默认 min-size = 15,这里 10 应被过滤）
    { id: 'method:g.ts#smallA', name: 'smallA', filePath: 'src/g.ts', line: 1, astFingerprint: 'fp_ddd_ddd', astFingerprintNodes: 10 },
    { id: 'method:h.ts#smallB', name: 'smallB', filePath: 'src/h.ts', line: 1, astFingerprint: 'fp_ddd_ddd', astFingerprintNodes: 10 },
    // 无 fingerprint（不计入）
    { id: 'method:i.ts#noFp', name: 'noFp', filePath: 'src/i.ts', line: 1 },
  ],
};

function mkFixture(snap) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-dup-'));
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(snap));
  return dir;
}

function runCli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI 超时\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, opts.timeoutMs ?? 10_000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', reject);
  });
}

test('duplicates --help 正常输出', async () => {
  const r = await runCli(['duplicates', '--help']);
  assert.match(r.stdout, /重复函数/);
  assert.match(r.stdout, /--min-size/);
  assert.match(r.stdout, /--format/);
});

test('duplicates 快照缺失报错', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-dup-nope-'));
  const r = await runCli(['duplicates', '--dir', emptyDir]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /快照未找到/);
});

test('duplicates 表格模式找出 2 个重复组（默认 min-size=15）', async () => {
  const dir = mkFixture(SNAP);
  const r = await runCli(['duplicates', '--dir', dir]);
  assert.equal(r.code, 0);
  // 扫描 8 个有 fingerprint 的 method（noFp 被跳过）
  assert.match(r.stdout, /扫描方法: 8 个/);
  assert.match(r.stdout, /跳过 1 个无 fingerprint/);
  // 找到 2 个重复组（组 1 = 3 个,组 2 = 2 个,小 fp_ddd_ddd 被 min-size=15 过滤）
  assert.match(r.stdout, /找到重复组: 2 个/);
  // 组 1 应是 3 成员
  assert.match(r.stdout, /3 个成员/);
  // 组 2 应是 2 成员
  assert.match(r.stdout, /2 个成员/);
});

test('duplicates --min-size 5 包含小重复', async () => {
  const dir = mkFixture(SNAP);
  const r = await runCli(['duplicates', '--dir', dir, '--min-size', '5']);
  assert.equal(r.code, 0);
  // 包含小 fp_ddd_ddd,应有 3 个重复组
  assert.match(r.stdout, /找到重复组: 3 个/);
});

test('duplicates --min-size 100 全部过滤', async () => {
  const dir = mkFixture(SNAP);
  const r = await runCli(['duplicates', '--dir', dir, '--min-size', '100']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /找到重复组: 0 个/);
  assert.match(r.stdout, /没有发现重复函数/);
});

test('duplicates --format json 输出结构化 envelope', async () => {
  const dir = mkFixture(SNAP);
  const r = await runCli(['duplicates', '--dir', dir, '--format', 'json']);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.scannedMethods, 8);
  assert.equal(out.skippedNoFingerprint, 1);
  assert.equal(out.minSize, 15);
  assert.equal(out.truncated, false);
  assert.ok(Array.isArray(out.groups));
  assert.equal(out.groups.length, 2);
  // 验证最大成员组排前
  assert.equal(out.groups[0].members.length, 3);
  assert.equal(out.groups[1].members.length, 2);
  // 验证成员结构
  const first = out.groups[0].members[0];
  assert.ok(first.id);
  assert.ok(first.name);
  assert.ok(first.filePath);
  assert.equal(typeof first.startLine, 'number');
});

test('duplicates --output 写文件', async () => {
  const dir = mkFixture(SNAP);
  const outFile = path.join(dir, 'duplicates.txt');
  const r = await runCli(['duplicates', '--dir', dir, '--output', outFile]);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(outFile));
  const content = fs.readFileSync(outFile, 'utf-8');
  assert.match(content, /nice-aos duplicates/);
  assert.match(content, /找到重复组: 2 个/);
});

test('duplicates 快照坏 JSON 报错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-dup-bad-'));
  fs.writeFileSync(path.join(dir, 'snapshot.json'), '{ not valid');
  const r = await runCli(['duplicates', '--dir', dir]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /快照加载失败/);
});

test('duplicates 全部单例（无重复）', async () => {
  const loneSnap = {
    _meta: { generatedAt: '2026-08-26T00:00:00.000Z' },
    Project: [{ id: 'proj:alone', name: 'alone' }],
    Method: [
      { id: 'method:a.ts#x', name: 'x', filePath: 'a.ts', line: 1, astFingerprint: 'fp1', astFingerprintNodes: 20 },
      { id: 'method:b.ts#y', name: 'y', filePath: 'b.ts', line: 1, astFingerprint: 'fp2', astFingerprintNodes: 25 },
    ],
  };
  const dir = mkFixture(loneSnap);
  const r = await runCli(['duplicates', '--dir', dir]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /找到重复组: 0 个/);
  assert.match(r.stdout, /没有发现重复函数/);
});
