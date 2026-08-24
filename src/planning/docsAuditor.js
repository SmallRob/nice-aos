// 产品规划健康审计：覆盖完整性 / 状态健康 / 依赖风险 / 版本规划 四维评分 + 问题清单。

function levelOf(score) {
  if (score >= 80) return 'good';
  if (score >= 60) return 'warn';
  return 'bad';
}

function countStatus(dist, keys) {
  return keys.reduce((sum, k) => sum + (dist.status[k] || 0), 0);
}

function auditCoverage(features) {
  const issues = [];
  const noDetail = features.filter((f) => !f.description && (!f.sources || f.sources.length === 0));
  for (const f of noDetail.slice(0, 20)) {
    issues.push({ feature: f.id, title: f.title, reason: '无 PRD 明细文档（仅清单行或目录名）' });
  }
  const score = features.length
    ? Math.round(((features.length - noDetail.length) / features.length) * 100)
    : 0;
  return {
    key: 'coverage', label: '覆盖完整性',
    score: Math.max(0, Math.min(100, score)), level: levelOf(score), issues,
  };
}

function auditStatusHealth(features, distribution) {
  const issues = [];
  const blocked = countStatus(distribution, ['blocked']);
  const unknown = countStatus(distribution, ['unknown']);
  for (const f of features.filter((x) => x.status === 'blocked').slice(0, 20)) {
    issues.push({ feature: f.id, title: f.title, reason: '阻塞 / 风险状态' });
  }
  for (const f of features.filter((x) => x.status === 'unknown').slice(0, 20)) {
    issues.push({ feature: f.id, title: f.title, reason: '状态未标注（unknown）' });
  }
  const riskRatio = features.length ? (blocked + unknown) / features.length : 0;
  const score = Math.round((1 - riskRatio) * 100);
  return {
    key: 'statusHealth', label: '状态健康',
    score: Math.max(0, Math.min(100, score)), level: levelOf(score), issues,
  };
}

function auditDependencyRisk(features, dependencies) {
  const issues = [];
  const known = new Set(features.map((f) => f.id));
  const missingRefs = dependencies.filter((d) => !known.has(d.target)).slice(0, 20);
  for (const d of missingRefs) {
    issues.push({ feature: d.source, target: d.target, reason: '引用不存在的特性（FT 未纳入清单）' });
  }
  // 自引用排查（理论上已排除，防御）
  const selfRefs = dependencies.filter((d) => d.source === d.target).slice(0, 10);
  for (const s of selfRefs) issues.push({ feature: s.source, reason: '自身引用（异常）' });
  const base = features.length ? 100 : 0;
  const missingPenalty = Math.min(40, missingRefs.length * 4);
  const score = Math.max(0, base - missingPenalty);
  return {
    key: 'dependencyRisk', label: '依赖风险',
    score, level: levelOf(score), issues,
  };
}

function auditReleasePlanning(features) {
  const issues = [];
  const unplanned = features.filter((f) => !f.targetVersion || f.targetVersion === '(未排期)').slice(0, 20);
  const planned = features.length - unplanned.length;
  for (const f of unplanned) {
    issues.push({ feature: f.id, title: f.title, reason: '未排目标版本' });
  }
  const score = features.length ? Math.round((planned / features.length) * 100) : 0;
  return {
    key: 'releasePlanning', label: '版本规划',
    score, level: levelOf(score), issues,
  };
}

export function auditHealth(model) {
  const features = model.features || [];
  const distribution = model.distribution || { status: {}, priority: {}, targetVersion: {} };
  const dimensions = [
    auditCoverage(features),
    auditStatusHealth(features, distribution),
    auditDependencyRisk(features, model.dependencies || []),
    auditReleasePlanning(features),
  ];
  const score = Math.round(dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length);
  const issues = dimensions.flatMap((d) =>
    d.issues.map((i) => ({ dimension: d.key, ...i })),
  );
  return { score, level: levelOf(score), dimensions, issues };
}

// 便捷：审计结果作为 viewer 模型的一部分
export function runPlanningAudit(model) {
  return auditHealth(model);
}