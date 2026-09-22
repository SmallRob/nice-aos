// 本体概览（v0.46.0）增强测试：viewerModel.blueprint 新增字段 + 本体概览 Tab 渲染
// 借鉴 asdm-aos getVocabulary（ontology.service.ts:178-194）+ graph.gitnexus-types.ts LINK_DEFS 思路
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildViewerModel, renderViewerHtml } from '../src/ontology/viewer.js';
import { buildOntologyData } from '../src/ontology/builder.js';

// 最小 fixture：触发 Project + Module + SourceFile + Interface + Class + Method + Component + Store + Route
async function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ontology-view-'));
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'types.ts'),
    `export interface User { id: string; name: string; }
export class UserService { get(id: string): User { return { id, name: 'x' }; }
}
export function findUser(id: string) { return new UserService().get(id); }
`);
  fs.writeFileSync(path.join(src, 'App.tsx'),
    `import { useDietStore } from './store';
export function App() { const s = useDietStore(); return <div>{s.name}</div>; }
`);
  fs.writeFileSync(path.join(src, 'store.ts'),
    `export const useDietStore = () => ({ name: 'diet' });
`);
  return dir;
}

test('本体概览：viewerModel.blueprint.vocabulary 暴露 objectTypes/linkTypes/reverseLinkTypes/actions', async (t) => {
  const dir = await makeFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataMap = await buildOntologyData(dir);
  const model = buildViewerModel(dataMap);
  const v = model.blueprint.vocabulary;
  assert.ok(v, '应暴露 vocabulary');
  assert.ok(Array.isArray(v.objectTypes), 'vocabulary.objectTypes 应为数组');
  assert.ok(v.objectTypes.length >= 10, 'vocabulary.objectTypes 至少 10 项');
  // 按 count 倒序
  for (let i = 1; i < v.objectTypes.length; i++) {
    assert.ok(v.objectTypes[i - 1].count >= v.objectTypes[i].count,
      'vocabulary.objectTypes 应按 count 倒序');
  }
  // 每项含 type/prefix/category/level/count/active
  for (const t of v.objectTypes) {
    assert.ok(typeof t.type === 'string');
    assert.ok(typeof t.prefix === 'string');
    assert.ok(typeof t.category === 'string');
    assert.ok(typeof t.level === 'string');
    assert.ok(typeof t.count === 'number');
    assert.ok(typeof t.active === 'boolean');
  }
  assert.ok(Array.isArray(v.linkTypes));
  assert.ok(Array.isArray(v.reverseLinkTypes));
  assert.deepEqual(v.actions, ['refreshRepo', 'analyzeFile', 'markReviewed', 'addNote']);
});

test('本体概览：categoryMatrix 每张范畴卡片含 declared/active/instance 计数 + 类型目录', async (t) => {
  const dir = await makeFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataMap = await buildOntologyData(dir);
  const model = buildViewerModel(dataMap);
  const cm = model.blueprint.categoryMatrix;
  assert.ok(Array.isArray(cm) && cm.length >= 5, '至少 5 个概念范畴');
  for (const cat of cm) {
    assert.ok(cat.category && cat.label && cat.description);
    assert.equal(typeof cat.declaredCount, 'number');
    assert.equal(typeof cat.activeCount, 'number');
    assert.equal(typeof cat.instanceTotal, 'number');
    assert.ok(Array.isArray(cat.types));
    for (const t of cat.types) {
      assert.equal(typeof t.declared, 'boolean');
      assert.equal(typeof t.active, 'boolean');
      assert.ok(typeof t.count === 'number');
    }
  }
  // Container 范畴应包含 Project / Module / SourceFile
  const container = cm.find((c) => c.category === 'Container');
  assert.ok(container);
  assert.ok(container.types.some((t) => t.type === 'Project'));
  assert.ok(container.types.some((t) => t.type === 'Module'));
  assert.ok(container.types.some((t) => t.type === 'SourceFile'));
});

test('本体概览：levelCards 按 L3→L0 自顶向下排列', async (t) => {
  const dir = await makeFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataMap = await buildOntologyData(dir);
  const model = buildViewerModel(dataMap);
  const lv = model.blueprint.levelCards;
  assert.deepEqual(lv.map((l) => l.level), ['L3', 'L2', 'L1', 'L0']);
  for (const l of lv) {
    assert.ok(l.name && l.description);
    assert.ok(typeof l.declaredCount === 'number' && l.declaredCount > 0);
  }
});

test('本体概览：linkTypePairs 仅保留既有 LINK_TYPES 中实际存在的双向对', async (t) => {
  const dir = await makeFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataMap = await buildOntologyData(dir);
  const model = buildViewerModel(dataMap);
  const pairs = model.blueprint.linkTypePairs;
  assert.ok(pairs);
  for (const [fwd, rev] of Object.entries(pairs)) {
    assert.ok(model.blueprint.linkTypes.includes(fwd),
      `forward ${fwd} 必须在 linkTypes 中`);
    assert.ok(model.blueprint.linkTypes.includes(rev),
      `reverse ${rev} 必须在 linkTypes 中`);
  }
  // 应至少包含 contains↔containedBy 与 calls↔calledBy 等核心对
  // 注：containedBy 未必在既有 LINK_TYPES 中（nice-aos 是单向），所以下面断言用 hasOwnProperty
  assert.ok(Object.prototype.hasOwnProperty.call(pairs, 'calls'));
});

test('本体概览：renderViewerHtml 嵌入新 Tab + 嵌入 renderOntology 渲染脚本', async (t) => {
  const dir = await makeFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataMap = await buildOntologyData(dir);
  const html = renderViewerHtml(buildViewerModel(dataMap));
  // Tab
  assert.match(html, /data-tab="ontology"/, 'Tab 列表应含本体概览');
  // Section
  assert.match(html, /id="view-ontology"/, '应含本体概览 Section');
  // 客户端脚本块含 renderOntology
  assert.match(html, /function renderOntology\(\)/, '客户端脚本应含 renderOntology()');
  assert.match(html, /renderOntology\(\);/, '初始化段应调用 renderOntology()');
  // 词汇表正反配对箭头
  assert.match(html, /ont-link-pair/, '应含链接配对样式钩子');
});

test('本体概览：activeTypeCount / totalInstanceCount 与 declaredTypeCount 自洽', async (t) => {
  const dir = await makeFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataMap = await buildOntologyData(dir);
  const model = buildViewerModel(dataMap);
  const bp = model.blueprint;
  assert.equal(bp.declaredTypeCount, bp.objectTypes.length);
  // active = count > 0 的类型数
  const expectedActive = bp.objectTypes.filter((t) => t.count > 0).length;
  assert.equal(bp.activeTypeCount, expectedActive);
  // totalInstance = 所有 count 之和
  const expectedTotal = bp.objectTypes.reduce((a, t) => a + t.count, 0);
  assert.equal(bp.totalInstanceCount, expectedTotal);
});