// ask 命令：基于本体快照向 AI CLI（codebuddy / opencode）或 OpenAI 兼容模型服务提问
// 借鉴 asdm-agentlink-cli 的 agent 桥接思路，Phase B：上下文构建走 SQLite 4 次 SQL（<50ms），
// better-sqlite3 不可用 / 无快照行时回退 JSON（12MB JSON.parse）
//
// 空数据自动快照：无 snapshot.json 或 Project.fileCount === 0（空项目快照）时，
// 先自动执行 refreshRepo（与 action 同款项目根探测）再问答，避免 AI 对着空上下文说"无法分析"。
// --no-auto-refresh 跳过自动刷新（保持旧的报错指引行为，供 CI / 显式控制场景）。
//
// 备选降级链（借鉴 nicekit modelFallback）：CLI agent 调用超时/失败时自动降级到已配置的
// 模型服务（OpenAI 兼容，如 DeepSeek，nice-aos ask config set 配置）；--agent api 直连模型服务。
//
// 用法：
//   nice-aos ask "这个项目有哪些功能域？" --agent codebuddy
//   nice-aos ask "架构分层的文件分布？" --serve          # 同时后台起 serve，AI CLI 可经 HTTP 深查
//   nice-aos ask "有哪些循环依赖？" --json
//   nice-aos ask "ASDM架构？"                            # 无快照/空项目时自动 refreshRepo 后再答
//   nice-aos ask "Q" --agent api                         # 直连模型服务（ask config 配置）
//   nice-aos ask config set --provider deepseek --api-key sk-xxx   # 配置模型服务（密钥加密落盘）
//   nice-aos ask config show / unset

import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { loadSnapshot, saveSnapshot } from '../../ontology/snapshot.js';
import { buildAskContextFromSql, saveSnapshot as sqlSaveSnapshot } from '../../storage/index.js';
import { getSnapshotDir } from '../../paths.js';
import { detectProjectRoot } from '../../analyzers/projectRootDetector.js';
import { buildOntologyData } from '../../ontology/builder.js';
import { fail, succeed } from '../shared.js';
import { resolveAgent, invokeAgent, listAvailableAgents } from './agentRunner.js';
import { buildAskContext } from './askContext.js';
import { invokeApiChat, invokeApiChatStream } from './openaiCompat.js';
import { PROVIDERS, loadAskConfig, saveAskConfig, clearAskConfig, describeAskConfig } from './askConfig.js';
import { loadSession, appendTurn, formatHistory, isValidSessionId } from './askSession.js';

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

