// Props 传递链（PropEdge）测试：tsAnalyzer 来源分类 → builder 组件对聚合 → blueprint passesProps → viewer propFlow
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';
import { analyzeFile } from '../src/analyzers/tsAnalyzer.js';
import { createBlueprint } from '../src/ontology/blueprint.js';
import { buildViewerModel, renderViewerHtml } from '../src/ontology/viewer.js';

function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-props-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// ---- fixture：Parent → Child，覆盖全部来源分类（forward/state/store/handler/literal/computed/spread）----
const PARENT_TSX = [
  "import { useState } from 'react';",
  "import { Child } from './Child';",
  "import { useItemsStore } from './store';",
  '',
  'export function Parent({ title, rest }) {',
  '  const [count, setCount] = useState(0);',
  '  const { items } = useItemsStore();',
  '  const handleClick = () => setCount(count + 1);',
  '  return (',
  '    <div>',
  '      <Child',
  '        title={title}',
  '        count={count}',
  '        items={items}',
  '        onClick={handleClick}',
  '        max={3}',
  '        label="hi"',
  '        sum={count + 1}',
  '        disabled',
  '        {...rest}',
  '      />',
  '    </div>',
  '  );',
  '}',
].join('\n');

const CHILD_TSX = [
  'export function Child({ title, count, items, onClick, max, label, sum, disabled }) {',
  '  return <div>{title}</div>;',
  '}',
].join('\n');

function buildPropsProject() {
  return makeProject({
    'package.json': JSON.stringify({ name: 'props-fixture', dependencies: { react: '^19.0.0' } }),
    'src/Parent.tsx': PARENT_TSX,
    'src/Child.tsx': CHILD_TSX,
    'src/store.ts': 'export function useItemsStore() { return { items: [] }; }',
  });
}

test('tsAnalyzer：props 声明提取与 JSX 属性来源分类', () => {
  const facts = analyzeFile('src/Parent.tsx', PARENT_TSX, process.cwd());
  const parent = facts.components.find((c) => c.name === 'Parent');
  assert.ok(parent, 'Parent 应被识别为组件');
  assert.deepEqual(parent.propsNames, ['title', 'rest']);
  assert.equal(parent.propsCount, 2);

  assert.equal(facts.jsxPropRenders.length, 1);
  const pass = facts.jsxPropRenders[0];
  assert.equal(pass.tag, 'Child');
  assert.equal(pass.fromComponent, 'Parent');
  const byName = new Map(pass.props.map((p) => [p.name, p]));
  assert.equal(byName.get('title').source, 'forward'); // 父组件 props 转发
  assert.equal(byName.get('count').source, 'state'); // useState 解构首元素
  assert.equal(byName.get('items').source, 'store'); // 非 builtin hook 变量
  assert.equal(byName.get('items').storeHook, 'useItemsStore');
  assert.equal(byName.get('onClick').source, 'handler'); // 组件内本地函数
  assert.equal(byName.get('max').source, 'literal'); // 数字字面量
  assert.equal(byName.get('label').source, 'literal'); // 字符串字面量
  assert.equal(byName.get('sum').source, 'computed'); // 非字面量表达式
  assert.equal(byName.get('disabled').source, 'literal'); // 裸属性 = true
  assert.equal(byName.get('disabled').valueText, 'true');
  assert.equal(byName.get('...rest').source, 'spread'); // spread 整体透传
});

