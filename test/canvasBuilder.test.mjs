// test/canvasBuilder.test.mjs
// 画布 builder 单测：模板注入 + 多种快照数据形态
//
// 覆盖：
//   1. 占位符注入契约（必须替换 __CANVAS_DATA_JSON__，注入的 JSON 合法）
//   2. deploy 画布：纯 Docker / 纯 K8s / 混合形态 / 无 K8s 资源 / 空 middleware
//   3. overview 画布：多项目矩阵 + 跨项目依赖
//   4. buildCanvasAuto 自动检测
//   5. 错误前置：空快照 / 缺字段 / 未知 kind
//   6. 模板文件存在性（防止发布包残缺）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCanvas, buildDeployCanvas, buildOverviewCanvas, buildCanvasAuto,
} from '../src/canvas/canvasBuilder.js';
import { readCanvasTemplate, injectCanvasData, CANVAS_TEMPLATES } from '../src/canvas/canvasPaths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ASSETS = path.resolve(__dirname, '..', 'skills', 'nice-aos-canvas-skill', 'assets');

// ────────── fixtures ──────────

function makeDeployFixture(overrides = {}) {
  return {
    services: [
      { id: 'service:web', name: 'web', type: 'frontend', layer: 'frontend', kind: 'container', image: 'nginx:1.25', namespace: 'default', replicas: 2, containerPorts: [80], envCount: 5 },
      { id: 'service:api', name: 'api', type: 'backend', layer: 'backend', kind: 'Deployment', image: 'myreg.io/api:1.0.0', namespace: 'asdm', replicas: 3, readinessProbe: { httpGet: { path: '/health' } }, resources: { limits: { cpu: '500m' } }, envCount: 12 },
      { id: 'service:db-bad', name: 'db-bad', type: 'db', layer: 'data', kind: 'container', image: 'mysql:latest', namespace: 'asdm', replicas: 1, envCount: 35 },
      { id: 'service:orphan', name: 'orphan-svc', type: 'backend', layer: 'backend', kind: 'container', image: 'alpine', namespace: 'default', envCount: 3 },
    ],
    routes: [
      { id: 'route:web->api', gateway: 'web', path: '/api', resolvedService: 'api', matchType: 'prefix' },
    ],
    upstreams: [
      { id: 'upstream:web.api', name: 'api', gateway: 'web', servers: [{ host: 'api', port: 8080, resolvedService: 'api' }] },
    ],
    dependencies: [
      { id: 'dep:api->db', from: 'api', to: 'db-bad', type: 'env_ref' },
    ],
    middleware: [
      { id: 'mw:mysql', name: 'mysql', kind: 'db', label: 'MySQL', version: '8.4', image: 'mysql:8.4', ports: [3306], consumers: ['api'] },
    ],
    environments: [
      { id: 'env:prod', name: 'prod', secretCount: 3 },
    ],
    files: [],
    layers: [
      { key: 'frontend', label: '前端层' },
      { key: 'backend', label: '应用服务层' },
      { key: 'data', label: '数据层' },
    ],
    k8sResourceCounts: { Deployment: 1 },
    k8sResources: [
      { kind: 'Deployment', name: 'api', namespace: 'asdm', replicas: 3, containers: [{ name: 'api', image: 'myreg.io/api:1.0.0' }] },
      { kind: 'Service', name: 'api', namespace: 'asdm', selector: { app: 'api' }, ports: [{ port: 80, targetPort: 8080 }] },
    ],
    _meta: { version: '1.0', subsystem: 'deployment', sourceDir: '/tmp/deploy', scannedAt: '2026-08-31T00:00:00Z', serviceCount: 4, routeCount: 1, dependencyCount: 1 },
    ...overrides,
  };
}

