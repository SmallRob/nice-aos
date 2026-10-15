// linkDefs 单元测试（v0.50.0）：
//   - 内部一致性（name 唯一、reverse 互指、sourcePrefixes 非空）
//   - 与 blueprint.js LINK_TYPES 完全同步（同一 56 个 linkType）
//   - REVERSE_OF / FORWARD_OF 对称
//   - 派生工具函数（getLinkDef / acceptsSource / hasLinkImpl）

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINK_DEF_BY_NAME,
  REVERSE_OF,
  FORWARD_OF,
  LINK_TYPE_PAIRS,
  REVERSE_LINK_TYPES,
  LINK_DEFS,
  LINK_TYPE_NAMES,
  IMPLEMENTED_LINK_TYPES,
  LINK_DEFS_BY_CATEGORY,
  getLinkDef,
  acceptsSource,
  hasLinkImpl,
} from '../src/ontology/linkDefs.js';
import { LINK_TYPES } from '../src/ontology/blueprint.js';

test('LINK_DEFS 内部一致性：name 集合唯一', () => {
  const set = new Set();
  for (const def of LINK_DEFS) {
    assert.equal(set.has(def.name), false, `name 重复: ${def.name}`);
    set.add(def.name);
  }
  assert.equal(set.size, LINK_DEFS.length, 'name 集合应等于 LINK_DEFS 长度');
});

test('LINK_DEFS 内部一致性：reverse 指向有效 name 且不等于自身', () => {
  for (const def of LINK_DEFS) {
    if (!def.reverse) continue;
    assert.notEqual(def.reverse, def.name, `${def.name}.reverse 不能等于 name`);
    assert.ok(LINK_DEF_BY_NAME[def.reverse], `${def.name}.reverse=${def.reverse} 必须存在 LINK_DEF`);
  }
});

test('LINK_DEFS 内部一致性：每个 def 必须声明 sourcePrefixes[] 非空', () => {
  for (const def of LINK_DEFS) {
    assert.ok(Array.isArray(def.sourcePrefixes), `${def.name} 必须有 sourcePrefixes[]`);
    assert.ok(def.sourcePrefixes.length > 0, `${def.name} sourcePrefixes 不能为空`);
  }
});

test('LINK_DEFS 与 blueprint.js LINK_TYPES 完全同步（同一 56 个 linkType）', () => {
  const defSet = new Set(LINK_TYPE_NAMES);
  const bpSet = new Set(LINK_TYPES);
  assert.equal(defSet.size, bpSet.size, `LINK_TYPE_NAMES 大小 (${defSet.size}) 应等于 blueprint.LINK_TYPES (${bpSet.size})`);
  for (const name of defSet) {
    assert.ok(bpSet.has(name), `linkDefs 含 ${name} 但 blueprint.LINK_TYPES 没有`);
  }
  for (const name of bpSet) {
    assert.ok(defSet.has(name), `blueprint.LINK_TYPES 含 ${name} 但 linkDefs 没有`);
  }
});

test('REVERSE_OF / FORWARD_OF 完全对称', () => {
  for (const [fwd, rev] of Object.entries(REVERSE_OF)) {
    assert.equal(FORWARD_OF[rev], fwd, `FORWARD_OF[${rev}] 应等于 ${fwd}`);
  }
  for (const [rev, fwd] of Object.entries(FORWARD_OF)) {
    assert.equal(REVERSE_OF[fwd], rev, `REVERSE_OF[${fwd}] 应等于 ${rev}`);
  }
});

test('REVERSE_OF 集合大小等于有 reverse 字段的 def 数量', () => {
  const reverseCount = LINK_DEFS.filter((d) => d.reverse).length;
  assert.equal(Object.keys(REVERSE_OF).length, reverseCount);
  assert.equal(Object.keys(FORWARD_OF).length, reverseCount);
  assert.equal(Object.keys(LINK_TYPE_PAIRS).length, reverseCount);
});

test('REVERSE_LINK_TYPES 仅含 LINK_TYPES 中实际存在的反向 name', () => {
  for (const rev of REVERSE_LINK_TYPES) {
    assert.ok(LINK_TYPES.includes(rev) || LINK_DEF_BY_NAME[rev],
      `反向 linkType ${rev} 不在 LINK_TYPES 中（应当两边共享）`);
  }
});

test('getLinkDef 已知 linkType 返回 def；未知返回 null', () => {
  const known = getLinkDef('renders');
  assert.ok(known);
  assert.equal(known.name, 'renders');
  assert.equal(known.reverse, 'renderedBy');

  const unknown = getLinkDef('not-a-linkType-zzz');
  assert.equal(unknown, null);
});

test('acceptsSource(prefix 命中) / 不命中（核心组件关系）', () => {
  // renders 源必须是 comp:
  assert.equal(acceptsSource('renders', 'comp:Button'), true);
  assert.equal(acceptsSource('renders', 'file:src/a.ts'), false);
  assert.equal(acceptsSource('renders', 'method:src/a.ts#foo'), false);

  // belongsTo 源可以是 mod: / method:
  assert.equal(acceptsSource('belongsTo', 'mod:src'), true);
  assert.equal(acceptsSource('belongsTo', 'method:foo'), true);
  assert.equal(acceptsSource('belongsTo', 'comp:X'), false);

  // contains 多源（proj/mod/file/iface/class/us）
  for (const p of ['proj', 'mod', 'file', 'iface', 'class', 'us']) {
    assert.equal(acceptsSource('contains', `${p}:foo`), true, `contains 应接受 ${p}:`);
  }
  assert.equal(acceptsSource('contains', 'method:foo'), false);

  // 未知 linkType 返回 false
  assert.equal(acceptsSource('not-z', 'comp:anything'), false);
});

test('hasLinkImpl 与 IMPLEMENTED_LINK_TYPES 对应', () => {
  // 27 个有实现的
  assert.equal(IMPLEMENTED_LINK_TYPES.length, 27, '当前 27 个 hasImpl=true');
  for (const lt of IMPLEMENTED_LINK_TYPES) {
    assert.equal(hasLinkImpl(lt), true, `${lt} 应有 linkImpls 实现`);
  }
  // shell/CMake/Nix/ROS/Cross-lang/callsApi 等有 def 但 hasImpl=false
  assert.equal(hasLinkImpl('callsFunction'), false);
  assert.equal(hasLinkImpl('crossLangMatches'), false);
  assert.equal(hasLinkImpl('declaresChannel'), false);
});

test('LINK_DEFS_BY_CATEGORY 分组完整（hierarchy / reference / derive）', () => {
  // 三个分类至少各有 1 个
  assert.ok(LINK_DEFS_BY_CATEGORY.hierarchy);
  assert.ok(LINK_DEFS_BY_CATEGORY.reference);
  assert.ok(LINK_DEFS_BY_CATEGORY.derive);
  // 各分类下的 name 都应在 LINK_TYPE_NAMES 里
  for (const [cat, names] of Object.entries(LINK_DEFS_BY_CATEGORY)) {
    for (const name of names) {
      assert.ok(LINK_DEF_BY_NAME[name], `${cat} 下 ${name} 应有 def`);
    }
  }
  // 分组总和等于 LINK_DEFS 长度
  let sum = 0;
  for (const arr of Object.values(LINK_DEFS_BY_CATEGORY)) sum += arr.length;
  assert.equal(sum, LINK_DEFS.length);
});
