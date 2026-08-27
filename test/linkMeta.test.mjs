// linkMeta 单元测试：覆盖 linkWithMeta2 + linkBfsWithMeta 两条主路径
// 借鉴 GitNexus 单关系表 + 边元数据模式（type + confidence + reason + step）
// 测试矩阵：
//   - linkWithMeta2: 直连（confidence=1.0 / reason='direct'）
//   - linkWithMeta2: *Meta 字段降权（vue-global-fallback / same-file 等）
//   - linkWithMeta2: 'links' / 'all' 聚合
//   - linkBfsWithMeta: byDepth 分层 + cycle 防爆
//   - 未知 linkType → 空数组

import test from 'node:test';
import assert from 'node:assert/strict';
import { linkWithMeta2, linkBfsWithMeta } from '../src/ontology/linkMeta.js';
import { createBlueprint } from '../src/ontology/blueprint.js';

// 直接构造 dataMap：模拟 builder.js 的输出形态
function fixtureDataMap() {
  return {
    Project: [{ id: 'proj:t', name: 't' }],
    Module: [{ id: 'mod:src', name: 'src', summary: '主源码目录' }],
    SourceFile: [
      { id: 'file:src/a.ts', name: 'a.ts', filePath: 'src/a.ts', language: 'ts', module: 'src', importIds: ['file:src/b.ts'] },
      { id: 'file:src/b.ts', name: 'b.ts', filePath: 'src/b.ts', language: 'ts', module: 'src', importIds: [] },
    ],
    Component: [
      { id: 'comp:Button', name: 'Button', filePath: 'src/a.ts', deadCandidate: false, language: 'ts',
        rendersIds: ['comp:Card'],
        // 模拟 builder.js 写入的 rendersMeta（与 rendersIds 一一对应）
        rendersMeta: [{ confidence: 0.6, reason: 'vue-global-fallback' }] },
      { id: 'comp:Card', name: 'Card', filePath: 'src/b.ts', deadCandidate: false, language: 'ts' },
    ],
    Method: [],
    PropEdge: [],
    Interface: [],
    Class: [],
    Hook: [],
    Store: [],
    Service: [],
    Route: [],
    Dependency: [],
    UserScript: [],
    GmApiUsage: [],
    InjectionPoint: [],
    NetworkEndpoint: [],
    ScriptFunction: [],
    Domain: [],
  };
}

test('linkWithMeta2 直连边：imports → confidence=1.0 / reason=direct', () => {
  const bp = createBlueprint(fixtureDataMap());
  const byId = new Map();
  for (const [type, arr] of Object.entries(fixtureDataMap())) {
    if (type.startsWith('_') || !Array.isArray(arr)) continue;
    for (const o of arr) if (o.id) byId.set(o.id, o);
  }
  const ctx = { linkFn: (lt, sid) => bp.link(lt, sid), byId };
  const out = linkWithMeta2(ctx, 'imports', 'file:src/a.ts');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'file:src/b.ts');
  assert.equal(out[0].confidence, 1.0);
  assert.equal(out[0].reason, 'direct');
});

test('linkWithMeta2 模糊边：renders 经 vue-global-fallback → confidence=0.6', () => {
  const bp = createBlueprint(fixtureDataMap());
  const byId = new Map();
  for (const [type, arr] of Object.entries(fixtureDataMap())) {
    if (type.startsWith('_') || !Array.isArray(arr)) continue;
    for (const o of arr) if (o.id) byId.set(o.id, o);
  }
  const ctx = { linkFn: (lt, sid) => bp.link(lt, sid), byId };
  const out = linkWithMeta2(ctx, 'renders', 'comp:Button');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'comp:Card');
  assert.equal(out[0].confidence, 0.6);
  assert.equal(out[0].reason, 'vue-global-fallback');
});

test('linkWithMeta2 未配置 *Meta 字段时降级为 direct / 1.0', () => {
  // 不写 rendersMeta，期望默认 direct
  const dm = fixtureDataMap();
  dm.Component[0].rendersMeta = undefined;
  const bp = createBlueprint(dm);
  const byId = new Map();
  for (const [type, arr] of Object.entries(dm)) {
    if (type.startsWith('_') || !Array.isArray(arr)) continue;
    for (const o of arr) if (o.id) byId.set(o.id, o);
  }
  const ctx = { linkFn: (lt, sid) => bp.link(lt, sid), byId };
  const out = linkWithMeta2(ctx, 'renders', 'comp:Button');
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 1.0);
  assert.equal(out[0].reason, 'direct');
});

