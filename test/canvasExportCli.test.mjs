// test/canvasExportCli.test.mjs
// 端到端 CLI 测试：spawn nice-aos process 跑 deploy/overview/output --format canvas
// 验证：进程退出码、产出文件、关键产物内容
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.js');

/**
 * 构造一个临时 .nice-aos/data 目录，含最小可用的 deploy-snapshot.json
 * @param {object} deployFixture
 * @returns {{ tmpDir: string, cleanup: () => void }}
 */
function makeTmpSnapshotDir(deployFixture) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-canvas-'));
  const dataDir = path.join(tmp, '.nice-aos', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'deploy-snapshot.json'), JSON.stringify(deployFixture, null, 2), 'utf-8');
  return {
    tmpDir: tmp,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

function makeDeployFixture() {
  return {
    services: [
      { id: 'service:web', name: 'web', type: 'frontend', layer: 'frontend', kind: 'container', image: 'nginx:1.25', namespace: 'default', replicas: 2, containerPorts: [80], envCount: 5 },
      { id: 'service:api', name: 'api', type: 'backend', layer: 'backend', kind: 'Deployment', image: 'myreg.io/api:1.0.0', namespace: 'asdm', replicas: 3, readinessProbe: { httpGet: { path: '/health' } }, envCount: 12 },
    ],
    routes: [{ id: 'route:web->api', gateway: 'web', path: '/api', resolvedService: 'api', matchType: 'prefix' }],
    upstreams: [],
    dependencies: [{ id: 'dep:web->api', from: 'web', to: 'api', type: 'env_ref' }],
    middleware: [],
    environments: [],
    files: [],
    layers: [{ key: 'frontend', label: '前端层' }, { key: 'backend', label: '应用服务层' }],
    k8sResources: [{ kind: 'Deployment', name: 'api', namespace: 'asdm', replicas: 3, containers: [{ name: 'api', image: 'myreg.io/api:1.0.0' }] }],
    k8sResourceCounts: { Deployment: 1 },
    _meta: { version: '1.0', subsystem: 'deployment', sourceDir: '/tmp/test', scannedAt: '2026-08-31T00:00:00Z', serviceCount: 2, routeCount: 1, dependencyCount: 1 },
  };
}

function runCli(args, env) {
  return spawnSync('node', [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 30000,
  });
}

test('CLI: deploy export --format canvas 产出自包含 HTML', () => {
  const { tmpDir, cleanup } = makeTmpSnapshotDir(makeDeployFixture());
  try {
    const out = path.join(tmpDir, 'canvas.html');
    const r = runCli(
      ['deploy', 'export', '--format', 'canvas', '--output', out],
      { NICE_AOS_DEPLOY_SNAPSHOT_DIR: path.join(tmpDir, '.nice-aos', 'data') },
    );
    assert.equal(r.status, 0, `exit code ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(fs.existsSync(out), '未生成输出文件');
    const html = fs.readFileSync(out, 'utf-8');
    assert.ok(html.startsWith('<!DOCTYPE html>'), '不是合法 HTML');
    assert.ok(html.includes('<script id="canvas-data"'));
    // 占位符在 data 块内已被替换为合法 JSON
    const m = html.match(/<script id="canvas-data" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(m, 'data 块缺失');
    const parsed = JSON.parse(m[1]);
    assert.equal(parsed.services.length, 2);
    assert.equal(parsed.services[0].name, 'web');
  } finally {
    cleanup();
  }
});

test('CLI: deploy export --format canvas 无 --output 时 fail', () => {
  const { tmpDir, cleanup } = makeTmpSnapshotDir(makeDeployFixture());
  try {
    const r = runCli(
      ['deploy', 'export', '--format', 'canvas'],
      { NICE_AOS_DEPLOY_SNAPSHOT_DIR: path.join(tmpDir, '.nice-aos', 'data') },
    );
    assert.notEqual(r.status, 0, '应非零退出');
    assert.ok(/canvas 必须配合 --output/.test(r.stderr + r.stdout), '错误信息未提示 --output');
  } finally {
    cleanup();
  }
});

test('CLI: output --format canvas 自动检测 deploy 快照', () => {
  const { tmpDir, cleanup } = makeTmpSnapshotDir(makeDeployFixture());
  try {
    const out = path.join(tmpDir, 'output-canvas.html');
    const r = runCli(
      ['output', '--format', 'canvas', '--output', out],
      { NICE_AOS_SNAPSHOT_DIR: path.join(tmpDir, '.nice-aos', 'data'), NICE_AOS_DEPLOY_SNAPSHOT_DIR: path.join(tmpDir, '.nice-aos', 'data') },
    );
    assert.equal(r.status, 0, `exit code ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(fs.existsSync(out), '未生成文件');
    // stderr 应有 "画布类型: deploy"
    assert.ok(/画布类型: deploy/.test(r.stderr), 'stderr 未报告画布类型');
    const html = fs.readFileSync(out, 'utf-8');
    assert.ok(html.includes('service:web') || html.includes('"name":"web"'), '画布未包含服务数据');
  } finally {
    cleanup();
  }
});

test('CLI: output --format canvas 无快照时给出可执行提示', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-canvas-empty-'));
  try {
    const out = path.join(tmp, 'canvas.html');
    const r = runCli(
      ['output', '--format', 'canvas', '--output', out],
      { NICE_AOS_SNAPSHOT_DIR: tmp, NICE_AOS_DEPLOY_SNAPSHOT_DIR: tmp, NICE_AOS_OVERVIEW_SNAPSHOT_DIR: tmp },
    );
    assert.notEqual(r.status, 0);
    const out_ = r.stdout + r.stderr;
    assert.ok(/未找到可用的画布数据/.test(out_), '未给出"无可用画布"提示');
    assert.ok(/nice-aos deploy scan/.test(out_), '未提示运行 deploy scan');
    assert.ok(!fs.existsSync(out), '失败时不应生成文件');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI: deploy export --format canvas 部署目录无快照时 fail（不是空 HTML）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-canvas-no-snap-'));
  try {
    const r = runCli(
      ['deploy', 'export', '--format', 'canvas', '--output', path.join(tmp, 'x.html')],
      { NICE_AOS_DEPLOY_SNAPSHOT_DIR: tmp },
    );
    assert.notEqual(r.status, 0);
    assert.ok(/未找到部署快照/.test(r.stderr + r.stdout), '未提示缺失快照');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
