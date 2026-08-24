// 后端服务审计器测试：复杂度占比全量重算 / 依赖多版本判定 / 健康分聚合
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditComplexity, auditDependencyHealth, auditHealth, runAllServiceAudits } from '../src/service/serviceAuditor.js';

function method(id, cc, extra = {}) {
  return {
    id: 'm' + id, name: 'm' + id, classId: 'c1',
    complexity: { cyclomaticComplexity: cc, maxNestingDepth: 1, branchCount: 0, loopCount: 0 },
    ...extra,
  };
}

test('复杂度审计：热点占比从全量方法统计，不受 TOP50 展示截断影响', () => {
  // 200 个 cc=20 的方法，模型只保留 TOP50 展示列表 —— 占比必须是 100% 而非 25%
  const methods = Array.from({ length: 200 }, (_, i) => method(i, 20));
  const model = {
    stats: { methodCount: 200 },
    methods,
    complexityHotspots: methods.slice(0, 50).map((m) => ({
      methodName: m.name, cyclomaticComplexity: 20, maxNestingDepth: 1,
      branchCount: 0, loopCount: 0, location: 'C#' + m.name, moduleKey: 'core',
    })),
  };
  const a = auditComplexity(model);
  assert.equal(a.stats.hotspotCount, 200, '应统计全量 200 个热点而非截断的 50');
  assert.equal(a.stats.hotspotRatio, 100);
  assert.equal(a.score, 0, '100% 热点应得 0 分');
  const ratioFinding = a.findings.find((f) => f.title.includes('占比'));
  assert.ok(ratioFinding && ratioFinding.title.includes('100.0%'), '占比文案应为 100.0%');
  assert.ok(ratioFinding.detail.includes('200 个热点方法'), '热点总数文案应为 200');
});

test('复杂度审计：无热点满分，cc<15 不计热点', () => {
  const methods = Array.from({ length: 10 }, (_, i) => method(i, 14));
  const a = auditComplexity({ stats: { methodCount: 10 }, methods, complexityHotspots: [] });
  assert.equal(a.stats.hotspotCount, 0);
  assert.equal(a.score, 100);
});

test('依赖审计：Maven 属性占位符与空版本不参与多版本判定', () => {
  const model = {
    dependencies: [
      { name: 'io.jsonwebtoken:jjwt-api', version: '0.12.3', scope: 'compile', source: 'maven' },
      { name: 'io.jsonwebtoken:jjwt-api', version: '${jjwt.version}', scope: 'compile', source: 'maven' },
      { name: 'io.jsonwebtoken:jjwt-api', version: '', scope: 'compile', source: 'maven' },
      { name: 'org.springdoc:springdoc-openapi-starter-webmvc-ui', version: '2.8.5', scope: 'compile', source: 'maven' },
    ],
  };
  const a = auditDependencyHealth(model);
  assert.equal(a.stats.duplicateCount, 0, '属性占位符/空版本不算多版本');
  assert.equal(a.findings.filter((f) => f.level === 'error').length, 0, '不应报多版本 error');
});

test('依赖审计：真实多版本仍报 error', () => {
  const model = {
    dependencies: [
      { name: 'com.x:a', version: '1.0', scope: 'compile', source: 'maven' },
      { name: 'com.x:a', version: '1.1', scope: 'compile', source: 'maven' },
    ],
  };
  const a = auditDependencyHealth(model);
  assert.equal(a.stats.duplicateCount, 1);
  assert.ok(a.findings.some((f) => f.level === 'error' && f.title.includes('1.0 / 1.1')));
});

test('auditHealth 复用外部传入审计结果且与自算一致', () => {
  const model = {
    stats: { methodCount: 100 },
    methods: Array.from({ length: 100 }, (_, i) => method(i, 2)),
    complexityHotspots: [],
    tables: [],
    testStats: { total: 10 },
    repositories: [],
    dependencies: [],
  };
  const audits = runAllServiceAudits(model);
  const h1 = auditHealth(model, audits);
  const h2 = auditHealth(model);
  assert.equal(h1.score, h2.score);
  assert.equal(h1.audits.complexity.score, audits.complexity.score, '内嵌审计应与传入结果一致');
  assert.deepEqual(h1.dimensions.map((d) => d.key), ['complexity', 'dataHealth', 'testCoverage', 'analysisQuality', 'dependencyHealth']);
});
