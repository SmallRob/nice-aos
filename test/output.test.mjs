// output 别名测试：output 是 export 的 commander alias，行为必须完全等价。
// 三大核心命令（ask / output / serve）的产品定位由该别名统一。
//
// 包含 out-1 增量导出（--since）的端到端测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

const SNAP = {
  _meta: { generatedAt: '2026-08-22T00:00:00.000Z', cycles: [], orphanCandidates: [], objectCounts: { Project: 1, SourceFile: 2, Component: 3, Method: 5, Dependency: 1 } },
  Project: [{
    id: 'proj:fixture', name: 'output-alias-fixture', framework: 'react', branch: 'main',
    fileCount: 2,
    commitHash: 'abc1234567',
    summary: '示例项目',
    architecture: { styleLabel: '分层架构', layerCount: 4, domainCount: 3 },
    health: { cycles: 0, deadCandidateCount: 1, undeclaredDeps: 0 },
  }],
  SourceFile: [{ id: 'file:src/a.ts' }, { id: 'file:src/b.ts' }],
  Component: [{ id: 'comp:1' }, { id: 'comp:2' }, { id: 'comp:3' }],
  Method: [{ id: 'm:1' }, { id: 'm:2' }, { id: 'm:3' }, { id: 'm:4' }, { id: 'm:5' }],
  Dependency: [{ id: 'd:1' }],
};

function runCli(args, cwd, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', cwd, env: { ...process.env, ...env } });
}

function mkFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-output-'));
  fs.mkdirSync(path.join(dir, '.nice-aos', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nice-aos', 'data', 'snapshot.json'), JSON.stringify(SNAP));
  return dir;
}

test('output 顶层别名：--help 中 export/output 同一行展示', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0, `nice-aos --help 应成功; stderr=${r.stderr}`);
  // commander v11 的 alias 会让命令显示为 "export|output ..."
  assert.match(r.stdout, /export\|output/, '顶层 --help 应展示 "export|output" 形式（commander alias 行为）');
});

test('output 与 export --help 等价：选项集完全一致', () => {
  const out = runCli(['output', '--help']);
  const exp = runCli(['export', '--help']);
  assert.equal(out.status, 0);
  assert.equal(exp.status, 0);
  // commander 在 alias 场景下 --help 应等价；对比去除 "Usage:" 行后的选项块
  const stripUsage = (s) => s.split('\n').filter((l) => !/^Usage:/.test(l)).join('\n');
  assert.equal(stripUsage(out.stdout), stripUsage(exp.stdout), 'output --help 应与 export --help 内容完全一致（除 Usage 行）');
});

test('output 命令在 --help 命令列表里', () => {
  const r = runCli(['--help']);
  // 即使 commander v11 不一定把 alias 也单独列出来，至少 export|output 必须存在
  assert.match(r.stdout, /export\|output/);
  // ask / serve 也必须存在（三大核心叙事）
  assert.match(r.stdout, /\bask\b/);
  assert.match(r.stdout, /\bserve\b/);
});

test('output --format viewmodel 产出与 export 等价（commander alias）', () => {
  const dir = mkFixture();
  const out = runCli(['output', '--format', 'viewmodel'], dir);
  const exp = runCli(['export', '--format', 'viewmodel'], dir);
  assert.equal(out.status, 0, `output --format viewmodel 应成功; stderr=${out.stderr}`);
  assert.equal(exp.status, 0, `export --format viewmodel 应成功; stderr=${exp.stderr}`);
  // 两者都应输出可解析的 viewModel JSON
  const outJson = JSON.parse(out.stdout);
  const expJson = JSON.parse(exp.stdout);
  assert.equal(typeof outJson, 'object');
  // output 与 export 应完全等价（commander alias 行为）
  assert.equal(JSON.stringify(outJson), JSON.stringify(expJson), 'viewmodel output 与 export 输出应一致');
});

test('output --format markdown 写入文件与 export 等价', () => {
  const dir = mkFixture();
  const outPath = path.join(dir, 'out-via-output.md');
  const expPath = path.join(dir, 'out-via-export.md');
  const out = runCli(['output', '--format', 'markdown', '--output', outPath], dir);
  const exp = runCli(['export', '--format', 'markdown', '--output', expPath], dir);
  assert.equal(out.status, 0);
  assert.equal(exp.status, 0);
  const outContent = fs.readFileSync(outPath, 'utf-8');
  const expContent = fs.readFileSync(expPath, 'utf-8');
  // markdown 报告含 _meta 派生信息；同一快照下两者应完全一致
  assert.equal(outContent, expContent, 'markdown 报告内容应完全一致');
  assert.match(outContent, /output-alias-fixture/, '报告应包含项目名');
});

