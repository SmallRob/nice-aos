// AI CLI 检测与调用（ask 命令的执行层）
// 借鉴 asdm-agentlink-cli 的 AgentDetector / which.ts 模式：
//   - 跨平台二进制查找：win32 用 where，其余用 which（execFile 数组参数，无 shell 拼接）
//   - 调用超时用 execFileSync 的 timeout（err.killed 标记超时）
//
// v0.34.0 扩展为数据驱动注册表：
//   - 预置 8 种 CLI（codebuddy / opencode / trae / qoder / claude / codex / qwen / aider），
//     未验证过 flag 组合的条目标记 experimental——调用失败会显式报错并给出 --agent-cmd 覆盖指引
//   - --agent-cmd "<bin> [args...] {prompt}" 支持任意自定义 CLI 接入（{prompt} 占位符可省略，
//     缺省时 prompt 追加在末尾），无需改代码即可接入新 AI CLI
//
// 默认解析顺序（ask --agent auto）：已配置模型服务优先 → 注册表序探测可用 CLI。
// （v0.33 及更早是 CLI 优先、模型服务兜底；v0.34 起翻转——自定义模型接入是一等公民）

import { execFileSync } from 'node:child_process';

/**
 * @typedef {{
 *   name: string,
 *   binary: string,
 *   buildArgs: (prompt: string) => string[],
 *   kind?: 'cli',
 *   experimental?: boolean,
 *   desc?: string,
 * }} AgentProbe
 */

// 预置 CLI 探针（顺序即探测优先级）
const AGENT_PROBES = [
  { name: 'codebuddy', binary: 'codebuddy', buildArgs: (prompt) => ['-p', prompt, '--output-format', 'text'], desc: 'codebuddy CLI' },
  { name: 'opencode', binary: 'opencode', buildArgs: (prompt) => ['run', prompt], desc: 'opencode CLI' },
  // 实验性条目：flag 组合以各 CLI 实际版本为准；不符时用 --agent-cmd 覆盖
  { name: 'trae', binary: 'trae', buildArgs: (prompt) => ['-p', prompt], experimental: true, desc: 'Trae CLI（实验）' },
  { name: 'qoder', binary: 'qoder', buildArgs: (prompt) => ['-p', prompt], experimental: true, desc: 'Qoder CLI（实验）' },
  { name: 'claude', binary: 'claude', buildArgs: (prompt) => ['-p', prompt], experimental: true, desc: 'Claude Code（实验）' },
  { name: 'codex', binary: 'codex', buildArgs: (prompt) => ['exec', prompt], experimental: true, desc: 'Codex CLI（实验）' },
  { name: 'qwen', binary: 'qwen', buildArgs: (prompt) => [prompt], experimental: true, desc: 'Qwen Code（实验）' },
  { name: 'aider', binary: 'aider', buildArgs: (prompt) => ['--message', prompt, '--no-auto-commits'], experimental: true, desc: 'aider（实验）' },
];

export { AGENT_PROBES };

export const AGENT_NAMES = AGENT_PROBES.map((p) => p.name);

// 跨平台二进制查找（execFileSync 非拼接，无 shell 注入风险）
function whichBinary(binary) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(cmd, [binary], { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// 自动探测：按 AGENT_PROBES 顺序找第一个可用 agent
export function detectAgent() {
  for (const probe of AGENT_PROBES) {
    if (whichBinary(probe.binary)) return probe;
  }
  throw new Error(`未检测到可用的 AI CLI。可用注册名: ${AGENT_NAMES.join(' / ')}；或 --agent-cmd "<bin> [args] {prompt}" 接入任意 CLI；或配置模型服务（nice-aos ask config set）。`);
}

// 列出 PATH 上全部可用 CLI agent（不抛错；ask 降级链用）
export function listAvailableAgents() {
  return AGENT_PROBES.filter((probe) => whichBinary(probe.binary));
}

// 显式指定 agent（注册表命名）。未知名字含空白或路径分隔符时引导走 --agent-cmd
export function resolveAgent(name) {
  const probe = AGENT_PROBES.find((p) => p.name === name);
  if (!probe) {
    throw new Error(`未注册的 agent: ${name}\n  可用注册名: ${AGENT_NAMES.join(', ')}\n  接入其他 CLI: --agent "<命令模板>"，如 --agent-cmd "myai --ask {prompt}"`);
  }
  return probe;
}

/**
 * 自定义 CLI 探针：把命令模板编译为 AgentProbe。
 * 模板形态 "<bin> [args...] {prompt}"：
 *   - 含 {prompt} 占位符 → 按占位符位置注入（可出现多次）
 *   - 不含占位符       → prompt 追加为最后一个参数
 * 词法按空白切分（不支持引号嵌套——AI CLI 参数场景足够；含空格路径请建 wrapper 脚本）
 * @param {string} template
 * @returns {AgentProbe}
 */
export function compileAgentCmd(template) {
  const trimmed = String(template ?? '').trim();
  if (!trimmed) throw new Error('--agent-cmd 模板不能为空。示例: --agent-cmd "myai --ask {prompt}"');
  const tokens = trimmed.split(/\s+/);
  const binary = tokens[0];
  const rest = tokens.slice(1);
  const hasPlaceholder = rest.some((t) => t.includes('{prompt}'));
  if (binary.includes('{prompt}')) {
    throw new Error('--agent-cmd 模板的二进制段不可含 {prompt} 占位符');
  }
  return {
    name: binary.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat)$/i, '') || 'custom',
    binary,
    buildArgs: (prompt) => (hasPlaceholder
      ? rest.map((t) => t.split('{prompt}').join(prompt))
      : [...rest, prompt]),
    custom: true,
    desc: `自定义 CLI: ${trimmed}`,
  };
}

// 调用 AI CLI（同步阻塞，返回 stdout 文本）
export function invokeAgent(agent, prompt, { timeout = 120000 } = {}) {
  const args = agent.buildArgs(prompt);
  try {
    return execFileSync(agent.binary, args, {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    // Node 26 下 execFileSync 超时不置 err.killed，可靠信号是 ETIMEDOUT / SIGTERM
    if (err.killed || err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM') {
      throw new Error(`${agent.name} 调用超时（${timeout}ms）`);
    }
    const stderr = err.stderr?.toString()?.trim() || err.message;
    const hint = agent.experimental && !agent.custom
      ? `\n  提示: ${agent.name} 为实验性接入（flag 以实际版本为准），可用 --agent "${trimmedName(agent)}" 形式经 --agent-cmd 覆盖调用模板`
      : '';
    throw new Error(`${agent.name} 调用失败: ${stderr}${hint}`);
  }
}

function trimmedName(agent) {
  return `${agent.binary} ... {prompt}`;
}
