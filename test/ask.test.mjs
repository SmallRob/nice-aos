// ask 命令测试：agent 探测/调用/超时 + JSON 回退上下文构建 + fake agent 端到端 + SQL 性能冒烟
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAgent, invokeAgent } from '../src/cli/commands/agentRunner.js';
import { buildAskContext } from '../src/cli/commands/askContext.js';
import { invokeApiChat } from '../src/cli/commands/openaiCompat.js';
import {
  encryptSecret, decryptSecret, maskApiKey, saveAskConfig, clearAskConfig, loadAskConfig,
} from '../src/cli/commands/askConfig.js';
import {
  setBlueprint, setStorageMode, setSqlitePath, saveSnapshot, buildAskContextFromSql, closeDb,
} from '../src/storage/index.js';
import { setSnapshotDir } from '../src/paths.js';
import { OBJECT_TYPES, LINK_TYPES } from '../src/ontology/blueprint.js';

setBlueprint({ OBJECT_TYPES, LINK_TYPES });

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');
const AGENT_RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'commands', 'agentRunner.js');

// ---------- 单元：agentRunner ----------

const nodeAgent = (args) => ({ name: 'fake', binary: process.execPath, buildArgs: () => args });

test('resolveAgent：显式指定 codebuddy / opencode，buildArgs 与约定一致', () => {
  const cb = resolveAgent('codebuddy');
  assert.equal(cb.name, 'codebuddy');
  assert.deepEqual(cb.buildArgs('Q'), ['-p', 'Q', '--output-format', 'text']);
  const oc = resolveAgent('opencode');
  assert.equal(oc.name, 'opencode');
  assert.deepEqual(oc.buildArgs('Q'), ['run', 'Q']);
});

test('resolveAgent：未知 agent 报错并列出可用项', () => {
  assert.throws(() => resolveAgent('nope'), /未知 agent: nope（可用: codebuddy, opencode）/);
});

test('invokeAgent：返回 stdout（trim 后）', () => {
  const out = invokeAgent(nodeAgent(['-e', 'console.log("  fake-answer  ")']), 'Q');
  assert.equal(out, 'fake-answer');
});

test('invokeAgent：prompt 经 buildArgs 透传给 CLI', () => {
  const agent = {
    name: 'fake',
    binary: process.execPath,
    buildArgs: (prompt) => ['-e', 'console.log(process.argv[1])', prompt],
  };
  assert.equal(invokeAgent(agent, 'HELLO-PROMPT'), 'HELLO-PROMPT');
});

test('invokeAgent：超时 → 明确的超时报错（err.killed）', () => {
  const agent = nodeAgent(['-e', 'setTimeout(() => {}, 10000)']);
  assert.throws(() => invokeAgent(agent, 'Q', { timeout: 200 }), /fake 调用超时（200ms）/);
});

test('invokeAgent：非零退出 → 调用失败 + stderr 透出', () => {
  const agent = nodeAgent(['-e', 'console.error("boom"); process.exit(3)']);
  assert.throws(() => invokeAgent(agent, 'Q'), /调用失败: boom/);
});

test('detectAgent：PATH 上无任何 AI CLI 时明确报错（空 PATH 子进程）', async () => {
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ask-emptybin-'));
  const code = `import { detectAgent } from ${JSON.stringify(pathToFileURL(AGENT_RUNNER).href)};
try { detectAgent(); console.log('NO_THROW'); } catch (e) { console.log('THROWN|' + e.message); }`;
  const r = await runNode(code, { PATH: emptyBin });
  assert.match(r.out, /THROWN\|未检测到可用的 AI CLI/);
});

// ---------- 单元：buildAskContext（JSON 回退版） ----------

const FIXTURE = {
  _meta: {
    analyzerVersion: '0.32.0',
    objectCounts: { Project: 1, Module: 3, SourceFile: 5, Dependency: 2 },
  },
  Project: [{
    id: 'proj:fixture', name: 'ask-fixture', framework: 'react', frameworkLabel: 'React 19',
    language: 'TypeScript', fileCount: 5, commitHash: 'abc123',
    architecture: { layers: [{ key: 'shared', label: '共享层', fileCount: 4, share: 80 }] },
    health: { cycleCount: 1, orphanFileCount: 2, deadTypeCount: 1, deadFunctionCount: 0, deadExportCount: 0, undeclaredDependencyCount: 3 },
  }],
  Domain: [{ id: 'dom:auth', name: 'auth', fileCount: 2, lineCount: 300 }],
  Module: [
    { id: 'mod:src', path: 'src', fileCount: 2, archLayerLabel: '共享层' },
    { id: 'mod:src/big', path: 'src/big', fileCount: 9, archLayerLabel: '共享层' },
    { id: 'mod:src/small', path: 'src/small', fileCount: 1, archLayerLabel: '共享层' },
  ],
  Dependency: [{ id: 'dep:react', name: 'react' }, { id: 'dep:zustand', name: 'zustand' }],
};