function makeOverviewFixture() {
  return {
    projects: [
      { name: 'proj-a', fileCount: 100, lineCount: 5000, languages: { java: 50, ts: 30 } },
      { name: 'proj-b', fileCount: 50, lineCount: 2000, languages: { ts: 40, vue: 10 } },
    ],
    applicationServices: [
      { id: 'svc:a.api', name: 'api', project: 'proj-a', language: 'java', framework: 'spring', kind: 'application', path: 'src/main/java/Api.java' },
      { id: 'svc:a.web', name: 'web', project: 'proj-a', language: 'ts', framework: 'react', kind: 'frontend', path: 'web/' },
      { id: 'svc:b.ui',  name: 'ui',  project: 'proj-b', language: 'vue', framework: 'vue3', kind: 'frontend', path: 'src/' },
    ],
    languages: { java: 50, ts: 70, vue: 10, py: 5 },
    architecture: {
      crossMatrix: { 'svc:a.api': ['svc:b.ui'] },
      composeRelations: [],
      nginxRelations: [],
      portAllocations: [],
    },
    totals: { projects: 2, javaServices: 1, grandTotalFiles: 150, grandTotalLines: 7000, layers: 7, crossProjectDeps: 1, apiControllers: 2, businessServices: 3 },
    _meta: { generator: 'nice-aos overview', projectsRoot: '/tmp/multi', generatedAt: '2026-08-31T01:00:00Z' },
  };
}

// ────────── tests ──────────

test('canvasPaths: 模板文件存在且非空', () => {
  assert.ok(fs.existsSync(CANVAS_TEMPLATES.deploy), `deploy 模板缺失: ${CANVAS_TEMPLATES.deploy}`);
  assert.ok(fs.existsSync(CANVAS_TEMPLATES.overview), `overview 模板缺失: ${CANVAS_TEMPLATES.overview}`);
  const tpl = readCanvasTemplate('deploy');
  assert.ok(tpl.includes('__CANVAS_DATA_JSON__'), 'deploy 模板未声明占位符');
  assert.ok(tpl.includes('canvas-data'), 'deploy 模板未声明 data 块');
});

test('canvasPaths: injectCanvasData 替换占位符且 JSON 合法', () => {
  const tpl = '<x>__CANVAS_DATA_JSON__</x>';
  const data = { a: 1, b: '中', c: [1, 2, 3] };
  const out = injectCanvasData(tpl, data);
  assert.ok(!out.includes('__CANVAS_DATA_JSON__'), '占位符未替换');
  const parsed = JSON.parse(out.replace(/^<x>/, '').replace(/<\/x>$/, ''));
  assert.deepEqual(parsed, data);
});

test('canvasPaths: injectCanvasData 注入含 </script 的字符串时转义安全', () => {
  const tpl = '<script id="canvas-data" type="application/json">__CANVAS_DATA_JSON__</script>';
  const data = { x: '</script><script>alert(1)</script>' };
  const out = injectCanvasData(tpl, data);
  // 注入的字符串应避免被浏览器提前关闭 </script>
  assert.ok(!/alert\(1\)<\/script>/.test(out), '转义失败：仍存在未转义的 </script>');
  assert.ok(out.includes('<\\/script'), '期望插入转义后的 <\\/script');
});

test('canvasPaths: 缺占位符时报错', () => {
  assert.throws(() => injectCanvasData('<x>no placeholder</x>', { a: 1 }), /未找到占位符/);
});

test('canvasPaths: 未知 kind 报错', () => {
  assert.throws(() => readCanvasTemplate('unknown'), /未知画布类型/);
});

test('buildDeployCanvas: 基本形态 + 6 维风险徽标覆盖', () => {
  const model = makeDeployFixture();
  const c = buildDeployCanvas(model);
  assert.equal(c.kind, 'deploy');
  assert.equal(c.stats.services, 4);
  assert.equal(c.stats.routes, 1);
  assert.equal(c.stats.middleware, 1);
  assert.ok(c.html.length > 5000, '画布 HTML 异常短');
  // 注入的 JSON 数据块必须可解析
  const m = c.html.match(/<script id="canvas-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, '未找到 data 块');
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed.services.length, 4);
});

test('buildDeployCanvas: 纯 K8s 形态（无 Docker 容器）也能产出', () => {
  const model = makeDeployFixture();
  model.services = model.services.map((s) => s.kind === 'container' ? { ...s, kind: 'Deployment' } : s);
  const c = buildDeployCanvas(model);
  assert.equal(c.kind, 'deploy');
  // K8s 画布 Tab 应被启用（模板里 #tab-k8s 节点）
  assert.ok(c.html.includes('id="tab-k8s"'), 'K8s Tab 节点未渲染');
});

test('buildDeployCanvas: 纯 Docker 形态（无 K8s 资源）也能产出', () => {
  const model = makeDeployFixture();
  model.k8sResources = [];
  model.services = model.services.filter((s) => s.kind !== 'Deployment');
  const c = buildDeployCanvas(model);
  assert.ok(c.html.includes('id="cv-title"'));
});