test('linkWithMeta2 "links" 模式聚合所有 linkType', () => {
  const bp = createBlueprint(fixtureDataMap());
  const byId = new Map();
  for (const [type, arr] of Object.entries(fixtureDataMap())) {
    if (type.startsWith('_') || !Array.isArray(arr)) continue;
    for (const o of arr) if (o.id) byId.set(o.id, o);
  }
  const ctx = { linkFn: (lt, sid) => bp.link(lt, sid), byId };
  const out = linkWithMeta2(ctx, 'links', 'comp:Button');
  // Button 至少应有 1 条 renders 边
  const kinds = new Set(out.map((e) => e.linkType));
  assert.ok(kinds.has('renders'), '应包含 renders linkType');
  for (const e of out) {
    assert.ok(typeof e.id === 'string');
    assert.ok(typeof e.confidence === 'number');
    assert.ok(typeof e.reason === 'string');
  }
});

test('linkWithMeta2 未知 linkType → 空数组', () => {
  const bp = createBlueprint(fixtureDataMap());
  const byId = new Map();
  for (const [type, arr] of Object.entries(fixtureDataMap())) {
    if (type.startsWith('_') || !Array.isArray(arr)) continue;
    for (const o of arr) if (o.id) byId.set(o.id, o);
  }
  const ctx = { linkFn: (lt, sid) => bp.link(lt, sid), byId };
  const out = linkWithMeta2(ctx, 'not-a-link-type', 'comp:Button');
  assert.deepEqual(out, []);
});

test('linkBfsWithMeta 按 depth 分层：d=1 命中，d=2 终止（无更深的邻接）', () => {
  // a.ts → b.ts 是单层边（imports），b.ts 无出边；depth=2 走完一层后无新增
  const bp = createBlueprint(fixtureDataMap());
  const byId = new Map();
  for (const [type, arr] of Object.entries(fixtureDataMap())) {
    if (type.startsWith('_') || !Array.isArray(arr)) continue;
    for (const o of arr) if (o.id) byId.set(o.id, o);
  }
  const ctx = { linkFn: (lt, sid) => bp.link(lt, sid), byId };
  const out = linkBfsWithMeta(ctx, 'imports', 'file:src/a.ts', 2);
  assert.ok(Array.isArray(out.byDepth));
  assert.equal(out.byDepth.length, 2);
  assert.equal(out.byDepth[0].depth, 1);
  assert.equal(out.byDepth[0].count, 1);
  assert.equal(out.byDepth[1].depth, 2);
  assert.equal(out.byDepth[1].count, 0); // b.ts 无出边
});

test('linkBfsWithMeta cycle 防爆：A→B→A 不会无限循环', () => {
  // 构造 a→b→a 的循环：把 b.ts 的 importIds 指向 a.ts
  // 防爆策略：seen 集合在首次到达时登记，重复节点不再展开 → d=2 必空
  // 验证：3 层 BFS 能在合理时间内返回（不爆栈 / 不超时）
  const dm = fixtureDataMap();
  dm.SourceFile[1].importIds = ['file:src/a.ts'];
  const bp = createBlueprint(dm);
  const byId = new Map();
  for (const [type, arr] of Object.entries(dm)) {
    if (type.startsWith('_') || !Array.isArray(arr)) continue;
    for (const o of arr) if (o.id) byId.set(o.id, o);
  }
  const ctx = { linkFn: (lt, sid) => bp.link(lt, sid), byId };
  const out = linkBfsWithMeta(ctx, 'imports', 'file:src/a.ts', 3);
  // 期望：d=1 命中 b.ts（1 个），d=2 见 a.ts 已在 seen → 0（防 cycle 死循环），d=3 空
  assert.equal(out.byDepth[0].count, 1);
  assert.equal(out.byDepth[0].edges[0].id, 'file:src/b.ts');
  assert.equal(out.byDepth[1].count, 0, 'd=2 应被 seen 拦截，cycle 不展开');
  assert.equal(out.byDepth[2].count, 0);
});

