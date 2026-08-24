// 后端服务健康审计器：五维健康度
//   1. auditComplexity      代码复杂度：高圈复杂度方法占比
//   2. auditDataHealth      数据层健康：孤儿表占比 / 实体映射覆盖
//   3. auditTestCoverage    测试覆盖率：测试方法占比
//   4. auditAnalysisQuality 分析质量：本体分析错误数
//   5. auditDependencyHealth 依赖健康：重复依赖 / 无版本依赖
// 每个审计返回 { key, label, score, level, findings: [{level, title, detail, location}], stats }

import { COMPLEXITY_HOTSPOT_CC } from './serviceModel.js';

export const DIMENSION_WEIGHTS = {
  complexity: 0.3,
  dataHealth: 0.2,
  testCoverage: 0.2,
  analysisQuality: 0.1,
  dependencyHealth: 0.2,
};

function makeAudit(key, label, score, findings, stats) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const level = clamped >= 90 ? 'good' : clamped >= 70 ? 'fair' : clamped >= 50 ? 'warn' : 'poor';
  return { key, label, score: clamped, level, findings, stats: stats || {} };
}

// ---------- 1. 代码复杂度 ----------

export function auditComplexity(model) {
  const findings = [];
  const totalMethods = model.stats?.methodCount || 0;
  const methods = model.methods || [];
  // 占比统计必须从全量方法重算：model.complexityHotspots 是 TOP50 展示截断列表，
  // 直接用它算占比会把大仓库的热点数压到 50，导致得分虚高
  const hotspotCount = methods.filter((m) => (m.complexity?.cyclomaticComplexity || 0) >= COMPLEXITY_HOTSPOT_CC).length;
  const hotspotRatio = totalMethods > 0 ? hotspotCount / totalMethods : 0;
  const hotspots = model.complexityHotspots || [];
  const totalCyclomatic = methods.reduce((s, m) => s + (m.complexity?.cyclomaticComplexity || 0), 0);
  const avgCyclomatic = totalMethods > 0 ? Math.round((totalCyclomatic / totalMethods) * 10) / 10 : 0;

  for (const h of hotspots.slice(0, 20)) {
    findings.push({
      level: 'warn',
      title: `高复杂度方法 ${h.methodName}（圈复杂度 ${h.cyclomaticComplexity}）`,
      detail: `嵌套深度 ${h.maxNestingDepth}，分支 ${h.branchCount}，循环 ${h.loopCount}。建议拆分重构`,
      location: h.location,
    });
  }
  if (hotspotRatio > 0.02) {
    findings.push({
      level: 'warn',
      title: `高复杂度方法占比 ${(hotspotRatio * 100).toFixed(1)}%（cc≥15）`,
      detail: `共 ${hotspotCount} 个热点方法 / ${totalMethods} 个方法，建议优先重构圈复杂度 >50 的方法`,
    });
  }
  const deepMethods = methods.filter((m) => (m.complexity?.maxNestingDepth || 0) >= 8);
  for (const m of deepMethods.slice(0, 10)) {
    findings.push({
      level: 'info',
      title: `深层嵌套方法 ${m.name}（深度 ${m.complexity.maxNestingDepth}）`,
      detail: '过深嵌套影响可读性，建议提取子方法',
      location: `${model.classes?.find((c) => c.id === m.classId)?.name || ''}#${m.name}`,
    });
  }

  const score = hotspotRatio === 0 ? 100 : Math.max(0, 100 - hotspotRatio * 400);
  return makeAudit('complexity', '代码复杂度', score, findings, { totalMethods, hotspotCount, hotspotRatio: Math.round(hotspotRatio * 10000) / 100, avgCyclomatic });
}

// ---------- 2. 数据层健康 ----------

