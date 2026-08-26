// 后端服务蓝图查看器测试：视图模型聚合 + 8 Tab 渲染（DOM stub 执行内嵌脚本）
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServiceModel } from '../src/service/serviceBuilder.js';
import { buildServiceViewerModel, renderServiceBlueprintHtml } from '../src/service/serviceViewer.js';

// 复用 builder fixture 的极简版本（仅构造模型所需对象；包数需满足动态模块推导阈值）
function buildFixtureSnapshot() {
  const pkg = (id, name, extra = {}) => ({ id, name, fullPath: name, visibility: 'public', classCount: 0, repoId: 'repo:t', dependsOnPackageIds: [], dependencyIds: [], ...extra });
  const cls = (id, name, packageId, extra = {}) => ({
    id, name, type: 'class', visibility: 'public', modifiers: ['public'], lineCount: 5,
    packageId, extendsClassIds: [], implementsInterfaceIds: [], description: '',
    isDataModel: false, dataModelType: null, tableName: '', entityName: '', ...extra,
  });
  const mtd = (id, name, classId, extra = {}) => ({
    id, name, returnType: 'void', visibility: 'public', modifiers: [], parameters: [], lineCount: 3,
    classId, callsMethodIds: [], description: '', isTest: false, testType: null, isTestSetup: false,
    endpointInfo: null, lambdaCount: 0, complexity: { cyclomaticComplexity: 1, maxNestingDepth: 0 }, ...extra,
  });
  return {
    Repository: [{ id: 'repo:t', name: 'test-app', path: '/x', language: 'Java', commitHash: 'abc', branch: 'main', fileCount: 9, analysisErrors: [] }],
    Package: [
      pkg('p1', 'ai.asdm.admin.core.controller', { dependencyIds: ['d1'] }), pkg('p2', 'ai.asdm.admin.core.service'),
      pkg('p3', 'ai.asdm.admin.core.entity'), pkg('p4', 'ai.asdm.admin.core.config'),
      pkg('p5', 'ai.asdm.admin.adapter.ads', { dependsOnPackageIds: ['p1', 'p2'] }), pkg('p6', 'ai.asdm.portal'),
    ],
    Class: [
      cls('c1', 'UserController', 'p1', { modifiers: ['@RestController', 'public'] }),
      cls('c2', 'UserService', 'p2', { modifiers: ['@Service', 'public'] }),
      cls('c3', 'User', 'p3', { modifiers: ['@Entity', 'public'], isDataModel: true, dataModelType: 'JPA Entity', tableName: 'users' }),
      cls('c4', 'AppConfig', 'p4', { modifiers: ['@Configuration', 'public'] }),
      cls('c5', 'AdsAdapter', 'p5', { modifiers: ['@Component', 'public'] }),
      cls('c6', 'PortalApi', 'p6'),
      cls('c7', 'Status', 'p6', { type: 'enum' }),
    ],
    Interface: [{ id: 'i1', name: 'UserQueryService', visibility: 'public', modifiers: [], lineCount: 2, methodSignatures: ['find'], packageId: 'p2', extendsInterfaceIds: [], description: '' }],
    Method: [
      mtd('m1', 'getUser', 'c1', { endpointInfo: { httpMethod: 'GET', path: '/api/v1/users', framework: 'Spring' }, complexity: { cyclomaticComplexity: 16, maxNestingDepth: 5 } }),
      mtd('m2', 'createUser', 'c1', { endpointInfo: { httpMethod: 'POST', path: '/api/v1/users', framework: 'Spring' }, callsMethodIds: ['m3'] }),
      mtd('m3', 'findUser', 'c2', { complexity: { cyclomaticComplexity: 2 } }),
      mtd('m4', 'testUser', 'c2', { isTest: true, testType: 'UnitTest' }),
    ],
    Dependency: [
      { id: 'd1', name: 'org.springframework.boot:spring-boot-starter-data-jpa', version: '3.2.0', scope: 'compile', source: 'maven' },
      { id: 'd2', name: 'org.springframework.boot:spring-boot-starter-web', version: '', scope: 'compile', source: 'maven' },
      { id: 'd3', name: 'io.minio:minio', version: '8.5.0', scope: 'compile', source: 'maven' },
      { id: 'd4', name: 'io.jsonwebtoken:jjwt-api', version: '', scope: 'compile', source: 'maven' },
    ],
    Table: [
      { id: 't1', name: 'users', schema: null, comment: '用户表', engine: 'INNODB', charset: 'utf8mb4', primaryKey: 'id', columns: [{ name: 'id' }], sourceFile: 'V1.sql', matchedEntityClass: 'User', fkDetails: [] },
      { id: 't2', name: 'audit_logs', schema: null, comment: '', engine: 'INNODB', charset: 'utf8mb4', primaryKey: 'id', columns: [{ name: 'id' }], sourceFile: 'V1.sql', matchedEntityClass: '', fkDetails: [] },
    ],
    Mapper: [],
  };
}

