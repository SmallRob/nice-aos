// converter 钩子单元测试（v0.51.0）：
//   - resolveLink 三档（forward / reverse / unknown）
//   - expandLinked 当前默认空（保留接口）
//   - linkVocabulary 派生 linkTypePairs + reverseLinkTypes
//   - getConverter 默认单例（两次调用同一实例）
//   - registerConverter 接口契约（钩子检查、default 切换、测试重置）

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  niceAosConverter,
  getConverter,
  registerConverter,
  __resetConverterForTest,
} from '../src/ontology/converter.js';

test('niceAosConverter 是默认实例（导入即可用）', () => {
  assert.equal(typeof niceAosConverter, 'object');
  assert.equal(typeof niceAosConverter.resolveLink, 'function');
  assert.equal(typeof niceAosConverter.expandLinked, 'function');
  assert.equal(typeof niceAosConverter.linkVocabulary, 'function');
});

test('resolveLink 正向 linkType → {base: 自身, direction: out}', () => {
  const r = niceAosConverter.resolveLink('renders');
  assert.deepEqual(r, { base: 'renders', direction: 'out' });

  const r2 = niceAosConverter.resolveLink('imports');
  assert.deepEqual(r2, { base: 'imports', direction: 'out' });
});

test('resolveLink 反向 linkType → {base: 反向的 forward, direction: in}', () => {
  const r = niceAosConverter.resolveLink('renderedBy');
  assert.deepEqual(r, { base: 'renders', direction: 'in' });

  const r2 = niceAosConverter.resolveLink('importedBy');
  assert.deepEqual(r2, { base: 'imports', direction: 'in' });

  const r3 = niceAosConverter.resolveLink('calledBy');
  assert.deepEqual(r3, { base: 'calls', direction: 'in' });
});

test('resolveLink 未知 linkType → null（不抛错）', () => {
  assert.equal(niceAosConverter.resolveLink('not-a-linkType-zzz'), null);
  assert.equal(niceAosConverter.resolveLink(''), null);
  assert.equal(niceAosConverter.resolveLink(null), null);
  assert.equal(niceAosConverter.resolveLink(undefined), null);
});

test('expandLinked 默认实现：返回 []（无多态扩展）', () => {
  const ctx = {
    index: { byId: new Map(), out: new Map(), inn: new Map() },
    srcId: 'method:foo',
    srcEntity: { id: 'method:foo', name: 'foo' },
    base: 'calls',
    direction: 'out',
    direct: [],
  };
  const extras = niceAosConverter.expandLinked(ctx);
  assert.deepEqual(extras, []);
});

test('linkVocabulary 返回 linkTypePairs + reverseLinkTypes', () => {
  const vocab = niceAosConverter.linkVocabulary();
  assert.ok(vocab.linkTypePairs && typeof vocab.linkTypePairs === 'object');
  assert.ok(Array.isArray(vocab.reverseLinkTypes));

  // 正向对里有 renders: renderedBy
  assert.equal(vocab.linkTypePairs.renders, 'renderedBy');
  assert.equal(vocab.linkTypePairs.imports, 'importedBy');
  assert.equal(vocab.linkTypePairs.calls, 'calledBy');

  // 反向列表里有 renderedBy 但不应有 renders（除非 wraps 反向重复）
  assert.ok(vocab.reverseLinkTypes.includes('renderedBy'));
  assert.ok(vocab.reverseLinkTypes.includes('importedBy'));
  assert.ok(vocab.reverseLinkTypes.includes('calledBy'));
  // reverseLinkTypes 去重
  assert.equal(vocab.reverseLinkTypes.length, new Set(vocab.reverseLinkTypes).size);
});

test('getConverter 默认返回 niceAosConverter 单例', () => {
  const a = getConverter();
  const b = getConverter();
  assert.equal(a, b, '两次 getConverter 必须返回同一实例（单例）');
  assert.equal(a, niceAosConverter, '默认实例即 niceAosConverter');
});

test('registerConverter 默认不替换（保持 niceAosConverter 单例不动）', () => {
  const prev = getConverter();
  const stub = {
    resolveLink: () => null,
    expandLinked: () => [],
    linkVocabulary: () => ({ linkTypePairs: {}, reverseLinkTypes: [] }),
  };
  // 不传 default: true → 不替换
  registerConverter(stub);
  const after = getConverter();
  assert.equal(after, prev, 'registerConverter 不传 opts.default 不替换');
});

test('registerConverter({default: true}) 替换默认', () => {
  const stub = {
    resolveLink: (lt) => lt === 'foo' ? { base: 'foo', direction: 'out' } : null,
    expandLinked: () => ['x'],
    linkVocabulary: () => ({
      linkTypePairs: { foo: 'fooedBy' },
      reverseLinkTypes: ['fooedBy'],
    }),
  };
  registerConverter(stub, { default: true });
  const curr = getConverter();
  assert.equal(curr, stub, 'opts.default=true 替换默认');
  assert.deepEqual(curr.resolveLink('foo'), { base: 'foo', direction: 'out' });
  assert.deepEqual(curr.expandLinked({}), ['x']); // stub 钩子返回 ['x']
  // 验证 __resetConverterForTest 恢复
  __resetConverterForTest();
  assert.equal(getConverter(), niceAosConverter);
});

test('registerConverter 拒绝缺钩子的对象', () => {
  assert.throws(
    () => registerConverter({}),
    /缺少.*钩子/,
    '必须三个钩子都有',
  );
  assert.throws(
    () => registerConverter({ resolveLink: () => null }), // 缺 expandLinked 和 linkVocabulary
    /缺少.*钩子/,
  );
  assert.throws(
    () => registerConverter(null),
    /必须传入 converter/,
    'null 也拒绝',
  );
});

test('niceAosConverter hook 调用是纯函数（不修改 ctx / 不修改 index）', () => {
  // expandLinked 应当是无副作用的，ctx 传入前后对象一致
  const ctx = {
    index: { byId: new Map(), out: new Map(), inn: new Map() },
    srcId: 'method:foo',
    srcEntity: { id: 'method:foo', name: 'foo' },
    base: 'calls',
    direction: 'out',
    direct: [{ id: 'mtd:bar' }],
  };
  const ctxSnapshot = JSON.stringify(ctx);
  niceAosConverter.expandLinked(ctx);
  assert.equal(JSON.stringify(ctx), ctxSnapshot, 'expandLinked 不应修改 ctx');
});
