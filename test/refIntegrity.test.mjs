// v0.47 引用完整性审计测试（借鉴 asdm-aos pending-refs/validate 思想的最小版）：
//   1. 悬空 *Id 置 null、*Ids 摘除元素，样本上报
//   2. 豁免字段（overlayId / opensOverlayIds）不动
//   3. frontendCalls[].fileId 悬空置 null
//   4. 构建产物带 _meta.refIntegrity 且自扫描零悬空
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditRefIntegrity } from '../src/ontology/refIntegrity.js';
import { buildOntologyData } from '../src/ontology/builder.js';

function sampleDataMap() {
  return {
    _meta: {},
    Component: [
      { id: 'comp:A', name: 'A', rendersIds: ['comp:B', 'comp:GHOST'], serverRouteId: 'route:ok', overlayId: 'not-an-id' },
      { id: 'comp:B', name: 'B', rendersIds: [], serverRouteId: 'route:GHOST' },
    ],
    Route: [
      { id: 'route:ok', routePath: '/ok', opensOverlayIds: ['/somewhere'], frontendCalls: [
        { fileId: 'file:exists', filePath: 'a.ts', line: 1, method: 'GET' },
        { fileId: 'file:GHOST', filePath: 'b.ts', line: 2, method: 'GET' },
      ] },
    ],
    SourceFile: [{ id: 'file:exists', path: 'a.ts' }],
  };
}

test('审计：悬空 Id/Ids 摘除 + 样本上报', () => {
  const dm = sampleDataMap();
  const report = auditRefIntegrity(dm);
  assert.equal(report.danglingCount, 3, 'rendersIds[ghost] + serverRouteId[ghost] + frontendCalls.fileId');
  const a = dm.Component[0];
  assert.deepEqual(a.rendersIds, ['comp:B']);
  assert.equal(a.serverRouteId, 'route:ok', '存在的不动');
  assert.equal(a.overlayId, 'not-an-id', '豁免字段不动');
  assert.equal(dm.Component[1].serverRouteId, null);
  assert.equal(dm.Route[0].opensOverlayIds.length, 1, '豁免字段（原始声明清单）不动');
  assert.equal(dm.Route[0].frontendCalls[0].fileId, 'file:exists');
  assert.equal(dm.Route[0].frontendCalls[1].fileId, null);
  // 样本包含字段与值
  const fields = report.samples.map((s) => s.field).sort();
  assert.ok(fields.includes('rendersIds') && fields.includes('serverRouteId') && fields.includes('frontendCalls[].fileId'));
});

test('审计：干净 dataMap 零悬空', () => {
  const dm = {
    _meta: {},
    Component: [{ id: 'comp:A', rendersIds: ['comp:B'] }, { id: 'comp:B' }],
    SourceFile: [{ id: 'file:a', importIds: ['file:b'] }, { id: 'file:b' }],
  };
  const report = auditRefIntegrity(dm);
  assert.equal(report.danglingCount, 0);
  assert.deepEqual(report.samples, []);
});

test('集成：构建产物带 _meta.refIntegrity（含同名函数脚本的 id 一致性）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-refint-'));
  try {
    // 油猴脚本：两个同名函数 out（历史上 fnIdMap 按名覆盖 → functionIds 悬空 + 重复对象 id）
    fs.writeFileSync(path.join(dir, 'dup.user.js'), [
      '// ==UserScript==',
      '// @name         dup-fn',
      '// @grant        GM_addStyle',
      '// ==/UserScript==',
      'function out(x) { return x; }',
      'function out(x, y) { return x + y; }',
      'function main() { out(1); out(2, 3); }',
      'main();',
    ].join('\n'));
    const dm = await buildOntologyData(dir);
    assert.ok(dm._meta.refIntegrity, '_meta.refIntegrity 存在');
    assert.equal(dm._meta.refIntegrity.danglingCount, 0, `不应有悬空，实际 ${JSON.stringify(dm._meta.refIntegrity.samples ?? [])}`);
    // 同名函数 → 两个不同 id 的 ScriptFunction，UserScript.functionIds 全部可解析
    const fns = dm.ScriptFunction.filter((f) => f.name === 'out');
    assert.equal(fns.length, 2, '两个同名函数对象');
    assert.notEqual(fns[0].id, fns[1].id);
    const idSet = new Set(dm.ScriptFunction.map((f) => f.id));
    for (const ref of dm.UserScript[0].functionIds) assert.ok(idSet.has(ref), `functionIds 应可解析: ${ref}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