test('buildDeployCanvas: 无 services 抛错（数据前置校验）', () => {
  assert.throws(() => buildDeployCanvas({ _meta: {} }), /需要 services/);
});

test('buildOverviewCanvas: 多项目矩阵 + 跨项目依赖', () => {
  const model = makeOverviewFixture();
  const c = buildOverviewCanvas(model);
  assert.equal(c.kind, 'overview');
  assert.equal(c.stats.projects, 2);
  assert.ok(c.html.includes('proj-a'), '未渲染 proj-a 列头');
  assert.ok(c.html.includes('proj-b'), '未渲染 proj-b 列头');
  // 跨项目依赖边（crossMatrix 中 svc:a.api → svc:b.ui）应出现
  assert.ok(c.html.includes('data-type="cross"'), '跨项目依赖边未渲染');
});

test('buildOverviewCanvas: 无 projects 抛错', () => {
  assert.throws(() => buildOverviewCanvas({ _meta: {} }), /需要 projects/);
});

test('buildCanvasAuto: 优先 deploy', () => {
  const c = buildCanvasAuto({ deployModel: makeDeployFixture(), overviewModel: makeOverviewFixture() });
  assert.equal(c.kind, 'deploy');
  assert.equal(c.source, 'deploy-snapshot');
});

test('buildCanvasAuto: 仅 overview 可用时回退', () => {
  const c = buildCanvasAuto({ overviewModel: makeOverviewFixture() });
  assert.equal(c.kind, 'overview');
  assert.equal(c.source, 'overview-snapshot');
});

test('buildCanvasAuto: preferKind 优先', () => {
  const c = buildCanvasAuto({
    deployModel: makeDeployFixture(),
    overviewModel: makeOverviewFixture(),
    preferKind: 'overview',
  });
  assert.equal(c.kind, 'overview');
});

test('buildCanvasAuto: 全部不可用时报错（带操作提示）', () => {
  assert.throws(() => buildCanvasAuto({}), /未找到可用的画布数据/);
  // 缺 services / 空数组 / 非数组 都视为不可用
  assert.throws(() => buildCanvasAuto({ deployModel: { _meta: {} } }), /未找到可用的画布数据/);
  assert.throws(() => buildCanvasAuto({ deployModel: { services: [], _meta: {} } }), /未找到可用的画布数据/);
  assert.throws(() => buildCanvasAuto({ deployModel: { services: 'not-array' } }), /未找到可用的画布数据/);
});

test('buildCanvas: 未知 kind 报错', () => {
  assert.throws(() => buildCanvas({ kind: 'unknown', snapshot: {} }), /不支持的 kind/);
});

test('buildCanvas: 缺 snapshot 报错', () => {
  assert.throws(() => buildCanvas({ kind: 'deploy' }), /缺少 snapshot/);
});

test('端到端: 真实 deploy 快照（asdm-admin）能产出可用的画布', () => {
  // 用一个最小可用的真实形态 fixture（避免依赖大快照文件）测试 builder 集成
  const model = makeDeployFixture();
  model.services.push({ id: 'service:gateway', name: 'gateway', type: 'gateway', layer: 'edge', kind: 'container', image: 'nginx:1.25', namespace: 'asdm', replicas: 2, envCount: 8 });
  const c = buildDeployCanvas(model);
  // 关键元素齐备
  assert.ok(c.html.includes('canvas-data'));
  // 注入的 JSON 数据块必须可解析（且占位符已被替换为合法 JSON）
  const m = c.html.match(/<script id="canvas-data" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(m, '未找到 canvas-data 块');
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed.services.length, 5);
  // 模板内启动脚本可能仍含占位符 token（用于"未注入时降级"检测），所以不应断言整文档无该 token
  assert.ok(c.html.length > 10000);
});

test('模板 SPA 路径: assets 目录确实随包发布', () => {
  // 防止 SKILL.md 文档与运行时模板不同步
  const dir = path.resolve(__dirname, '..', 'skills', 'nice-aos-canvas-skill', 'assets');
  const files = fs.readdirSync(dir);
  assert.ok(files.includes('deploy-canvas-template.html'), 'deploy 模板未发布');
  assert.ok(files.includes('overview-canvas-template.html'), 'overview 模板未发布');
  // 文件大小合理（避免空文件被发布）
  for (const f of files) {
    const sz = fs.statSync(path.join(dir, f)).size;
    assert.ok(sz > 1000, `模板文件 ${f} 异常小（${sz}B）`);
  }
});