test('output 未知格式与 export 一样报 exit=1', () => {
  const dir = mkFixture();
  const out = runCli(['output', '--format', 'pdf'], dir);
  const exp = runCli(['export', '--format', 'pdf'], dir);
  assert.equal(out.status, 1);
  assert.equal(exp.status, 1);
  assert.match(out.stderr, /未知格式/);
  assert.match(exp.stderr, /未知格式/);
});

// ---------- out-1 增量导出（--since） ----------

// 在 tmp dir 建一个真 git 仓库 + snapshot，让 export --since 能跑通
function mkGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-since-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@test.com']);
  run(['config', 'user.name', 'Test']);
  // 初始 commit（含 .gitignore 隔离 .nice-aos/ 避免未跟踪文件干扰 --since 测试）
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;');
  fs.writeFileSync(path.join(dir, 'src/b.ts'), 'export const b = 2;');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.nice-aos/\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);

  // 写一个"含 src/a.ts 与 src/b.ts"的本体快照
  fs.mkdirSync(path.join(dir, '.nice-aos', 'data'), { recursive: true });
  const snap = {
    _meta: { generatedAt: '2026-08-22T00:00:00.000Z', cycles: [], orphanCandidates: [], objectCounts: { SourceFile: 2, Component: 1 } },
    Project: [{ id: 'proj:since', name: 'since-fixture', framework: 'react', branch: 'main' }],
    SourceFile: [{ id: 'file:src/a.ts' }, { id: 'file:src/b.ts' }],
    Component: [{ id: 'comp:A', name: 'A', filePath: 'src/a.ts' }],
  };
  fs.writeFileSync(path.join(dir, '.nice-aos', 'data', 'snapshot.json'), JSON.stringify(snap));
  return { dir, run };
}

test('output --since HEAD 增量导出：列出工作区未暂存变更', () => {
  const { dir, run } = mkGitFixture();
  // 改 a.ts + 新增 c.ts（不 add，保持工作区未暂存）
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 999;');
  fs.writeFileSync(path.join(dir, 'src/c.ts'), 'export const c = 3;');
  const r = runCli(['output', '--format', 'markdown', '--since', 'HEAD', '--output', path.join(dir, 'out.md')], dir);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = fs.readFileSync(path.join(dir, 'out.md'), 'utf-8');
  assert.match(out, /增量变更摘要（since HEAD/);
  // 应列出 a.ts 和 c.ts
  assert.match(out, /`src\/a\.ts`/);
  assert.match(out, /`src\/c\.ts`/);
  // 涉及对象：comp:A @ src/a.ts
  assert.match(out, /comp:A/);
  // 涉及文件计数
  assert.match(out, /涉及文件: \*\*2\*\* 个/);
  assert.match(out, /涉及对象: \*\*1\*\* 个/);
  // stderr 应打印涉及统计
  assert.match(r.stderr, /since=HEAD 涉及 2 文件 \/ 1 对象/);
});

test('output --since HEAD~1..HEAD 增量导出：列出 2 个 commit 间变更', () => {
  const { dir, run } = mkGitFixture();
  // 第二个 commit：改 b.ts
  fs.writeFileSync(path.join(dir, 'src/b.ts'), 'export const b = 999;');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'second']);
  // 此时 HEAD~1..HEAD 应只含 b.ts
  const r = runCli(['output', '--format', 'markdown', '--since', 'HEAD~1..HEAD', '--output', path.join(dir, 'out.md')], dir);
  assert.equal(r.status, 0);
  const out = fs.readFileSync(path.join(dir, 'out.md'), 'utf-8');
  assert.match(out, /增量变更摘要（since HEAD~1\.\.HEAD/);
  assert.match(out, /`src\/b\.ts`/);
  assert.doesNotMatch(out, /`src\/a\.ts`/);
});

test('output --since 不传 ref（git 空差异）→ 节存在但 0 文件', () => {
  const { dir } = mkGitFixture();
  // 没新 commit，工作区也没改
  const r = runCli(['output', '--format', 'markdown', '--since', 'HEAD', '--output', path.join(dir, 'out.md')], dir);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = fs.readFileSync(path.join(dir, 'out.md'), 'utf-8');
  assert.match(out, /增量变更摘要/);
  assert.match(out, /无变更文件/);
});

test('output --since 非法 spec → 报错', () => {
  const { dir } = mkGitFixture();
  const r = runCli(['output', '--format', 'markdown', '--since', 'abc;rm', '--output', path.join(dir, 'out.md')], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /非法的 --since spec/);
});

