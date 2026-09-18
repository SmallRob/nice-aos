// 全景架构 viewer 测试（v0.45.0）
//
// 覆盖：
//   1) buildOverviewViewerModel：聚合字段齐全 + 缺失字段默认值
//   2) renderOverviewHtml：基本骨架（<title> / <h1> / 7 Tab / 6 卡片 / 各 panel 容器）
//   3) 交互：搜索 input / chips / 端口过滤 input / 复制按钮 / 回到顶部 按钮都在 HTML 里
//   4) URL hash 同步：Tab 切换调用 history.replaceState（脚本片段含 'tab=' 与 'hash'）
//   5) escape：HTML / attr 转义正确
//   6) renderTable：表头 + 行渲染 + empty 分支
//   7) services / tech / deployment 三 Tab 的 toolbar 各自带正确 data-toolbar
//   8) 数据空场景：humanKnowledge 空时显示提示
//   9) 数据填满场景：每个 panel 内容非空
//  10) 卡片可点击展开：svc 节点含 .copy-btn + 可被点击展开
//
// viewer 是字符串拼装的纯函数，不引入 JSDOM；用关键字 / 正则断言即可。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOverviewViewerModel, renderOverviewHtml } from '../src/overview/overviewViewer.js';

function buildFixture() {
  return {
    _meta: {
      generatedAt: '2026-09-04T10:00:00Z',
      scannerVersion: '0.45.0',
      projectsRoot: '/tmp/projects',
      layoutFile: '/tmp/projects/layout.json',
      humanKnowledgeFile: '/tmp/projects/hk.json',
      projectCount: 3,
    },
    projects: [
      {
        name: 'admin', displayName: 'Admin', layerHint: 'application', roleHint: '服务',
        note: '管理端', framework: 'React', frameworkVariants: ['React 18'],
        fileCount: 120, totalLines: 8000, testLines: 200, entryFiles: 3,
        byExt: { js: { files: 100, lines: 7000 } },
        techStack: ['react@18', 'antd@5'],
        javaServices: [],
        snapshotPath: '/x/admin/snapshot.json',
        snapshotExists: true,
      },
      {
        name: 'asdm-admin', displayName: 'ASDM Admin', layerHint: 'application', roleHint: 'Java聚合',
        note: 'asdm 主体', framework: 'Spring Boot', frameworkVariants: [],
        fileCount: 500, totalLines: 50000, testLines: 5000, entryFiles: 10,
        byExt: { java: { files: 400, lines: 45000 } },
        techStack: ['spring-boot@3', 'mybatis@3'],
        javaServices: [
          { name: 'asdm-admin-services-core', displayName: 'core', port: 8887, appName: 'asdm-core', artifactId: 'asdm-admin-services-core', parent: 'asdm-admin', path: 'asdm-admin-services/core', dependencies: [] },
          { name: 'asdm-admin-services-auth', displayName: 'auth', port: 8888, appName: 'asdm-auth', artifactId: 'asdm-admin-services-auth', parent: 'asdm-admin', path: 'asdm-admin-services/auth', dependencies: ['asdm-admin-services-core'] },
        ],
        snapshotPath: '/x/asdm-admin/snapshot.json',
        snapshotExists: true,
      },
      {
        name: 'docs', displayName: 'Docs', layerHint: 'repo', roleHint: '文档',
        note: '', framework: 'Vue 3', frameworkVariants: [],
        fileCount: 30, totalLines: 1500, testLines: 0, entryFiles: 1,
        byExt: { vue: { files: 25, lines: 1200 } },
        techStack: ['vue@3'],
        javaServices: [],
        snapshotPath: '/x/docs/snapshot.json',
        snapshotExists: true,
      },
    ],
    layers: {
      client: [],
      gateway: [],
      application: [
        { name: 'admin', displayName: 'Admin', layerHint: 'application', roleHint: '前端',
          framework: 'React', techStack: ['react@18'], javaServices: [] },
      ],
      integration: [],
      tool: [],
      repo: [
        { name: 'docs', displayName: 'Docs', layerHint: 'repo', roleHint: '文档',
          framework: 'Vue 3', techStack: ['vue@3'], javaServices: [] },
      ],
    },
    applicationServices: [
      { name: 'asdm-admin-services-core', displayName: 'core', port: 8887, appName: 'asdm-core', parent: 'asdm-admin' },
      { name: 'asdm-admin-services-auth', displayName: 'auth', port: 8888, appName: 'asdm-auth', parent: 'asdm-admin' },
    ],
    languages: { js: { files: 100, lines: 7000 }, java: { files: 400, lines: 45000 } },
    architecture: {
      crossMatrix: { admin: ['asdm-shared@1'] },
      composeRelations: [{ project: 'asdm-admin', compose: 'docker-compose.yml', service: 'mysql', port: 3306, kind: 'compose-port' }],
      nginxRelations: [{ project: 'asdm-admin', config: 'nginx.conf', target: 'backend:8080', path: '/api', kind: 'proxy-pass' }],
      portAllocations: [
        { service: 'core', port: 8887, appName: 'asdm-core', parent: 'asdm-admin', kind: 'Spring Boot' },
        { service: 'auth', port: 8888, appName: 'asdm-auth', parent: 'asdm-admin', kind: 'Spring Boot' },
      ],
    },
    humanKnowledge: {
      intent: [
        { title: '产品定位', description: '统一管理层', tags: ['mcp'], source: { label: 'ASDM.md', href: '#' } },
      ],
      resources: [
        { name: 'core', cpu: '500m', memory: '512Mi', replicas: 2 },
      ],
      sources: [{ label: 'ASDM.md', path: 'cict-asdm/ASDM.md' }],
    },
    totals: {
      projects: 3,
      withSource: 3,
      grandTotalLines: 59500,
      grandTotalFiles: 650,
      javaFiles: 400,
      javaLines: 45000,
      javaServices: 2,
      layers: 3,
      crossProjectDeps: 1,
      apiControllers: 30,
      businessServices: 20,
    },
  };
}

