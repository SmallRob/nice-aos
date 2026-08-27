// ask 命令：基于本体快照向 AI CLI 或 OpenAI 兼容模型服务提问
// 上下文构建走 SQLite 4 次 SQL（<50ms），better-sqlite3 不可用 / 无快照行时回退 JSON。
//
// 空数据自动快照：无 snapshot.json 或 Project.fileCount === 0（空项目快照）时，
// 先自动执行 refreshRepo（与 action 同款项目根探测）再问答；--no-auto-refresh 跳过。
//
// v0.34.0 升级：
//   - Agent 解析默认翻转：--agent auto 时已配置的模型服务优先，其次按注册表序探测 CLI
//     （codebuddy → opencode → trae → qoder → claude → codex → qwen → aider）
//   - --agent-cmd "<bin> [args...] {prompt}"：任意自定义 AI CLI 接入，无需改代码
//   - --tools：自治深查模式——自动后台起 serve 并把 query/link/export 的使用指引注入 prompt，
//     让 AI 按需自行取证（v0.35.0 sub-tool P1）
//   - --save [path]：回答落盘为自包含 Markdown 存档（P2）
//   - --since <ref> [--staged]：跨快照 diff 问答——增量变更上下文折叠进 prompt（P2）
//   - ask eval 子命令：评测 harness，JSONL 用例集 + 关键词断言出通过率报告（P2）
//
// 用法：
//   nice-aos ask "这个项目有哪些功能域？"
//   nice-aos ask "Q" --agent codebuddy            # 显式指定 CLI
//   nice-aos ask "Q" --agent-cmd "myai --ask {prompt}"   # 自定义 CLI 接入
//   nice-aos ask "Q" --tools                      # AI 自治深查
//   nice-aos ask "这次重构影响谁？" --since HEAD~1        # 增量问答
//   nice-aos ask "Q" --save answers/arch.md       # 落盘
//   nice-aos ask eval --cases cases.jsonl         # 评测

import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { loadSnapshot, saveSnapshot } from '../../ontology/snapshot.js';
import { buildAskContextFromSql, saveSnapshot as sqlSaveSnapshot } from '../../storage/index.js';
import { getSnapshotDir } from '../../paths.js';
import { detectProjectRoot } from '../../analyzers/projectRootDetector.js';
import { buildOntologyData } from '../../ontology/builder.js';
import { isValidRangeSpec } from '../../analyzers/gitDiff.js';
import { fail, succeed } from '../shared.js';
import { resolveAgent, invokeAgent, listAvailableAgents, compileAgentCmd } from './agentRunner.js';
import { buildAskContext } from './askContext.js';
import { invokeApiChat, invokeApiChatStream } from './openaiCompat.js';
import { PROVIDERS, loadAskConfig, saveAskConfig, clearAskConfig, describeAskConfig } from './askConfig.js';
import { loadSession, appendTurn, formatHistory, isValidSessionId } from './askSession.js';
import { resolveSavePath, formatAskArchive, writeAskArchive } from './askSave.js';
import { buildSinceContext } from './askDiffContext.js';
import { registerEvalCommand } from './askEval.js';

// 后台启动 serve（--port 0 自动分配），从 stdout 解析实际端口
// 失败/超时返回 null（不阻塞 ask 主流程）
function startServeInBg(snapshotDir) {
  const CLI_ENTRY = process.argv[1];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, 'serve', '--port', '0', '--dir', snapshotDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => resolve(null), 5000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    });
  });
}

// ---------- 上下文准备（ask 主流程与 eval harness 共用） ----------

