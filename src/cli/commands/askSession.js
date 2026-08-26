// ask 多轮会话：基于 JSONL 的 session 存储
// 借鉴 nicekit agentRunner 的 ~/.nicekit/ 布局 + chat history 模式
//
// 存储布局：
//   $NICE_AOS_CONFIG_DIR/sessions/<id>.jsonl
//   ~/.nice-aos/sessions/<id>.jsonl  （默认；与 ~/.nice-aos/config.json 同一根目录）
//
// JSONL 格式（每行一个 turn）：
//   {"ts":1700000000000,"question":"...","answer":"...","agent":"api","model":"deepseek-chat","durationMs":1234}
//
// 设计原则：
//   - 追加写（O(1)），不重写整文件；并发写场景由 OS 文件锁兜底（家用 CLI 量级，足够）
//   - 损坏容忍：单行 JSON 解析失败时跳过 + 标记为损坏行，不阻塞整文件读取
//   - 历史 prompt 截断：默认带全部历史；可用 --session-max-turns 限制
//   - session id 校验：仅允许 [A-Za-z0-9_.-]+，防止路径穿越

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SAFE_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function isValidSessionId(id) {
  return typeof id === 'string' && SAFE_ID_RE.test(id);
}

export function getSessionsDir() {
  // 沿用 askConfig 同样的 NICE_AOS_CONFIG_DIR 覆盖链
  const override = process.env.NICE_AOS_CONFIG_DIR?.trim();
  const base = override || path.join(os.homedir(), '.nice-aos');
  return path.join(base, 'sessions');
}

function sessionPath(id) {
  if (!isValidSessionId(id)) {
    throw new Error(`非法的 session id（仅允许字母数字 _-.，长度 1-64）: ${id}`);
  }
  return path.join(getSessionsDir(), `${id}.jsonl`);
}

// 读取 session 的所有 turn；损坏行跳过；空文件返回 []
// opts.since 可选：只返回 ts >= since 的 turn（增量读场景）
export function loadSession(id, opts = {}) {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) return { turns: [], corrupted: 0 };
  const text = fs.readFileSync(p, 'utf-8');
  const turns = [];
  const lines = text.split('\n');
  let corrupted = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (!obj || typeof obj !== 'object') { corrupted += 1; continue; }
      if (typeof obj.question !== 'string' || typeof obj.answer !== 'string') { corrupted += 1; continue; }
      if (opts.since != null && (obj.ts ?? 0) < opts.since) continue;
      turns.push(obj);
    } catch {
      corrupted += 1;
    }
  }
  return { turns, corrupted };
}

// 追加一条 turn 到 session（O(1) 追加）
// 返回写入后的 turn 数
export function appendTurn(id, turn) {
  if (!turn || typeof turn.question !== 'string' || typeof turn.answer !== 'string') {
    throw new Error('turn 必须含 question 和 answer 字符串字段');
  }
  const p = sessionPath(id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const record = {
    ts: turn.ts ?? Date.now(),
    question: turn.question,
    answer: turn.answer,
    ...(turn.agent ? { agent: turn.agent } : {}),
    ...(turn.model ? { model: turn.model } : {}),
    ...(turn.durationMs != null ? { durationMs: turn.durationMs } : {}),
  };
  fs.appendFileSync(p, JSON.stringify(record) + '\n', 'utf-8');
  return loadSession(id).turns.length;
}

// 列出所有 session（id + 轮数 + 首/末次时间）
export function listSessions() {
  const dir = getSessionsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const result = [];
  for (const f of files) {
    const id = f.replace(/\.jsonl$/, '');
    if (!isValidSessionId(id)) continue;
    const filePath = path.join(dir, f);
    const stat = fs.statSync(filePath);
    const { turns, corrupted } = loadSession(id);
    const firstTs = turns[0]?.ts ?? null;
    const lastTs = turns[turns.length - 1]?.ts ?? null;
    result.push({
      id,
      turnCount: turns.length,
      firstTs,
      lastTs,
      sizeBytes: stat.size,
      corrupted,
    });
  }
  // 最近使用优先
  result.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  return result;
}

// 删除指定 session
// 返回 true（删除）/ false（不存在）
export function clearSession(id) {
  const p = sessionPath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

// 把 turns 格式化为可拼进 prompt 的多轮对话段
// 限制：maxTurns 截断（只带最后 N 轮，避免超长 prompt 击穿 token 预算）
// 格式：
//   ## 对话历史（session: <id>，已 <N> 轮；以下为最近 <K> 轮）
//
//   ### 轮 1
//   **用户**: ...
//   **助手**: ...
//
//   ### 轮 2
//   ...
//
//   ## 当前问题
//   <question>
export function formatHistory({ sessionId, turns, question, maxTurns = null }) {
  if (!turns || turns.length === 0) {
    return `## 当前问题\n${question}`;
  }
  const slice = maxTurns != null && maxTurns > 0 ? turns.slice(-maxTurns) : turns;
  const skipped = turns.length - slice.length;
  const skipNote = skipped > 0 ? `（已省略前 ${skipped} 轮）` : '';
  const historyBlock = slice.map((t, i) => {
    const round = skipped + i + 1;
    return `### 轮 ${round}\n**用户**: ${t.question}\n**助手**: ${t.answer}`;
  }).join('\n\n');
  return `## 对话历史（session: ${sessionId}，已 ${turns.length} 轮${skipNote}）\n\n${historyBlock}\n\n## 当前问题\n${question}`;
}
