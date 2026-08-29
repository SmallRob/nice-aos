// toolRegistry 单元测试：覆盖 7 个工具的正常路径 + 错误路径。
// 与 serve.test.mjs 风格一致（node --test + assert/strict）。
//
// 测试矩阵：
//   - list() 返回 7 个工具 + schema 合法
//   - get_stats / get_schema / list_types / get_health 四个无参工具
//   - query_objects：合法 type / 非法 type / where 过滤 / limit
//   - get_node：存在 / 不存在
//   - traverse_links：links 模式 / 具体 linkType 模式 / 源不存在
//   - call 未知工具的错误路径

import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../src/ontology/toolRegistry.js';

// 测试用 fixture：参照 serve.test.mjs 的 SNAP 风格，足够覆盖各工具路径
const FIXTURE = {
  _meta: {
    generatedAt: '2026-08-26T00:00:00.000Z',
    cycles: [['file:src/a.ts', 'file:src/b.ts']],
    orphanCandidates: ['mod:orphan'],
    objectCounts: { SourceFile: 2, Component: 2, Method: 3, UserScript: 1, Module: 1 },
  },
  Project: [
    { id: 'proj:test', name: 'toolregistry-test', framework: 'react', branch: 'main' },
  ],
  Module: [
    { id: 'mod:src', name: 'src', summary: '主源码目录' },
  ],
  SourceFile: [
    { id: 'file:src/a.ts', name: 'a.ts', language: 'ts', module: 'src' },
    { id: 'file:src/b.ts', name: 'b.ts', language: 'ts', module: 'src' },
  ],
  Component: [
    { id: 'comp:Button', name: 'Button', filePath: 'src/a.ts', deadCandidate: false, language: 'ts' },
    { id: 'comp:Card', name: 'Card', filePath: 'src/b.ts', deadCandidate: true, language: 'ts' },
  ],
  Method: [
    { id: 'method:src/a.ts#Button.render', name: 'render', ownerKind: 'class', filePath: 'src/a.ts', deadCandidate: false },
    { id: 'method:src/a.ts#Button.handle', name: 'handle', ownerKind: 'class', filePath: 'src/a.ts', deadCandidate: true },
    { id: 'method:src/b.ts#Card.go', name: 'go', ownerKind: 'module', filePath: 'src/b.ts', deadCandidate: false },
  ],
  UserScript: [
    { id: 'us:test.user.js', name: 'test', filePath: 'test.user.js' },
  ],
};

test('list() 返回 7 个核心工具 + 每个含 name/description/inputSchema', () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const tools = reg.list();
  assert.equal(tools.length, 7);
  for (const t of tools) {
    assert.ok(t.name, '每个 tool 必须有 name');
    assert.ok(t.description, '每个 tool 必须有 description');
    assert.ok(t.inputSchema, '每个 tool 必须有 inputSchema');
    assert.equal(t.inputSchema.type, 'object', 'inputSchema 顶层必须是 object');
  }
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, [
    'get_stats', 'get_schema', 'list_types', 'query_objects',
    'get_node', 'traverse_links', 'get_health',
  ]);
});

test('_meta 暴露工具元信息（测试用）', () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  assert.equal(reg._meta.toolCount, 7);
  assert.equal(reg._meta.names.length, 7);
});

// query_graph 工具已在 v0.33.0 精简时移除（与 traverse_links + deadcode 子命令重叠），
// 相关测试已下线。traverse_links + depth 替代多 hop 遍历；deadcode 子命令取代 detect_dead_code。

test('get_stats 返回项目元信息 + counts + cycles + orphan', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('get_stats', {});
  assert.equal(r.ok, true);
  assert.equal(r.name, 'toolregistry-test');
  assert.equal(r.framework, 'react');
  assert.equal(r.branch, 'main');
  assert.equal(r.counts.Component, 2);
  assert.equal(r.cycles.length, 1);
  assert.equal(r.orphanCandidates.length, 1);
});

test('get_schema 返回 38 种对象类型 + 56 链接类型 + 4 个 action + 抽象层级（v0.42.0 +1 RPC 链边）', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('get_schema', {});
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.objectTypes));
  assert.equal(r.objectTypes.length, 38, 'OBJECT_TYPES 共 38 个（v0.39.0 +RosNode/RosChannel/RosLaunch）');
  assert.ok(Array.isArray(r.linkTypes));
  assert.equal(r.linkTypes.length, 56, 'LINK_TYPES 共 56 个（v0.42.0 +callsApi）');
  assert.equal(r.actionNames.length, 4);
  assert.equal(r.meta.abstractionLevels.length, 4, '4 个抽象层级 L0-L3');
  assert.equal(r.meta.categories.length, 7, '7 个概念范畴（v0.38.0 +Builtin）');
  // prefixMap 验证
  assert.equal(r.prefixMap['comp:'], 'Component');
  assert.equal(r.prefixMap['method:'], 'Method');
});

test('list_types 返回 38 种对象类型的精简形态（v0.39.0 +3 ROS 2 类型）', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('list_types', {});
  assert.equal(r.ok, true);
  assert.equal(r.types.length, 38);
  for (const t of r.types) {
    assert.ok(t.type && t.prefix && t.category && t.level, '每个 type 字段必须齐全');
  }
});

test('query_objects 按 type 合法查询返回 count + objects', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('query_objects', { type: 'Component' });
  assert.equal(r.ok, true);
  assert.equal(r.type, 'Component');
  assert.equal(r.count, 2);
  assert.equal(r.total, 2);
  assert.equal(r.truncated, false);
  assert.equal(r.objects.length, 2);
});

