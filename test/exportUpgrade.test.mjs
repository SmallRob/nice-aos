// output 命令 v0.34.0 升级单测：
//   - out-4 filterObjectTypes：include/exclude/未知类型 fail/objectCounts 对齐
//   - out-6 renderAll 三件套
//   - out-5 主题：registerTheme 校验 / 用户主题落盘 CRUD / 懒加载生效
//   - CLI 端到端：output theme add/list/remove（子进程，隔离 NICE_AOS_THEMES_DIR）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPORTER = path.join(ROOT, 'src/ontology/exporter.js');
const THEMES = path.join(ROOT, 'src/themes/index.js');
const THEME_STORE = path.join(ROOT, 'src/cli/commands/themeStore.js');
const CLI = path.join(ROOT, 'src/cli/index.js');

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        NICE_AOS_THEMES_DIR: '',
        ...env,
      },
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

// ---------- filterObjectTypes ----------

describe('filterObjectTypes 类型过滤', () => {
  const makeMap = () => ({
    _meta: { generatedAt: 't', objectCounts: { Project: 1, Domain: 2, Module: 3 } },
    Project: [{ id: 'p:1', name: 'P' }],
    Domain: [{ id: 'd:1' }, { id: 'd:2' }],
    Module: [{ id: 'm:1' }, { id: 'm:2' }, { id: 'm:3' }],
  });

  test('include 白名单：仅保留指定类型；objectCounts 同步对齐', async () => {
    const { filterObjectTypes } = await import(EXPORTER);
    const r = filterObjectTypes(makeMap(), { include: ['Domain'] });
    assert.deepEqual(Object.keys(r.dataMap).sort(), ['Domain', '_meta']);
    assert.equal(r.dataMap.Domain.length, 2);
    assert.equal(r.dataMap._meta.objectCounts.Project, undefined);
    assert.equal(r.removed, 4); // Project(1) + Module(3)
    assert.equal(r.kept, 2);
  });

  test('exclude 黑名单在 include 之后应用；空 exclude 无操作', async () => {
    const { filterObjectTypes } = await import(EXPORTER);
    const r = filterObjectTypes(makeMap(), { include: ['Project', 'Domain'], exclude: ['Domain'] });
    assert.deepEqual(Object.keys(r.dataMap).sort(), ['Project', '_meta']);

    const r2 = filterObjectTypes(makeMap(), {});
    assert.equal(r2.removed, 0);
    assert.equal(r2.kept, 6);
  });

  test('include/exclude 拼错类型 → 报错并列出可用类型', async () => {
    const { filterObjectTypes } = await import(EXPORTER);
    assert.throws(() => filterObjectTypes(makeMap(), { include: ['Componnt'] }), /可用类型: Project, Domain, Module/);
    assert.throws(() => filterObjectTypes(makeMap(), { exclude: ['Strore'] }), /可用类型/);
  });
});

// ---------- renderAll ----------