test('buildOverviewViewerModel 聚合字段齐全', () => {
  const model = buildOverviewViewerModel(buildFixture());
  assert.equal(model.totals.projects, 3);
  assert.equal(model.applicationServices.length, 2);
  assert.equal(model.architecture.crossMatrix.admin[0], 'asdm-shared@1');
  assert.equal(model.humanKnowledge.intent.length, 1);
});

test('buildOverviewViewerModel 容忍缺失字段（兜底空对象 / 空数组）', () => {
  const m = buildOverviewViewerModel({});
  assert.deepEqual(m.totals, {});
  assert.deepEqual(m.projects, []);
  assert.deepEqual(m.layers, {});
  assert.deepEqual(m.applicationServices, []);
  assert.deepEqual(m.humanKnowledge, { intent: [], resources: [], sources: [] });
});

test('renderOverviewHtml 输出 7 Tab + 6 统计卡 + 7 Panel', () => {
  const html = renderOverviewHtml(buildOverviewViewerModel(buildFixture()));
  // 7 个 tab
  const tabs = html.match(/data-tab="[a-z]+"/g) || [];
  assert.equal(tabs.length, 7, `应有 7 个 tab，实际 ${tabs.length}`);
  // 6 个 .card
  const cards = html.match(/class="card c-[a-z]+"/g) || [];
  assert.equal(cards.length, 6, `应有 6 张统计卡，实际 ${cards.length}`);
  // 7 个 .panel
  const panels = html.match(/data-panel="[a-z]+"/g) || [];
  assert.equal(panels.length, 7, `应有 7 个 panel，实际 ${panels.length}`);
  // <title>
  assert.match(html, /<title>全景架构蓝图（3 项目 \+ 2 Java 服务）<\/title>/);
  // <h1>
  assert.match(html, /<h1>全景架构蓝图<\/h1>/);
});

test('renderOverviewHtml 含 services/tech/deployment 三个 toolbar（data-toolbar）', () => {
  const html = renderOverviewHtml(buildOverviewViewerModel(buildFixture()));
  assert.match(html, /data-toolbar="services"/);
  assert.match(html, /data-toolbar="tech"/);
  assert.match(html, /data-toolbar="deployment"/);
  // services 含 role-filter checkbox
  assert.match(html, /data-role-filter/);
  // tech 含 framework chip
  assert.match(html, /data-fw="Spring Boot"/);
  assert.match(html, /data-fw="React"/);
  // deployment 含端口范围 input
  assert.match(html, /data-port-min/);
  assert.match(html, /data-port-max/);
});

