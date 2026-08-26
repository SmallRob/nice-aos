// deadCode BFS 算法测试
// 覆盖：
//   - computeReachableSet 基础 BFS（imports + calls）
//   - roots 包含 entry files / exported / test files / extraEntryIds
//   - 不可达 method 被正确识别
//   - markDeadCandidates 写回字段
//   - handle 循环依赖
//   - 边界：空 snapshot、孤儿 id、深度链路

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeReachableSet, findDeadExported, markDeadCandidates } from '../src/analyzers/deadCode.js';

// 测试 fixture：一个 React 项目的微型版本
// - main.tsx 是 entry file，含 module function "main"
// - App.tsx 是 entry file
// - A 组件用 B 组件；B 组件没人用（dead）
// - helper: exported 但没人调（dead）
const FIXTURE = {
  _meta: { generatedAt: '2026-08-26T00:00:00.000Z' },
  Project: [{ id: 'proj:test', name: 'test' }],
  Method: [
    // main.tsx 中的 module function：调 A.render
    { id: 'method:src/main.tsx#main', name: 'main', filePath: 'src/main.tsx', line: 1, ownerKind: 'module', exported: true, callIds: ['method:src/A.tsx#A#render'] },
    // helper: 导出但没人调
    { id: 'method:src/utils.ts#formatDate', name: 'formatDate', filePath: 'src/utils.ts', line: 1, ownerKind: 'module', exported: true },
    // A 组件的方法：不再调 B（让 B 完全独立，验证 dead class 检测）
    { id: 'method:src/A.tsx#A#render', name: 'render', filePath: 'src/A.tsx', line: 5, ownerKind: 'class', exported: true, ownerId: 'class:src/A.tsx#A' },
    // B 组件的方法：没被任何东西调
    { id: 'method:src/B.tsx#B#render', name: 'render', filePath: 'src/B.tsx', line: 5, ownerKind: 'class', exported: true, ownerId: 'class:src/B.tsx#B' },
    // 测试方法：算 root
    { id: 'method:src/__tests__/main.test.ts#testX', name: 'testX', filePath: 'src/__tests__/main.test.ts', line: 1, ownerKind: 'module', exported: true },
  ],
  Class: [
    { id: 'class:src/A.tsx#A', name: 'A', filePath: 'src/A.tsx', line: 3, exported: true, methodIds: ['method:src/A.tsx#A#render'] },
    { id: 'class:src/B.tsx#B', name: 'B', filePath: 'src/B.tsx', line: 3, exported: true, methodIds: ['method:src/B.tsx#B#render'] },
  ],
  Interface: [
    { id: 'iface:src/types.ts#UnusedIface', name: 'UnusedIface', filePath: 'src/types.ts', line: 1, exported: true },
    { id: 'iface:src/types.ts#UsedIface', name: 'UsedIface', filePath: 'src/types.ts', line: 5, exported: true, methodIds: [] },
  ],
  SourceFile: [
    { id: 'file:src/main.tsx', name: 'main.tsx', module: 'src' },
    { id: 'file:src/A.tsx', name: 'A.tsx', module: 'src' },
    { id: 'file:src/B.tsx', name: 'B.tsx', module: 'src' },
    { id: 'file:src/utils.ts', name: 'utils.ts', module: 'src' },
    { id: 'file:src/types.ts', name: 'types.ts', module: 'src' },
    { id: 'file:src/__tests__/main.test.ts', name: 'main.test.ts', module: 'src' },
  ],
  Component: [
    // 假设 App 用了 A
    { id: 'comp:App', name: 'App', filePath: 'src/App.tsx', line: 1, storeIds: [], methodIds: [] },
  ],
};

