// ask 跨快照 diff 问答上下文（--since <ref> [--staged]）
// 复用 gitDiff 的变更解析与对象过滤，把"ref 以来的变更"折叠为 prompt 中的一段
// 紧凑 Markdown（--since 增量导出同源数据，节名对齐 exportToMarkdown 的"增量变更摘要"）。
//
// 设计目标：让 AI 回答聚焦在变更影响面——"这次改动动了哪些对象？谁依赖它们？"，
// 与全量项目上下文互补而非替代。

import {
  listChangedFiles,
  listChangedFilesSince,
  filterObjectsByFiles,
  findGitRoot,
} from '../../analyzers/gitDiff.js';

const MAX_FILES_LISTED = 40;
const MAX_OBJECTS_PER_TYPE = 15;

/**
 * 构建增量变更上下文
 * @param {Object} dataMap 本体快照
 * @param {{ since: string, staged?: boolean }} opts
 * @returns {{ section: string|null, files: string[], byType: Object, spec: string }}
 *   section 为 null 表示无变更（空段落不拼进 prompt）
 * @throws 非法 spec / 不在 git 仓库 / git 失败时抛错（调用方决定 fail 还是降级提示）
 */
export function buildSinceContext(dataMap, { since, staged = false }) {
  const gitRoot = findGitRoot(process.cwd());
  if (!gitRoot) {
    throw new Error(`--since 需要在 git 仓库内运行，但未找到 .git 目录（cwd=${process.cwd()}）`);
  }
  const changedFiles = staged
    ? listChangedFiles(gitRoot, since, { staged: true })
    : listChangedFilesSince(gitRoot, since);
  const byType = filterObjectsByFiles(dataMap, changedFiles);

  if (changedFiles.length === 0) {
    return { section: null, files: [], byType, spec: since };
  }

  const lines = [
    `## 增量变更上下文（since=${since}${staged ? ' · staged' : ''}）`,
    '',
    `git 变更文件 ${changedFiles.length} 个：`,
    ...changedFiles.slice(0, MAX_FILES_LISTED).map((f) => `- ${f}`),
    ...(changedFiles.length > MAX_FILES_LISTED ? [`- …（另 ${changedFiles.length - MAX_FILES_LISTED} 个文件略）`] : []),
    '',
  ];

  const typeRows = [];
  let totalObjs = 0;
  for (const [type, arr] of Object.entries(byType)) {
    totalObjs += arr.length;
    // 每对象一行关键标识（id / name / filePath），类型排序按数量降序
    for (const o of arr.slice(0, MAX_OBJECTS_PER_TYPE)) {
      const idPart = o.id ? ` \`${o.id}\`` : '';
      const namePart = o.name && !o.id?.includes(o.name) ? ` ${o.name}` : '';
      typeRows.push(`- **${type}**${idPart}${namePart}${o.filePath ? ` — ${o.filePath}` : ''}`);
    }
    if (arr.length > MAX_OBJECTS_PER_TYPE) {
      typeRows.push(`- **${type}** …（另 ${arr.length - MAX_OBJECTS_PER_TYPE} 个略）`);
    }
  }
  lines.push(`涉及本体对象 ${totalObjs} 个（变更文件的直接命中）：`);
  lines.push(...(typeRows.length ? typeRows : ['- （无直接命中的已登记对象——多为新增未扫描文件或纯测试/资源变更）']));

  return { section: lines.join('\n'), files: changedFiles, byType, spec: since };
}
