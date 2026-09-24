// v0.47 facts 解析缓存测试（借鉴 asdm-aos contentHash/manifest 继承思想）：
//   1. 序列化往返：Set/Map 保形、imports[].resolved 剥离
//   2. 跨调用复用：第二次构建全部命中（hit=fileCount），产物与全量等价
//   3. 局部变更：仅变更文件 miss，其余命中；变更内容如实反映
//   4. 缓存失效：projectRoot 不匹配 → 整体弃用
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';
import {
  serializeFacts, deserializeFacts, loadFactsCache, saveFactsCache, computeContentHash16,
} from '../src/analyzers/factsCache.js';

test('facts 序列化往返：Set/Map 保形，resolved/AST 节点剥离', () => {
  const facts = {
    path: 'a.ts',
    jsxTags: new Set(['Div', 'Span']),
    importMap: new Map([['x', './x']]),
    imports: [{ specifier: './x', resolved: { kind: 'internal', file: 'x.ts' }, names: [] }],
    exportSymbols: [{ name: 'useA', kind: 'function', isExported: true, node: { kind: 1 }, statementNode: { kind: 2 } }],
    nested: { deep: new Map([['k', 'v']]) },
  };
  const back = deserializeFacts(serializeFacts(facts));
  assert.ok(back.jsxTags instanceof Set);
  assert.deepEqual([...back.jsxTags], ['Div', 'Span']);
  assert.ok(back.importMap instanceof Map);
  assert.equal(back.importMap.get('x'), './x');
  assert.ok(back.nested.deep instanceof Map);
  assert.equal(back.imports[0].resolved, undefined, 'resolved 不落盘（每次构建重跑解析）');
  assert.equal(back.imports[0].specifier, './x');
  assert.equal(back.exportSymbols[0].node, undefined, 'AST 节点不落盘（下游只消费普通字段）');
  assert.equal(back.exportSymbols[0].statementNode, undefined);
  assert.equal(back.exportSymbols[0].name, 'useA');
});

function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-fcache-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const FILES = {
  'package.json': JSON.stringify({ name: 'fcache-demo', dependencies: { vue: '^3.4.0' } }),
  'src/main.ts': [
    "import { createApp } from 'vue';",
    "import App from './App.vue';",
    "import { fetchUser } from './api';",
    'createApp(App).mount("#app");',
  ].join('\n'),
  'src/api.ts': [
    'export async function fetchUser(id: string) {',
    '  return fetch(`/api/users/${id}`);',
    '}',
  ].join('\n'),
  'src/App.vue': [
    '<template>',
    '  <div class="app">{{ msg }}</div>',
    '</template>',
    '<script setup lang="ts">',
    "import { ref } from 'vue';",
    'const msg = ref("hi");',
    '</script>',
  ].join('\n'),
};

function stripVolatile(meta) {
  const { generatedAt, durationMs, ...rest } = meta;
  return rest;
}

test('跨调用复用：第二次构建全部命中且产物等价', async () => {
  const dir = makeProject(FILES);
  const cachePath = path.join(path.dirname(dir), `cache-${path.basename(dir)}.json`);
  try {
    const run1 = await buildOntologyData(dir, { factsCachePath: cachePath });
    assert.equal(run1._meta.factsCache.hit, 0);
    assert.ok(run1._meta.factsCache.miss >= 3);

    const run2 = await buildOntologyData(dir, { factsCachePath: cachePath });
    assert.equal(run2._meta.factsCache.hit, run1._meta.factsCache.miss, '全部文件命中');
    assert.equal(run2._meta.factsCache.miss, 0);
    assert.ok(fs.existsSync(cachePath));

    // 产物等价：对象计数 / 关键派生（import 边、组件）一致
    assert.deepEqual(run2._meta.objectCounts, run1._meta.objectCounts);
    assert.equal(run2.SourceFile.length, run1.SourceFile.length);
    const f1 = run1.SourceFile.find((f) => f.path === 'src/main.ts');
    const f2 = run2.SourceFile.find((f) => f.path === 'src/main.ts');
    assert.deepEqual(f2.importIds, f1.importIds, '缓存复用后 import 解析照常重跑');
    assert.deepEqual(run2.Component.map((c) => c.id), run1.Component.map((c) => c.id));

    // _meta.fileManifest 存在且含 hash
    assert.ok(run2._meta.fileManifest['src/api.ts'].h.length === 16);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cachePath, { force: true });
  }
});

test('局部变更：仅变更文件 miss，其余命中；变更如实反映', async () => {
  const dir = makeProject(FILES);
  const cachePath = path.join(path.dirname(dir), `cache2-${path.basename(dir)}.json`);
  try {
    const run1 = await buildOntologyData(dir, { factsCachePath: cachePath });
    fs.writeFileSync(path.join(dir, 'src/api.ts'), [
      'export async function fetchUser(id: string) {',
      '  return fetch(`/api/users/${id}`);',
      '}',
      'export async function fetchOrder(id: string) {',
      '  return fetch(`/api/orders/${id}`);',
      '}',
    ].join('\n'));
    const run3 = await buildOntologyData(dir, { factsCachePath: cachePath });
    assert.equal(run3._meta.factsCache.miss, 1, '仅 api.ts 重解析');
    assert.equal(run3._meta.factsCache.hit, run1._meta.factsCache.miss - 1);
    // 新函数出现（Method 或 moduleFunctions 派生对象数增加）
    const m1 = run1._meta.objectCounts.Method;
    const m3 = run3._meta.objectCounts.Method;
    assert.ok(m3 > m1, `Method ${m1} → ${m3}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(cachePath, { force: true });
  }
});

test('缓存失效：projectRoot 不匹配整体弃用（--snapshot-dir 共享目录场景）', async () => {
  const dirA = makeProject(FILES);
  const dirB = makeProject(FILES);
  const cachePath = path.join(path.dirname(dirA), `cache3-${path.basename(dirA)}.json`);
  try {
    await buildOntologyData(dirA, { factsCachePath: cachePath });
    const runB = await buildOntologyData(dirB, { factsCachePath: cachePath });
    assert.equal(runB._meta.factsCache.hit, 0, '项目根变化 → 不复用他人缓存');
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
    fs.rmSync(cachePath, { force: true });
  }
});

test('loadFactsCache：损坏 / 缺失文件返回 null 不抛出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-fcache-bad-'));
  const p = path.join(dir, 'bad.json');
  assert.equal(loadFactsCache(p, dir), null, '文件缺失');
  fs.writeFileSync(p, '{not json', 'utf-8');
  assert.equal(loadFactsCache(p, dir), null, 'JSON 损坏');
  fs.writeFileSync(p, JSON.stringify({ version: 999, projectRoot: dir, entries: {} }), 'utf-8');
  assert.equal(loadFactsCache(p, dir), null, '版本不匹配');
  // saveFactsCache 原子写 + 读回
  const entries = new Map([['a.ts', { h: computeContentHash16('x'), facts: { path: 'a.ts', jsxTags: new Set(['A']) } }]]);
  assert.equal(saveFactsCache(p, dir, entries), true);
  const loaded = loadFactsCache(p, dir);
  assert.equal(loaded.size, 1);
  assert.ok(loaded.get('a.ts').facts.jsxTags instanceof Set);
  fs.rmSync(dir, { recursive: true, force: true });
});