export function auditDataHealth(model) {
  const findings = [];
  const tables = model.tables || [];
  const orphans = tables.filter((t) => t.isOrphan);
  const orphanCount = orphans.length;
  const orphanRatio = tables.length > 0 ? orphanCount / tables.length : 0;
  const mappedEntityCount = tables.filter((t) => t.matchedEntityClass).length;

  for (const t of orphans.slice(0, 20)) {
    findings.push({
      level: 'warn',
      title: `孤儿表 ${t.name}（无实体映射且无外键）`,
      detail: `列数 ${t.columnCount}${t.comment ? `，注释「${t.comment}」` : ''}。建议确认是否为纯查询/备份/调度框架表`,
      location: `table:${t.name}`,
    });
  }
  for (const t of tables.filter((tb) => !tb.isOrphan && !tb.matchedEntityClass).slice(0, 10)) {
    findings.push({
      level: 'info',
      title: `表 ${t.name} 无实体映射`,
      detail: '可能由 MyBatis Mapper / 原生 SQL 访问，或为纯查询表',
      location: `table:${t.name}`,
    });
  }

  const score = tables.length === 0 ? 100 : Math.max(0, 100 - orphanRatio * 300);
  return makeAudit('dataHealth', '数据层健康', score, findings, { totalTables: tables.length, orphanCount, orphanRatio: Math.round(orphanRatio * 10000) / 100, mappedEntityCount });
}

// ---------- 3. 测试覆盖率 ----------

export function auditTestCoverage(model) {
  const findings = [];
  const testStats = model.testStats || {};
  const totalMethods = model.stats?.methodCount || 0;
  const testMethodCount = testStats.total || 0;
  const testRatio = totalMethods > 0 ? testMethodCount / totalMethods : 0;

  if (totalMethods > 0 && testRatio < 0.05) {
    findings.push({
      level: 'warn',
      title: `测试覆盖率偏低（${(testRatio * 100).toFixed(1)}%）`,
      detail: `测试方法 ${testMethodCount} / 全部方法 ${totalMethods}。建议为核心 Service 与适配层补充单元/集成测试`,
    });
  }
  if (testRatio === 0 && totalMethods > 0) {
    findings.push({
      level: 'error',
      title: '未检测到任何测试方法',
      detail: '项目缺少 @Test 标注的测试方法，测试体系缺失',
    });
  }
  // 无测试的业务类 TOP（controller/service/repository 层）
  const layerByClass = new Map((model.classes || []).map((c) => [c.id, c.layerKey]));
  const testedClassNames = new Set((model.methods || [])
    .filter((m) => m.isTest || m.isTestSetup)
    .map((m) => model.classes?.find((c) => c.id === m.classId)?.name)
    .filter(Boolean));
  const bizClasses = (model.classes || [])
    .filter((c) => ['controller', 'service', 'repository'].includes(c.layerKey) && !testedClassNames.has(c.name))
    .sort((a, b) => b.methodCount - a.methodCount)
    .slice(0, 10);
  if (bizClasses.length > 0) {
    findings.push({
      level: 'info',
      title: `${bizClasses.length} 个业务类无直接测试`,
      detail: bizClasses.map((c) => `${c.name}(${c.methodCount} 方法)`).join('、'),
    });
  }

  const score = totalMethods === 0 ? 0 : Math.min(100, testRatio * 1000);
  return makeAudit('testCoverage', '测试覆盖率', score, findings, { totalMethods, testMethodCount, testRatio: Math.round(testRatio * 10000) / 100, testClassCount: testStats.testClassCount || 0 });
}

// ---------- 4. 分析质量 ----------

export function auditAnalysisQuality(model) {
  const findings = [];
  const repos = model.repositories || [];
  const analysisErrorCount = model.stats?.analysisErrorCount || 0;

  for (const r of repos) {
    if ((r.analysisErrorCount || 0) > 0) {
      findings.push({
        level: 'error',
        title: `仓库 ${r.name} 存在 ${r.analysisErrorCount} 个分析错误`,
        detail: '本体快照构建期解析错误，相关代码可能未被完整纳入分析',
        location: r.path,
      });
    }
  }
  if (model._meta?.warn) {
    findings.push({ level: 'info', title: model._meta.warn, detail: '非 Java 仓库仍按本体结构分析' });
  }

  const score = Math.max(0, 100 - analysisErrorCount * 25);
  return makeAudit('analysisQuality', '分析质量', score, findings, { analysisErrorCount, repositoryCount: repos.length });
}