async function prepareContext(opts) {
  let dataMap = null;
  let noSnapshot = false;
  try {
    dataMap = loadSnapshot();
  } catch (err) {
    if (err.code !== 'NO_SNAPSHOT') throw err;
    noSnapshot = true;
  }
  const isEmptyData = noSnapshot || (dataMap?.Project?.[0]?.fileCount ?? 0) === 0;
  let refreshed = false;
  if (isEmptyData && opts.autoRefresh) {
    const reason = noSnapshot ? '未找到本体快照' : '当前快照为空项目（0 个源文件）';
    console.error(`ℹ️  ${reason}，自动执行 refreshRepo 重建快照（--no-auto-refresh 可跳过）...`);
    try {
      const detected = detectProjectRoot('', { cwd: process.cwd() });
      const projectPath = detected?.root ?? process.cwd();
      dataMap = await buildOntologyData(projectPath, {});
      saveSnapshot(dataMap);
      refreshed = true;
      const p = dataMap.Project?.[0];
      console.error(`ℹ️  快照已重建: ${p?.name ?? '未知项目'}（${p?.fileCount ?? 0} 个源文件）`);
      // 同步 SQLite 镜像（best-effort：失败不阻塞，下次走 JSON 回退）
      try {
        const w = sqlSaveSnapshot({ kind: 'code', dataMap });
        if (w?.ok === false) console.error(`⚠️  SQLite 镜像更新失败: ${w.reason}（不影响本次问答）`);
      } catch (err) {
        console.error(`⚠️  SQLite 镜像更新异常: ${err.message}（不影响本次问答）`);
      }
    } catch (err) {
      console.error(`⚠️  自动快照失败: ${err.message}`);
      if (noSnapshot) {
        fail(`快照构建失败: ${err.message}\n  可手动执行: nice-aos action refreshRepo --params '{"repoPath":"."}'`);
      }
      // 空项目快照仍保留在 dataMap → 继续问答（上下文如实呈现空项目）
    }
  } else if (noSnapshot && !opts.autoRefresh) {
    fail(`未找到本体快照。\n  请先执行构建: nice-aos action refreshRepo\n  或去掉 --no-auto-refresh 让 ask 自动构建`);
  }

  let context;
  let contextSource;
  if (refreshed) {
    context = buildAskContext(dataMap);
    contextSource = 'json-refreshed';
  } else {
    context = buildAskContextFromSql({ kind: 'code' });
    contextSource = 'sqlite';
    if (!context) {
      context = buildAskContext(dataMap);
      contextSource = 'json';
    }
  }
  return { dataMap, context, contextSource };
}

// ---------- 核心问答执行器（主流程与 eval 共用） ----------
//
// opts 额外约定：
//   _quiet: true 时不做任何 stdout 输出（eval 场景由 runEval 收集 answer）
// 返回 { answer, meta }：meta 含 agent / model / provider / fallbackFrom /
//                        streamed / session / serveUsed / savedPath 等，供调用方消费与存档。