describe('renderAll 三件套', () => {
  test('返回 markdown/html/viewmodel 且内容形态正确；模板只作用于 markdown 分支', async () => {
    const { renderAll } = await import(EXPORTER);
    const dataMap = {
      _meta: { analyzerVersion: '0.34.0', objectCounts: { Project: 1, Module: 1 } },
      Project: [{ id: 'p:x', name: 'all-render', framework: 'react', frameworkLabel: 'React 19', fileCount: 1, architecture: { layers: [] }, health: {} }],
      Module: [{ id: 'mod:src', path: 'src', fileCount: 1 }],
    };
    const r = renderAll(dataMap, { theme: 'deep-blue', templateStr: '# 自定义 {{Project.name}}' });
    assert.match(r.markdown, /# 自定义 all-render/);
    assert.match(r.html, /<!DOCTYPE html>|<html/i);
    const vm = JSON.parse(r.viewmodel);
    assert.ok(vm, 'viewmodel 应为合法 JSON');
  });
});

// ---------- registerTheme / 用户主题落盘 ----------

const VALID_DEF = {
  label: '午夜青',
  dark: true,
  vars: { '--bg': '#0b1220', '--fg': '#e2e8f0', '--blue': '#22d3ee', '--green': '#34d399' },
};

describe('主题 API 与用户主题落盘', () => {
  test('registerTheme：合法注册可被 resolveTheme/buildThemeCss 消费；非法定义逐项报错', async () => {
    const m = await import(THEMES);
    const reg = m.registerTheme('test-cyan-1', VALID_DEF);
    assert.deepEqual(reg, { name: 'test-cyan-1', overridden: false });
    assert.ok(m.listThemeNames().includes('test-cyan-1'));
    const css = m.buildThemeCss('test-cyan-1');
    assert.match(css, /--bg: #0b1220;/);
    assert.match(css, /color-scheme: dark;/);

    assert.throws(() => m.registerTheme('Bad_Name', VALID_DEF), /非法主题名/);
    assert.throws(() => m.registerTheme('x-1', { label: '', dark: 'yes', vars: {} }), (e) =>
      e.message.includes('label') && e.message.includes('dark') && e.message.includes('--bg'));
    // 清理避免污染其他用例的 listThemeNames 断言
    delete m.THEMES['test-cyan-1'];
  });

  test('themeStore add/list/remove 往返（临时目录）', async () => {
    const store = await import(THEME_STORE);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-themes-'));
    const { filePath } = store.saveUserTheme('midnight-teal', VALID_DEF, dir);
    assert.equal(filePath, path.join(dir, 'midnight-teal.json'));

    const listed = store.listUserThemes(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'midnight-teal');
    assert.equal(listed[0].label, '午夜青');

    assert.equal(store.readUserTheme('nope', dir), null);
    assert.throws(() => store.saveUserTheme('UPPER', VALID_DEF, dir), /非法主题名/);
    assert.throws(() => store.removeUserTheme('builtin-x', dir), /未找到用户主题/);

    store.removeUserTheme('midnight-teal', dir);
    assert.deepEqual(store.listUserThemes(dir), []);
  });

  test('themes/index 懒加载用户目录：落盘文件自动进入 listThemeNames/resolveTheme', async () => {
    const themesMod = await import(THEMES);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-themes-lazy-'));
    fs.writeFileSync(path.join(dir, 'lazy-solar.json'), JSON.stringify({
      label: '懒加载日光', dark: false,
      vars: { '--bg': '#fffbeb', '--fg': '#78350f' },
    }));
    fs.writeFileSync(path.join(dir, 'broken-one.json'), '{ not json');
    process.env.NICE_AOS_THEMES_DIR = dir;
    themesMod.resetUserThemesCache();
    try {
      assert.ok(themesMod.listThemeNames().includes('lazy-solar'));
      const t = themesMod.resolveTheme('lazy-solar');
      assert.equal(t.label, '懒加载日光');
      assert.equal(t.dark, false);
      // broken 文件不阻塞其他主题加载
      assert.ok(!themesMod.listThemeNames().includes('broken-one'));
    } finally {
      delete process.env.NICE_AOS_THEMES_DIR;
      themesMod.resetUserThemesCache();
      delete themesMod.THEMES['lazy-solar'];
    }
  });
});

// ---------- CLI e2e ----------

describe('nice-aos output theme 子命令（CLI 端到端）', () => {
  const tmpRoots = [];
  function mkThemesDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-themes-cli-'));
    tmpRoots.push(dir);
    return dir;
  }
  function writeDef(dir) {
    const defFile = path.join(dir, 'def.json');
    fs.writeFileSync(defFile, JSON.stringify(VALID_DEF));
    return defFile;
  }

  test('add → list（含 [user] 标注）→ remove 全流程', async () => {
    const dir = mkThemesDir();
    const defFile = writeDef(dir);

    const r1 = await runCli(['output', 'theme', 'add', '--name', 'cli-teal', '--file', defFile], { NICE_AOS_THEMES_DIR: dir });
    assert.equal(r1.code, 0, r1.err);
    assert.match(r1.out, /"name": "cli-teal"/);
    assert.ok(fs.existsSync(path.join(dir, 'cli-teal.json')));

    const r2 = await runCli(['output', 'theme', 'list'], { NICE_AOS_THEMES_DIR: dir });
    assert.equal(r2.code, 0, r2.err);
    assert.match(r2.out, /deep-blue\t\[builtin\]/);
    assert.match(r2.out, /cli-teal\t\[user\]\t午夜青/);

    const r3 = await runCli(['output', 'theme', 'remove', 'cli-teal'], { NICE_AOS_THEMES_DIR: dir });
    assert.equal(r3.code, 0, r3.err);
    assert.match(r3.err, /已删除/);
    const afterList = await runCli(['output', 'theme', 'list'], { NICE_AOS_THEMES_DIR: dir });
    assert.doesNotMatch(afterList.out, /cli-teal/);
  });

  test('remove 内置主题 → exit 1 引导；add 非法定义 → 语义校验报错且不落盘', async () => {
    const dir = mkThemesDir();
    const r1 = await runCli(['output', 'theme', 'remove', 'deep-blue'], { NICE_AOS_THEMES_DIR: dir });
    assert.equal(r1.code, 1);
    assert.match(r1.err, /内置主题不可删除|未找到用户主题/);

    const badDef = path.join(dir, 'bad.json');
    fs.writeFileSync(badDef, JSON.stringify({ label: '缺 vars' }));
    const r2 = await runCli(['output', 'theme', 'add', '--name', 'bad-theme', '--file', badDef], { NICE_AOS_THEMES_DIR: dir });
    assert.equal(r2.code, 1);
    assert.match(r2.err, /vars 须为对象|vars 缺少必需变量 --bg/);
    assert.ok(!fs.existsSync(path.join(dir, 'bad-theme.json')), '校验失败不应落盘');
  });

  test('--format all 需要快照且产出三件套（夹具仓库端到端）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-out-fmt-'));
    tmpRoots.push(dir);
    const dataDir = path.join(dir, '.nice-aos', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
      _meta: { analyzerVersion: '0.34.0', objectCounts: { Project: 1, Module: 1 } },
      Project: [{ id: 'p:f', name: 'fmt-all-fixture', framework: 'react', frameworkLabel: 'React 19', fileCount: 1, architecture: { layers: [] }, health: {} }],
      Module: [{ id: 'mod:s', path: 'src', fileCount: 1 }],
    }));
    const snapEnv = { NICE_AOS_SNAPSHOT_DIR: dataDir };
    const r = await runCli(['output', '--format', 'all', '--output', path.join(dir, 'report.html')], snapEnv);
    assert.equal(r.code, 0, `stderr: ${r.err}`);
    assert.ok(fs.existsSync(path.join(dir, 'report.md')), '.md 未生成');
    assert.ok(fs.existsSync(path.join(dir, 'report.html')), '.html 未生成');
    assert.ok(fs.existsSync(path.join(dir, 'report.viewmodel.json')), '.viewmodel.json 未生成');
    const vm = JSON.parse(fs.readFileSync(path.join(dir, 'report.viewmodel.json'), 'utf-8'));
    assert.ok(vm, 'viewmodel 应可解析');

    // 无 --output 时明确报错而非刷屏
    const r2 = await runCli(['output', '--format', 'all'], snapEnv);
    assert.equal(r2.code, 1);
    assert.match(r2.err, /--format all 需要 --output/);
  });

  test('--include 过滤作用于导出；未知类型 fail', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-out-inc-'));
    tmpRoots.push(dir);
    const dataDir = path.join(dir, '.nice-aos', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'snapshot.json'), JSON.stringify({
      _meta: { analyzerVersion: '0.34.0', objectCounts: { Project: 1, Module: 2, Domain: 1 } },
      Project: [{ id: 'p:i', name: 'inc-fixture', framework: 'react', frameworkLabel: 'React 19', fileCount: 3, architecture: { layers: [] }, health: {} }],
      Module: [{ id: 'mod:a', path: 'a', fileCount: 1 }, { id: 'mod:b', path: 'b', fileCount: 2 }],
      Domain: [{ id: 'dom:d', name: 'd', fileCount: 3, lineCount: 10 }],
    }));
    const snapEnv = { NICE_AOS_SNAPSHOT_DIR: dataDir };

    const vmPath = path.join(dir, 'out.vm.json');
    const r = await runCli(['output', '--format', 'json', '--include', 'Module', '--output', vmPath], snapEnv);
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(fs.readFileSync(vmPath, 'utf-8'));
    assert.deepEqual(Object.keys(j).filter((k) => k !== '_meta'), ['Module']);
    assert.equal(j._meta.objectCounts.Domain, undefined, 'objectCounts 应与过滤后一致');

    const r2 = await runCli(['output', '--format', 'markdown', '--exclude', 'NoSuchType'], snapEnv);
    assert.equal(r2.code, 1);
    // 注意：fail() 经 JSON.stringify 输出，内嵌引号被转义为 \"，断言避开引号字符
    assert.match(r2.err, /NoSuchType.. 不在当前快照中/);
    assert.match(r2.err, /可用类型: Project, Module, Domain/);
  });
});