// ---------- 5. 依赖健康 ----------

export function auditDependencyHealth(model) {
  const findings = [];
  const deps = model.dependencies || [];
  const byName = new Map();
  for (const d of deps) {
    if (!byName.has(d.name)) byName.set(d.name, []);
    byName.get(d.name).push(d);
  }
  // 多版本判定只比较具体版本号：Maven 属性占位符（${xxx.version}，实际由 dependencyManagement 管理）
  // 与空版本（继承版本）不是独立版本，混入会误报"多版本漂移"
  const concreteVersions = (list) => [...new Set(list
    .map((d) => String(d.version || '').trim())
    .filter((v) => v && !/^\$\{.*\}$/.test(v)))];
  const duplicates = [...byName.values()].filter((list) => list.length > 1 && concreteVersions(list).length > 1);
  const versionless = deps.filter((d) => !d.version);
  const systemScope = deps.filter((d) => d.scope === 'system');

  for (const list of duplicates.slice(0, 5)) {
    findings.push({
      level: 'error',
      title: `依赖 ${list[0].name} 存在多版本（${list.map((d) => d.version || '?').join(' / ')}）`,
      detail: '多模块重复声明导致版本漂移，建议用 BOM / dependencyManagement 统一',
    });
  }
  for (const d of versionless.slice(0, 10)) {
    findings.push({
      level: 'warn',
      title: `依赖 ${d.name} 未指定版本`,
      detail: `scope=${d.scope || '?'}，source=${d.source || '?'}。建议固定版本以保障构建可复现`,
    });
  }
  for (const d of systemScope.slice(0, 5)) {
    findings.push({
      level: 'info',
      title: `依赖 ${d.name} 为 system scope`,
      detail: 'system scope 依赖不走仓库解析，需人工维护 classpath',
    });
  }

  const score = Math.max(0, 100 - Math.min(duplicates.length * 10, 30) - Math.min(versionless.length, 10));
  return makeAudit('dependencyHealth', '依赖健康', score, findings, { totalDeps: deps.length, duplicateCount: duplicates.length, versionlessCount: versionless.length });
}

// ---------- 综合健康 ----------

export function auditHealth(model, audits = runAllServiceAudits(model)) {
  const dims = Object.entries(DIMENSION_WEIGHTS).map(([key, weight]) => {
    const a = audits[key];
    return { key, label: a.label, score: a.score, level: a.level, weight };
  });
  const score = Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0));
  const level = score >= 90 ? 'good' : score >= 70 ? 'fair' : score >= 50 ? 'warn' : 'poor';
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'E';

  const allFindings = Object.values(audits).flatMap((a) => a.findings);
  const rank = { error: 0, warn: 1, info: 2 };
  const topFindings = allFindings
    .slice()
    .sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3))
    .slice(0, 12);
  const errorCount = allFindings.filter((f) => f.level === 'error').length;
  const warnCount = allFindings.filter((f) => f.level === 'warn').length;
  const infoCount = allFindings.filter((f) => f.level === 'info').length;

  return {
    key: 'health',
    label: '综合健康评分',
    score,
    level,
    grade,
    dimensions: dims,
    errorCount,
    warnCount,
    infoCount,
    topFindings,
    audits,
  };
}

export function runAllServiceAudits(model) {
  return {
    complexity: auditComplexity(model),
    dataHealth: auditDataHealth(model),
    testCoverage: auditTestCoverage(model),
    analysisQuality: auditAnalysisQuality(model),
    dependencyHealth: auditDependencyHealth(model),
  };
}