export const askCommand = new Command('ask')
  .description('基于本体快照向 AI CLI（codebuddy / opencode）或模型服务（OpenAI 兼容，如 DeepSeek）提问：上下文走 SQLite 预过滤（4 次 SQL，<50ms），回退 JSON；CLI 超时/失败自动降级到模型服务')
  .argument('[question]', '问题文本（ask config 子命令时省略）')
  .option('--agent <name>', 'AI CLI: codebuddy | opencode | api | auto（默认 auto：依次探测 codebuddy → opencode，末位降级到已配置模型服务）', 'auto')
  .option('--cwd <path>', '项目根目录（默认当前目录；影响快照目录解析链）')
  .option('--serve', '同时后台启动 serve，把 HTTP URL 拼进 prompt 供 AI CLI 深查完整快照')
  .option('--no-auto-refresh', '跳过空数据自动快照（无快照/空项目时不自动 refreshRepo，直接按现状处理）')
  .option('--timeout <ms>', 'agent / 模型服务调用超时（默认 120000）', '120000')
  .option('--stream', '流式输出（仅 --agent api 有效：token 逐字打到 stdout；CLI agent 不支持流式，自动降级到非流式）')
  .option('--json', 'JSON 结构化输出 {ok, agent, contextSource, durationMs, answer, streamed}')
  .option('--session <id>', '多轮会话：把历史 turn 折进 prompt，回答后 append 到 ~/.nice-aos/sessions/<id>.jsonl；同 id 续聊可保持上下文')
  .option('--session-max-turns <n>', '多轮会话：prompt 中只带最近 N 轮（默认全带；防止 token 击穿）', (v) => parseInt(v, 10))
  .action(async (question, opts) => {
    if (question === undefined) {
      fail('缺少问题文本。用法: nice-aos ask "<问题>"（配置模型服务: nice-aos ask config set --provider deepseek --api-key <key>）');
    }
    const started = Date.now();
    if (opts.cwd) {
      try {
        process.chdir(path.resolve(opts.cwd));
      } catch (err) {
        fail(`--cwd 目录不存在: ${opts.cwd}`);
      }
    }

    // 0) 空数据检测：无快照 / 空项目快照 → 自动 refreshRepo 后再问答
    //    （空项目 = Project.fileCount === 0，典型产物：扫了空目录 / repoPath 指错）
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

    // 1) 上下文：刷新后直接用 dataMap（JSON 构建）；否则 SQL 优先（4 次查询），JSON 回退
    //    （无快照路径已在上方 fail 或刷新，此处 dataMap 必非 null）
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

    // 2) --serve：后台起 serve，让 AI CLI 可通过 HTTP 拉取完整快照
    let serve = null;
    if (opts.serve) {
      serve = await startServeInBg(getSnapshotDir());
      if (!serve) console.error('⚠️  --serve 后台服务启动失败，继续无 serve 模式');
    }

    try {
      // 2.5) 多轮会话：读历史 → 折进 prompt；回答后 append
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
        if (sessionTurns.length > 0 && !opts.json) {
          console.error(`ℹ️  session ${sessionId} 续聊：已 ${sessionTurns.length} 轮历史`);
        }
      }

      // 3) 拼 prompt（"## 问题"节统一在此拼接，构建器不负责）
      const serveNote = serve
        ? `\n\n完整快照与对象级查询可通过 HTTP 访问:\n- http://127.0.0.1:${serve.port}/snapshot.json\n- http://127.0.0.1:${serve.port}/api/objects/<type>?where=k=v\n- http://127.0.0.1:${serve.port}/api/ask/context`
        : '';
      const questionPart = sessionId
        ? formatHistory({ sessionId, turns: sessionTurns, question, maxTurns: opts.sessionMaxTurns })
        : `## 问题\n${question}`;
      const fullPrompt = `${context}${serveNote}\n\n${questionPart}`;

      // 4) 解析降级链：CLI agent（按序）+ 已配置模型服务兜底；--agent api 直连
      const apiConfig = loadAskConfig();
      const apiAgent = apiConfig ? { name: 'api', kind: 'api' } : null;
      let chain;
      if (opts.agent === 'auto') {
        const cliAgents = listAvailableAgents();
        if (cliAgents.length === 0 && !apiAgent) {
          fail('未检测到可用的 AI CLI（codebuddy / opencode）。请安装其一，或配置模型服务: nice-aos ask config set --provider deepseek --api-key <key>');
        }
        chain = [...cliAgents, ...(apiAgent ? [apiAgent] : [])];
      } else if (opts.agent === 'api') {
        if (!apiAgent) {
          fail('未配置模型服务。请先执行: nice-aos ask config set --provider deepseek --api-key <key>（或设 NICE_AOS_API_KEY / NICE_AOS_BASE_URL / NICE_AOS_MODEL 环境变量）');
        }
        chain = [apiAgent];
      } else {
        chain = [resolveAgent(opts.agent), ...(apiAgent ? [apiAgent] : [])];
      }

      // 5) 依序调用：失败/超时自动降级到下一个（每级独立 timeout 预算）
      const timeoutMs = parseInt(opts.timeout, 10);
      let answer;
      let answeredBy;
      let streamed = false;
      let failedAgents = [];
      let lastErr = null;
      for (let i = 0; i < chain.length; i++) {
        const agent = chain[i];
        const isLast = i === chain.length - 1;
        try {
          if (agent.kind === 'api') {
            if (opts.stream) {
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
            // CLI agent（codebuddy / opencode）：目前是 execFileSync 同步阻塞，不支持 token-by-token
            // 若用户同时指定 --stream + CLI agent，给一次温和提示后走同步路径
            if (opts.stream && !opts.json) {
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
            console.error(`⚠️  ${agent.name} 调用失败（${err.message}），降级到 ${nextLabel}...`);
          }
        }
      }
      if (answer === undefined) {
        fail(`所有 agent 调用失败。最后错误: ${lastErr?.message ?? '未知'}`);
      }

      // 5.5) 多轮会话：把这一轮 append 到 session jsonl
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
          if (!opts.json) console.error(`⚠️  session 写入失败: ${err.message}`);
        }
      }

      // 6) 输出
      // 流式 + 非 JSON 模式：token 已在 invokeApiChatStream 的 onToken 中实时打到 stdout，
      // 此处不再重复 console.log（避免重复输出）
      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          agent: answeredBy,
          ...(answeredBy === 'api' && { model: apiConfig.model, provider: apiConfig.provider ?? 'custom' }),
          ...(failedAgents.length > 0 && { fallbackFrom: failedAgents }),
          contextSource,
          durationMs: Date.now() - started,
          streamed,
          ...(sessionId ? { session: { id: sessionId, turnCount: sessionTurnCount } } : {}),
          answer,
        }, null, 2));
      } else if (streamed) {
        // 流式已写到 stdout，stderr 补充降级/状态信息
        if (failedAgents.length > 0) {
          const target = answeredBy === 'api' ? `模型服务（${apiConfig.model}）` : answeredBy;
          console.error(`ℹ️  ${failedAgents.join(' → ')} 调用失败，已由 ${target} 流式回答`);
        }
        if (sessionId) {
          console.error(`ℹ️  session ${sessionId} 已 append（第 ${sessionTurnCount} 轮）`);
        }
      } else if (failedAgents.length > 0) {
        const target = answeredBy === 'api' ? `模型服务（${apiConfig.model}）` : answeredBy;
        console.error(`ℹ️  ${failedAgents.join(' → ')} 调用失败，已由 ${target} 回答`);
        console.log(answer);
        if (sessionId) console.error(`ℹ️  session ${sessionId} 已 append（第 ${sessionTurnCount} 轮）`);
      } else {
        console.log(answer);
        if (sessionId) console.error(`ℹ️  session ${sessionId} 已 append（第 ${sessionTurnCount} 轮）`);
      }
    } finally {
      if (serve?.child) {
        try { serve.child.kill(); } catch { /* ignore */ }
      }
    }
  });

// ---------- ask config：模型服务配置（密钥加密落盘） ----------

const configCmd = askCommand.command('config')
  .description('管理 ask 备选模型服务配置（OpenAI 兼容；apiKey AES-256-GCM 加密存储）');

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
      hint: '环境变量 NICE_AOS_API_KEY / NICE_AOS_BASE_URL / NICE_AOS_MODEL 优先于本配置',
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
  .description('清除已保存的模型服务配置')
  .action(() => {
    clearAskConfig();
    succeed({ ok: true, cleared: true });
  });

// 多轮会话：仅保留核心 --session <id> 读写；session 列表 / 清理走 askSession.js 模块 API，
// 不在 CLI 暴露（用户脚本可直接调用 `import { listSessions } from '.../askSession.js'`）。