test('buildAskContext：章节齐全（快照/分层/功能域/模块/依赖/健康/统计）', () => {
  const ctx = buildAskContext(FIXTURE);
  assert.match(ctx, /## 项目本体快照/);
  assert.match(ctx, /- 名称: ask-fixture/);
  assert.match(ctx, /- 框架: React 19/);
  assert.match(ctx, /## 架构分层\n- 共享层: 4 文件 \(80%\)/);
  assert.match(ctx, /## 功能域\n- auth: 2 文件, 300 行/);
  assert.match(ctx, /## 声明依赖\nreact, zustand/);
  assert.match(ctx, /## 健康指标\n- 循环依赖: 1\n- 孤儿文件: 2\n- 死代码候选: 1\n- 未声明依赖: 3/);
  assert.match(ctx, /## 对象统计[\s\S]*- SourceFile: 5/);
});

test('buildAskContext：模块按 fileCount 降序取 Top 10', () => {
  const ctx = buildAskContext(FIXTURE);
  const big = ctx.indexOf('src/big');
  const mid = ctx.indexOf('\n- src ');
  const small = ctx.indexOf('src/small');
  assert.ok(big !== -1 && small !== -1);
  assert.ok(big < mid, 'fileCount=9 的模块应排在 fileCount=2 之前');
  assert.ok(mid < small, 'fileCount=2 的模块应排在 fileCount=1 之前');
});

test('buildAskContext：空 dataMap 兜底（未知 / 无）', () => {
  const ctx = buildAskContext({});
  assert.match(ctx, /- 名称: 未知/);
  assert.match(ctx, /- 框架: 未知/);
  assert.match(ctx, /## 声明依赖\n无/);
  assert.doesNotMatch(ctx, /## 架构分层/);
  assert.doesNotMatch(ctx, /## 健康指标/);
});

test('buildAskContext：不含"## 问题"节（由 ask.js 统一拼接）', () => {
  assert.doesNotMatch(buildAskContext(FIXTURE), /## 问题/);
});

// ---------- 端到端：fake agent（PATH 注入） ----------

function mkFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ask-'));
  const dataDir = path.join(dir, '.nice-aos', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify(FIXTURE));
  return dir;
}

// fake AI CLI：把收到的 prompt 落盘，回固定答案（$2 即 buildArgs 中的 prompt 位置参数）
function mkFakeAgentBin(names, logFile) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ask-bin-'));
  for (const name of names) {
    const script = path.join(bin, name);
    fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$2" > "${logFile}"\necho "FAKE_AGENT_ANSWER"\n`);
    fs.chmodSync(script, 0o755);
  }
  return bin;
}

// 剥离 NICE_AOS_* 环境变量，保证目录解析链确定（不受宿主环境影响）
function cleanEnv() {
  const env = { ...process.env };
  delete env.NICE_AOS_SNAPSHOT_DIR;
  delete env.NICE_AOS_SQLITE_PATH;
  delete env.NICE_AOS_SQLITE_MODE;
  delete env.NICE_AOS_API_KEY;
  delete env.NICE_AOS_BASE_URL;
  delete env.NICE_AOS_MODEL;
  delete env.NICE_AOS_CONFIG_DIR;
  return env;
}

function runCli(args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...cleanEnv(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => resolve({ code, out, err }));
    child.on('error', reject);
  });
}

function runNode(code, envOverride) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...cleanEnv(), ...envOverride },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => resolve({ code, out, err }));
    child.on('error', reject);
  });
}

test('ask 端到端（fake codebuddy）：auto 探测 + JSON 回退上下文 + prompt 组装', async () => {
  const dir = mkFixture();
  const logFile = path.join(dir, 'prompt.log');
  const bin = mkFakeAgentBin(['codebuddy'], logFile);

  const r = await runCli(['ask', '这个项目的架构分层?', '--cwd', dir, '--json'], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.equal(j.agent, 'codebuddy');
  assert.equal(j.contextSource, 'json', 'fixture 无 SQLite 镜像 → 回退 JSON');
  assert.equal(j.answer, 'FAKE_AGENT_ANSWER');
  assert.ok(Number.isFinite(j.durationMs));

  // prompt 组装：上下文在前 + "## 问题"节在后
  const prompt = fs.readFileSync(logFile, 'utf-8');
  assert.match(prompt, /## 项目本体快照/);
  assert.match(prompt, /ask-fixture/);
  assert.match(prompt, /## 问题\n这个项目的架构分层\?\n$/);
});

test('ask 端到端：显式 --agent opencode + 纯文本输出（非 --json）', async () => {
  const dir = mkFixture();
  const logFile = path.join(dir, 'prompt.log');
  const bin = mkFakeAgentBin(['opencode'], logFile);

  const r = await runCli(['ask', 'Q', '--agent', 'opencode', '--cwd', dir], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  assert.equal(r.out.trim(), 'FAKE_AGENT_ANSWER');
});

test('ask 端到端：--agent 指定未知 agent → exit 1 + 错误信息', async () => {
  const dir = mkFixture();
  const r = await runCli(['ask', 'Q', '--agent', 'nope', '--cwd', dir]);
  assert.equal(r.code, 1);
  assert.match(r.err, /未知 agent: nope（可用: codebuddy, opencode）/);
});

test('ask 端到端：--no-auto-refresh 无快照 → 保持旧 fail 指引', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ask-empty-'));
  const r = await runCli(['ask', 'Q', '--cwd', empty, '--no-auto-refresh'], {
    env: { NICE_AOS_SNAPSHOT_DIR: path.join(empty, 'no-snapshot-data') },
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /refreshRepo/);
  assert.match(r.err, /--no-auto-refresh/);
});

// ---------- 端到端：空数据自动快照 ----------

// 真实可扫描的最小 React 项目（package.json + src/App.tsx）
function mkRealProject(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ask-proj-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, dependencies: { react: '^19.0.0' } }));
  fs.writeFileSync(path.join(dir, 'src', 'App.tsx'),
    'import { useState } from "react";\n'
    + 'export function Counter() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }\n'
    + 'export default function App() { return <Counter />; }\n');
  return dir;
}

test('ask 端到端：无快照 + 有源码 → 自动 refreshRepo 后作答（json-refreshed）', async () => {
  const proj = mkRealProject('auto-refresh-proj');
  const logFile = path.join(proj, 'prompt.log');
  const bin = mkFakeAgentBin(['codebuddy'], logFile);

  const r = await runCli(['ask', 'Q', '--cwd', proj, '--json'], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  assert.match(r.err, /未找到本体快照，自动执行 refreshRepo/);
  assert.match(r.err, /快照已重建: auto-refresh-proj（1 个源文件）/);

  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.equal(j.contextSource, 'json-refreshed');
  assert.equal(j.answer, 'FAKE_AGENT_ANSWER');

  // prompt 含刷新后的真实项目数据 + snapshot.json 与 SQLite 镜像双双落盘
  const prompt = fs.readFileSync(logFile, 'utf-8');
  assert.match(prompt, /- 名称: auto-refresh-proj/);
  assert.match(prompt, /- 源文件数: 1/);
  assert.ok(fs.existsSync(path.join(proj, '.nice-aos', 'data', 'snapshot.json')), 'JSON 快照落盘');
  assert.ok(fs.existsSync(path.join(proj, '.nice-aos', 'data', 'aos.sqlite')), 'SQLite 镜像落盘');
});

test('ask 端到端：空项目快照（fileCount=0）+ 有源码 → 自动刷新覆盖空快照', async () => {
  const proj = mkRealProject('real-behind-empty');
  const logFile = path.join(proj, 'prompt.log');
  const bin = mkFakeAgentBin(['codebuddy'], logFile);

  // 预置空项目快照（模拟扫错目录 / 空目录扫描产物）
  fs.mkdirSync(path.join(proj, '.nice-aos', 'data'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.nice-aos', 'data', 'snapshot.json'),
    JSON.stringify({ _meta: { objectCounts: { Project: 1 } }, Project: [{ id: 'proj:x', name: 'empty-project', fileCount: 0 }] }));

  const r = await runCli(['ask', 'ASDM架构', '--cwd', proj, '--json'], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  assert.match(r.err, /当前快照为空项目（0 个源文件），自动执行 refreshRepo/);

  const j = JSON.parse(r.out);
  assert.equal(j.contextSource, 'json-refreshed');
  const prompt = fs.readFileSync(logFile, 'utf-8');
  assert.match(prompt, /- 名称: real-behind-empty/, 'prompt 应含真实项目而非 empty-project');
  assert.doesNotMatch(prompt, /- 名称: empty-project/);
});

test('ask 端到端：真空目录 → 刷新后仍空，照常作答不 fail', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ask-void-'));
  const logFile = path.join(empty, 'prompt.log');
  const bin = mkFakeAgentBin(['codebuddy'], logFile);

  const r = await runCli(['ask', 'Q', '--cwd', empty, '--json'], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  assert.match(r.err, /未找到本体快照，自动执行 refreshRepo/);

  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.equal(j.contextSource, 'json-refreshed');
  // 上下文如实呈现空项目，AI 仍获作答（不做空数据拒绝）
  const prompt = fs.readFileSync(logFile, 'utf-8');
  assert.match(prompt, /- 源文件数: 0/);
  assert.match(prompt, /## 问题\nQ/);
});

// ---------- 端到端：有数据快照 + stale 镜像防护 ----------

test('ask 端到端：有数据快照 → 不刷新，直接查询（无 refreshRepo 日志）', async () => {
  const dir = mkFixture(); // fileCount=5 的有数据快照
  const logFile = path.join(dir, 'prompt.log');
  const bin = mkFakeAgentBin(['codebuddy'], logFile);

  const r = await runCli(['ask', 'Q', '--cwd', dir, '--json'], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  // 核心断言：有数据不触发空库自动刷新
  assert.doesNotMatch(r.err, /refreshRepo/);
  assert.doesNotMatch(r.err, /自动执行/);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.notEqual(j.contextSource, 'json-refreshed', '不应走刷新路径');
  const prompt = fs.readFileSync(logFile, 'utf-8');
  assert.match(prompt, /- 名称: ask-fixture/);
});

test('ask 端到端：stale 镜像（JSON 新于镜像水位）→ 回退 JSON 不读旧数据', async () => {
  const dir = mkFixture();
  // 先镜像（此时 JSON mtime = t0，水位 = t0）
  await runCli(['--snapshot-dir', path.join(dir, '.nice-aos', 'data'), 'storage', 'rebuild', '--kind', 'code']);
  // 模拟"刷新时镜像写失败"：外部改写 JSON（mtime 新于水位），SQLite 内容不变
  const dm = JSON.parse(fs.readFileSync(path.join(dir, '.nice-aos', 'data', 'snapshot.json'), 'utf-8'));
  dm.Project[0].name = 'updated-external';
  await new Promise((r) => setTimeout(r, 150)); // 确保 mtime 差超过容差
  fs.writeFileSync(path.join(dir, '.nice-aos', 'data', 'snapshot.json'), JSON.stringify(dm));

  const logFile = path.join(dir, 'prompt.log');
  const bin = mkFakeAgentBin(['codebuddy'], logFile);
  const r = await runCli(['ask', 'Q', '--cwd', dir, '--json'], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  const j = JSON.parse(r.out);
  assert.equal(j.contextSource, 'json', 'stale 镜像应回退 JSON');
  const prompt = fs.readFileSync(logFile, 'utf-8');
  assert.match(prompt, /- 名称: updated-external/, '上下文应反映 JSON 新数据');
});

test('ask 端到端：镜像新鲜（rebuild 后）→ 走 sqlite 且只读运行不洗白水位', async () => {
  const dir = mkFixture();
  const dataDir = path.join(dir, '.nice-aos', 'data');
  await runCli(['--snapshot-dir', dataDir, 'storage', 'rebuild', '--kind', 'code']);

  const logFile = path.join(dir, 'prompt.log');
  const bin = mkFakeAgentBin(['codebuddy'], logFile);
  const opts = { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } };

  // 第一次：走 sqlite
  const r1 = await runCli(['ask', 'Q', '--cwd', dir, '--json'], opts);
  assert.equal(JSON.parse(r1.out).contextSource, 'sqlite');
  // 第二次（只读运行后，WAL checkpoint 不更新水位）：仍走 sqlite
  const r2 = await runCli(['ask', 'Q', '--cwd', dir, '--json'], opts);
  assert.equal(JSON.parse(r2.out).contextSource, 'sqlite');
});

test('ask 端到端：codebuddy 超时降级到 opencode（未配置模型服务）', async () => {
  const dir = mkFixture();
  // codebuddy 挂起超时；opencode 正常应答
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ask-chain-'));
  fs.writeFileSync(path.join(bin, 'codebuddy'), '#!/bin/sh\nsleep 5\n');
  fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\necho "OPENCODE_ANSWER"\n');
  fs.chmodSync(path.join(bin, 'codebuddy'), 0o755);
  fs.chmodSync(path.join(bin, 'opencode'), 0o755);

  const r = await runCli(['ask', 'Q', '--cwd', dir, '--timeout', '600', '--json'], {
    env: {
      PATH: minimalPath(bin),
      // 未配置模型服务（cleanEnv 已剥 NICE_AOS_API_KEY 等）
    },
  });
  assert.equal(r.code, 0, `stderr: ${r.err}`);
  assert.match(r.err, /codebuddy 调用失败（codebuddy 调用超时（600ms）），降级到 opencode/);
  const j = JSON.parse(r.out);
  assert.equal(j.agent, 'opencode');
  assert.deepEqual(j.fallbackFrom, ['codebuddy']);
  assert.equal(j.answer, 'OPENCODE_ANSWER');
  assert.equal(j.model, undefined, '未配置模型服务时不应有 model 字段');
});

// ---------- 性能冒烟：buildAskContextFromSql（4 次 SQL） ----------

function bigFixture() {
  const dataMap = {
    _meta: { analyzerVersion: '0.32.0', objectCounts: { Project: 1, Module: 200, SourceFile: 3000, Dependency: 200 } },
    Project: [FIXTURE.Project[0]],
    Domain: Array.from({ length: 20 }, (_, i) => ({ id: `dom:d${i}`, name: `d${i}`, fileCount: 10, lineCount: 1000 })),
    Module: Array.from({ length: 200 }, (_, i) => ({ id: `mod:m${i}`, path: `src/m${i}`, fileCount: (i % 50) + 1, archLayerLabel: '共享层' })),
    SourceFile: Array.from({ length: 3000 }, (_, i) => ({ id: `file:src/f${i}.ts`, path: `src/f${i}.ts`, lineCount: 100, moduleId: `mod:m${i % 200}`, archLayer: 'shared' })),
    Dependency: Array.from({ length: 200 }, (_, i) => ({ id: `dep:pkg${i}`, name: `pkg${i}`, version: '^1.0.0' })),
  };
  return dataMap;
}

test('性能冒烟：SQLite 上下文构建 4 次 SQL（< 500ms，避免 12MB JSON.parse 全量路径）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ask-perf-'));
  setSnapshotDir(dir);
  setStorageMode('on');
  setSqlitePath(path.join(dir, 'aos.sqlite'));

  saveSnapshot({ kind: 'code', snapshotDir: dir, dataMap: bigFixture() });

  const t0 = performance.now();
  const ctx = buildAskContextFromSql({ kind: 'code', question: 'perf?' });
  const ms = performance.now() - t0;

  assert.ok(ctx, 'SQLite 可用时应返回 SQL 上下文');
  assert.match(ctx, /## 项目本体快照（SQL 预过滤）/);
  assert.match(ctx, /- 名称: ask-fixture/);
  assert.match(ctx, /## 问题\nperf\?$/);
  assert.ok(ms < 500, `SQL 上下文构建耗时 ${ms.toFixed(1)}ms（冒烟阈值 500ms，目标 < 50ms）`);

  closeDb();
});

// ---------- 单元：openaiCompat（本地 fake OpenAI 服务） ----------

function startFakeOpenAiServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('invokeApiChat：成功路径（Bearer 头 + messages 透传 + choices 解析）', async () => {
  let seenReq = null;
  const { srv, port } = await startFakeOpenAiServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seenReq = { auth: req.headers.authorization, body: JSON.parse(body) };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: `ANS:${seenReq.body.model}` } }] }));
    });
  });
  try {
    const out = await invokeApiChat({
      baseUrl: `http://127.0.0.1:${port}/chat/completions`,
      apiKey: 'sk-test-key',
      model: 'deepseek-chat',
      prompt: 'PROMPT-CONTENT',
      timeout: 5000,
    });
    assert.equal(out, 'ANS:deepseek-chat');
    assert.equal(seenReq.auth, 'Bearer sk-test-key');
    assert.deepEqual(seenReq.body.messages, [{ role: 'user', content: 'PROMPT-CONTENT' }]);
    assert.equal(seenReq.body.stream, false);
  } finally {
    srv.close();
  }
});