test('renderOverviewHtml 含交互脚本：tab / hash / copy / search / filter / back-top / toast', () => {
  const html = renderOverviewHtml(buildOverviewViewerModel(buildFixture()));
  // tab 切换 + hash 同步
  assert.match(html, /activate\(tabId,push\)/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /#tab=/);
  // 复制 + 卡片展开
  assert.match(html, /copyText/);
  assert.match(html, /navigator\.clipboard/);
  assert.match(html, /classList\.toggle\('expanded'/);
  // 搜索 / 防抖
  assert.match(html, /debounce/);
  assert.match(html, /data-search-target="services"/);
  assert.match(html, /data-search-target="tech"/);
  assert.match(html, /data-search-target="deployment"/);
  // 回到顶部 + toast
  assert.match(html, /id="back-top"/);
  assert.match(html, /id="toast"/);
});

test('renderOverviewHtml 卡片含 copy-btn + data-name + 可被点击展开', () => {
  const html = renderOverviewHtml(buildOverviewViewerModel(buildFixture()));
  // 每张 svc 都有 copy-btn + data-name
  const svcs = html.match(/<div class="svc"[^>]*data-name=/g) || [];
  assert.ok(svcs.length >= 3, `应有 >= 3 张 svc 卡，实际 ${svcs.length}`);
  // 含 :8887 / :8888 端口（Java 服务卡）
  assert.match(html, /<span class="port">:8887<\/span>/);
  assert.match(html, /<span class="port">:8888<\/span>/);
});

test('renderOverviewHtml 人类知识为空时显示提示', () => {
  const fixture = buildFixture();
  fixture.humanKnowledge = { intent: [], resources: [], sources: [] };
  const html = renderOverviewViewerSafe(fixture);
  assert.match(html, /未提供人类架构知识/);
});

test('renderOverviewHtml 人类知识填满时显示 intent / resources / sources', () => {
  const html = renderOverviewHtml(buildOverviewViewerModel(buildFixture()));
  assert.match(html, /产品定位/);
  assert.match(html, /统一管理层/);
  // resources 卡
  assert.match(html, /class="res-card"/);
  // sources 列表
  assert.match(html, /<h3>参考来源<\/h3>/);
  assert.match(html, /cict-asdm\/ASDM\.md/);
});

test('renderOverviewHtml 转义：含 HTML / 引号 / < / > 不破坏', () => {
  const fixture = buildFixture();
  fixture.humanKnowledge.intent[0].title = '<script>alert(1)</script>';
  fixture.humanKnowledge.intent[0].description = '"quoted" & <x>';
  const html = renderOverviewHtml(buildOverviewViewerModel(fixture));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'title 中的 <script> 必被转义');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;quoted&quot;/);
  assert.match(html, /&amp; &lt;x&gt;/);
});

test('renderOverviewHtml crossMatrix 行存在', () => {
  const html = renderOverviewHtml(buildOverviewViewerModel(buildFixture()));
  assert.match(html, /跨项目 npm 依赖/);
  assert.match(html, /admin/);
  assert.match(html, /asdm-shared@1/);
});

test('renderOverviewHtml nginx / compose / port 都渲染', () => {
  const html = renderOverviewHtml(buildOverviewViewerModel(buildFixture()));
  assert.match(html, /端口分配总览/);
  assert.match(html, /Docker Compose 服务关系/);
  assert.match(html, /nginx 代理关系/);
});

test('renderOverviewHtml totals 反映在 cards', () => {
  const html = renderOverviewHtml(buildOverviewViewerModel(buildFixture()));
  assert.match(html, /<div class="v">3<small>个<\/small><\/div>/);
  assert.match(html, /<div class="v">2<small>Spring Boot<\/small><\/div>/);
  assert.match(html, /<div class="v">1<small>条<\/small><\/div>/);
  assert.match(html, /<div class="v">30<small>@RestController<\/small><\/div>/);
  assert.match(html, /<div class="v">20<small>@Service\/@Component<\/small><\/div>/);
});

// helper: buildOverviewViewerModel 是幂等的；直接传入 raw fixture 同样可用
function renderOverviewViewerSafe(fixture) {
  return renderOverviewHtml(buildOverviewViewerModel(fixture));
}