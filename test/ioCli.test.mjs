// io CLI 集成测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

const FIXTURE = {
  _meta: { generatedAt: '2026-08-26T00:00:00.000Z', cycles: [], orphanCandidates: [], objectCounts: {} },
  Project: [{ id: 'proj:io', name: 'io-test' }],
  SourceFile: [
    { id: 'file:src/main.ts', name: 'main.ts', path: 'src/main.ts' },
  ],
  Method: [
    { id: 'm:src/main.ts#doX', name: 'doX', filePath: 'src/main.ts', line: 1, ownerKind: 'module', pos: 0, end: 200 },
  ],
};

function mkRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-io-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/main.ts'), `
function doX() {
  const t = GM_getValue("token");
  fetch("/api/x", { headers: { Authorization: "Bearer " + t } });
  GM_setValue("cache", "x");
  eval("alert(1)");
}
  `);
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(FIXTURE));
  return dir;
}

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

test('io --help 正常输出', async () => {
  const r = await runCli(['io', '--help']);
  assert.match(r.stdout, /敏感 API/);
  assert.match(r.stdout, /--min-danger/);
  assert.match(r.stdout, /--kinds/);
  assert.match(r.stdout, /--format/);
});

test('io 缺快照报错', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-io-nope-'));
  const r = await runCli(['io', '--root', empty, '--dir', empty]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /快照未找到/);
});

test('io 真实代码扫描：4 个 IO 使用（GM_getValue, fetch, GM_setValue, eval）', async () => {
  const dir = mkRoot();
  const r = await runCli(['io', '--root', dir, '--dir', dir, '--min-danger', 'low']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /扫描方法: 1 个/);
  assert.match(r.stdout, /共 4 次调用/);
  // critical: 1 (eval)
  assert.match(r.stdout, /critical=1/);
  // high: 1 (fetch)
  assert.match(r.stdout, /high=1/);
  // medium: 1 (GM_setValue)
  assert.match(r.stdout, /medium=1/);
  // low: 1 (GM_getValue)
  assert.match(r.stdout, /low=1/);
});

test('io --min-danger critical 只看 eval', async () => {
  const dir = mkRoot();
  const r = await runCli(['io', '--root', dir, '--dir', dir, '--min-danger', 'critical']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /共 1 次调用/);
  assert.match(r.stdout, /critical=1/);
  assert.match(r.stdout, /high=0/);
});

test('io --kinds NETWORK 只看 fetch', async () => {
  const dir = mkRoot();
  const r = await runCli(['io', '--root', dir, '--dir', dir, '--kinds', 'NETWORK', '--min-danger', 'low']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /共 1 次调用/);
  assert.match(r.stdout, /NETWORK=1/);
  assert.match(r.stdout, /STORAGE=0/);
  assert.match(r.stdout, /SCRIPT=0/);
});

test('io --format json 输出结构化', async () => {
  const dir = mkRoot();
  const r = await runCli(['io', '--root', dir, '--dir', dir, '--format', 'json', '--min-danger', 'low']);
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.summary);
  assert.equal(out.summary.totalIO, 4);
  assert.equal(out.hits.length, 1); // 1 个 method
  const methodHits = out.hits[0];
  assert.equal(methodHits.methodId, 'm:src/main.ts#doX');
  const apis = methodHits.hits.map((h) => h.callee);
  assert.ok(apis.includes('GM_getValue'));
  assert.ok(apis.includes('fetch'));
  assert.ok(apis.includes('GM_setValue'));
  assert.ok(apis.includes('eval'));
});

test('io --output 写文件', async () => {
  const dir = mkRoot();
  const outFile = path.join(dir, 'io-report.txt');
  const r = await runCli(['io', '--root', dir, '--dir', dir, '--output', outFile]);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(outFile));
  assert.match(fs.readFileSync(outFile, 'utf-8'), /nice-aos io/);
});
