// AI CLI 检测与调用（ask 命令的执行层）
// 借鉴 asdm-agentlink-cli 的 AgentDetector / which.ts 模式：
//   - 跨平台二进制查找：win32 用 where，其余用 which（execFile 数组参数，无 shell 拼接）
//   - 探测顺序即优先级：codebuddy → opencode（预留 claude / codex / qwen / aider 扩展位）
//   - 调用超时用 execFileSync 的 timeout（err.killed 标记超时）

import { execFileSync } from 'node:child_process';

const AGENT_PROBES = [
  { name: 'codebuddy', binary: 'codebuddy', buildArgs: (prompt) => ['-p', prompt, '--output-format', 'text'] },
  { name: 'opencode', binary: 'opencode', buildArgs: (prompt) => ['run', prompt] },
  // 预留扩展（asdm-agentlink-cli LEGACY_PROBES 同思路）：
  // { name: 'claude', binary: 'claude', buildArgs: (prompt) => ['-p', prompt] },
  // { name: 'codex',  binary: 'codex',  buildArgs: (prompt) => ['exec', prompt] },
  // { name: 'qwen',   binary: 'qwen',   buildArgs: (prompt) => [prompt] },
  // { name: 'aider',  binary: 'aider',  buildArgs: (prompt) => ['--message', prompt, '--no-auto-commits'] },
];

export { AGENT_PROBES };

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
  throw new Error('未检测到可用的 AI CLI。请先安装 codebuddy 或 opencode，或通过 --agent 指定，或配置模型服务（nice-aos ask config set）。');
}

// 列出 PATH 上全部可用 CLI agent（不抛错；ask 降级链用：CLI 全缺失时仍可走模型服务）
export function listAvailableAgents() {
  return AGENT_PROBES.filter((probe) => whichBinary(probe.binary));
}

// 显式指定 agent（--agent codebuddy / opencode）
export function resolveAgent(name) {
  const probe = AGENT_PROBES.find((p) => p.name === name);
  if (!probe) {
    throw new Error(`未知 agent: ${name}（可用: ${AGENT_PROBES.map((p) => p.name).join(', ')}）`);
  }
  return probe;
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
    throw new Error(`${agent.name} 调用失败: ${stderr}`);
  }
}
