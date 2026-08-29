// 蓝图引擎单测：借鉴 asdm-aos BlueprintRuntime + createEngine 模式
// 覆盖：find / where / link / action / snapshot / schema / 写回不污染 seed / 守卫语义
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createBlueprintEngine,
  prefixOf,
  findObjectByPrefix,
} from '../src/ontology/blueprintEngine.js';
import {
  createBlueprintV2,
  OBJECT_TYPES,
  LINK_TYPES,
  ACTION_NAMES,
  BLUEPRINT_SCHEMA,
  ONTOLOGY_META,
} from '../src/ontology/blueprint.js';

// =============================================================================
// 1. 引擎基础：createBlueprintEngine 构造 + find/where/snapshot 行为
// =============================================================================

test('createBlueprintEngine: 最小 blueprint 构造后 byId/byType 索引可查', () => {
  const engine = createBlueprintEngine({
    id: 'test',
    name: '测试蓝图',
    objectTypes: [{ name: 'Foo' }, { name: 'Bar' }],
    linkTypes: ['related'],
    actionDefs: ['doX'],
    linkImpls: {
      related: (src) => (src.peers ?? []).map((id) => ({ id, name: id })),
    },
    actionImpls: {
      doX: (ctx, input) => ({ ok: true, message: `did ${input?.what ?? 'nothing'}` }),
    },
    createData: () => ({
      Foo: [{ id: 'foo:1', name: 'F1' }, { id: 'foo:2', name: 'F2' }],
      Bar: [{ id: 'bar:1', name: 'B1' }],
    }),
  });
  assert.equal(engine.find('foo:1')?.name, 'F1');
  assert.equal(engine.find('nonexistent'), null);
  assert.equal(engine.where('Foo').length, 2);
  assert.equal(engine.where('Bar').length, 1);
  assert.equal(engine.where('NonExist').length, 0);
});

test('createBlueprintEngine: where 谓词过滤', () => {
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }],
    linkTypes: [],
    actionDefs: [],
    linkImpls: {},
    actionImpls: {},
    createData: () => ({ X: [{ id: 'x:1', k: 1 }, { id: 'x:2', k: 2 }, { id: 'x:3', k: 3 }] }),
  });
  const big = engine.where('X', (o) => o.k >= 2);
  assert.equal(big.length, 2);
  assert.deepEqual(big.map((o) => o.id), ['x:2', 'x:3']);
});

test('createBlueprintEngine: snapshot 是深拷贝，外部修改不污染 engine.data', () => {
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }],
    linkTypes: [],
    actionDefs: [],
    linkImpls: {},
    actionImpls: {},
    createData: () => ({ X: [{ id: 'x:1', name: 'orig' }] }),
  });
  const snap = engine.snapshot();
  snap.X[0].name = 'mutated';
  assert.equal(engine.find('x:1')?.name, 'orig', 'engine.data 不应被外部 snapshot 修改污染');
});

test('createBlueprintEngine: createData 缺省时引擎以空 dataMap 启动', () => {
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }, { name: 'Y' }],
    linkTypes: [],
    actionDefs: [],
    linkImpls: {},
    actionImpls: {},
  });
  assert.deepEqual(engine.where('X'), []);
  assert.deepEqual(engine.where('Y'), []);
});

test('createBlueprintEngine: 已声明对象类型在 createData 缺该 key 时默认为空数组', () => {
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }, { name: 'Y' }],
    linkTypes: [],
    actionDefs: [],
    linkImpls: {},
    actionImpls: {},
    createData: () => ({ X: [{ id: 'x:1' }] }), // Y 缺省
  });
  assert.equal(engine.where('X').length, 1);
  assert.equal(engine.where('Y').length, 0);
});

// =============================================================================
// 2. 链接实现：linkImpls 按 src.id 解析
// =============================================================================