test('invokeApiChat：非 2xx → 明确错误（状态码 + 响应体片段）', async () => {
  const { srv, port } = await startFakeOpenAiServer((req, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
  });
  try {
    await assert.rejects(
      () => invokeApiChat({ baseUrl: `http://127.0.0.1:${port}/x`, apiKey: 'k', model: 'm', prompt: 'p', timeout: 5000 }),
      /模型服务返回 401.*Invalid API key/,
    );
  } finally {
    srv.close();
  }
});

test('invokeApiChat：服务端无响应 → 超时错误', async () => {
  const { srv, port } = await startFakeOpenAiServer(() => { /* hold */ });
  try {
    await assert.rejects(
      () => invokeApiChat({ baseUrl: `http://127.0.0.1:${port}/x`, apiKey: 'k', model: 'm', prompt: 'p', timeout: 300 }),
      /模型服务调用超时（300ms）: m/,
    );
  } finally {
    srv.close();
  }
});

test('invokeApiChat：缺参校验', async () => {
  await assert.rejects(() => invokeApiChat({}), /缺少 baseUrl/);
  await assert.rejects(() => invokeApiChat({ baseUrl: 'u' }), /缺少 apiKey/);
  await assert.rejects(() => invokeApiChat({ baseUrl: 'u', apiKey: 'k' }), /缺少 model/);
});

