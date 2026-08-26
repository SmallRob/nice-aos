// nice-aos overview 单测
// 验证多项目 snapshot 聚合 + 5 层架构 + 跨项目依赖矩阵 + 人类知识

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 准备临时 fixture
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-overview-'));
  // 1) 写一个模拟 snapshot.json（项目 A：React 前端）
  const projA = path.join(root, 'proj-a');
  fs.mkdirSync(projA, { recursive: true });
  fs.writeFileSync(path.join(projA, 'snapshot.json'), JSON.stringify({
    Project: [{ name: 'proj-a', framework: 'react', frameworkVariants: ['vite'], fileCount: 100, durationMs: 1000 }],
    SourceFile: [
      { ext: 'ts', lineCount: 5000, isTest: false, isEntry: true },
      { ext: 'tsx', lineCount: 3000, isTest: true, isEntry: false },
      { ext: 'css', lineCount: 500, isTest: false, isEntry: false },
    ],
    Dependency: [
      { name: 'react', version: '^19.0.0', source: 'npm', importCount: 50 },
      { name: 'zustand', version: '^5.0.0', source: 'npm', importCount: 30 },
    ],
  }));
  // 2) 写一个模拟 Java 项目（含 pom.xml + application.yml）
  const projB = path.join(root, 'proj-b');
  fs.mkdirSync(path.join(projB, 'services', 'core'), { recursive: true });
  fs.writeFileSync(path.join(projB, 'services', 'core', 'pom.xml'), `<?xml version="1.0"?>
<project>
  <artifactId>backend-core</artifactId>
  <dependencies>
    <dependency><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><artifactId>backend-other</artifactId></dependency>
  </dependencies>
</project>`);
  fs.mkdirSync(path.join(projB, 'services', 'core', 'src', 'main', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(projB, 'services', 'core', 'src', 'main', 'resources', 'application.yml'), `
server:
  port: 8880
spring:
  application:
    name: backend-core
`);
  // 写 2 个含 @RestController 的 Java 文件
  fs.mkdirSync(path.join(projB, 'services', 'core', 'src', 'main', 'java'), { recursive: true });
  fs.writeFileSync(path.join(projB, 'services', 'core', 'src', 'main', 'java', 'FooController.java'),
    '@RestController\npublic class FooController {}\n');
  fs.writeFileSync(path.join(projB, 'services', 'core', 'src', 'main', 'java', 'BarController.java'),
    '@RestController\npublic class BarController {}\n');
  // 写 1 个 @Service + 1 个 @Component
  fs.writeFileSync(path.join(projB, 'services', 'core', 'src', 'main', 'java', 'FooService.java'),
    '@Service\npublic class FooService {}\n');
  fs.writeFileSync(path.join(projB, 'services', 'core', 'src', 'main', 'java', 'FooComponent.java'),
    '@Component\npublic class FooComponent {}\n');
  // 写一个 mock snapshot.json
  fs.writeFileSync(path.join(projB, 'snapshot.json'), JSON.stringify({
    Project: [{ name: 'proj-b', framework: 'java', frameworkVariants: ['spring-boot'], fileCount: 10, durationMs: 2000 }],
    SourceFile: [{ ext: 'ts', lineCount: 100, isTest: false, isEntry: false }],
    Dependency: [],
  }));
  return root;
}