test('computeReachableSet 基础 BFS 包含 main + test + chain', () => {
  const { reachable, stats } = computeReachableSet(FIXTURE);
  // main 是 root（entry file module function）
  assert.ok(reachable.has('method:src/main.tsx#main'));
  // testX 是 test file → root
  assert.ok(reachable.has('method:src/__tests__/main.test.ts#testX'));
  // formatDate 是 exported module function 但没人调 → BFS 不可达（新设计）
  assert.ok(!reachable.has('method:src/utils.ts#formatDate'), 'exported module function 不可达');
  // main → A.render 通过 callIds
  assert.ok(reachable.has('method:src/A.tsx#A#render'));
  // A 类节点通过反向边（method → owner class）可达
  assert.ok(reachable.has('class:src/A.tsx#A'));
  // B.render 没被任何东西调 → 不可达
  assert.ok(!reachable.has('method:src/B.tsx#B#render'), 'B.render 不可达（无 call 链）');
  // B 类节点也不可达（通过反向边：method 可达时 class 才可达）
  assert.ok(!reachable.has('class:src/B.tsx#B'), 'B 类不可达');
  assert.ok(stats.nodesReachable > 0);
});

test('findDeadExported 找出 UnusedClass（没被任何东西引用）', () => {
  // 阶段 1.2 仅报 class dead
  // B 类是 exported，但 main 调 A.render 不调 B，B 没在 main 的 *Ids 字段中
  // A 是 exported class → root
  // A.methodIds 拉 A.render 可达
  // 但 B 类自身没在 A 的 *Ids 字段中（class.methodIds 是 A.methodIds，不是 B.methodIds）
  // 所以 B 是 dead
  const result = findDeadExported(FIXTURE);
  // B 应被报
  assert.ok(result.deadClasses.length >= 1, 'B 应被报为 dead class');
  assert.ok(result.deadClasses.some((c) => c.name === 'B'));
});

test('findDeadExported 处理循环引用', () => {
  // 简化：让 a/b 在 entry file 中
  const cyclic = {
    _meta: {},
    Method: [
      { id: 'm:src/main.tsx#a', name: 'a', filePath: 'src/main.tsx', line: 1, ownerKind: 'module', callIds: ['m:src/main.tsx#b'] },
      { id: 'm:src/main.tsx#b', name: 'b', filePath: 'src/main.tsx', line: 5, ownerKind: 'module', callIds: ['m:src/main.tsx#a'] },
    ],
    SourceFile: [{ id: 'file:src/main.tsx', name: 'main.tsx', module: 'src' }],
  };
  const { reachable, stats } = computeReachableSet(cyclic);
  // a 是 entry file module function → root → 链 a→b→a 应能 BFS 完
  assert.ok(reachable.has('m:src/main.tsx#a'));
  assert.ok(reachable.has('m:src/main.tsx#b'));
  assert.ok(stats.queueOps < 10, 'BFS 不应无限循环');
});

test('findDeadExported 边界：空 snapshot', () => {
  const empty = { _meta: {} };
  const result = findDeadExported(empty);
  assert.equal(result.deadClasses.length, 0);
  assert.equal(result.stats.deadTotal, 0);
});

test('findDeadExported class A 被引用，class B 没人引用', () => {
  // A 是 root (imported by main)；B 是 exported class 但没人用
  const fixture = {
    _meta: {},
    Class: [
      { id: 'class:A#A', name: 'A', filePath: 'A.tsx', line: 1, exported: true, methodIds: [] },
      { id: 'class:B#B', name: 'B', filePath: 'B.tsx', line: 1, exported: true, methodIds: [] },
    ],
    SourceFile: [{ id: 'file:src/main.tsx', name: 'main.tsx', module: 'src' }],
    Method: [
      // main 显式 import A（用 importIds 字段）
      { id: 'm:src/main.tsx#main', name: 'main', filePath: 'src/main.tsx', line: 1, ownerKind: 'module', importIds: ['class:A#A'] },
    ],
  };
  const result = findDeadExported(fixture);
  assert.equal(result.deadClasses.length, 1);
  assert.equal(result.deadClasses[0].name, 'B');
});