// ---------- 单元：askConfig（加密存取 + 环境变量覆盖） ----------

function withConfigDir(dir, fn) {
  const prev = process.env.NICE_AOS_CONFIG_DIR;
  process.env.NICE_AOS_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.NICE_AOS_CONFIG_DIR;
    else process.env.NICE_AOS_CONFIG_DIR = prev;
  }
}

test('askConfig：加密往返 + 密文不含明文 + keyring 权限 600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfg-'));
  withConfigDir(dir, () => {
    const enc = encryptSecret('sk-plain-secret-123');
    assert.match(enc, /^enc:v1:/);
    assert.ok(!enc.includes('plain-secret'));
    assert.equal(decryptSecret(enc), 'sk-plain-secret-123');
    // keyring 文件存在且权限 0600（POSIX）
    const keyring = path.join(dir, '.keyring');
    assert.ok(fs.existsSync(keyring));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(keyring).mode & 0o777, 0o600);
    }
  });
});

test('askConfig：saveAskConfig 落盘加密，loadAskConfig 解出；env 覆盖优先', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfg-'));
  withConfigDir(dir, () => {
    // 预置填充在 CLI 层（ask config set）完成，存储层按显式字段保存
    saveAskConfig({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
      apiKey: 'sk-file-key-abc12345',
    });
    const raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf-8');
    assert.ok(!raw.includes('sk-file-key-abc12345'), '配置文件不得含明文 key');

    const cfg = loadAskConfig();
    assert.equal(cfg.provider, 'deepseek');
    assert.equal(cfg.model, 'deepseek-chat');
    assert.equal(cfg.apiKey, 'sk-file-key-abc12345');
    assert.equal(cfg.apiKeySource, 'file');

    // env 覆盖 model + key
    process.env.NICE_AOS_MODEL = 'deepseek-reasoner';
    process.env.NICE_AOS_API_KEY = 'sk-env-key-xyz98765';
    try {
      const cfg2 = loadAskConfig();
      assert.equal(cfg2.model, 'deepseek-reasoner');
      assert.equal(cfg2.apiKey, 'sk-env-key-xyz98765');
      assert.equal(cfg2.apiKeySource, 'env');
    } finally {
      delete process.env.NICE_AOS_MODEL;
      delete process.env.NICE_AOS_API_KEY;
    }
  });
});