test('overview.scanOverview: 聚合多项目 + 5 层架构 + Java 解析 + 人类知识', async () => {
  const { scanOverview } = await import('../src/overview/overviewScanner.js');
  const root = makeFixture();
  const layoutFile = path.join(root, '_layout.json');
  fs.writeFileSync(layoutFile, JSON.stringify({
    projects: [
      { name: 'proj-a', displayName: '项目A', layerHint: 'client', roleHint: 'frontend', sourceRoot: path.join(root, 'proj-a') },
      { name: 'proj-b', displayName: '项目B', layerHint: 'application', roleHint: 'backend', sourceRoot: path.join(root, 'proj-b') },
    ],
  }));
  const hkFile = path.join(root, '_hk.json');
  fs.writeFileSync(hkFile, JSON.stringify({
    intent: [{ title: '测试意图', description: '描述', tags: ['t1'] }],
    resources: [{ name: 'MySQL', cpu: '500m', memory: '1Gi' }],
  }));

  const model = await scanOverview({
    projectsRoot: root,
    layoutFile,
    humanKnowledgeFile: hkFile,
    niceAosVersion: '0.31.0-test',
  });

  // 1) 基础聚合
  assert.equal(model._meta.projectCount, 2);
  assert.equal(model.projects.length, 2);
  assert.equal(model.totals.projects, 2);
  // 源行数：proj-a 8500 + proj-b 100 = 8600
  assert.equal(model.totals.grandTotalSourceLines, 8600);

  // 2) 5 层架构
  assert.equal(model.layers.client.length, 1);
  assert.equal(model.layers.client[0].name, 'proj-a');
  assert.equal(model.layers.application.length, 1);
  // Java 子服务被展开到 applicationServices
  assert.equal(model.applicationServices.length, 1);
  assert.equal(model.applicationServices[0].name, 'core');
  assert.equal(model.applicationServices[0].port, 8880);
  assert.equal(model.applicationServices[0].appName, 'backend-core');

  // 3) Java 注解统计
  const projB = model.projects.find((p) => p.name === 'proj-b');
  assert.ok(projB.javaAnnotationCounts);
  assert.equal(projB.javaAnnotationCounts.controllers, 2);
  assert.equal(projB.javaAnnotationCounts.services, 2);

  // 4) Java 文件统计（4 个 controller/service/component = 4 个 .java 文件）
  assert.equal(projB.javaFileStats.files, 4);
  assert.equal(projB.javaFileStats.lines, 8); // 4 文件，每文件 2 行

  // 5) 跨项目 npm 依赖（proj-a 顶层有 react/zustand，无 asdm-*）
  // 但本测试没设跨项目 deps，crossMatrix 应为空
  assert.equal(Object.keys(model.architecture.crossMatrix).length, 0);

  // 6) 人类知识
  assert.equal(model.humanKnowledge.intent.length, 1);
  assert.equal(model.humanKnowledge.intent[0].title, '测试意图');
  assert.equal(model.humanKnowledge.resources.length, 1);
  assert.equal(model.humanKnowledge.resources[0].name, 'MySQL');

  // 7) 汇总指标
  assert.equal(model.totals.apiControllers, 2);
  assert.equal(model.totals.businessServices, 2);
  assert.equal(model.totals.javaServices, 1);
  // grandTotalLines = grandTotalSourceLines + javaTotalLines
  // javaTotalLines = 8（4 文件 × 2 行）
  assert.equal(model.totals.grandTotalLines, 8600 + 8);

  // cleanup
  fs.rmSync(root, { recursive: true, force: true });
});

test('overview.scanOverview: 自动发现模式（无 layout 文件）', async () => {
  const { scanOverview } = await import('../src/overview/overviewScanner.js');
  const root = makeFixture();
  const model = await scanOverview({
    projectsRoot: root,
    niceAosVersion: '0.31.0-test',
  });
  assert.equal(model.projects.length, 2);
  // 自动发现时 layerHint = 'auto'
  for (const p of model.projects) {
    assert.equal(p.layerHint, 'auto');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('overview.scanOverview: 跳过无 snapshot.json 的目录', async () => {
  const { scanOverview } = await import('../src/overview/overviewScanner.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-overview-empty-'));
  const model = await scanOverview({ projectsRoot: root, niceAosVersion: '0.31.0-test' });
  assert.equal(model.projects.length, 0);
  assert.equal(model.totals.grandTotalLines, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('overview.buildOverviewViewerModel + renderOverviewHtml: 生成有效 HTML', async () => {
  const { scanOverview } = await import('../src/overview/overviewScanner.js');
  const { buildOverviewViewerModel, renderOverviewHtml } = await import('../src/overview/overviewViewer.js');
  const root = makeFixture();
  const model = await scanOverview({ projectsRoot: root, niceAosVersion: '0.31.0-test' });
  const viewModel = buildOverviewViewerModel(model);
  const html = renderOverviewHtml(viewModel);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('全景架构蓝图'));
  assert.ok(html.includes('整体架构'));
  assert.ok(html.includes('设计意图'));
  assert.ok(html.includes('资源需求'));
  assert.ok(html.includes('data-tab="intent"'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('overview.discoverSnapshots: 自动发现 snapshot.json 目录', async () => {
  const { discoverSnapshots } = await import('../src/overview/overviewSnapshot.js');
  const root = makeFixture();
  const found = discoverSnapshots(root);
  // proj-a 和 proj-b 各有一个 snapshot.json
  assert.equal(found.length, 2);
  const names = found.map((f) => f.name).sort();
  assert.deepEqual(names, ['proj-a', 'proj-b']);
  fs.rmSync(root, { recursive: true, force: true });
});