async function doAsk(question, opts) {
  const started = Date.now();
  const quiet = !!opts._quiet;

  // 1) 上下文（可由外部预构建传入 —— eval 多用例共享同一份）
  let ctx = opts._preparedCtx ?? null;

  // 2) --serve / --tools：后台起 serve
  let serve = null;
  if (opts.serve || opts.tools) {
    serve = await startServeInBg(getSnapshotDir());
    if (!serve && (opts.serve || opts.tools)) console.error('⚠️  后台 serve 启动失败，继续无 serve 模式');
  }

  try {
    // 3) 多轮会话
    let sessionTurns = [];
    let sessionId = null;
    if (opts.session) {
      if (!isValidSessionId(opts.session)) {
        fail(`非法的 session id（仅允许字母数字 _-.，长度 1-64）: ${opts.session}`);
      }
      sessionId = opts.session;
      const loaded = loadSession(sessionId);
      sessionTurns = loaded.turns;
      if (loaded.corrupted > 0 && !opts.json) {
        console.error(`⚠️  session ${sessionId} 含 ${loaded.corrupted} 行损坏 JSON，已跳过`);
      }
      if (sessionTurns.length > 0 && !opts.json && !quiet) {
        console.error(`ℹ️  session ${sessionId} 续聊：已 ${sessionTurns.length} 轮历史`);
      }
    }

    if (!ctx) {
      ctx = await prepareContext(opts);
    }

    // 4) --since 跨快照 diff 上下文
    let sinceSection = null;
    let sinceMeta = null;
    if (opts.since) {
      if (!isValidRangeSpec(opts.since)) {
        fail(`非法的 --since spec（仅允许字母数字 . ~ ^ _ - .. 空白）: ${opts.since}`);
      }
      try {
        const sinceCtx = buildSinceContext(ctx.dataMap, { since: opts.since, staged: !!opts.staged });
        sinceSection = sinceCtx.section;
        sinceMeta = { spec: sinceCtx.spec, fileCount: sinceCtx.files.length };
      } catch (err) {
        fail(`--since 解析失败: ${err.message}`);
      }
    }

    // 5) 拼 prompt
    const parts = [ctx.context];
    if (serve) {
      parts.push(
        `完整快照与对象级查询可通过 HTTP 访问:\n`
        + `- http://127.0.0.1:${serve.port}/snapshot.json\n`
        + `- http://127.0.0.1:${serve.port}/api/objects/<type>?where=k=v\n`
        + `- http://127.0.0.1:${serve.port}/api/ask/context`,
      );
    }
    if (opts.tools) {
      parts.push(
        [
          '## 自治深查工具（sub-tool，按需取证后作答）',
          '',
          '预置的项目上下文可能不足以精确回答。你可以先自行取证再回答：',
          '',
          '### 方式一：本地 CLI（无副作用、毫秒级）',
          '- `nice-aos query <Type> --where "k=v,k2~v2" [--limit n]` —— 对象查询；类型清单见 `nice-aos mcp` get_schema 或下述 /api/schema',
          '- `nice-aos link <linkType> --src "<objectId>"` —— 关系遍历（importedBy / renders / navigatesTo / implements / calls ...）',
          '- `nice-aos export --format viewmodel` —— 聚合视图模型 JSON',
          '',
          '### 方式二：HTTP 数据源',
          `- GET http://127.0.0.1:${serve ? serve.port : 8420}/api/schema —— 能力发现`,
          `- GET http://127.0.0.1:${serve ? serve.port : 8420}/api/objects/<Type>?where=k~v&limit=200`,
          '',
          '要求：关键结论须引用对象 id；工具无法回答的部分明确说明。',
        ].join('\n'),
      );
    }
    if (sinceSection) parts.push(sinceSection);
    const questionPart = sessionId
      ? formatHistory({ sessionId, turns: sessionTurns, question, maxTurns: opts.sessionMaxTurns })
      : `## 问题\n${question}`;
    parts.push(questionPart);
    const fullPrompt = parts.join('\n\n');

    // 6) 解析降级链：默认（auto）已配置模型服务优先 → 注册表序 CLI；--agent-cmd 显式自定义置顶
    const apiConfig = loadAskConfig();
    const apiAgent = apiConfig ? { name: 'api', kind: 'api' } : null;
    let chain;
    if (opts.agentCmd) {
      chain = [compileAgentCmd(opts.agentCmd), ...(apiAgent ? [apiAgent] : [])];
    } else if (opts.agent === 'auto') {
      const cliAgents = listAvailableAgents();
      chain = [...(apiAgent ? [apiAgent] : []), ...cliAgents];
      if (chain.length === 0) {
        fail([
          '未检测到任何可用问答通道。',
          '  任选其一:',
          '  a) 配置模型服务（推荐，一等公民）: nice-aos ask config set --provider deepseek --api-key <key>',
          `  b) 安装任一受支持的 AI CLI: ${listAvailableAgentsTip()}`,
          '  c) 接入任意其他 CLI: nice-aos ask "Q" --agent-cmd "<bin> [args...] {prompt}"',
        ].join('\n'));
      }
    } else if (opts.agent === 'api') {
      if (!apiAgent) {
        fail('未配置模型服务。请先执行: nice-aos ask config set --provider deepseek --api-key <key>（或设 NICE_AOS_API_KEY / NICE_AOS_BASE_URL / NICE_AOS_MODEL 环境变量）');
      }
      chain = [apiAgent];
    } else {
      chain = [resolveAgent(opts.agent), ...(apiAgent ? [apiAgent] : [])];
    }

    // 7) 依序调用：失败/超时自动降级到下一个（每级独立 timeout 预算）
    const timeoutMs = parseInt(opts.timeout, 10);
    let answer;
    let answeredBy;
    let streamed = false;
    const failedAgents = [];
    let lastErr = null;
    for (let i = 0; i < chain.length; i++) {
      const agent = chain[i];
      const isLast = i === chain.length - 1;
      try {
        if (agent.kind === 'api') {
          if (opts.stream && !quiet) {
            // 流式：边收边打 token；最终 answer 仍是完整文本
            streamed = true;
            if (!opts.json) {
              process.stdout.write('\n'); // 流式开始前换行，与降级提示分行
            }
            answer = await invokeApiChatStream({
              ...apiConfig,
              prompt: fullPrompt,
              timeout: timeoutMs,
              onToken: opts.json ? () => {} : (token) => process.stdout.write(token),
            });
            if (!opts.json) {
              process.stdout.write('\n'); // 流式结束换行
            }
          } else {
            answer = await invokeApiChat({ ...apiConfig, prompt: fullPrompt, timeout: timeoutMs });
          }
        } else {
          // CLI agent：execFileSync 同步阻塞，不支持 token-by-token；
          // --stream 下给一次温和提示后走同步路径
          if (opts.stream && !opts.json && !quiet) {
            console.error(`ℹ️  ${agent.name} 走 CLI agent 路径暂不支持流式，同步等待完整回答...`);
          }
          answer = invokeAgent(agent, fullPrompt, { timeout: timeoutMs });
        }
        answeredBy = agent.name;
        break;
      } catch (err) {
        lastErr = err;
        failedAgents.push(agent.name);
        if (!isLast) {
          const nextLabel = chain[i + 1].kind === 'api' ? `模型服务（${apiConfig.model}）` : chain[i + 1].name;
          if (!quiet) console.error(`⚠️  ${agent.name} 调用失败（${err.message}），降级到 ${nextLabel}...`);
        }
      }
    }
    if (answer === undefined) {
      throw new Error(`所有 agent 调用失败。最后错误: ${lastErr?.message ?? '未知'}`);
    }

    // 8) 多轮会话 append
    let sessionTurnCount = null;
    if (sessionId) {
      try {
        sessionTurnCount = appendTurn(sessionId, {
          question,
          answer,
          agent: answeredBy,
          ...(answeredBy === 'api' && apiConfig?.model ? { model: apiConfig.model } : {}),
          durationMs: Date.now() - started,
        });
      } catch (err) {
        // append 失败不应阻塞输出（用户已经拿到答案）
        if (!opts.json && !quiet) console.error(`⚠️  session 写入失败: ${err.message}`);
      }
    }

    return {
      answer,
      meta: {
        agent: answeredBy,
        ...(answeredBy === 'api' && { provider: apiConfig.provider ?? 'custom', model: apiConfig.model }),
        contextSource: ctx.contextSource,
        durationMs: Date.now() - started,
        streamed,
        fallbackFrom: failedAgents,
        session: sessionId,
        sessionTurnCount,
        serveUsed: !!serve,
        tools: !!opts.tools,
        since: sinceMeta,
        question,
      },
    };
  } finally {
    if (serve?.child) {
      try { serve.child.kill(); } catch { /* ignore */ }
    }
  }
}