test('link: 调用 linkImpls 传入 src + ctx；linkImpl 可访问 byId/byType', () => {
  /** @type {string[]} */
  const calls = [];
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'A' }, { name: 'B' }],
    linkTypes: ['linkAtoB'],
    actionDefs: [],
    linkImpls: {
      linkAtoB: (src, ctx) => {
        calls.push(`src=${src.id}`);
        // 验证 ctx.byId / byType 可访问
        assert.ok(ctx.byId.get(src.id), 'ctx.byId 应可查源');
        assert.ok(ctx.byType.get('B'), 'ctx.byType 应可查 B');
        return ctx.byType.get('B') ?? [];
      },
    },
    actionImpls: {},
    createData: () => ({
      A: [{ id: 'a:1' }, { id: 'a:2' }],
      B: [{ id: 'b:1' }, { id: 'b:2' }],
    }),
  });
  const r = engine.link('linkAtoB', 'a:1');
  assert.deepEqual(calls, ['src=a:1']);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((b) => b.id), ['b:1', 'b:2']);
});

test('link: 未知 linkType 抛错（含可用类型列表）', () => {
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }],
    linkTypes: ['known'],
    actionDefs: [],
    linkImpls: { known: () => [] },
    actionImpls: {},
    createData: () => ({ X: [{ id: 'x:1' }] }),
  });
  assert.throws(() => engine.link('unknown', 'x:1'), /未知链接类型: unknown/);
  assert.throws(() => engine.link('unknown', 'x:1'), /known/);
});

test('link: 源 id 不存在时返回空数组（不抛错，对齐既有 createBlueprint 行为）', () => {
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }],
    linkTypes: ['rel'],
    actionDefs: [],
    linkImpls: { rel: (src) => [src] },
    actionImpls: {},
    createData: () => ({ X: [{ id: 'x:1' }] }),
  });
  assert.deepEqual(engine.link('rel', 'nonexistent'), []);
});

// =============================================================================
// 3. 动作实现：守卫 + 异常捕获
// =============================================================================

test('action: 未知动作返回守卫失败（不抛错）', () => {
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }],
    linkTypes: [],
    actionDefs: ['known'],
    linkImpls: {},
    actionImpls: { known: () => ({ ok: true, message: 'ok' }) },
    createData: () => ({ X: [] }),
  });
  const r = engine.action('unknown');
  assert.equal(r.ok, false);
  assert.match(r.message, /未知动作: unknown/);
});

test('action: 守卫失败（必填参数缺失）返回 {ok:false, message}', () => {
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }],
    linkTypes: [],
    actionDefs: ['create'],
    linkImpls: {},
    actionImpls: {
      create: (ctx, input) => {
        if (!input?.name) return { ok: false, message: 'name 必填' };
        return { ok: true, message: 'created' };
      },
    },
    createData: () => ({ X: [] }),
  });
  const r = engine.action('create', {});
  assert.equal(r.ok, false);
  assert.equal(r.message, 'name 必填');
});

test('action: 异常被捕获，返回守卫失败（不抛到调用方）', () => {
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }],
    linkTypes: [],
    actionDefs: ['boom'],
    linkImpls: {},
    actionImpls: {
      boom: () => { throw new Error('boom'); },
    },
    createData: () => ({ X: [] }),
  });
  const r = engine.action('boom');
  assert.equal(r.ok, false);
  assert.match(r.message, /boom/);
});

test('action: 写回不污染 seed（写后 engine.find 拿到新值；再调 snapshot 也是新值）', () => {
  /** @type {DataMap} */
  let savedTo = null;
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }],
    linkTypes: [],
    actionDefs: ['review'],
    linkImpls: {},
    actionImpls: {
      review: (ctx, input) => {
        const obj = ctx.byId.get(input.id);
        if (!obj) return { ok: false, message: '对象不存在' };
        obj.reviewed = true;
        if (input.save) savedTo = ctx.snapshot();
        return { ok: true, message: 'reviewed' };
      },
    },
    createData: () => ({ X: [{ id: 'x:1', name: 'foo' }] }),
  });
  // 写前
  assert.equal(engine.find('x:1')?.reviewed, undefined);
  // 写后
  engine.action('review', { id: 'x:1', save: true });
  assert.equal(engine.find('x:1')?.reviewed, true);
  // snapshot 也是新值
  assert.equal(engine.snapshot().X[0].reviewed, true);
  // savedTo 独立
  assert.equal(savedTo.X[0].reviewed, true);
});

