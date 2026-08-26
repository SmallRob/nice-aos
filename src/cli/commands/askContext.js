// ask 上下文构建（JSON 回退版）
// 与 storage/sqliteSnapshot.js 的 buildAskContextFromSql 输出格式逐节对齐：
// SQLite 可用时走 4 次 SQL（<50ms）；不可用时走本文件（12MB JSON.parse 后内存构建）
// 章节：项目本体快照 / 架构分层 / 功能域 / 模块 Top 10 / 声明依赖 / 健康指标 / 对象统计
// （"## 问题"节由 ask.js 统一拼接，构建器不负责）

export function buildAskContext(dataMap) {
  const project = dataMap.Project?.[0] || {};
  const domains = dataMap.Domain || [];
  const modules = [...(dataMap.Module || [])]
    .sort((a, b) => (b.fileCount ?? 0) - (a.fileCount ?? 0))
    .slice(0, 10);
  const deps = (dataMap.Dependency || []).slice(0, 50);
  const meta = dataMap._meta || {};
  const health = project.health || {};

  const lines = [];
  lines.push('## 项目本体快照');

  lines.push(`- 名称: ${project.name ?? '未知'}`);
  lines.push(`- 框架: ${project.frameworkLabel ?? project.framework ?? '未知'}`);
  lines.push(`- 语言: ${project.language ?? '未知'}`);
  lines.push(`- 源文件数: ${project.fileCount ?? 0}`);
  lines.push(`- Commit: ${project.commitHash ?? '无'}`);

  // 架构分层
  if (project.architecture?.layers?.length) {
    lines.push('\n## 架构分层');
    for (const layer of project.architecture.layers) {
      lines.push(`- ${layer.label}: ${layer.fileCount} 文件 (${layer.share}%)`);
    }
  }

  // 功能域
  if (domains.length) {
    lines.push('\n## 功能域');
    for (const dom of domains) {
      lines.push(`- ${dom.name}: ${dom.fileCount ?? '?'} 文件, ${dom.lineCount ?? '?'} 行`);
    }
  }

  // 模块 Top 10（按 fileCount 降序）
  if (modules.length) {
    lines.push('\n## 模块 Top 10');
    for (const mod of modules) {
      lines.push(`- ${mod.path} (${mod.fileCount ?? 0} 文件, ${mod.archLayerLabel ?? mod.layer ?? '?'})`);
    }
  }

  // 声明依赖
  lines.push('\n## 声明依赖');
  lines.push(deps.map((d) => d.name).filter(Boolean).join(', ') || '无');

  // 健康指标
  if (project.health) {
    lines.push('\n## 健康指标');
    lines.push(`- 循环依赖: ${health.cycleCount ?? 0}`);
    lines.push(`- 孤儿文件: ${health.orphanFileCount ?? 0}`);
    lines.push(`- 死代码候选: ${(health.deadTypeCount ?? 0) + (health.deadFunctionCount ?? 0) + (health.deadExportCount ?? 0)}`);
    lines.push(`- 未声明依赖: ${health.undeclaredDependencyCount ?? 0}`);
  }

  // objectCounts 摘要
  const countEntries = Object.entries(meta.objectCounts || {}).filter(([, v]) => v > 0);
  if (countEntries.length) {
    lines.push('\n## 对象统计');
    for (const [type, count] of countEntries) {
      lines.push(`- ${type}: ${count}`);
    }
  }

  return lines.join('\n');
}