function listAvailableAgentsTip() {
  try {
    const avail = listAvailableAgents().map((a) => a.name);
    if (avail.length) return avail.join(' / ');
  } catch { /* ignore */ }
  return 'codebuddy / opencode / trae / qoder（或经 --agent-cmd 接入其它 CLI）';
}

// ---------- CLI 命令定义 ----------

export const askCommand = new Command('ask')
  .description('基于本体快照向 AI 提问：默认优先后自定义模型服务（OpenAI 兼容），亦可选择 AI CLI（codebuddy/opencode/trae/qoder/...）或 --agent-cmd 接入任意 CLI；支持 --tools 自治深查、--since 增量问答、--session 多轮、--stream 流式、--save 落盘')
  .argument('[question]', '问题文本（config / eval 子命令时省略）')
  .option('--agent <name>', `问答通道: auto | api | ${['codebuddy', 'opencode', 'trae', 'qoder'].join(' | ')} | ...（默认 auto：已配置的自定义模型服务优先，其次按注册表序探测可用 CLI）`, 'auto')
  .option('--agent-cmd <template>', '自定义 AI CLI 接入模板: "<bin> [args...] {prompt}"；含 {prompt} 占位符按位注入，缺省追加末尾。示例: --agent-cmd "myai --ask {prompt}"')
  .option('--cwd <path>', '项目根目录（默认当前目录；影响快照目录解析链）')
  .option('--serve', '同时后台启动 serve，把 HTTP URL 拼进 prompt 供 AI 深查完整快照')
  .option('--tools', '自治深查模式（隐含 --serve）：把 query/link/export CLI 与 HTTP 端点使用指引注入 prompt，让 AI 按需自行取证并引用对象 id')
  .option('--no-auto-refresh', '跳过空数据自动快照（无快照/空项目时不自动 refreshRepo，直接按现状处理）')
  .option('--timeout <ms>', 'agent / 模型服务调用超时（默认 120000）', '120000')
  .option('--stream', '流式输出（仅 --agent api 有效：token 逐字打到 stdout；CLI agent 不支持流式，自动降级到非流式）')
  .option('--json', 'JSON 结构化输出 {ok, agent, contextSource, durationMs, answer, streamed}')
  .option('--session <id>', '多轮会话：把历史 turn 折进 prompt，回答后 append 到 ~/.nice-aos/sessions/<id>.jsonl；同 id 续聊可保持上下文')
  .option('--session-max-turns <n>', '多轮会话：prompt 中只带最近 N 轮（默认全带；防止 token 击穿）', (v) => parseInt(v, 10))
  .option('--save [path]', '回答落盘为自包含 Markdown 存档；省略路径时写入 <snapshotDir>/answers/ask-<时间戳>.md')
  .option('--since <ref>', '跨快照 diff 问答：git ref 以来的变更文件与涉及对象折叠进 prompt（语法同 export --since）；适合"这次改动影响谁"类提问')
  .option('--staged', '配合 --since：只看已暂存变更（pre-commit 体检场景）')
  .action(async (question, opts) => {
    if (question === undefined) {
      fail('缺少问题文本。用法: nice-aos ask "<问题>"（配置模型服务: nice-aos ask config set --provider deepseek --api-key <key>）');
    }
    if (opts.cwd) {
      try {
        process.chdir(path.resolve(opts.cwd));
      } catch {
        fail(`--cwd 目录不存在: ${opts.cwd}`);
      }
    }

    let result;
    try {
      result = await doAsk(question, opts);
    } catch (err) {
      fail(err.message);
    }
    const { answer, meta } = result;

    // --save 回答落盘
    let savedPath = null;
    if (opts.save) {
      const explicitPath = typeof opts.save === 'string' ? opts.save : undefined;
      const { filePath } = resolveSavePath(explicitPath, getSnapshotDir());
      savedPath = writeAskArchive(filePath, formatAskArchive({
        ...meta,
        fallbackFrom: meta.fallbackFrom ?? [],
      }));
      if (!opts.json) console.error(`ℹ️  已保存: ${savedPath}`);
    }

    // 输出
    if (opts.json) {
      console.log(JSON.stringify({
        ok: true,
        agent: meta.agent,
        ...(meta.model && { model: meta.model, provider: meta.provider }),
        ...(meta.fallbackFrom.length > 0 && { fallbackFrom: meta.fallbackFrom }),
        contextSource: meta.contextSource,
        durationMs: meta.durationMs,
        streamed: meta.streamed,
        ...(meta.session ? { session: { id: meta.session, turnCount: meta.sessionTurnCount } } : {}),
        ...(meta.since ? { since: meta.since } : {}),
        ...(meta.tools ? { tools: true } : {}),
        ...(savedPath ? { saved: savedPath } : {}),
        answer,
      }, null, 2));
      return;
    }
    if (!meta.streamed) {
      console.log(answer);
    } else if (meta.fallbackFrom.length > 0) {
      const target = meta.agent === 'api' ? `模型服务（${meta.model}）` : meta.agent;
      console.error(`ℹ️  ${meta.fallbackFrom.join(' → ')} 调用失败，已由 ${target} 流式回答`);
    }
    if (meta.session) console.error(`ℹ️  session ${meta.session} 已 append（第 ${meta.sessionTurnCount} 轮）`);
  });