// =============================================================================
// 4. Schema 自描述
// =============================================================================

test('schema: 暴露 objectTypes / linkTypes / actionDefs / objectCounts', () => {
  const engine = createBlueprintEngine({
    id: 'test-schema',
    name: '测试',
    description: '用于测试 schema 输出',
    objectTypes: [{ name: 'A' }, { name: 'B' }],
    linkTypes: ['relA', { name: 'relB', label: 'B 关系' }],
    actionDefs: ['actX', { name: 'actY', label: 'Y 动作', params: [] }],
    linkImpls: {},
    actionImpls: {},
    createData: () => ({ A: [{ id: 'a:1' }, { id: 'a:2' }], B: [{ id: 'b:1' }] }),
  });
  const s = engine.schema();
  assert.equal(s.id, 'test-schema');
  assert.equal(s.name, '测试');
  assert.equal(s.objectTypes.length, 2);
  assert.equal(s.linkTypes.length, 2);
  assert.equal(s.actionDefs.length, 2);
  assert.equal(s.objectCounts.A, 2);
  assert.equal(s.objectCounts.B, 1);
  // 字符串 linkType 被规范化为对象
  assert.equal(s.linkTypes[0].name, 'relA');
  // 对象 linkType 保留
  assert.equal(s.linkTypes[1].label, 'B 关系');
  // 字符串 actionDef 被规范化为对象
  assert.equal(s.actionDefs[0].name, 'actX');
  assert.equal(s.actionDefs[0].label, 'actX');
  assert.deepEqual(s.actionDefs[0].params, []);
});

test('schema: linkTypes 字符串数组与对象数组混合输入都规范化', () => {
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }],
    linkTypes: ['plain', { name: 'rich', description: 'd', sourceType: 'X' }],
    actionDefs: [],
    linkImpls: {},
    actionImpls: {},
  });
  const s = engine.schema();
  assert.equal(s.linkTypes[0].name, 'plain');
  assert.equal(s.linkTypes[1].name, 'rich');
  assert.equal(s.linkTypes[1].sourceType, 'X');
});

// =============================================================================
// 5. nice-aos 既有 OBJECT_TYPES / LINK_TYPES / ACTION_NAMES / ONTOLOGY_META 不变
// =============================================================================

test('nice-aos 既有元数据：OBJECT_TYPES 38 个 / LINK_TYPES 56 个 / ACTION_NAMES 4 个（v0.42.0 +1 RPC 链边）', () => {
  assert.equal(OBJECT_TYPES.length, 38);
  assert.equal(LINK_TYPES.length, 56);
  assert.equal(ACTION_NAMES.length, 4);
});

test('nice-aos 既有 ONTOLOGY_META: abstractionLevels 4 个 / categories 7 个', () => {
  assert.equal(ONTOLOGY_META.abstractionLevels.length, 4);
  assert.equal(ONTOLOGY_META.categories.length, 7);
});

test('nice-aos 既有 BLUEPRINT_SCHEMA 聚合了所有静态元数据', () => {
  assert.equal(BLUEPRINT_SCHEMA.id, 'nice-aos-ontology');
  assert.equal(BLUEPRINT_SCHEMA.objectTypes.length, 38);
  assert.equal(BLUEPRINT_SCHEMA.linkTypes.length, 56);
  assert.equal(BLUEPRINT_SCHEMA.actionNames.length, 4);
  assert.equal(BLUEPRINT_SCHEMA.meta, ONTOLOGY_META);
});

// =============================================================================
// 6. createBlueprintV2: 用既有 createBlueprint 的 link 闭包驱动新引擎
// =============================================================================