test('askConfig：未配置返回 null；maskApiKey 掩码', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfg-'));
  withConfigDir(dir, () => {
    assert.equal(loadAskConfig(), null);
    assert.equal(maskApiKey('sk-abcd1234wxyz'), 'sk-ab****wxyz');
    assert.equal(maskApiKey('short'), '****');
  });
});

// ---------- 端到端：降级链 + ask config CLI ----------

// 最小 PATH：含 fake bin + 系统目录，排除宿主安装的真实 codebuddy/opencode
function minimalPath(fakeBin) {
  return `${fakeBin}${path.delimiter}/usr/bin:/bin`;
}

// 挂起的 fake codebuddy（触发超时降级）
function mkTimeoutAgentBin() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ask-tbin-'));
  const script = path.join(bin, 'codebuddy');
  fs.writeFileSync(script, '#!/bin/sh\nsleep 5\n');
  fs.chmodSync(script, 0o755);
  return bin;
}

test('ask 端到端：CLI 超时自动降级到模型服务（fake server）', async () => {
  const dir = mkFixture();
  const bin = mkTimeoutAgentBin();
  let lastPayload = null;
  const { srv, port } = await startFakeOpenAiServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastPayload = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'API_FALLBACK_ANSWER' } }] }));
    });
  });
  try {
    const r = await runCli(['ask', '降级链测试?', '--cwd', dir, '--timeout', '600', '--json'], {
      env: {
        PATH: minimalPath(bin),
        NICE_AOS_API_KEY: 'sk-e2e-key',
        NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`,
        NICE_AOS_MODEL: 'deepseek-chat',
      },
    });
    assert.equal(r.code, 0, `stderr: ${r.err}`);
    assert.match(r.err, /codebuddy 调用失败（codebuddy 调用超时（600ms）），降级到 模型服务（deepseek-chat）/);
    const j = JSON.parse(r.out);
    assert.equal(j.ok, true);
    assert.equal(j.agent, 'api');
    assert.equal(j.model, 'deepseek-chat');
    assert.deepEqual(j.fallbackFrom, ['codebuddy']);
    assert.equal(j.answer, 'API_FALLBACK_ANSWER');
    // 服务端收到的 prompt 含上下文 + 问题节
    assert.match(lastPayload.messages[0].content, /## 项目本体快照/);
    assert.match(lastPayload.messages[0].content, /## 问题\n降级链测试\?/);
    assert.equal(lastPayload.model, 'deepseek-chat');
  } finally {
    srv.close();
  }
});

test('ask 端到端：--agent api 直连模型服务', async () => {
  const dir = mkFixture();
  const { srv, port } = await startFakeOpenAiServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'DIRECT_API_ANSWER' } }] }));
  });
  try {
    // PATH 无任何 CLI（最小系统 PATH），--agent api 不依赖 CLI 探测
    const r = await runCli(['ask', 'Q', '--cwd', dir, '--agent', 'api', '--json'], {
      env: {
        PATH: minimalPath(''),
        NICE_AOS_API_KEY: 'sk-e2e-key',
        NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`,
        NICE_AOS_MODEL: 'deepseek-chat',
      },
    });
    assert.equal(r.code, 0, `stderr: ${r.err}`);
    const j = JSON.parse(r.out);
    assert.equal(j.agent, 'api');
    assert.equal(j.answer, 'DIRECT_API_ANSWER');
    assert.equal(j.fallbackFrom, undefined, '直连不应有降级记录');
  } finally {
    srv.close();
  }
});