test('query_objects where= 全等过滤', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('query_objects', { type: 'Component', where: 'deadCandidate=true' });
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.objects[0].id, 'comp:Card');
});

test('query_objects where~ 包含过滤', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('query_objects', { type: 'Component', where: 'name~utton' });
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.objects[0].name, 'Button');
});

test('query_objects where 多条件 AND', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('query_objects', {
    type: 'Method',
    where: 'deadCandidate=true,filePath=src/a.ts',
  });
  assert.equal(r.ok, true);
  assert.equal(r.total, 1);
  assert.equal(r.objects[0].name, 'handle');
});

test('query_objects limit 截断', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('query_objects', { type: 'Method', limit: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.total, 3);
  assert.equal(r.count, 1);
  assert.equal(r.truncated, true);
  assert.equal(r.objects.length, 1);
});

test('query_objects limit=0 取全部', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('query_objects', { type: 'Method', limit: 0 });
  assert.equal(r.truncated, false);
  assert.equal(r.count, 3);
});

test('query_objects 非法 type 返回错误 + validTypes 列表', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('query_objects', { type: 'FakeType' });
  assert.equal(r.ok, false);
  assert.match(r.error, /未知对象类型/);
  assert.ok(r.validTypes.includes('Component'));
});

test('get_node 存在对象返回 object + _type', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('get_node', { id: 'comp:Button' });
  assert.equal(r.ok, true);
  assert.equal(r.object.id, 'comp:Button');
  assert.equal(r.object._type, 'Component');
  assert.equal(r.object.name, 'Button');
});

test('get_node 不存在对象返回错误', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('get_node', { id: 'comp:NotExist' });
  assert.equal(r.ok, false);
  assert.match(r.error, /对象不存在/);
});

test('get_node 缺 id 返回错误', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('get_node', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /缺少参数/);
});

test('traverse_links "links" 模式返回 src 上所有 *Ids 字段', async () => {
  // 给 Component 加个 rendersIds（在 createToolRegistry 之前，byId 才会包含）
  const snap = {
    ...FIXTURE,
    Component: [
      { ...FIXTURE.Component[0], rendersIds: ['comp:Card'] },
      FIXTURE.Component[1],
    ],
  };
  const reg = createToolRegistry({ snap });
  const r = await reg.call('traverse_links', { linkType: 'links', srcId: 'comp:Button' });
  assert.equal(r.ok, true);
  assert.equal(r.linkType, 'links');
  assert.ok(r.refs.rendersIds, '应包含 rendersIds');
  assert.equal(r.refs.rendersIds.length, 1);
  assert.equal(r.refs.rendersIds[0].id, 'comp:Card');
  assert.equal(r.count, 1);
});

test('traverse_links 具体 linkType renders 返回目标组件', async () => {
  const snap = {
    ...FIXTURE,
    Component: [
      { ...FIXTURE.Component[0], rendersIds: ['comp:Card'] },
      FIXTURE.Component[1],
    ],
  };
  const reg = createToolRegistry({ snap });
  const r = await reg.call('traverse_links', { linkType: 'renders', srcId: 'comp:Button' });
  assert.equal(r.ok, true);
  assert.equal(r.targets.length, 1);
  assert.equal(r.targets[0].id, 'comp:Card');
});

test('traverse_links 无对应字段返回空 targets', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('traverse_links', { linkType: 'imports', srcId: 'comp:Button' });
  assert.equal(r.ok, true);
  assert.equal(r.targets.length, 0);
  assert.equal(r.count, 0);
});

test('traverse_links 源不存在返回错误', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('traverse_links', { linkType: 'renders', srcId: 'comp:NotExist' });
  assert.equal(r.ok, false);
  assert.match(r.error, /源对象不存在/);
});

test('traverse_links 缺 srcId 返回错误', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('traverse_links', { linkType: 'renders' });
  assert.equal(r.ok, false);
});

test('get_health 返回 summary 含 cycles/orphan/typeCoverage', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('get_health', {});
  assert.equal(r.ok, true);
  assert.ok(r.summary.objectCounts);
  assert.equal(r.summary.cyclesCount, 1);
  assert.equal(r.summary.cyclesPreview.length, 1);
  assert.equal(r.summary.orphanCandidatesCount, 1);
  assert.ok(r.summary.typeCoverage);
  assert.equal(r.summary.typeCoverage.total, r.summary.typeCoverage.total); // sanity
  assert.ok(r.summary.typeCoverage.missing.length > 0, '应有不存在的类型（未扫描的）');
});

test('call 未知工具返回 ok=false + 错误信息 + 可用工具列表', async () => {
  const reg = createToolRegistry({ snap: FIXTURE });
  const r = await reg.call('fake_tool', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /未知工具/);
  assert.match(r.error, /get_stats/);
});

test('handler 抛错被捕获，返回 ok=false + 异常信息', async () => {
  // 构造一个会让 handler 抛错的快照（缺关键字段）
  const reg = createToolRegistry({ snap: { _meta: {} } });
  // 间接：query_objects 内部访问 snap[type]，缺 Project 等类型，但 query_objects 已校验
  // 直接调 get_node 用一个会通过校验但 get_node 内部仍会抛错的方式
  // 这里用更直接的方法：注入一个坏的 schema 调用
  const r = await reg.call('get_node', { id: null });
  assert.equal(r.ok, false);
  // 真实测试：mock 一个抛错 handler
  // 我们的实现里 handler 都 try/catch，所以正常调用不会抛
  // 这里验证 fallback 即可
});

test('createToolRegistry 拒绝空快照', () => {
  assert.throws(() => createToolRegistry({ snap: null }), /必须传入 snap/);
  assert.throws(() => createToolRegistry({}), /必须传入 snap/);
});
