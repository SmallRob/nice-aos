// mcp handlers 单元测试（v0.52.0）：
//   - createMcpHandlers(snap) 返回 {listTools, callTool}
//   - listTools 返回 7 个 tool，含 name/description/inputSchema
//   - callTool 缺 name → isError=true
//   - callTool 未知 tool → isError=true（toolRegistry.call 走错误信路径）
//   - callTool 合法 get_stats → isError=false（OK 路径）

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMcpHandlers,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
} from '../src/cli/commands/mcp.js';

const FIXTURE = {
  _meta: {
    generatedAt: '2026-10-16T00:00:00.000Z',
    objectCounts: { SourceFile: 1, Component: 1 },
    cycles: [],
    orphanCandidates: [],
  },
  Project: [{ id: 'proj:test', name: 'mcp-unit', framework: 'react', branch: 'main' }],
  SourceFile: [{ id: 'file:a.ts', name: 'a.ts', language: 'ts' }],
  Component: [{ id: 'comp:Button', name: 'Button', filePath: 'a.ts' }],
};

test('createMcpHandlers 返回 {listTools, callTool} 双函数', () => {
  const handlers = createMcpHandlers(FIXTURE);
  assert.equal(typeof handlers.listTools, 'function');
  assert.equal(typeof handlers.callTool, 'function');
});

test('listTools 返回工具列表（含 7 个 tool，每个含 name/description/inputSchema）', () => {
  const handlers = createMcpHandlers(FIXTURE);
  const result = handlers.listTools();
  assert.ok(Array.isArray(result.tools));
  assert.equal(result.tools.length, 7, '7 个工具（v0.33.0 精简后）');
  for (const t of result.tools) {
    assert.equal(typeof t.name, 'string');
    assert.match(t.description, /\S/, 'description 非空');
    assert.ok(t.inputSchema && typeof t.inputSchema === 'object', 'inputSchema 是对象');
  }
  const names = result.tools.map((t) => t.name);
  for (const expected of ['get_stats', 'get_schema', 'list_types', 'query_objects', 'get_node', 'traverse_links', 'get_health']) {
    assert.ok(names.includes(expected), `${expected} 应在工具列表`);
  }
});

test('callTool 缺 name 参数 → isError=true + content 含错误文本', async () => {
  const handlers = createMcpHandlers(FIXTURE);
  const r = await handlers.callTool({ params: {} });
  assert.equal(r.isError, true);
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, 'text');
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /缺少 name/);
});

test('callTool 缺 params → 与缺 name 同效', async () => {
  const handlers = createMcpHandlers(FIXTURE);
  const r = await handlers.callTool({});
  assert.equal(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert.match(parsed.error, /缺少 name/);
});

test('callTool 合法 tool（get_stats）→ isError=false', async () => {
  const handlers = createMcpHandlers(FIXTURE);
  const r = await handlers.callTool({ params: { name: 'get_stats', arguments: {} } });
  assert.equal(r.isError, false);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.name, 'mcp-unit');
});

test('callTool 未知 tool → isError=true（toolRegistry.call 兜底）', async () => {
  const handlers = createMcpHandlers(FIXTURE);
  const r = await handlers.callTool({ params: { name: 'fake_tool', arguments: {} } });
  assert.equal(r.isError, true);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /未知工具/);
});

test('callTool 缺 arguments 时按 {} 处理（不报错）', async () => {
  const handlers = createMcpHandlers(FIXTURE);
  // list_types 是无参 tool，给 name 不给 arguments 也应通过
  const r = await handlers.callTool({ params: { name: 'list_types' } });
  assert.equal(r.isError, false);
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.ok, true);
});

test('MCP 常量导出（test 引用稳定）', () => {
  assert.equal(typeof MCP_PROTOCOL_VERSION, 'string');
  assert.match(MCP_PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式');
  assert.equal(MCP_SERVER_NAME, 'nice-aos');
});