test('ask 端到端：--agent api 未配置 → 明确报错指引', async () => {
  const dir = mkFixture();
  const r = await runCli(['ask', 'Q', '--cwd', dir, '--agent', 'api'], {
    env: { PATH: minimalPath('') },
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /未配置模型服务/);
  assert.match(r.err, /ask config set --provider deepseek/);
});

test('ask 端到端：无 CLI 且无模型服务 → 提示两条出路', async () => {
  const dir = mkFixture();
  const r = await runCli(['ask', 'Q', '--cwd', dir], {
    env: { PATH: minimalPath('') },
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /未检测到可用的 AI CLI/);
  assert.match(r.err, /ask config set/);
});

test('ask 端到端：config set/show/unset 全流程（密钥加密 + 掩码）', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfg-e2e-'));
  const env = { NICE_AOS_CONFIG_DIR: cfgDir };

  // set：deepseek 预置填充 base-url/model
  const r1 = await runCli(['ask', 'config', 'set', '--provider', 'deepseek', '--api-key', 'sk-e2e-roundtrip-999'], { env });
  assert.equal(r1.code, 0, `stderr: ${r1.err}`);
  const j1 = JSON.parse(r1.out);
  assert.equal(j1.saved.provider, 'deepseek');
  assert.equal(j1.saved.baseUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(j1.saved.model, 'deepseek-chat');

  // 落盘密文：不含明文
  const raw = fs.readFileSync(path.join(cfgDir, 'config.json'), 'utf-8');
  assert.ok(!raw.includes('sk-e2e-roundtrip-999'), '配置文件不得含明文 key');
  assert.match(raw, /enc:v1:/);

  // show：掩码 + 生效配置
  const r2 = await runCli(['ask', 'config', 'show'], { env });
  assert.equal(r2.code, 0);
  const j2 = JSON.parse(r2.out);
  assert.equal(j2.configured, true);
  assert.equal(j2.model, 'deepseek-chat');
  assert.match(j2.apiKey, /^sk-e2\*\*\*\*-999$/);
  assert.equal(j2.apiKeySource, 'file');

  // unset → show 未配置
  const r3 = await runCli(['ask', 'config', 'unset'], { env });
  assert.equal(r3.code, 0);
  const r4 = await runCli(['ask', 'config', 'show'], { env });
  const j4 = JSON.parse(r4.out);
  assert.equal(j4.configured, false);
});

test('ask 端到端：config set 未知 provider / 无参数 → 报错', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-cfg-e2e-'));
  const env = { NICE_AOS_CONFIG_DIR: cfgDir };
  const r1 = await runCli(['ask', 'config', 'set', '--provider', 'nope'], { env });
  assert.equal(r1.code, 1);
  assert.match(r1.err, /未知 provider: nope/);
  const r2 = await runCli(['ask', 'config', 'set'], { env });
  assert.equal(r2.code, 1);
  assert.match(r2.err, /无可更新项/);
});

// ---------- 端到端：--stream 流式输出（ask-1） ----------

test('ask 端到端：--stream + --agent api + --json → streamed=true + 完整 answer + stream:true', async () => {
  const dir = mkFixture();
  let lastPayload = null;
  const { srv, port } = await startFakeOpenAiServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastPayload = JSON.parse(body);
      res.setHeader('content-type', 'text/event-stream');
      // 模拟 OpenAI 兼容流式响应
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.end();
    });
  });
  try {
    const r = await runCli(['ask', 'Q', '--cwd', dir, '--agent', 'api', '--stream', '--json'], {
      env: {
        PATH: minimalPath(''),
        NICE_AOS_API_KEY: 'sk-stream-test',
        NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`,
        NICE_AOS_MODEL: 'test-stream',
      },
    });
    assert.equal(r.code, 0, `stderr: ${r.err}`);
    const j = JSON.parse(r.out);
    assert.equal(j.agent, 'api');
    assert.equal(j.streamed, true, 'JSON 应含 streamed=true');
    assert.equal(j.answer, '你好', 'answer 应是 token 顺序拼接的完整文本');
    // 服务端收到的 stream 应是 true
    assert.equal(lastPayload.stream, true, '流式调用应传 stream:true');
  } finally {
    srv.close();
  }
});

test('ask 端到端：--stream + --agent api（无 --json）→ token 实时到 stdout', async () => {
  const dir = mkFixture();
  const { srv, port } = await startFakeOpenAiServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  try {
    const r = await runCli(['ask', 'Q', '--cwd', dir, '--agent', 'api', '--stream'], {
      env: {
        PATH: minimalPath(''),
        NICE_AOS_API_KEY: 'sk-stream-test',
        NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`,
        NICE_AOS_MODEL: 'test-stream',
      },
    });
    assert.equal(r.code, 0, `stderr: ${r.err}`);
    // token 应在 stdout 中按顺序出现（不被合并到一行 JSON）
    assert.match(r.out, /你好 world/, 'stdout 应含 token 拼接的完整文本');
    // 不应输出 JSON 块（无 --json）
    assert.equal(r.out.includes('"answer"'), false, '非 JSON 模式不应输出 JSON 字段');
  } finally {
    srv.close();
  }
});

