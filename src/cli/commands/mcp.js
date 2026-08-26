// nice-aos MCP server 子命令。
// 借鉴 code-graph-rag 的 mcp-server 实现（codebase_rag/mcp/server.py）：
//   - 单 Server + StdioServerTransport（Claude Code / Cursor 默认传输）
//   - 启动 fail-fast：快照缺失 / 解析失败时直接报错退出
//   - 工具通过 createToolRegistry() 注入（src/ontology/toolRegistry.js）
//   - 错误用返回值表达（tool 内部 try/catch 包装），handler 不抛
//   - console.error 写日志（**绝对不要 console.log** —— stdout 是 JSON-RPC 通道，污染会断协议）
//
// 用法：
//   nice-aos mcp                       # 读 <root>/.nice-aos/data/snapshot.json
//   nice-aos mcp --dir /path/to/data   # 自定义快照目录
//   nice-aos mcp --root /path/to/repo  # 自定义项目根（找 .nice-aos/data）
//
// Claude Code 集成：
//   claude mcp add nice-aos -- npx nice-aos mcp --root /abs/path/to/repo
//
// 实现细节：
//   - 用低层 Server + setRequestHandler 而非 McpServer.tool()，避免引入 zod 依赖
//     （McpServer.tool() 要求 zod schema；我们用 JSON Schema 由 handler 自己校验）
//   - inputSchema 用 JSON Schema 形态（与现有 ParamDef 一致，MCP 协议层接受）
//   - 工具调用结果用 {content: [{type: 'text', text: JSON.stringify(result)}]} 包装
//
// 阶段 1 范围：仅 stdio 传输。HTTP 传输留到阶段 3（涉及 bearer auth 复杂度，不阻塞阶段 1 价值）

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { setSnapshotDir, getSnapshotDirOverride } from '../../paths.js';
import { createToolRegistry } from '../../ontology/toolRegistry.js';

// 动态 import SDK（避免未安装时启动报错）
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

function resolveDirs(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const explicitDir = opts.dir || getSnapshotDirOverride() || process.env.NICE_AOS_SNAPSHOT_DIR;
  const dataDir = explicitDir ? path.resolve(explicitDir) : path.join(root, '.nice-aos', 'data');
  return { root, dataDir };
}

function loadSnapshot(snapPath) {
  if (!fs.existsSync(snapPath)) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  let text;
  try {
    text = fs.readFileSync(snapPath, 'utf-8');
  } catch (err) {
    return { ok: false, error: `READ_FAILED: ${err?.message ?? err}` };
  }
  let snap;
  try {
    snap = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `PARSE_FAILED: ${err?.message ?? err}` };
  }
  return { ok: true, snap };
}

export const mcpCommand = new Command('mcp')
  .description('启动 MCP server（stdio 传输）—— 把 nice-aos 7 个能力暴露为 MCP tools，供 Claude Code / Cursor / Continue 等 MCP 客户端直接调用')
  .option('--root <dir>', '项目根目录（默认当前目录，用于定位 .nice-aos/data）', process.cwd())
  .option('--dir <path>', '快照目录（含 snapshot.json；默认 <root>/.nice-aos/data；亦可用全局 --snapshot-dir 或环境变量 NICE_AOS_SNAPSHOT_DIR 覆盖）')
  .option('--name <name>', 'MCP server 显示名（默认 nice-aos）', 'nice-aos')
  .option('--version <version>', 'MCP server 版本（默认读 package.json）')
  .action(async (opts) => {
    const { root, dataDir } = resolveDirs(opts);
    const snapPath = path.join(dataDir, 'snapshot.json');
    setSnapshotDir(dataDir);

    // 启动日志走 stderr（MCP 协议只用 stdout，污染会断协议）
    process.stderr.write(`[nice-aos mcp] 启动中...\n`);
    process.stderr.write(`[nice-aos mcp]   root = ${root}\n`);
    process.stderr.write(`[nice-aos mcp]   data = ${dataDir}\n`);
    process.stderr.write(`[nice-aos mcp]   snap = ${snapPath}\n`);

    // 加载快照（fail-fast）
    const loaded = loadSnapshot(snapPath);
    if (!loaded.ok) {
      if (loaded.error === 'NOT_FOUND') {
        process.stderr.write(`\n[错误] 快照未找到: ${snapPath}\n`);
        process.stderr.write(`[提示] 请先执行: nice-aos action refreshRepo --params '{"repoPath":"<项目根>"}'\n`);
        process.stderr.write(`[提示] 或将 snapshot.json 放到 ${dataDir}/snapshot.json\n\n`);
        process.exit(1);
      }
      process.stderr.write(`\n[错误] 快照加载失败: ${loaded.error}\n\n`);
      process.exit(1);
    }
    const snap = loaded.snap;

    // 加载 MCP SDK
    const { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema } = await loadMcpSdk();

    // 构造工具注册表
    const registry = createToolRegistry({ snap });
    const toolList = registry.list();

    // 构造低层 server（避开 McpServer.tool() 强制 zod 的限制）
    const version = opts.version || (await readPkgVersion());
    const server = new Server(
      { name: opts.name, version },
      { capabilities: { tools: {} } },
    );

    // list_tools handler
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolList.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }));

    // call_tool handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params || {};
      if (!name) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '缺少 name 参数' }) }],
          isError: true,
        };
      }
      const result = await registry.call(name, args || {});
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: !result.ok,
      };
    });

    // 启动 transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    process.stderr.write(`[nice-aos mcp] 就绪：${toolList.length} 个工具已注册 (${registry._meta.names.join(', ')})\n`);
    process.stderr.write(`[nice-aos mcp] 监听 stdin，等待 MCP 客户端连接（Ctrl+C 退出）\n`);

    // 优雅关闭：SIGTERM / SIGINT
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