test('createBlueprintV2: 接受 dataMap + 输出 engine 实例', () => {
  const dataMap = {
    _meta: { generatedAt: '2026-08-26T00:00:00Z' },
    Project: [{ id: 'proj:t', name: 'test' }],
    SourceFile: [{ id: 'file:a.ts', path: 'src/a.ts' }],
    Component: [{ id: 'comp:Foo', name: 'Foo', filePath: 'src/a.ts' }],
  };
  const engine = createBlueprintV2(dataMap);
  assert.equal(engine.find('proj:t')?.name, 'test');
  assert.equal(engine.where('Component').length, 1);
});

test('createBlueprintV2: link 复用既有 link 闭包（linkImpls 零重写）', () => {
  const dataMap = {
    _meta: {},
    Project: [{ id: 'proj:t' }],
    Module: [
      { id: 'mod:foo', name: 'foo' },
      { id: 'mod:bar', name: 'bar' },
    ],
    SourceFile: [
      { id: 'file:foo/a.ts', module: 'foo', importIds: [] },
      { id: 'file:bar/b.ts', module: 'bar', importIds: ['file:foo/a.ts'] },
    ],
  };
  const engine = createBlueprintV2(dataMap);
  // contains: Project → Domain + Module
  const contained = engine.link('contains', 'proj:t');
  assert.ok(contained.length >= 2, 'Project 至少包含 2 个 Module');
  // imports: file:bar/b.ts → file:foo/a.ts
  const imports = engine.link('imports', 'file:bar/b.ts');
  assert.equal(imports.length, 1);
  assert.equal(imports[0].id, 'file:foo/a.ts');
});

test('createBlueprintV2: markReviewed 写回并触发 snapshotSave 回调', () => {
  /** @type {DataMap|null} */
  let saved = null;
  const dataMap = {
    _meta: {},
    Project: [{ id: 'proj:t' }],
    Component: [{ id: 'comp:X', name: 'X' }],
  };
  const engine = createBlueprintV2(dataMap, {
    snapshotSave: (d) => { saved = d; },
  });
  const r = engine.action('markReviewed', { objectId: 'comp:X' });
  assert.equal(r.ok, true);
  assert.equal(engine.find('comp:X')?.reviewed, true);
  assert.ok(saved, 'snapshotSave 已被调用');
  assert.equal(saved.Component[0].reviewed, true);
});

test('createBlueprintV2: addNote 累加注释', () => {
  const dataMap = {
    _meta: {},
    Project: [{ id: 'proj:t' }],
    Component: [{ id: 'comp:X', name: 'X' }],
  };
  const engine = createBlueprintV2(dataMap);
  engine.action('addNote', { objectId: 'comp:X', note: 'first' });
  engine.action('addNote', { objectId: 'comp:X', note: 'second' });
  assert.equal(engine.find('comp:X')?.notes, 'first\nsecond');
});

test('createBlueprintV2: 动作守卫（objectId 缺失 / 对象不存在）', () => {
  const dataMap = {
    _meta: {},
    Project: [{ id: 'proj:t' }],
  };
  const engine = createBlueprintV2(dataMap);
  assert.equal(engine.action('markReviewed', {}).ok, false);
  assert.match(engine.action('markReviewed', {}).message, /objectId/);
  assert.equal(engine.action('markReviewed', { objectId: 'comp:Nope' }).ok, false);
  assert.match(engine.action('markReviewed', { objectId: 'comp:Nope' }).message, /不存在/);
  // addNote 也走同一守卫
  assert.equal(engine.action('addNote', { objectId: 'proj:t', note: '' }).ok, false);
  assert.match(engine.action('addNote', { objectId: 'proj:t', note: '' }).message, /不可为空/);
});

test('createBlueprintV2: 未知动作返回守卫失败', () => {
  const dataMap = { _meta: {}, Project: [] };
  const engine = createBlueprintV2(dataMap);
  const r = engine.action('unknownAction');
  assert.equal(r.ok, false);
  assert.match(r.message, /未知动作/);
});