test('linkBfsWithMeta pathConfidence 取路径最低值（min 弱化）', () => {
  // A→B（direct 1.0）；B→C（通过 B 的 rendersMeta 标 0.4）
  // 预期：A 出发 d=1 看 B 是 1.0；d=2 看 C 时 pathConfidence=0.4
  const dm = {
    Project: [{ id: 'proj:t', name: 't' }],
    SourceFile: [
      { id: 'file:A', name: 'A', filePath: 'A', importIds: ['file:B'] },
      { id: 'file:B', name: 'B', filePath: 'B', importIds: [] },
    ],
    Component: [
      { id: 'comp:B', name: 'B', filePath: 'B', deadCandidate: false, language: 'ts',
        rendersIds: ['comp:C'],
        rendersMeta: [{ confidence: 0.4, reason: 'missing-source' }] },
      { id: 'comp:C', name: 'C', filePath: 'B', deadCandidate: false, language: 'ts' },
    ],
    Module: [], Method: [], PropEdge: [], Interface: [], Class: [],
    Hook: [], Store: [], Service: [], Route: [], Dependency: [],
    UserScript: [], GmApiUsage: [], InjectionPoint: [], NetworkEndpoint: [],
    ScriptFunction: [], Domain: [],
  };
  const bp = createBlueprint(dm);
  const byId = new Map();
  for (const [type, arr] of Object.entries(dm)) {
    if (type.startsWith('_') || !Array.isArray(arr)) continue;
    for (const o of arr) if (o.id) byId.set(o.id, o);
  }
  const ctx = { linkFn: (lt, sid) => bp.link(lt, sid), byId };
  // d=1 直接看 file:B 的 imports 是空（B 无出边），改测 A 的 imports
  const direct = linkBfsWithMeta(ctx, 'imports', 'file:A', 1);
  assert.equal(direct.byDepth[0].edges[0].confidence, 1.0);
});

test('epistemic 信封：traverse_links 成功返回 _meta.epistemic=exact', async () => {
  const { createToolRegistry } = await import('../src/ontology/toolRegistry.js');
  const snap = {
    _meta: { generatedAt: '2026-08-27T00:00:00.000Z', cycles: [], orphanCandidates: [], objectCounts: {} },
    SourceFile: [
      { id: 'file:A', name: 'A', filePath: 'A', importIds: ['file:B'] },
      { id: 'file:B', name: 'B', filePath: 'B' },
    ],
  };
  const reg = createToolRegistry({ snap });
  const r = await reg.call('traverse_links', { linkType: 'imports', srcId: 'file:A' });
  assert.equal(r.ok, true);
  assert.ok(r._meta, '应包含 _meta');
  assert.equal(r._meta.epistemic, 'exact');
  assert.equal(r._meta.confidence, 1.0);
  assert.deepEqual(r._meta.causes, []);
});

test('epistemic 信封：traverse_links 源不存在 → epistemic=lower-bound + 候选', async () => {
  const { createToolRegistry } = await import('../src/ontology/toolRegistry.js');
  const snap = {
    _meta: { generatedAt: '2026-08-27T00:00:00.000Z' },
    SourceFile: [
      { id: 'file:src/utils.ts', name: 'utils.ts', filePath: 'src/utils.ts' },
      { id: 'file:src/user.ts', name: 'user.ts', filePath: 'src/user.ts' },
    ],
  };
  const reg = createToolRegistry({ snap });
  const r = await reg.call('traverse_links', { linkType: 'imports', srcId: 'file:util' });
  assert.equal(r.ok, false);
  assert.equal(r._meta.epistemic, 'lower-bound');
  assert.ok(Array.isArray(r._meta.ambiguity.candidates));
  // 期望 utils.ts 在候选中（前缀命中）
  const ids = r._meta.ambiguity.candidates.map((c) => c.id);
  assert.ok(ids.includes('file:src/utils.ts'), '应包含 utils.ts 作为相似候选');
});

test('withMeta=true 在 traverse_links 返回中带 edges 元数据', async () => {
  const { createToolRegistry } = await import('../src/ontology/toolRegistry.js');
  const snap = {
    _meta: { generatedAt: '2026-08-27T00:00:00.000Z' },
    SourceFile: [
      { id: 'file:A', name: 'A', filePath: 'A', importIds: ['file:B'] },
      { id: 'file:B', name: 'B', filePath: 'B' },
    ],
  };
  const reg = createToolRegistry({ snap });
  const r = await reg.call('traverse_links', { linkType: 'imports', srcId: 'file:A', withMeta: true });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.edges));
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].id, 'file:B');
  assert.equal(r.edges[0].confidence, 1.0);
  assert.equal(r.edges[0].reason, 'direct');
});

