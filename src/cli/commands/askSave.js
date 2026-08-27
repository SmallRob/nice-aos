// ask 回答落盘（--save）：Markdown 存档生成与路径解析
//
// 形态：
//   nice-aos ask "Q" --save                 → <snapshotDir>/answers/ask-<ts>.md
//   nice-aos ask "Q" --save out/report.md   → 指定路径（目录不存在自动创建）
//
// 存档为自包含 Markdown：元信息头 + 问题 + 完整回答，便于归档/贴 issue/二次消费。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析落盘路径。显式 path 优先；否则落到 <baseDir>/answers/ask-<ISO 时间戳>.md
 * @param {string|undefined} explicitPath 用户指定的输出路径
 * @param {string} baseDir 快照目录（默认 answers/ 的挂载点）
 * @returns {{filePath: string}}
 */
export function resolveSavePath(explicitPath, baseDir) {
  if (explicitPath && explicitPath.trim()) {
    return { filePath: path.resolve(explicitPath.trim()) };
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return { filePath: path.join(baseDir, 'answers', `ask-${ts}.md`) };
}

/**
 * 生成自包含 Markdown 存档文本
 * @param {{
 *   question: string,
 *   answer: string,
 *   agent?: string, model?: string, provider?: string,
 *   contextSource?: string, durationMs?: number,
 *   session?: string|null, since?: string|null, tools?: boolean,
 *   fallbackFrom?: string[],
 * }} meta
 */
export function formatAskArchive(meta) {
  const {
    question, answer,
    agent, model, provider, contextSource, durationMs,
    session = null, since = null, tools = false, fallbackFrom = [],
  } = meta;
  const head = [
    '# nice-aos ask 回答存档',
    '',
    `- **时间**: ${new Date().toISOString()}`,
    `- **回答方**: ${agent ?? 'unknown'}${model ? `（${provider ?? 'custom'} · ${model}）` : ''}`,
    ...(fallbackFrom.length ? [`- **降级链**: ${fallbackFrom.join(' → ')}`] : []),
    `- **上下文来源**: ${contextSource ?? 'unknown'}`,
    // since 兼容两种形态：string（直接展示）或 {spec}（doAsk 传出的元信息对象）
    ...(since ? [`- **增量范围**: ${typeof since === 'string' ? since : since.spec ?? ''}`] : []),
    ...(tools ? ['- **自治工具**: 已启用（serve + CLI sub-tool）'] : []),
    ...(session ? [`- **会话**: ${session}`] : []),
    ...(durationMs != null ? [`- **耗时**: ${(durationMs / 1000).toFixed(1)}s`] : []),
    '',
    '## 问题',
    '',
    question.trim(),
    '',
    '## 回答',
    '',
    answer.trim(),
    '',
  ];
  return head.join('\n');
}

/**
 * 写入存档文件（父目录不存在时自动创建）
 * @returns {string} 写入的绝对路径
 */
export function writeAskArchive(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
