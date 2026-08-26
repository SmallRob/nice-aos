// 蓝图交互动作单测：借鉴 asdm-aos ActionPanel.tsx 设计
// 覆盖：按类型过滤 / 默认值 / HTML 渲染 / 守卫 / 多动作拼接
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_DEFS,
  getActionsForType,
  buildActionCards,
  renderActionCardHtml,
  renderActionCardsHtml,
} from '../src/ontology/blueprintActions.js';

// =============================================================================
// 1. 元数据
// =============================================================================

test('ACTION_DEFS 含 4 个内置动作', () => {
  assert.equal(ACTION_DEFS.length, 4);
  const names = ACTION_DEFS.map((a) => a.name);
  for (const expected of ['markReviewed', 'addNote', 'refreshRepo', 'analyzeFile']) {
    assert.ok(names.includes(expected), `ACTION_DEFS 应含 ${expected}`);
  }
});

test('ACTION_DEFS：refreshRepo 仅适用于 Project 类型', () => {
  const refresh = ACTION_DEFS.find((a) => a.name === 'refreshRepo');
  assert.deepEqual(refresh.applicableTypes, ['Project']);
});

test('ACTION_DEFS：markReviewed/addNote/analyzeFile 适用于所有类型（applicableTypes="*"）', () => {
  const universal = ['markReviewed', 'addNote', 'analyzeFile'];
  for (const n of universal) {
    const a = ACTION_DEFS.find((x) => x.name === n);
    assert.equal(a.applicableTypes, '*');
  }
});

// =============================================================================
// 2. getActionsForType：按类型过滤
// =============================================================================

test('getActionsForType: Component → markReviewed/addNote/analyzeFile（不含 refreshRepo）', () => {
  const applicable = getActionsForType('Component').map((a) => a.name);
  assert.ok(applicable.includes('markReviewed'));
  assert.ok(applicable.includes('addNote'));
  assert.ok(applicable.includes('analyzeFile'));
  assert.ok(!applicable.includes('refreshRepo'));
});

test('getActionsForType: Project → 含 refreshRepo', () => {
  const applicable = getActionsForType('Project').map((a) => a.name);
  assert.ok(applicable.includes('refreshRepo'));
});

test('getActionsForType: Module → 不含 refreshRepo', () => {
  const applicable = getActionsForType('Module').map((a) => a.name);
  assert.ok(!applicable.includes('refreshRepo'));
});

test('getActionsForType: 未知类型 → 仍返回 * 类动作（markReviewed/addNote/analyzeFile）', () => {
  const applicable = getActionsForType('UnknownType').map((a) => a.name);
  assert.equal(applicable.length, 3);
  assert.ok(applicable.includes('markReviewed'));
  assert.ok(applicable.includes('addNote'));
  assert.ok(applicable.includes('analyzeFile'));
});

// =============================================================================
// 3. buildActionCards：结构化输出
// =============================================================================

test('buildActionCards: 选中 Component → 4 卡片，其中 refreshRepo 不适用', () => {
  const cards = buildActionCards({
    selectedObjId: 'comp:Button',
    selectedObjType: 'Component',
  });
  assert.equal(cards.length, 4);
  const refresh = cards.find((c) => c.name === 'refreshRepo');
  assert.equal(refresh.applicableNow, false);
  assert.match(refresh.reason, /Component/);
  const review = cards.find((c) => c.name === 'markReviewed');
  assert.equal(review.applicableNow, true);
  // objectId 自动填入选中对象
  const objectIdField = review.params.find((p) => p.name === 'objectId');
  assert.equal(objectIdField.default, 'comp:Button');
});

test('buildActionCards: 选中 Project → refreshRepo 适用', () => {
  const cards = buildActionCards({
    selectedObjId: 'proj:t',
    selectedObjType: 'Project',
  });
  const refresh = cards.find((c) => c.name === 'refreshRepo');
  assert.equal(refresh.applicableNow, true);
});

test('buildActionCards: 未选中对象 → 所有卡片标为不可用，reason 说明', () => {
  const cards = buildActionCards({ selectedObjId: null });
  for (const c of cards) {
    assert.equal(c.applicableNow, false);
    assert.match(c.reason, /未选中对象/);
  }
});

test('buildActionCards: 自定义 endpoint 注入到每张卡片', () => {
  const cards = buildActionCards({
    selectedObjId: 'comp:Button',
    selectedObjType: 'Component',
    endpoint: '/api/custom/action',
  });
  for (const c of cards) {
    assert.equal(c.endpoint, '/api/custom/action');
  }
});

test('buildActionCards: params 字段含 name/kind/label/input/default 等元数据', () => {
  const cards = buildActionCards({
    selectedObjId: 'comp:Button',
    selectedObjType: 'Component',
  });
  const review = cards.find((c) => c.name === 'markReviewed');
  const p = review.params.find((p) => p.name === 'objectId');
  assert.equal(p.kind, 'text');
  assert.equal(p.label, '对象 ID');
  assert.equal(p.input.tag, 'input');
  assert.equal(p.input.type, 'text');
});

// =============================================================================
// 4. renderActionCardHtml：HTML 渲染
// =============================================================================

test('renderActionCardHtml: 含 form/data-action/disabled 状态', () => {
  const card = buildActionCards({
    selectedObjId: 'comp:Button',
    selectedObjType: 'Component',
  })[0];
  const html = renderActionCardHtml(card);
  assert.match(html, /<form class="bp-action-card[^"]*" data-action="markReviewed"/);
  assert.match(html, /<button type="submit"/);
  // 第一个是 markReviewed（universal），应可执行
  assert.ok(!html.includes('disabled'));
});