function buildFixtureModel() {
  return buildServiceModel(buildFixtureSnapshot());
}

test('视图模型聚合：meta/stats/模块/分层/技术栈/孤儿表/审计', () => {
  const vm = buildServiceViewerModel(buildFixtureModel());
  assert.equal(vm.meta.repositoryName, 'test-app');
  assert.equal(vm.stats.classCount, 6);
  assert.equal(vm.stats.enumCount, 1);
  assert.equal(vm.meta.endpointCount, 2);
  assert.deepEqual(vm.stats.endpointByMethod, { GET: 1, POST: 1 });

  assert.ok(vm.modules.some((m) => m.key === 'core'), '模块应含 core');
  assert.ok(vm.modules.some((m) => m.key === 'portal'), '模块应含 portal');
  const layers = Object.fromEntries(vm.layers.map((l) => [l.key, l]));
  assert.equal(layers.controller.label, '接口层');
  assert.equal(layers.controller.classCount, 1);
  assert.equal(layers.entity.classCount, 1);
  assert.equal(layers.adapter.classCount, 1, 'AdsAdapter（adapter 包）应归适配层');

  const ts = Object.fromEntries(vm.techStack.map((t) => [t.key, t]));
  assert.equal(ts.jpa.label, 'JPA (Hibernate)');
  assert.ok(ts.minio, 'MinIO 应被检测');

  assert.equal(vm.orphanTables.length, 1);
  assert.equal(vm.orphanTables[0].name, 'audit_logs');
  assert.equal(vm.complexityHotspots.length, 1, 'cc=16 应入热点');
  assert.equal(vm.complexityHotspots[0].location, 'UserController#getUser');

  // 图谱：模块依赖 + 分层调用流
  assert.ok(vm.moduleGraph, '视图模型应含 moduleGraph');
  const mEdge = vm.moduleGraph.moduleView.edges.find((e) => e.source === 'module:adapter' && e.target === 'module:core');
  assert.ok(mEdge, '模块图谱应有 adapter→core 边');
  const lEdge = vm.moduleGraph.layerView.edges.find((e) => e.source === 'layer:controller' && e.target === 'layer:service');
  assert.ok(lEdge, '分层调用流应有 controller→service 边');
  assert.ok(vm.moduleGraph.moduleView.nodes.every((n) => n.color), '模块节点应带配色');
  assert.ok(vm.moduleGraph.layerView.nodes.every((n) => n.color), '分层节点应带配色');
  assert.ok(vm.moduleGraph.techView, '视图模型应含模块×技术栈图');
  assert.ok(vm.moduleGraph.techView.edges.some((e) => e.target === 'tech:jpa'), '技术图应有 core→JPA 边');

  const health = vm.audits.health;
  assert.ok(Number.isInteger(health.score) && health.score >= 0 && health.score <= 100, '健康分应在 [0,100]');
  assert.ok(Array.isArray(health.dimensions) && health.dimensions.length === 5, '应含 5 个健康维度');
});

test('HTML 渲染：8 Tab / 主题 / 内嵌数据脚本', () => {
  const vm = buildServiceViewerModel(buildFixtureModel());
  const html = renderServiceBlueprintHtml(vm);
  for (const token of [
    'data-tab="overview"', 'data-tab="modules"', 'data-tab="layers"', 'data-tab="graph"',
    'data-tab="endpoints"', 'data-tab="database"', 'data-tab="deps"', 'data-tab="quality"', 'data-tab="health"',
    'id="view-overview"', 'id="view-graph"', 'id="view-health"', 'id="service-viewer-data"', '后端服务蓝图',
  ]) {
    assert.ok(html.includes(token), `HTML 应含 ${token}`);
  }
  assert.ok(html.includes('data-theme="elegant-purple"'), '默认主题应为 elegant-purple');
});