test('ask 端到端：--stream + CLI agent → 提示降级 + 走同步路径', async () => {
  // fake codebuddy 立即成功返回固定文本（同步路径）
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-stream-cli-'));
  const script = path.join(bin, 'codebuddy');
  fs.writeFileSync(script, '#!/bin/sh\necho CLI_STREAM_FALLBACK\n');
  fs.chmodSync(script, 0o755);
  try {
    const dir = mkFixture();
    const r = await runCli(['ask', 'Q', '--cwd', dir, '--agent', 'codebuddy', '--stream'], {
      env: { PATH: `${bin}${path.delimiter}/usr/bin:/bin` },
    });
    assert.equal(r.code, 0);
    // 降级提示应在 stderr
    assert.match(r.err, /不支持流式/);
    // CLI agent 实际回答应仍在 stdout（同步打印完整文本）
    assert.match(r.out, /CLI_STREAM_FALLBACK/);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('ask 端到端：--stream + api 流式 0 token → 报错且降级链路工作', async () => {
  const dir = mkFixture();
  const { srv, port } = await startFakeOpenAiServer((req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{}}]}\n\n'); // 0 content
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const r = await runCli(['ask', 'Q', '--cwd', dir, '--agent', 'api', '--stream', '--json'], {
      env: {
        PATH: minimalPath(''),
        NICE_AOS_API_KEY: 'sk-test',
        NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`,
        NICE_AOS_MODEL: 'test-empty',
      },
    });
    // 0 token → invokeApiChatStream 抛错；chain 失败后应再尝试 fallback（无则 exit=1）
    // 这里 chain 只含 api 一个；最后错误应透出到 stderr
    assert.equal(r.code, 1);
    assert.match(r.err, /无有效 token/);
  } finally {
    srv.close();
  }
});

// ---------- 端到端：--session 多轮会话（ask-2） ----------

test('ask 端到端：--session <id> 第 1 轮 → prompt 不含历史 + 写入 session jsonl', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sess-cfg-'));
  try {
    const dir = mkFixture();
    const { srv, port } = await startFakeOpenAiServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'ROUND1_ANS' } }] }));
      });
    });
    try {
      const r = await runCli(['ask', 'Q1', '--cwd', dir, '--agent', 'api', '--session', 'sess-1', '--json'], {
        env: {
          PATH: minimalPath(''),
          NICE_AOS_CONFIG_DIR: cfgDir,
          NICE_AOS_API_KEY: 'sk-test',
          NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`,
          NICE_AOS_MODEL: 'test',
        },
      });
      assert.equal(r.code, 0, `stderr: ${r.err}`);
      const j = JSON.parse(r.out);
      assert.equal(j.answer, 'ROUND1_ANS');
      assert.equal(j.session.id, 'sess-1');
      assert.equal(j.session.turnCount, 1);

      // session jsonl 应被写入
      const sessionFile = path.join(cfgDir, 'sessions', 'sess-1.jsonl');
      assert.ok(fs.existsSync(sessionFile), 'session jsonl 应存在');
      const lines = fs.readFileSync(sessionFile, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 1);
      const rec = JSON.parse(lines[0]);
      assert.equal(rec.question, 'Q1');
      assert.equal(rec.answer, 'ROUND1_ANS');
      assert.equal(rec.agent, 'api');
      assert.equal(rec.model, 'test');
    } finally {
      srv.close();
    }
  } finally {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('ask 端到端：--session <id> 续聊 → prompt 含历史 + turnCount=2', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sess-cfg-'));
  try {
    const dir = mkFixture();
    let lastPrompt = null;
    let callCount = 0;
    const { srv, port } = await startFakeOpenAiServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        callCount += 1;
        lastPrompt = JSON.parse(body).messages[0].content;
        const ans = callCount === 1 ? 'ROUND1_ANS' : 'ROUND2_ANS';
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: ans } }] }));
      });
    });
    try {
      // 第 1 轮
      const r1 = await runCli(['ask', 'first question', '--cwd', dir, '--agent', 'api', '--session', 'sess-2', '--json'], {
        env: {
          PATH: minimalPath(''),
          NICE_AOS_CONFIG_DIR: cfgDir,
          NICE_AOS_API_KEY: 'sk-test',
          NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`,
          NICE_AOS_MODEL: 'test',
        },
      });
      assert.equal(r1.code, 0, `r1 stderr: ${r1.err}`);
      assert.equal(JSON.parse(r1.out).answer, 'ROUND1_ANS');
      // 第 2 轮：续聊
      const r2 = await runCli(['ask', 'follow up', '--cwd', dir, '--agent', 'api', '--session', 'sess-2', '--json'], {
        env: {
          PATH: minimalPath(''),
          NICE_AOS_CONFIG_DIR: cfgDir,
          NICE_AOS_API_KEY: 'sk-test',
          NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`,
          NICE_AOS_MODEL: 'test',
        },
      });
      assert.equal(r2.code, 0, `r2 stderr: ${r2.err}`);
      const j = JSON.parse(r2.out);
      assert.equal(j.answer, 'ROUND2_ANS');
      assert.equal(j.session.turnCount, 2);

      // 第 2 轮 prompt 应含历史
      assert.match(lastPrompt, /## 对话历史（session: sess-2/);
      assert.match(lastPrompt, /\*\*用户\*\*: first question/);
      assert.match(lastPrompt, /\*\*助手\*\*: ROUND1_ANS/);
      assert.match(lastPrompt, /## 当前问题\nfollow up/);

      // session 文件应有 2 行
      const lines = fs.readFileSync(path.join(cfgDir, 'sessions', 'sess-2.jsonl'), 'utf-8').trim().split('\n');
      assert.equal(lines.length, 2);
    } finally {
      srv.close();
    }
  } finally {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('ask 端到端：--session-max-turns → prompt 只带最近 N 轮', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sess-cfg-'));
  try {
    const dir = mkFixture();
    let lastPrompt = null;
    const { srv, port } = await startFakeOpenAiServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        lastPrompt = JSON.parse(body).messages[0].content;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'ANS' } }] }));
      });
    });
    try {
      // 连发 3 轮，每轮问题唯一可识别
      for (const q of ['q-one', 'q-two', 'q-three']) {
        await runCli(['ask', q, '--cwd', dir, '--agent', 'api', '--session', 'sess-mt', '--json'], {
          env: {
            PATH: minimalPath(''),
            NICE_AOS_CONFIG_DIR: cfgDir,
            NICE_AOS_API_KEY: 'sk-test',
            NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`,
            NICE_AOS_MODEL: 'test',
          },
        });
      }
      // 第 4 轮带 --session-max-turns 1
      await runCli(['ask', 'q-four', '--cwd', dir, '--agent', 'api', '--session', 'sess-mt', '--session-max-turns', '1', '--json'], {
        env: {
          PATH: minimalPath(''),
          NICE_AOS_CONFIG_DIR: cfgDir,
          NICE_AOS_API_KEY: 'sk-test',
          NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`,
          NICE_AOS_MODEL: 'test',
        },
      });
      // 提示应含 skipNote + 只有 q-three 历史
      assert.match(lastPrompt, /已省略前 2 轮/);
      assert.match(lastPrompt, /\*\*用户\*\*: q-three/);
      assert.doesNotMatch(lastPrompt, /\*\*用户\*\*: q-one/);
      assert.match(lastPrompt, /## 当前问题\nq-four/);
    } finally {
      srv.close();
    }
  } finally {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('ask 端到端：不同 session id 互不干扰（隔离）', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sess-cfg-'));
  try {
    const dir = mkFixture();
    const { srv, port } = await startFakeOpenAiServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'X' } }] }));
    });
    try {
      await runCli(['ask', 'A1', '--cwd', dir, '--agent', 'api', '--session', 'a', '--json'], {
        env: { PATH: minimalPath(''), NICE_AOS_CONFIG_DIR: cfgDir, NICE_AOS_API_KEY: 'k', NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`, NICE_AOS_MODEL: 'm' },
      });
      await runCli(['ask', 'B1', '--cwd', dir, '--agent', 'api', '--session', 'b', '--json'], {
        env: { PATH: minimalPath(''), NICE_AOS_CONFIG_DIR: cfgDir, NICE_AOS_API_KEY: 'k', NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`, NICE_AOS_MODEL: 'm' },
      });
      const aLines = fs.readFileSync(path.join(cfgDir, 'sessions', 'a.jsonl'), 'utf-8').trim().split('\n');
      const bLines = fs.readFileSync(path.join(cfgDir, 'sessions', 'b.jsonl'), 'utf-8').trim().split('\n');
      assert.equal(aLines.length, 1);
      assert.equal(bLines.length, 1);
      assert.equal(JSON.parse(aLines[0]).question, 'A1');
      assert.equal(JSON.parse(bLines[0]).question, 'B1');
    } finally {
      srv.close();
    }
  } finally {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});