test('builder：PropEdge 按组件对聚合，含出入度与 passesProps 链接', async () => {
  const dir = buildPropsProject();
  try {
    const data = await buildOntologyData(dir);
    const edges = data.PropEdge ?? [];
    assert.equal(edges.length, 1);
    const e = edges[0];
    assert.equal(e.id, 'prop:Parent→Child');
    assert.equal(e.fromComponentId, 'comp:Parent');
    assert.equal(e.toComponentId, 'comp:Child');
    assert.equal(e.fromFileId, 'file:src/Parent.tsx');
    assert.equal(e.toFileId, 'file:src/Child.tsx');
    assert.equal(e.renderCount, 1);
    const byName = new Map(e.props.map((p) => [p.name, p]));
    assert.equal(byName.size, 9);
    assert.equal(byName.get('title').source, 'forward');
    assert.equal(byName.get('items').storeHook, 'useItemsStore');

    const parent = data.Component.find((c) => c.name === 'Parent');
    const child = data.Component.find((c) => c.name === 'Child');
    assert.equal(parent.propOutCount, 1);
    assert.equal(parent.propInCount, 0);
    assert.equal(child.propInCount, 1);
    assert.equal(child.propOutCount, 0);

    const bp = createBlueprint(data);
    assert.deepEqual(bp.link('passesProps', 'comp:Parent').map((o) => o.id), ['comp:Child']);
    assert.equal(bp.link('passesProps', 'comp:Child').length, 0);
    assert.deepEqual(bp.link('passesProps', e.id).map((o) => o.id).sort(), ['comp:Child', 'comp:Parent']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('builder：多处渲染累计 renderCount，同名 prop 取更高优先级来源', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'props-agg', dependencies: { react: '^19.0.0' } }),
    'src/App.tsx': [
      "import { useState } from 'react';",
      "import { Badge } from './Badge';",
      'export function App() {',
      "  const [label, setLabel] = useState('live');",
      '  return (<div>',
      '    <Badge label="static" />',
      '    <Badge label={label} />',
      '  </div>);',
      '}',
    ].join('\n'),
    'src/Badge.tsx': 'export function Badge({ label }) { return <span>{label}</span>; }',
  });
  try {
    const data = await buildOntologyData(dir);
    const edges = data.PropEdge;
    assert.equal(edges.length, 1);
    assert.equal(edges[0].renderCount, 2); // 两处渲染聚合为一条边
    const label = edges[0].props.find((p) => p.name === 'label');
    assert.equal(label.source, 'state'); // state(5) 优先于 literal(1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('builder：同文件导出组件间传递也可成边', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'props-samefile', dependencies: { react: '^19.0.0' } }),
    'src/Both.tsx': [
      'export function Outer() { return <Inner x={1} />; }',
      'export function Inner({ x }) { return <div>{x}</div>; }',
    ].join('\n'),
  });
  try {
    const data = await buildOntologyData(dir);
    const edges = data.PropEdge;
    assert.equal(edges.length, 1);
    assert.equal(edges[0].id, 'prop:Outer→Inner');
    assert.equal(edges[0].props.find((p) => p.name === 'x').source, 'literal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay 路由：props 工厂函数提取 factoryProps', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'props-overlay', dependencies: { react: '^19.0.0' } }),
    'src/overlayGroups/main.ts': [
      "import { DetailPanel } from '../components/DetailPanel';",
      'export const routes = [',
      '  {',
      "    id: '/detail',",
      "    routePath: '/detail',",
      '    component: DetailPanel,',
      "    props: (app) => ({ item: app.item, mode: 'view' }),",
      '  },',
      '  {',
      "    id: '/plain',",
      "    routePath: '/plain',",
      '    component: DetailPanel,',
      '  },',
      '];',
    ].join('\n'),
    'src/components/DetailPanel.tsx': 'export function DetailPanel({ item, mode }) { return <div />; }',
  });
  try {
    const data = await buildOntologyData(dir);
    const detail = data.Route.find((r) => r.routePath === '/detail');
    const plain = data.Route.find((r) => r.routePath === '/plain');
    assert.ok(detail && plain, '两条 overlay 路由均应产出');
    assert.equal(detail.hasPropsFactory, true);
    assert.deepEqual(detail.factoryProps, ['item', 'mode']);
    assert.equal(plain.hasPropsFactory, false);
    assert.deepEqual(plain.factoryProps, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('propFlow 模型层与渲染：来源分布/出入度/SVG 传递图', async () => {
  const dir = buildPropsProject();
  try {
    const dataMap = await buildOntologyData(dir);
    const model = buildViewerModel(dataMap);
    const pf = model.propFlow;
    assert.ok(pf, '有 PropEdge 时 propFlow 应存在');
    assert.equal(pf.edgeCount, 1);
    assert.equal(pf.nodeCount, 2);
    assert.equal(pf.propTotal, 9); // 含 spread
    assert.equal(pf.spreadCount, 1);
    assert.deepEqual(pf.sourceDist, { forward: 1, state: 1, store: 1, handler: 1, computed: 1, literal: 3 });
    assert.equal(pf.edges[0].fromName, 'Parent');
    assert.equal(pf.edges[0].toName, 'Child');
    assert.equal(pf.topOut[0].name, 'Parent');
    assert.equal(pf.topIn[0].name, 'Child');

    const html = renderViewerHtml(model);
    assert.ok(html.includes('data-tab="props"'), '应有组件数据流 Tab');
    assert.ok(html.includes('id="view-props"'));

    // 嵌入数据无损
    const dataJson = html.match(/<script id="viewer-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
    const script = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
    const parsed = JSON.parse(dataJson);
    assert.equal(parsed.propFlow.edgeCount, 1);

    // mock DOM 执行内嵌脚本，验证渲染输出
    const elements = new Map();
    const makeEl = (id) => {
      if (!elements.has(id)) {
        elements.set(id, {
          innerHTML: '', textContent: id === 'viewer-data' ? dataJson : '',
          dataset: {}, style: {}, value: '', addEventListener() {},
          classList: { add() {}, remove() {} }, querySelectorAll: () => [],
          querySelector: () => makeEl('generic'),
        });
      }
      return elements.get(id);
    };
    const prevDocument = globalThis.document;
    globalThis.document = {
      getElementById: makeEl, querySelectorAll: () => [], querySelector: () => makeEl('generic'), addEventListener() {},
    };
    try {
      new Function(script)();
    } finally {
      globalThis.document = prevDocument;
    }

    const out = makeEl('view-props').innerHTML;
    assert.ok(out.includes('组件数据流总览'), '应有数据流总览面板');
    assert.ok(out.includes('props 来源分布'), '应有来源分布面板');
    assert.ok(out.includes('Props 传递图'), '应有传递图面板');
    assert.ok(makeEl('prop-graph').innerHTML.includes('<svg'), '传递图应渲染 SVG');
    assert.ok(out.includes('高传出组件'), '应有高传出组件面板');
    assert.ok(out.includes('高传入组件'), '应有高传入组件面板');
    assert.ok(out.includes('Props 传递边清单'), '应有传递边清单');
    assert.ok(out.includes('spread 透传'), 'spread 应单独计数展示');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('propFlow：无 PropEdge 项目为 null（Tab 由客户端隐藏）', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'no-props-fixture', dependencies: { react: '^19.0.0' } }),
    'src/util.ts': 'export const x = 1;',
  });
  try {
    const dataMap = await buildOntologyData(dir);
    const model = buildViewerModel(dataMap);
    assert.equal(model.propFlow, null);
    const html = renderViewerHtml(model);
    assert.ok(html.includes("if (!M.propFlow) hideTab('props');"), '无传递边时应隐藏 Tab');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