test('findDeadExported exported class 没人用且没人 import → dead', () => {
  // 最简：单一 exported class，main 不引
  const fixture = {
    _meta: {},
    Class: [
      { id: 'class:lonely.ts#Lonely', name: 'Lonely', filePath: 'lonely.ts', line: 1, exported: true, methodIds: [] },
    ],
    Method: [
      { id: 'm:src/main.tsx#main', name: 'main', filePath: 'src/main.tsx', line: 1, ownerKind: 'module' },
    ],
  };
  const result = findDeadExported(fixture);
  assert.equal(result.deadClasses.length, 1);
  assert.equal(result.deadClasses[0].name, 'Lonely');
});

test('markDeadCandidates 写回 Class 字段', () => {
  const snap = {
    _meta: {},
    Class: [
      { id: 'class:lonely.ts#Lonely', name: 'Lonely', filePath: 'lonely.ts', line: 1, exported: true, methodIds: [] },
    ],
    Method: [
      { id: 'm:src/main.tsx#main', name: 'main', filePath: 'src/main.tsx', line: 1, ownerKind: 'module' },
    ],
  };
  const marked = markDeadCandidates(snap);
  assert.equal(marked, 1);
  const cls = snap.Class[0];
  assert.equal(cls.deadCandidate, true);
  assert.match(cls.deadReason, /BFS 不可达/);
});

test('markDeadCandidates 不标非导出的 class', () => {
  const snap = {
    _meta: {},
    Class: [
      { id: 'class:internal#Internal', name: 'Internal', filePath: 'internal.ts', line: 1, exported: false, methodIds: [] },
    ],
  };
  const marked = markDeadCandidates(snap);
  assert.equal(marked, 0);
  assert.equal(snap.Class[0].deadCandidate, undefined);
});

test('computeReachableSet 包含 Component（React/Vue 框架渲染）', () => {
  const snap = {
    _meta: {},
    Component: [
      { id: 'comp:Header', name: 'Header', filePath: 'Header.tsx', line: 1 },
    ],
    Method: [
      { id: 'm:src/main.tsx#main', name: 'main', filePath: 'src/main.tsx', line: 1, ownerKind: 'module' },
    ],
  };
  const { reachable } = computeReachableSet(snap);
  // Component 是 root
  assert.ok(reachable.has('comp:Header'));
});

test('BFS 节点计数准确', () => {
  const snap = {
    _meta: {},
    Method: [
      { id: 'm:src/main.tsx#x', name: 'x', filePath: 'src/main.tsx', line: 1, ownerKind: 'module', callIds: ['m:src/main.tsx#y'] },
      { id: 'm:src/main.tsx#y', name: 'y', filePath: 'src/main.tsx', line: 5, ownerKind: 'module', callIds: ['m:src/main.tsx#z'] },
      { id: 'm:src/main.tsx#z', name: 'z', filePath: 'src/main.tsx', line: 9, ownerKind: 'module' },
    ],
    SourceFile: [{ id: 'file:src/main.tsx', name: 'main.tsx', module: 'src' }],
  };
  const { reachable, stats } = computeReachableSet(snap);
  // x 是 entry file module function → root
  assert.equal(reachable.size, 3);
  assert.equal(stats.nodesReachable, 3);
});

test('BFS 不被 orphan ID 影响（id 不在 byId 中）', () => {
  const snap = {
    _meta: {},
    Method: [
      { id: 'm:src/main.tsx#main', name: 'main', filePath: 'src/main.tsx', line: 1, ownerKind: 'module', callIds: ['m:non-existent#orphan'] },
    ],
    SourceFile: [{ id: 'file:src/main.tsx', name: 'main.tsx', module: 'src' }],
  };
  const { reachable, stats } = computeReachableSet(snap);
  assert.ok(reachable.has('m:src/main.tsx#main'));
  assert.equal(stats.queueOps, 1, 'orphan id 应被跳过');
});
