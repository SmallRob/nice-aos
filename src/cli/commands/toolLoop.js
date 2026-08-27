// ask --tool-call：AI 自治工具循环（x-1，v0.34.0 / 路线图 ReAct ≤5 步）
//
// 协议（文本 ReAct 约定，任何 OpenAI 兼容端点都能用）：
//   1. 初始 prompt 尾部注入 buildToolInstructions() —— query/link/export 三个
//      sub-command 的参数说明与"输出 aos-tool 块"的格式约定
//   2. 模型需要取证时输出一个 ```aos-tool ... ``` fenced JSON 块；
//      准备好最终回答时不输出任何块
//   3. 循环解析最后一块 → 经子进程执行真实 `nice-aos query/link/output` 命令 →
//      结果截断后回填进下一轮 prompt → 再次生成（≤ maxSteps 步）
//   4. 仅模型服务通道可用（CLI agent 无法可靠多轮回调，提示走 --tools）
//
// 分层：extractToolCall / validateToolCall 纯函数；createCliTools 子进程执行器；
// runToolLoop 只依赖注入的 chatFn/tools —— 全部可脱离网络与文件系统单测。

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_RESULT_CHARS = 8 * 1024;

// ---------- 协议解析 ----------

/**
 * 从模型回复中提取最后一个 ```aos-tool fenced JSON 块。
 * @returns {{ call: object|null, rawBlock: string|null, parseError: string|null }}
 *   call=null 且 parseError=null → 模型给出了最终回答；parseError 非 null → 块存在但内容非法
 */
export function extractToolCall(responseText) {
  const re = /```aos-tool\s*\n([\s\S]*?)```/g;
  let last = null;
  let m;
  while ((m = re.exec(String(responseText ?? '')))) last = m;
  if (!last) return { call: null, rawBlock: null, parseError: null };
  const raw = last[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { call: null, rawBlock: last[0], parseError: `JSON 解析失败: ${err.message}` };
  }
  const problems = [];
  if (!parsed || typeof parsed !== 'object') problems.push('顶层须为对象');
  else {
    if (!['query', 'link', 'output'].includes(parsed.tool)) {
      problems.push(`tool 仅允许 query | link | output（收到: ${String(parsed.tool)}）`);
    }
    if (parsed.args !== undefined && (typeof parsed.args !== 'object' || parsed.args === null || Array.isArray(parsed.args))) {
      problems.push('args 须为对象');
    }
  }
  if (problems.length) {
    return { call: null, rawBlock: last[0], parseError: problems.join('; ') };
  }
  parsed.args = parsed.args ?? {};
  return { call: parsed, rawBlock: last[0], parseError: null };
}

/** 注入到初始 prompt 尾部的工具使用说明 */
export function buildToolInstructions() {
  return [
    '## 自治工具循环（sub-command 取证协议）',
    '',
    '预置上下文可能不足以精确回答。你可以调用以下只读 sub-command 取证（每轮至多一个）：',
    '',
    '- 对象查询: {"tool":"query","args":{"type":"<对象类型>","where":"k=v,k2~v2","limit":50}}',
    '  · type 见上方对象统计的键名（如 Component / Method / Dependency）；where 同 CLI query（~ 为子串包含）',
    '- 关系遍历: {"tool":"link","args":{"linkType":"<链接类型>","src":"<objectId>"}}',
    '  · 如 {"tool":"link","args":{"linkType":"importedBy","src":"file:src/services/ai.ts"}}',
    '- 报告/蓝图: {"tool":"output","args":{"format":"viewmodel|markdown|json"}}',
    '',
    '输出格式：把单个调用写成 ```aos-tool 代码围栏内的 JSON（不要输出别的工具语法）。',
    '准备好最终回答时，直接回答正文，不要再输出任何 aos-tool 围栏。',
  ].join('\n');
}

// ---------- 默认子进程执行器 ----------

import fs from 'node:fs';

function findCliEntry() {
  // 从本模块向上逐级探测包根的 src/cli/index.js
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'src', 'cli', 'index.js');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('未能定位 nice-aos CLI 入口（src/cli/index.js）');
}

/**
 * 创建基于真实 nice-aos 子进程的工具集（与用户手敲 CLI 完全同源，零逻辑重复）。
 * @param {{ cwd?: string, timeoutMs?: number, cliEntry?: string }} opts
 * @returns {(call: {tool:string,args:object}) => Promise<object>}
 */
