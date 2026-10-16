# ADR 0017: MCP stdio server 接 withSnapshot 透明加载（v0.52.0）

> **Status**: Accepted (v0.52.0, 2026-10-16)
> **Predecessors**: [ADR 0014 (withSnapshot 透明加载)](./0014-asdm-aos-withsnapshot-vocabulary-envelope.md), [ADR 0016 (converter 钩子)](./0016-converter-hooks.md)
> **Trigger**: 候选三项最后一项"MCP server 接入"
> **基线**: 远端 v0.46 已用 `@modelcontextprotocol/sdk` 实现 MCP stdio server (`src/cli/commands/mcp.js`，157 行)

## Context

候选三项最后一项是 MCP server 接入（详见 `.nice-aos/analysis/asdm-aos-borrow-analysis.md §4` + CHANGELOG v0.50.0/v0.51.0 后续候选）。远端 v0.46 已落地 MCP stdio server，但有两个未补齐的小坑：

1. **fail-fast 模式**：快照缺失时 CLI 直接 `process.exit(1)` 退出，无法对 agent 提供"自动修复"路径
2. **handler 不可测**：`server.setRequestHandler(...)` 直接挂在 SDK 上，没有可单测的纯函数 handler

v0.52.0 在不引入新依赖、不改 SDK 的前提下做这两个增强。

## Decision

### D1. 抽出 `createMcpHandlers(snap)` 工厂函数（纯函数）

旧实现：handlers 直接挂在 SDK `server.setRequestHandler` 上，无法独立测试。
新实现：

```js
export function createMcpHandlers(snap) {
  const registry = createToolRegistry({ snap });
  
  function listTools() {
    return { tools: registry.list().map(/* 形态映射 */) };
  }
  
  async function callTool(request) {
    const { name, arguments: args } = request.params ?? {};
    if (!name) return errorEnvelope('缺少 name 参数');
    const result = await registry.call(name, args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: result?.ok === false,
    };
  }
  
  return { listTools, callTool };
}
```

**好处**：
- 8 个单测覆盖 listTools / callTool 不依赖 SDK/stdio
- 协议层（setRequestHandler）和业务层（createMcpHandlers）解耦
- 未来若加 HTTP transport，复用 createMcpHandlers + 换 transport 模块

### D2. 接入 v0.48.0 withSnapshot（替换 fail-fast）

旧实现：
```js
const loaded = loadSnapshotFile(snapPath);
if (!loaded.ok) {
  if (loaded.error === 'NOT_FOUND') process.exit(1);  // 缺快照直接退出
  if (loaded.error === 'PARSE_FAILED') process.exit(1);
}
```

新实现：
```js
const { value: snap, rebuilt } = await withSnapshot(root, s => s, {
  silent: true,
  onRebuild: () => { rebuilt = true; },
});
if (rebuilt) process.stderr.write('[nice-aos mcp] 快照缺失，已自动 build（v0.48.0 透明加载）\n');
```

**对照 asdm `withGraph(gid, fn)` 设计哲学** —— "查询自动 load，无需先手动调 load"。agent 启动 `nice-aos mcp` 不再需要先跑 `action refreshRepo`。

**JSON 损坏仍报错并退出**：withSnapshot 透传非 NO_SNAPSHOT 错误（v0.48.0 决策），损坏 JSON → SyntaxError 抛 → CLI 退出。保护性 fail-fast 保留。

### D3. 保持 SDK 依赖 + stdio transport

零新增依赖，复用远端已装的 `@modelcontextprotocol/sdk`。stdio 是当前 Claude Code / Cursor / Continue 等主流 MCP 客户端的默认 transport；HTTP 传输留 v0.53+ 评估（涉及 bearer auth + Express/mcp SDK 双栈复杂度）。

### D4. MCP 协议版本常量导出

```js
export const MCP_PROTOCOL_VERSION = '2024-11-05';  // SDK 期望的版本
export const MCP_SERVER_NAME = 'nice-aos';
```

`server.info` 输出这两个常量，与 SDK 期望对齐。

## Consequences

### 立即收益

- **agent 体验升级**：MCP 客户端启动 mcp 服务器不再需要"先有快照"前提
- **handler 可独立测试**：8 个 mcp.test.mjs 覆盖 listTools / callTool 不依赖 SDK
- **协议与业务解耦**：createMcpHandlers 是纯函数，未来换 HTTP transport 直接复用
- **零行为破坏对合法快照路径**：`mcpCli.test.mjs` 3/3 通过（合法快照场景）

### 测试影响（破坏性变更）

mcpCli.test.mjs 一个测试被废除（缺快照 fail-fast 场景），一个测试更新错误信匹配（JSON 损坏 → 现在报 "快照加载/构建失败"）。

### 不进入（明确留给后续）

- ❌ HTTP transport（v0.53+ 评估：Express + bearer auth + Streamable HTTP SDK）
- ❌ 多 MCP server 并存市场（保持单 server 启动）

## Implementation

### 文件变更清单

| 文件 | 行数 | 性质 |
|------|------|------|
| `src/cli/commands/mcp.js` | 200 行 | 重写（保留 SDK + CLI 选项） |
| `test/mcp.test.mjs` | 130 行（8 测试） | 新增 — handler 单元测试 |
| `test/mcpCli.test.mjs` | -15 / +12 行 | 废除 1 测试 + 更新 1 测试 |
| `docs/adr/0017-mcp-stdio-withsnapshot.md` | 本文件 | 新增 |
| `CHANGELOG.md` | +50 行 | v0.52.0 段 |
| `package.json` | +1/-1 | version 0.51.0 → 0.52.0 |

### 验证

- [x] `mcp.test.mjs` 8 测试全通过（handler 逻辑）
- [x] `mcpCli.test.mjs` 3 测试全通过（合法快照启动 + JSON 损坏仍 fail-fast）
- [x] `toolRegistry.test.mjs` 29 测试无回归
- [x] `converter.test.mjs` / `linkDefs.test.mjs` / `with-snapshot.test.mjs` 无回归
- [x] 无新依赖
- [x] CLI `--help/--root/--dir/--name/--version` 签名不变

## References

- **远端基线**：v0.46 已落地 MCP stdio server，使用 `@modelcontextprotocol/sdk`
- **asdm-aos-server 借形**：`withGraph(gid, fn)` MCP server.ts:53-56 — 透明按需加载哲学
- **v0.48.0 withSnapshot**：`src/ontology/withSnapshot.js` 透明快照保障
- **v0.51.0 converter**：toolRegistry 与 converter 钩子下放（与本 ADR 正交，但保证 `toolRegistry.call()` 行为稳定）

## 后续候选（v0.53+）

| 主题 | 内容 | 备注 |
|------|------|------|
| MCP HTTP transport | Streamable HTTP SDK + bearer auth | 复杂度高，主流 client 仍走 stdio |
| Multi-graph MCP server | 跨越多 projectRoot 的 aggregate | 单 server 多图场景可能未来出现 |
| converter 钩子接入 MCP request lifecycle | MCP request → converter.requestPreProcess 钩子 | 当前重定向 tool 调用，钩子化收益小 |