test('DOM stub：执行内嵌脚本渲染各 Tab 内容', () => {
  const vm = buildServiceViewerModel(buildFixtureModel());
  const html = renderServiceBlueprintHtml(vm, { theme: 'fresh-green' });
  assert.ok(html.includes('data-theme="fresh-green"'), '--theme 应生效');

  const dataJson = html.match(/<script id="service-viewer-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const script = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];

  const elements = new Map();
  const makeEl = (id) => {
    if (!elements.has(id)) {
      const attrs = {};
      elements.set(id, {
        innerHTML: '', textContent: id === 'service-viewer-data' ? dataJson : '',
        attrs, dataset: {}, style: {}, value: '',
        addEventListener() {},
        classList: { add() {}, remove() {} },
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return attrs[k] ?? null; },
        querySelectorAll: () => [],
        insertAdjacentHTML() {},
        getBoundingClientRect: () => ({ width: 900, height: 300 }),
      });
    }
    return elements.get(id);
  };
  const prevDocument = globalThis.document;
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.document = {
    getElementById: makeEl,
    querySelectorAll: () => [],
    querySelector: () => makeEl('generic'),
    addEventListener() {},
    documentElement: { getAttribute: () => 'fresh-green' },
  };
  globalThis.requestAnimationFrame = (fn) => { fn(() => {}); return 0; };
  try {
    new Function(script)();
  } finally {
    globalThis.document = prevDocument;
    globalThis.requestAnimationFrame = prevRaf;
  }

  // 总览：技术栈 chips
  const tech = makeEl('tech-stack').innerHTML;
  assert.ok(tech.includes('JPA (Hibernate)'), '总览应渲染 JPA 技术栈');
  assert.ok(tech.includes('MinIO'));
  // 模块表
  const moduleTable = makeEl('module-table').innerHTML;
  assert.ok(moduleTable.includes('core') && moduleTable.includes('portal'), '模块表应渲染模块');
  // 分层
  const layerGrid = makeEl('layer-grid').innerHTML;
  assert.ok(layerGrid.includes('接口层') && layerGrid.includes('业务层'), '分层应渲染标签');
  // API 面
  const epList = makeEl('ep-list').innerHTML;
  assert.ok(epList.includes('/api/v1/users') && epList.includes('GET'), 'API 面应渲染端点');
  // 数据层：孤儿表
  const orphan = makeEl('orphan-list').innerHTML;
  assert.ok(orphan.includes('audit_logs') && orphan.includes('无实体映射且无外键'), '数据层应渲染孤儿表');
  const tableGrid = makeEl('table-grid').innerHTML;
  assert.ok(tableGrid.includes('孤儿表') && tableGrid.includes('无实体映射'), '表网格应渲染孤儿标记');
  // 代码质量：热点
  const hotspot = makeEl('hotspot-list').innerHTML;
  assert.ok(hotspot.includes('UserController#getUser'), '质量应渲染热点方法位置');
  // 健康审计：评分环 + 维度
  const healthScore = makeEl('health-score').innerHTML;
  assert.ok(healthScore.includes('score-ring-svg') && healthScore.includes('等级'), '健康审计应渲染评分环');
  const dims = makeEl('health-dimensions').innerHTML;
  assert.ok(dims.includes('代码复杂度') && dims.includes('测试覆盖率'), '健康审计应渲染维度');

  // 图谱：力导向图渲染节点与边
  const graphRoot = makeEl('graph-root').innerHTML;
  assert.ok(graphRoot.includes('模块图谱') && graphRoot.includes('分层调用流') && graphRoot.includes('模块×技术栈'), '图谱应渲染三种模式按钮');
  assert.ok(graphRoot.includes('sg-stage'), '图谱应渲染力导向图舞台');
  const graphSvg = makeEl('sg-transform').innerHTML;
  assert.ok(graphSvg.includes('<circle'), '图谱应渲染节点');
  assert.ok(graphSvg.includes('<line'), '图谱应渲染边');
  assert.ok(!graphSvg.includes('NaN'), '图谱坐标不应出现 NaN');
  const graphCount = makeEl('sg-count').textContent || '';
  assert.ok(graphCount.includes('模块图谱'), `图谱工具栏应显示视图名，实际 ${graphCount}`);
});

test('空数据容错：空模型构建视图模型与 HTML 不抛错', () => {
  const empty = { _meta: {}, stats: {} };
  const vm = buildServiceViewerModel(empty);
  assert.ok(vm.stats, '空模型视图模型应存在');
  const html = renderServiceBlueprintHtml(vm);
  assert.ok(html.includes('data-tab="overview"'));
  assert.ok(html.includes('id="service-viewer-data"'));
});