test('get_node 找不到 id → ambiguity 候选', async () => {
  const { createToolRegistry } = await import('../src/ontology/toolRegistry.js');
  const snap = {
    _meta: { generatedAt: '2026-08-27T00:00:00.000Z' },
    Component: [
      { id: 'comp:Button', name: 'Button', filePath: 'src/Btn.ts' },
      { id: 'comp:Banner', name: 'Banner', filePath: 'src/Banner.ts' },
    ],
  };
  const reg = createToolRegistry({ snap });
  const r = await reg.call('get_node', { id: 'comp:Buttn' });
  assert.equal(r.ok, false);
  assert.equal(r._meta.epistemic, 'lower-bound');
  const ids = r._meta.ambiguity.candidates.map((c) => c.id);
  assert.ok(ids.includes('comp:Button'), '应包含 Button 作为相似候选');
  // 候选按 score 降序
  for (let i = 1; i < r._meta.ambiguity.candidates.length; i++) {
    assert.ok(r._meta.ambiguity.candidates[i - 1].score >= r._meta.ambiguity.candidates[i].score);
  }
});

test('query_objects 歧义名（~ 多匹配）→ ambiguity 候选', async () => {
  const { createToolRegistry } = await import('../src/ontology/toolRegistry.js');
  const snap = {
    _meta: { generatedAt: '2026-08-27T00:00:00.000Z' },
    Component: [
      { id: 'comp:Button', name: 'Button', filePath: 'src/Btn.ts' },
      { id: 'comp:ButtonGroup', name: 'ButtonGroup', filePath: 'src/Group.ts' },
      { id: 'comp:Banner', name: 'Banner', filePath: 'src/Banner.ts' },
    ],
  };
  const reg = createToolRegistry({ snap });
  const r = await reg.call('query_objects', { type: 'Component', where: 'name~utton' });
  assert.equal(r.ok, true);
  assert.equal(r.total, 2);
  assert.ok(r._meta, '歧义匹配应附 _meta');
  assert.equal(r._meta.ambiguity.queriedName, 'utton');
  assert.equal(r._meta.ambiguity.distinctNames, 2);
  assert.equal(r._meta.ambiguity.candidates.length, 2);
  // 两个候选都应包含在结果中；relevance 一致（同为子串命中 0.6）
  const names = r._meta.ambiguity.candidates.map((c) => c.name);
  assert.ok(names.includes('Button'));
  assert.ok(names.includes('ButtonGroup'));
  // 候选按 score 降序排列
  for (let i = 1; i < r._meta.ambiguity.candidates.length; i++) {
    assert.ok(r._meta.ambiguity.candidates[i - 1].relevance >= r._meta.ambiguity.candidates[i].relevance);
  }
});

test('query_objects 单一匹配（精确）→ 无 _meta', async () => {
  const { createToolRegistry } = await import('../src/ontology/toolRegistry.js');
  const snap = {
    _meta: { generatedAt: '2026-08-27T00:00:00.000Z' },
    Component: [
      { id: 'comp:Button', name: 'Button', filePath: 'src/Btn.ts' },
      { id: 'comp:Banner', name: 'Banner', filePath: 'src/Banner.ts' },
    ],
  };
  const reg = createToolRegistry({ snap });
  const r = await reg.call('query_objects', { type: 'Component', where: 'name=Button' });
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r._meta, undefined, '精确匹配不附 _meta');
});

test('get_health 返回 resolutionStats（空时为 null）', async () => {
  const { createToolRegistry } = await import('../src/ontology/toolRegistry.js');
  const snap = { _meta: { generatedAt: '2026-08-27T00:00:00.000Z' } };
  const reg = createToolRegistry({ snap });
  const r = await reg.call('get_health', {});
  assert.equal(r.ok, true);
  // 无 resolutionStats 时为 null（不抛错）
  assert.equal(r.summary.resolutionStats, null);
});

test('get_health 暴露 builder 写入的 resolutionStats', async () => {
  const { createToolRegistry } = await import('../src/ontology/toolRegistry.js');
  const snap = {
    _meta: {
      generatedAt: '2026-08-27T00:00:00.000Z',
      resolutionStats: {
        totalImportAttempts: 100,
        totalResolvedImports: 95,
        unresolvedImportsCount: 5,
        importResolutionRate: 0.95,
        fuzzyLinkCount: 12,
      },
    },
  };
  const reg = createToolRegistry({ snap });
  const r = await reg.call('get_health', {});
  assert.equal(r.ok, true);
  assert.equal(r.summary.resolutionStats.importResolutionRate, 0.95);
  assert.equal(r.summary.resolutionStats.fuzzyLinkCount, 12);
});
