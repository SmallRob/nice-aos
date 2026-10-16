// nice-aos MCP server 子命令（v0.52.0）：
// 借鉴 code-graph-rag 的 mcp-server 实现（codebase_rag/mcp/server.py）：
//   - 单 Server + StdioServerTransport（Claude Code / Cursor 默认传输）
//   - 通过 createToolRegistry() 注入 7 个工具
//   - 错误用返回值表达（tool 内部 try/catch 包装），handler 不抛
//   - console.error 写日志（**绝对不要 console.log** —— stdout 是 JSON-RPC 通道，污染会断协议）
//
// v0.52.0 增强（在远端 v0.46 实现基础上）：
//   - 改成 withSnapshot 透明加载（v0.48.0）：快照缺失自动 build 不退出
//   - 抽取 createMcpHandlers(snap) 工厂函数（v0.52.0）：handler 逻辑可单测
//   - 不再依赖 SDK 静态属性；SDK 动态 import 失败时清晰报错（fail-fast）
//
// 用法：
//   nice-aos mcp                       # 读默认 snapshot dir；缺失自动 build
//   nice-aos mcp --dir /path/to/data   # 自定义快照目录
//   nice-aos mcp --root /path/to/repo  # 自定义项目根（找 .nice-aos/data）；缺失时在 root 上 build

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { setSnapshotDir } from '../../paths.js';
import { createToolRegistry } from '../../ontology/toolRegistry.js';
import { withSnapshot } from '../../ontology/withSnapshot.js'; // v0.48.0 透明加载
import { resolveSnapshotDirs } from '../shared.js';

/**
 * v0.52.0 抽取：构造 MCP listTools / callTool handler。
 * 纯函数，零副作用，便于单测覆盖。
 *
 * @param {Object} snap 已构建的本体快照
 * @returns {{ listTools: Function, callTool: Function }}
 */
export function createMcpHandlers(snap) {
  const registry = createToolRegistry({ snap });

  /** MCP `tools/list` 请求处理器 */
  function listTools() {
    return {
      tools: registry.list().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  }

  /**
   * MCP `tools/call` 请求处理器。
   * @param {{params?: {name?: string, arguments?: Object}}} request
   * @returns {{content: Array, isError: boolean}}
   */
  async function callTool(request) {
    const { name, arguments: args } = request.params ?? {};
    if (!name) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: false, error: '缺少 name 参数' }),
        }],
        isError: true,
      };
    }
    const result = await registry.call(name, args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: result?.ok === false,
    };
  }

  return { listTools, callTool };
}

/**
 * v0.52.0 抽取：协议常量集中导出（test 单测可见）。
 * 当前 MCP 协议版本与 SDK 期望一致：2024-11-05。
 */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'nice-aos';

/**
 * 动态加载 @modelcontextprotocol/sdk（避免静态依赖未安装时启动报错）。
 * 抛 Error 时附"如何安装"提示，方便用户立刻知道修复路径。
 */
async function loadMcpSdk() {
  try {
    const serverMod = await import('@modelcontextprotocol/sdk/server/index.js');
    const stdioMod = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const typesMod = await import('@modelcontextprotocol/sdk/types.js');
    return {
      Server: serverMod.Server,
      StdioServerTransport: stdioMod.StdioServerTransport,
      ListToolsRequestSchema: typesMod.ListToolsRequestSchema,
      CallToolRequestSchema: typesMod.CallToolRequestSchema,
    };
  } catch (err) {
    throw new Error(
      '未找到 @modelcontextprotocol/sdk。请先安装依赖：npm install\n' +
      `原始错误: ${err?.message ?? err}`,
    );
  }
}

export const mcpCommand = new Command('mcp')
  .description('启动 MCP server（stdio 传输）—— 把 nice-aos 7 个能力暴露为 MCP tools，供 Claude Code / Cursor / Continue 等 MCP 客户端直接调用。v0.52.0 起快照缺失自动 build。')
  .option('--root <dir>', '项目根目录（默认当前目录，用于定位 .nice-aos/data；缺失时在此构建）', process.cwd())
  .option('--dir <path>', '快照目录（含 snapshot.json；默认 <root>/.nice-aos/data；亦可用全局 --snapshot-dir 或环境变量 NICE_AOS_SNAPSHOT_DIR 覆盖）')
  .option('--name <name>', 'MCP server 显示名（默认 nice-aos）', MCP_SERVER_NAME)
  .option('--version <version>', 'MCP server 版本（默认读 package.json）')
  .action(async (opts) => {
    const { root, dataDir } = resolveSnapshotDirs(opts);
    setSnapshotDir(dataDir);
    process.stderr.write(`[nice-aos mcp] 启动中...\n`);
    process.stderr.write(`[nice-aos mcp]   root = ${root}\n`);
    process.stderr.write(`[nice-aos mcp]   data = ${dataDir}\n`);

    // v0.48.0 withSnapshot：缺失自动 build；不再 fail-fast
    let snap;
    let rebuilt = false;
    try {
      const result = await withSnapshot(root, (s) => s, {
        silent: true,
        onRebuild: () => { rebuilt = true; },
      });
      snap = result.value;
    } catch (err) {
      process.stderr.write(`\n[错误] 快照加载/构建失败: ${err?.message ?? err}\n\n`);
      process.exit(1);
    }

    if (rebuilt) {
      process.stderr.write(`[nice-aos mcp] 快照缺失，已自动 build（v0.48.0 透明加载）\n`);
    }

    // 加载 MCP SDK
    let SDK;
    try {
      SDK = await loadMcpSdk();
    } catch (err) {
      process.stderr.write(`\n[错误] ${err.message}\n\n`);
      process.exit(1);
    }

    // 构造低层 server（避开 McpServer.tool() 强制 zod 限制）
    const version = opts.version || (await readPkgVersion());
    const server = new SDK.Server(
      { name: opts.name, version },
      { capabilities: { tools: {} } },
    );

    // v0.52.0：handler 来自 createMcpHandlers（可测）
    const handlers = createMcpHandlers(snap);
    server.setRequestHandler(SDK.ListToolsRequestSchema, async () => handlers.listTools());
    server.setRequestHandler(SDK.CallToolRequestSchema, async (request) => handlers.callTool(request));

    // 启动 transport
    const transport = new SDK.StdioServerTransport();
    await server.connect(transport);

    process.stderr.write(`[nice-aos mcp] 就绪：${handlers && 'listTools' in handlers ? '7' : '?'} 个工具已注册（${['get_stats','get_schema','list_types','query_objects','get_node','traverse_links','get_health'].join(', ')}）\n`);
    process.stderr.write(`[nice-aos mcp] 监听 stdin，等待 MCP 客户端连接（Ctrl+C 退出）\n`);

    // 优雅关闭
    const shutdown = async (sig) => {
      process.stderr.write(`\n[nice-aos mcp] 收到 ${sig}，关闭中...\n`);
      try {
        await server.close();
        await transport.close();
      } catch (err) {
        process.stderr.write(`[nice-aos mcp] 关闭时异常: ${err?.message ?? err}\n`);
      }
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  });

async function readPkgVersion() {
  try {
    const pkgPath = new URL('../../../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