// ask eval 子命令：评测 harness（复用 doAsk；每用例静默采集 answer）
registerEvalCommand(askCommand, async (q) => {
  const { answer, meta } = await doAsk(q, {
    agent: process.env.NICE_AOS_EVAL_AGENT ?? 'auto',
    timeout: process.env.NICE_AOS_EVAL_TIMEOUT ?? '60000',
    autoRefresh: false,
    json: true,
    _quiet: true,
  });
  return { answer, meta };
});

// ---------- ask config：模型服务配置（密钥加密落盘） ----------

const configCmd = askCommand.command('config')
  .description('管理自定义模型服务配置（OpenAI 兼容；apiKey AES-256-GCM 加密存储）。配置后成为 --agent auto 的首选通道');

configCmd
  .command('set')
  .description('写入/更新模型服务配置（预置 provider: deepseek；custom 用 --base-url/--model 自定义）')
  .option('--provider <name>', `预置服务: ${Object.keys(PROVIDERS).join(' | ')} | custom`, null)
  .option('--api-key <key>', 'API 密钥（sk-xxx；加密落盘，show 时掩码显示）')
  .option('--base-url <url>', 'OpenAI 兼容端点（含 /chat/completions），覆盖 provider 预置值')
  .option('--model <name>', '模型名（如 deepseek-chat），覆盖 provider 预置值')
  .action((opts) => {
    const patch = {};
    if (opts.provider !== null) {
      const preset = PROVIDERS[opts.provider];
      if (!preset && opts.provider !== 'custom') {
        fail(`未知 provider: ${opts.provider}（可用: ${[...Object.keys(PROVIDERS), 'custom'].join(', ')}）`);
      }
      patch.provider = opts.provider;
      if (preset) {
        if (!opts.baseUrl) patch.baseUrl = preset.baseUrl;
        if (!opts.model) patch.model = preset.model;
      }
    }
    if (opts.baseUrl) patch.baseUrl = opts.baseUrl;
    if (opts.model) patch.model = opts.model;
    if (opts.apiKey !== undefined) patch.apiKey = opts.apiKey;
    if (Object.keys(patch).length === 0) {
      fail('无可更新项。请至少指定 --provider / --api-key / --base-url / --model 之一');
    }
    const saved = saveAskConfig(patch);
    succeed({
      ok: true,
      saved: {
        provider: saved.provider,
        baseUrl: saved.baseUrl,
        model: saved.model,
        apiKey: saved.apiKeyEnc ? '已加密存储（enc:v1:AES-256-GCM）' : null,
      },
      hint: '配置后 --agent auto 将优先走该模型服务；环境变量 NICE_AOS_API_KEY / NICE_AOS_BASE_URL / NICE_AOS_MODEL 优先于本配置',
    });
  });

configCmd
  .command('show')
  .description('查看当前生效配置（密钥掩码显示）')
  .action(() => {
    succeed({ ok: true, ...describeAskConfig() });
  });

configCmd
  .command('unset')
  .description('清除已保存的模型服务配置（之后 --agent auto 仅探测 AI CLI）')
  .action(() => {
    clearAskConfig();
    succeed({ ok: true, cleared: true });
  });

// 多轮会话：仅保留核心 --session <id> 读写；session 列表 / 清理走 askSession.js 模块 API，
// 不在 CLI 暴露（用户脚本可直接调用 `import { listSessions } from '.../askSession.js'`）。
