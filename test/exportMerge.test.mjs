// out-3 多快照合并（src/ontology/merge.js）+ export --merge CLI 接入 单测

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MERGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/ontology/merge.js');

function snapA() {
  return {
    _meta: { analyzerVersion: '0.34.0', snapshotVersion: 3, objectCounts: { Project: 1, Domain: 1, Component: 2 } },
    Project: [{ id: 'proj:a', name: 'app-a', framework: 'react', fileCount: 10 }],
    Domain: [{ id: 'dom:shared', name: 'auth', fileCount: 5, lineCount: 100 }],
    Component: [
      { id: 'comp:Button', name: 'Button', filePath: 'src/a/Button.tsx', domainId: 'dom:shared' },
      { id: 'comp:A-only', name: 'AOnly', filePath: 'src/a/AOnly.tsx', relatedIds: ['comp:Button'] },
    ],
  };
}

function snapB() {
  return {
    _meta: { analyzerVersion: '0.34.0', objectCounts: { Project: 1, Domain: 1, Hook: 1 } },
    Project: [{ id: 'proj:b', name: 'app-b', framework: 'vue', fileCount: 6 }],
    Domain: [{ id: 'dom:shared', name: 'auth-b-variant', fileCount: 4, lineCount: 80 }],
    Hook: [{ id: 'hook:useB', name: 'useB', domainId: 'dom:shared' }],
  };
}

describe('mergeSnapshots 合并策略', () => {
  test('first-wins：冲突保留先到者；非首源 Project 折叠；objectCounts 重算', async () => {
    const { mergeSnapshots } = await import(MERGE);
    const { dataMap, meta } = mergeSnapshots([snapA(), snapB()], {
      strategy: 'first-wins',
      sources: [{ name: 'app-a' }, { name: 'app-b' }],
    });

    assert.equal(dataMap.Project.length, 1);
    assert.equal(dataMap.Project[0].name, 'app-a');
    assert.deepEqual(meta.droppedProjects, ['app-b']);
    assert.equal(meta.conflicts, 1);
    assert.deepEqual(meta.conflictSamples, ['Domain:dom:shared']);
    // 域只剩先到版本
    assert.equal(dataMap.Domain.length, 1);
    assert.equal(dataMap.Domain[0].name, 'auth');
    // 后到源独有类型完整吸收
    assert.equal(dataMap.Hook.length, 1);
    // 非首源 Project 名折叠上报
    assert.ok(Array.isArray(meta.droppedProjects));

    assert.equal(dataMap._meta.objectCounts.Component, 2);
    assert.equal(dataMap._meta.objectCounts.Hook, 1);
    assert.equal(dataMap._meta.merged.strategy, 'first-wins');
    assert.deepEqual(meta.sources.map((s) => s.name), ['app-a', 'app-b']);
  });

  test('rename：冲突对象重前缀 + 已收对象引用字段泛键回填', async () => {
    const { mergeSnapshots } = await import(MERGE);
    const { dataMap, meta } = mergeSnapshots([snapA(), snapB()], {
      strategy: 'rename',
      sources: [{ name: 'app-a-src' }, { name: 'app-b-src' }],
    });

    assert.equal(meta.renamedCount, 1);
    assert.equal(dataMap.Domain.length, 2);

    // 后到的冲突 Domain 被重命名为 <sourceName>:<origId>；先到者保持原 id
    const renamedDomain = dataMap.Domain.find((d) => d.id !== 'dom:shared');
    assert.ok(renamedDomain, '应存在重前缀变体');
    assert.equal(renamedDomain.id, 'app-b-src:dom:shared');

    // snapB 后到：其 Hook.domainId 指向旧冲突 id → 回填为新 id
    const hook = dataMap.Hook[0];
    assert.equal(hook.domainId, 'app-b-src:dom:shared');

    // 先到源的引用指向未冲突原 id → 不受影响
    const button = dataMap.Component[0];
    assert.equal(button.domainId, 'dom:shared');

    assert.equal(dataMap._meta.objectCounts.Domain, 2);
  });

  test('无 sources 信息时自动派生 snap-N 命名；空快照数组报错', async () => {
    const { mergeSnapshots } = await import(MERGE);
    const { meta } = mergeSnapshots([snapA()]);
    assert.deepEqual(meta.sources.map((s) => s.name), ['snap-0']);
  });
});

// ---------- CLI 端到端 ----------

describe('output --merge CLI 端到端', () => {
  test('双快照 markdown 合并导出 + 参数校验（<2 路径 / 快照不存在 / 非法策略）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naos-merge-'));
    const aPath = path.join(dir, 'app-a', 'snapshot.json');
    const bPath = path.join(dir, 'app-b', '.nice-aos', 'data', 'snapshot.json');
    fs.mkdirSync(path.dirname(aPath), { recursive: true });
    fs.mkdirSync(path.dirname(bPath), { recursive: true });
    fs.writeFileSync(aPath, JSON.stringify(snapA()));
    fs.writeFileSync(bPath, JSON.stringify(snapB()));

    const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli/index.js');
    const runCli = (args) => new Promise((resolve) => {
      import('node:child_process').then(({ spawn }) => {
        const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('exit', (code) => resolve({ code, out, err }));
      });
    });

    const r1 = await runCli(['output', '--format', 'markdown', '--merge', aPath, bPath, '--output', path.join(dir, 'merged.md')]);
    assert.equal(r1.code, 0, r1.err);
    const md = fs.readFileSync(path.join(dir, 'merged.md'), 'utf-8');
    assert.match(md, /app-a/, '总览画像应取首源 Project');
    assert.match(r1.err, /合并 2 份快照/);

    // 源名推断：<proj>/snapshot.json → app-a
    assert.match(r1.err, /app-a \+/);

    const r2 = await runCli(['output', '--format', 'markdown', '--merge', aPath]);
    assert.equal(r2.code, 1);
    assert.match(r2.err, /至少 2 份快照/);

    const r3 = await runCli(['output', '--format', 'markdown', '--merge', aPath, path.join(dir, 'nope.json')]);
    assert.equal(r3.code, 1);
    assert.match(r3.err, /不存在: /);

    const r4 = await runCli(['output', '--format', 'markdown', '--merge', aPath, bPath, '--merge-strategy', 'bogus']);
    assert.equal(r4.code, 1);
    assert.match(r4.err, /未知合并策略/);
  });
});