test('ask 端到端：--session 非法 id → fail', async () => {
  const dir = mkFixture();
  const r = await runCli(['ask', 'Q', '--cwd', dir, '--agent', 'api', '--session', '../escape'], {
    env: { PATH: minimalPath('') },
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /非法的 session id/);
});

// ask session list/clear 子命令在 v0.33.0 精简时移除（CLI 入口收敛）；
// 底层 listSessions / clearSession 仍由 askSession.js 模块 export，外部脚本可 import 复用。
// 验证模块 API 自身可用，等价替代 CLI 子命令：
test('askSession.listSessions / clearSession 模块 API 等价于被移除的 CLI 子命令', async () => {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-sess-cfg-'));
  try {
    const dir = mkFixture();
    const { srv, port } = await startFakeOpenAiServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'Y' } }] }));
    });
    try {
      // 创建 2 个 session（通过 ask --session 落到 cfgDir/sessions/ 下）
      await runCli(['ask', 'A', '--cwd', dir, '--agent', 'api', '--session', 'sa', '--json'], {
        env: { PATH: minimalPath(''), NICE_AOS_CONFIG_DIR: cfgDir, NICE_AOS_API_KEY: 'k', NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`, NICE_AOS_MODEL: 'm' },
      });
      await runCli(['ask', 'B', '--cwd', dir, '--agent', 'api', '--session', 'sb', '--json'], {
        env: { PATH: minimalPath(''), NICE_AOS_CONFIG_DIR: cfgDir, NICE_AOS_API_KEY: 'k', NICE_AOS_BASE_URL: `http://127.0.0.1:${port}/chat/completions`, NICE_AOS_MODEL: 'm' },
      });

      const sessionsMod = await import('../src/cli/commands/askSession.js');
      // listSessions / clearSession 通过 process.env.NICE_AOS_CONFIG_DIR 读路径；
      // 子进程 CLI 调用已写文件到 cfgDir/sessions/，父进程 import 模块后需临时切到 cfgDir
      const origCfg = process.env.NICE_AOS_CONFIG_DIR;
      process.env.NICE_AOS_CONFIG_DIR = cfgDir;
      try {
        // listSessions
        const list = sessionsMod.listSessions();
        assert.equal(list.length, 2);
        const ids = list.map((s) => s.id).sort();
        assert.deepEqual(ids, ['sa', 'sb']);
        for (const s of list) assert.equal(s.turnCount, 1);

        // clearSession
        const removed = sessionsMod.clearSession('sa');
        assert.equal(removed, true);
        assert.equal(fs.existsSync(path.join(cfgDir, 'sessions', 'sa.jsonl')), false);

        // 再次 clear → false
        const removed2 = sessionsMod.clearSession('sa');
        assert.equal(removed2, false);
      } finally {
        if (origCfg === undefined) delete process.env.NICE_AOS_CONFIG_DIR;
        else process.env.NICE_AOS_CONFIG_DIR = origCfg;
      }
    } finally {
      srv.close();
    }
  } finally {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  }
});