test('createBlueprintV2: schema 暴露 38 类型 / 56 链接 / 4 动作（v0.42.0 +1 RPC 链边）', () => {
  const dataMap = {
    _meta: {},
    Project: [{ id: 'proj:t' }],
    SourceFile: [{ id: 'file:a' }, { id: 'file:b' }],
  };
  const engine = createBlueprintV2(dataMap);
  const s = engine.schema();
  assert.equal(s.objectTypes.length, 38);
  assert.equal(s.linkTypes.length, 56);
  assert.equal(s.actionDefs.length, 4);
  assert.equal(s.objectCounts.SourceFile, 2);
});

test('createBlueprintV2: extraActions 允许扩展动作（供 service/planning 蓝图复用）', () => {
  const dataMap = { _meta: {}, Project: [] };
  const engine = createBlueprintV2(dataMap, {
    extraActions: {
      customEcho: (_ctx, input) => ({ ok: true, message: `echo: ${input?.msg}` }),
    },
  });
  const r = engine.action('customEcho', { msg: 'hello' });
  assert.equal(r.ok, true);
  assert.equal(r.message, 'echo: hello');
});

test('createBlueprintV2: 写回不污染传入的 dataMap（既有 createBlueprint 行为兼容）', () => {
  const dataMap = {
    _meta: {},
    Project: [{ id: 'proj:t' }],
    Component: [{ id: 'comp:X', name: 'X' }],
  };
  const engine = createBlueprintV2(dataMap);
  engine.action('markReviewed', { objectId: 'comp:X' });
  // engine.find 拿到新值
  assert.equal(engine.find('comp:X')?.reviewed, true);
  // 但传入的 dataMap 仍然保持原样（createBlueprintV2 默认不存）
  assert.equal(dataMap.Component[0].reviewed, undefined, 'dataMap 不应被污染');
});

// =============================================================================
// 7. 辅助函数
// =============================================================================

test('prefixOf: type 有 prefix 字段时优先用', () => {
  assert.equal(prefixOf({ name: 'Module', prefix: 'mod:' }), 'mod:');
  assert.equal(prefixOf({ name: 'Component', prefix: 'comp:' }), 'comp:');
});

test('prefixOf: 无 prefix 时从 name 推断（小写全名 + :）', () => {
  assert.equal(prefixOf({ name: 'Foo' }), 'foo:');
  assert.equal(prefixOf({ name: 'BazQux' }), 'bazqux:');
});

test('findObjectByPrefix: 按 prefix 匹配返回正确 typeName', () => {
  const byId = new Map([['x:1', { id: 'x:1' }]]);
  const r = findObjectByPrefix(byId, [{ name: 'X' }], 'x:1');
  assert.ok(r);
  assert.equal(r.obj.id, 'x:1');
  assert.equal(r.typeName, 'X');
});

test('findObjectByPrefix: 对象不存在返回 null', () => {
  const byId = new Map();
  assert.equal(findObjectByPrefix(byId, [], 'x:1'), null);
});

// =============================================================================
// 8. v0.35.0 技术债回归：嵌套深拷贝（E-6）+ 异步 actionImpl 契约（E-3）+ 动作真实现
// =============================================================================

test('createBlueprintEngine: action 写嵌套字段不穿透 seed（E-6 深拷贝补齐到嵌套对象）', () => {
  const seedObj = {
    id: 'x:1',
    meta: { tags: ['a'], nested: { deep: 'keep' } },
    list: [{ k: 1 }],
  };
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }],
    linkTypes: [],
    actionDefs: ['mutate'],
    linkImpls: {},
    actionImpls: {
      mutate: (ctx) => {
        const o = ctx.byId.get('x:1');
        o.meta.tags.push('z');
        o.meta.nested.deep = 'changed';
        o.list[0].k = 99;
        return { ok: true, message: 'done' };
      },
    },
    createData: () => ({ X: [seedObj] }),
  });
  engine.action('mutate');
  // 引擎内数据已变更
  assert.deepEqual(engine.find('x:1').meta.tags, ['a', 'z']);
  // seed 原对象嵌套字段不被写穿（修复前 {...r} 浅拷贝会让 push/赋值穿透）
  assert.deepEqual(seedObj.meta.tags, ['a'], 'seed 嵌套数组不应被写穿');
  assert.equal(seedObj.meta.nested.deep, 'keep', 'seed 深层字段不应被写穿');
  assert.equal(seedObj.list[0].k, 1, 'seed 数组内对象不应被写穿');
});