test('renderActionCardHtml: 不适用时 disabled + reason 显示', () => {
  const card = buildActionCards({
    selectedObjId: 'comp:Button',
    selectedObjType: 'Component',
  }).find((c) => c.name === 'refreshRepo');
  const html = renderActionCardHtml(card);
  assert.match(html, /disabled/);
  assert.match(html, /bp-action-card--disabled/);
  assert.match(html, /bp-action-reason/);
  assert.match(html, /Component/);
});

test('renderActionCardHtml: objectId 默认值出现在 input value 中', () => {
  const card = buildActionCards({
    selectedObjId: 'method:Foo.bar',
    selectedObjType: 'Method',
  }).find((c) => c.name === 'markReviewed');
  const html = renderActionCardHtml(card);
  assert.match(html, /value="method:Foo\.bar"/);
});

test('renderActionCardHtml: HTML 转义防注入', () => {
  const card = {
    name: 'test',
    label: '<script>alert(1)</script>',
    description: 'desc "quoted" & <bang>',
    params: [],
    endpoint: '/x',
    applicableNow: true,
  };
  const html = renderActionCardHtml(card);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('renderActionCardHtml: enum 字段渲染为 <select>', () => {
  const card = {
    name: 'pick',
    label: 'Pick',
    description: 'Pick a value',
    params: [
      { name: 'choice', kind: 'enum', label: '选择', options: ['a', 'b', 'c'], input: PARAM_RENDER_DEFAULTS_FOR('enum') },
    ],
    endpoint: '/x',
    applicableNow: true,
  };
  const html = renderActionCardHtml(card);
  assert.match(html, /<select/);
  assert.match(html, /<option value="a">a<\/option>/);
  assert.match(html, /<option value="b">b<\/option>/);
  assert.match(html, /<option value="c">c<\/option>/);
});

test('renderActionCardHtml: boolean 字段渲染为 checkbox', () => {
  const card = {
    name: 'flag',
    label: 'Flag',
    description: '',
    params: [
      { name: 'enabled', kind: 'boolean', label: '启用', input: PARAM_RENDER_DEFAULTS_FOR('boolean') },
    ],
    endpoint: '/x',
    applicableNow: true,
  };
  const html = renderActionCardHtml(card);
  assert.match(html, /<input type="checkbox"/);
});

test('renderActionCardHtml: number 字段渲染为 type=number + min/max', () => {
  const card = {
    name: 'limit',
    label: 'Limit',
    description: '',
    params: [
      { name: 'size', kind: 'number', label: '大小', min: 1, max: 100, input: PARAM_RENDER_DEFAULTS_FOR('number') },
    ],
    endpoint: '/x',
    applicableNow: true,
  };
  const html = renderActionCardHtml(card);
  assert.match(html, /<input type="number"/);
  assert.match(html, /min="1"/);
  assert.match(html, /max="100"/);
});

test('renderActionCardHtml: objectRef 字段渲染为 select + data-reftype', () => {
  const card = {
    name: 'pick',
    label: 'Pick',
    description: '',
    params: [
      { name: 'target', kind: 'objectRef', label: '目标', refType: 'Component', input: PARAM_RENDER_DEFAULTS_FOR('objectRef') },
    ],
    endpoint: '/x',
    applicableNow: true,
  };
  const html = renderActionCardHtml(card);
  assert.match(html, /<select/);
  assert.match(html, /data-reftype="Component"/);
});

test('renderActionCardHtml: objectRefMulti 渲染为 multiple select', () => {
  const card = {
    name: 'pick',
    label: 'Pick',
    description: '',
    params: [
      { name: 'targets', kind: 'objectRefMulti', label: '多目标', refType: 'Component', input: PARAM_RENDER_DEFAULTS_FOR('objectRefMulti') },
    ],
    endpoint: '/x',
    applicableNow: true,
  };
  const html = renderActionCardHtml(card);
  assert.match(html, /multiple/);
  assert.match(html, /data-reftype="Component"/);
});

// =============================================================================
// 5. renderActionCardsHtml：批量渲染
// =============================================================================

test('renderActionCardsHtml: 多卡片拼接 + 空列表兜底', () => {
  const cards = buildActionCards({
    selectedObjId: 'comp:Button',
    selectedObjType: 'Component',
  });
  const html = renderActionCardsHtml(cards);
  // 宽松匹配：class 后面可能有空格（disabled 时有 bp-action-card--disabled）
  assert.match(html, /data-action="markReviewed"/);
  assert.match(html, /data-action="addNote"/);
  assert.match(html, /data-action="refreshRepo"/);
  assert.match(html, /data-action="analyzeFile"/);
});

test('renderActionCardsHtml: 空列表返回空状态文案', () => {
  const html = renderActionCardsHtml([]);
  assert.match(html, /bp-actions-empty/);
  assert.match(html, /无可用动作/);
});

// =============================================================================
// 辅助：与 paramDefs.js 的 PARAM_RENDER_DEFAULTS 保持一致
// =============================================================================

function PARAM_RENDER_DEFAULTS_FOR(kind) {
  const map = {
    text: { tag: 'input', type: 'text', attrs: { class: 'bp-input' } },
    number: { tag: 'input', type: 'number', attrs: { class: 'bp-input bp-num' } },
    boolean: { tag: 'input', type: 'checkbox', attrs: { class: 'bp-check' } },
    enum: { tag: 'select', attrs: { class: 'bp-select' } },
    objectRef: { tag: 'select', attrs: { class: 'bp-select bp-ref' }, multiple: false },
    objectRefMulti: { tag: 'select', attrs: { class: 'bp-select bp-ref', multiple: 'multiple' } },
  };
  return map[kind];
}