test('output --since 在非 git 目录 → 报错', () => {
  const dir = mkFixture(); // mkFixture 不建 .git
  const r = runCli(['output', '--format', 'markdown', '--since', 'HEAD', '--output', path.join(dir, 'out.md')], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /未找到 \.git 目录/);
});

test('output 不传 --since → 报告不含"增量变更摘要"节（向后兼容）', () => {
  const dir = mkFixture();
  const r = runCli(['output', '--format', 'markdown', '--output', path.join(dir, 'out.md')], dir);
  assert.equal(r.status, 0);
  const out = fs.readFileSync(path.join(dir, 'out.md'), 'utf-8');
  assert.doesNotMatch(out, /增量变更摘要/);
});

test('output --since 配套 --staged → 仅已暂存', () => {
  const { dir, run } = mkGitFixture();
  // 改两个文件，只 add 一个
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 999;');
  fs.writeFileSync(path.join(dir, 'src/b.ts'), 'export const b = 999;');
  run(['add', 'src/a.ts']);
  const r = runCli(['output', '--format', 'markdown', '--since', 'HEAD', '--staged', '--output', path.join(dir, 'out.md')], dir);
  assert.equal(r.status, 0);
  const out = fs.readFileSync(path.join(dir, 'out.md'), 'utf-8');
  assert.match(out, /增量变更摘要（since HEAD \[staged\]/);
  // 只含已暂存 a.ts，不含 b.ts
  assert.match(out, /`src\/a\.ts`/);
  assert.doesNotMatch(out, /`src\/b\.ts`/);
});

// ---------- out-2 自定义模板（--template） ----------

test('output --template <path>：模板占位符替换', () => {
  const dir = mkFixture();
  // 写个简单模板到 tmp
  const tplPath = path.join(dir, 'tpl.md');
  fs.writeFileSync(tplPath, [
    '# {{Project.name}}',
    '',
    '框架: {{Project.framework}}',
    '源文件数: {{Project.fileCount}}',
    '组件数: {{stats.Component}}',
    '依赖数: {{stats.Dependency}}',
    '总对象: {{ObjectCounts.Project}}',
    '组件数（_meta）: {{_meta.objectCounts.SourceFile}}',
    '缺字段: {{NonExistent.key}}',
  ].join('\n'));
  const r = runCli(['output', '--format', 'markdown', '--template', tplPath, '--output', path.join(dir, 'out.md')], dir);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = fs.readFileSync(path.join(dir, 'out.md'), 'utf-8');
  assert.match(out, /^# output-alias-fixture/m);
  assert.match(out, /框架: react/);
  assert.match(out, /源文件数: \d+/);
  assert.match(out, /组件数: \d+/);
  assert.match(out, /依赖数: \d+/);
  assert.match(out, /总对象: \d+/);
  assert.match(out, /组件数（_meta）: \d+/);
  assert.match(out, /缺字段: \(unknown:NonExistent\.key\)/);
});

// 内置 architecture.md.tpl 在 v0.33.0 精简时移除（themes/templates/ 整目录删除；
// 用户使用 --template 时显式给绝对路径或相对路径即可）——相关测试已下线。
test('output --template 模板文件不存在 → 报错', () => {
  const dir = mkFixture();
  const r = runCli(['output', '--format', 'markdown', '--template', '/tmp/nonexistent-tpl-xyz.md', '--output', path.join(dir, 'out.md')], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--template 模板文件不存在/);
});

test('output 不传 --template → 默认走 exportToMarkdown（含完整章节）', () => {
  const dir = mkFixture();
  const r = runCli(['output', '--format', 'markdown', '--output', path.join(dir, 'out.md')], dir);
  assert.equal(r.status, 0);
  const out = fs.readFileSync(path.join(dir, 'out.md'), 'utf-8');
  // 默认报告含代码本体快照标题
  assert.match(out, /# output-alias-fixture 代码本体快照/);
  // 不含模板占位符
  assert.doesNotMatch(out, /\{\{/);
});

test('output --format json + --template：json 不走模板（--template 被忽略）', () => {
  const dir = mkFixture();
  const tplPath = path.join(dir, 'tpl.md');
  fs.writeFileSync(tplPath, 'NAME={{Project.name}}');
  const r = runCli(['output', '--format', 'json', '--template', tplPath, '--output', path.join(dir, 'out.json')], dir);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = fs.readFileSync(path.join(dir, 'out.json'), 'utf-8');
  const j = JSON.parse(out);
  // json 输出应是 dataMap，不应含模板占位符
  assert.equal(j.Project[0].name, 'output-alias-fixture');
  assert.doesNotMatch(out, /\{\{/);
});