test('createBlueprintEngine: 同步/异步 actionImpl 契约（同步保持同步返回，异步收 Promise，rejection 收敛 ok:false）', async () => {
  const engine = createBlueprintEngine({
    id: 't',
    name: 't',
    objectTypes: [{ name: 'X' }],
    linkTypes: [],
    actionDefs: [],
    linkImpls: {},
    actionImpls: {
      syncAct: () => ({ ok: true, message: 'sync' }),
      asyncOk: async () => ({ ok: true, message: 'async' }),
      asyncBoom: async () => { throw new Error('boom'); },
    },
    createData: () => ({ X: [] }),
  });
  const r1 = engine.action('syncAct');
  assert.ok(!(r1 && typeof r1.then === 'function'), '同步 impl 结果应原样同步返回（向后兼容）');
  assert.equal(r1.message, 'sync');
  const r2 = await engine.action('asyncOk');
  assert.deepEqual(r2, { ok: true, message: 'async' });
  const r3 = await engine.action('asyncBoom');
  assert.equal(r3.ok, false);
  assert.match(r3.message, /boom/);
});

test('createBlueprintV2: analyzeFile 真实分析单文件并输出统计（E-3）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-analyze-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });
  fs.writeFileSync(path.join(dir, 'widget.tsx'), [
    "import React from 'react';",
    'export function Hello() { return <p>hi</p>; }',
    'export default Hello;',
  ].join('\n'));
  const engine = createBlueprintV2({ _meta: {}, Project: [{ id: 'proj:t' }] });
  const r = await engine.action('analyzeFile', { file: path.join(dir, 'widget.tsx') });
  assert.equal(r.ok, true, `analyzeFile 应成功: ${r.message}`);
  assert.match(r.message, /widget\.tsx/);
  assert.ok(r.stats, '应携带对象统计 stats');
  assert.ok((r.stats.SourceFile ?? 0) >= 1, '至少产出 1 个 SourceFile 对象');
  // 缺参 / 文件不存在守卫
  assert.equal((await engine.action('analyzeFile', {})).ok, false);
  assert.equal((await engine.action('analyzeFile', { file: '/nonexistent/nope.ts' })).ok, false);
});

test('createBlueprintV2: refreshRepo 真实重扫并把快照落到沙箱快照目录（E-3）', async (t) => {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-refresh-proj-'));
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-refresh-snap-'));
  t.after(() => {
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch { /* */ }
  });
  fs.writeFileSync(path.join(projDir, 'package.json'), '{"name":"refresh-fixture"}');
  fs.writeFileSync(path.join(projDir, 'app.js'), 'export const x = 1;\n');

  // 快照目录重定向到沙箱，避免污染真实 ~/.nice-aos；结束后恢复
  const { setSnapshotDir, getSnapshotDirOverride } = await import('../src/ontology/snapshot.js');
  const prevOverride = getSnapshotDirOverride();
  setSnapshotDir(snapDir);
  try {
    const engine = createBlueprintV2({ _meta: {}, Project: [{ id: 'proj:t' }] });
    const r = await engine.action('refreshRepo', { repoPath: projDir });
    assert.equal(r.ok, true, `refreshRepo 应成功: ${r.message}`);
    assert.match(r.message, /refresh-fixture/);
    assert.ok(r.snapshot, '应返回落盘路径');
    assert.ok(fs.existsSync(path.join(snapDir, 'snapshot.json')), '快照应写入沙箱目录');
    assert.ok(r.stats && Object.keys(r.stats).length > 0, '应携带 objectCounts 统计');
    // 守卫：不存在的 repoPath → ok:false
    const bad = await engine.action('refreshRepo', { repoPath: '/nonexistent/dir-nope' });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /不存在/);
  } finally {
    setSnapshotDir(prevOverride ?? null);
  }
});