export function createCliTools(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const cliEntry = opts.cliEntry ?? findCliEntry();
  return async function runTool(call) {
    const argv = [];
    if (call.tool === 'query') {
      argv.push('query', String(call.args.type ?? ''));
      if (call.args.where) argv.push('--where', String(call.args.where));
      if (call.args.limit != null) argv.push('--limit', String(call.args.limit));
    } else if (call.tool === 'link') {
      argv.push('link', String(call.args.linkType ?? ''), '--src', String(call.args.src ?? ''));
    } else if (call.tool === 'output') {
      argv.push('output', '--format', ['viewmodel', 'markdown', 'json'].includes(call.args.format) ? call.args.format : 'viewmodel');
    }
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [cliEntry, ...argv.filter((a) => a !== '')], {
        cwd,
        encoding: 'utf-8',
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, NICE_AOS_TOOLS_CHILD: '1' },
      });
    } catch (err) {
      const stderr = err.stderr?.toString?.()?.trim() || err.message;
      return { ok: false, error: truncate(`sub-command 失败: ${stderr}`, MAX_RESULT_CHARS) };
    }
    // 快照目录继承当前环境；输出直接回填给模型（超大截断）
    return { ok: true, output: truncate(stdout, MAX_RESULT_CHARS) };
  };
}

function truncate(s, max) {
  const str = String(s ?? '');
  return str.length > max ? `${str.slice(0, max)}\n…（已截断，原长 ${str.length} 字符）` : str;
}

// ---------- 主循环 ----------

/**
 * @param {{
 *   initialPrompt: string,
 *   chatFn: (fullPrompt: string) => Promise<string>,
 *   tools: (call: {tool:string,args:object}) => Promise<object>,
 *   maxSteps?: number,
 *   onEvent?: (e: {step:number, kind:'model'|'tool'|'done', detail?:object}) => void,
 * }} opts
 * @returns {Promise<{ answer: string, steps: number, toolCalls: object[] }>}
 *   达到步数上限仍未收敛时，最后一轮附加强制收尾指令再生成一次。
 */
export async function runToolLoop({ initialPrompt, chatFn, tools, maxSteps = 5, onEvent }) {
  const emit = (e) => { try { onEvent?.(e); } catch { /* ignore */ } };
  let currentPrompt = `${initialPrompt}\n\n${buildToolInstructions()}`;
  const toolCalls = [];
  let modelText = '';

  for (let step = 1; step <= maxSteps; step += 1) {
    emit({ step, kind: 'model' });
    modelText = await chatFn(currentPrompt);

    const { call, parseError } = extractToolCall(modelText);
    if (!call && !parseError) {
      emit({ step, kind: 'done', detail: { reason: 'final-answer' } });
      return { answer: modelText.trim(), steps: step - 1, toolCalls };
    }

    let resultPayload;
    if (parseError) {
      resultPayload = { ok: false, error: `工具调用块非法: ${parseError}` };
    } else {
      toolCalls.push(call);
      emit({ step, kind: 'tool', detail: call });
      try {
        resultPayload = await tools(call);
      } catch (err) {
        resultPayload = { ok: false, error: `工具执行异常: ${err.message}` };
      }
    }

    currentPrompt = [
      currentPrompt,
      '<assistant_output>',
      truncate(modelText, 4000),
      '</assistant_output>',
      `<tool_result step=${step}>`,
      truncate(JSON.stringify(resultPayload), MAX_RESULT_CHARS),
      '</tool_result>',
      step < maxSteps
        ? '继续：需要更多取证就输出下一个 ```aos-tool``` 块；否则给出最终回答（不要输出 aos-tool 围栏）。'
        : '已达步数上限：请立即基于以上取证给出最终回答，不要输出任何 aos-tool 围栏。',
    ].join('\n\n');
  }

  // 收尾强制生成
  emit({ step: maxSteps + 1, kind: 'model' });
  modelText = await chatFn(currentPrompt);
  const finalExtract = extractToolCall(modelText);
  const answer = (finalExtract.call ? stripLastFence(modelText) : modelText).trim();
  emit({ step: maxSteps + 1, kind: 'done', detail: { reason: 'max-steps-reached' } });
  return { answer, steps: maxSteps, toolCalls };
}

/** 兜底剥离最后的 aos-tool 围栏（保证给用户的答案不含协议噪声） */
export function stripLastFence(text) {
  return String(text ?? '').replace(/```aos-tool[\s\S]*?```\s*$/g, '').trim();
}
