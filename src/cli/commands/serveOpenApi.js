// serve 的 /openapi.json 生成器（srv-3，v0.34.0）
//
// 设计：ENDPOINTS 是端点清单的单一事实源——/api/status 的 endpoints 数组与
// OpenAPI paths 都由它派生，新增端点只需在此登记 + 在 serve.js 加路由。
// 零依赖生成 OpenAPI 3.0.3 spec；where/limit 等查询参数文档化，供 agent 自动发现能力。

import { OBJECT_TYPES } from '../../ontology/blueprint.js';

/**
 * 端点登记表。
 * method: HTTP 方法；path: 路由模板；role: minRoleFor 表同步；summary/description 中文描述
 */
export const ENDPOINTS = [
  { method: 'GET', path: '/', public: true, summary: '数据源信息页', description: '快照/蓝图就绪状态一览与端点导航。' },
  { method: 'GET', path: '/snapshot.json', public: true, summary: '本体快照 JSON', description: '完整本体快照（供 AI agent 拉取）。' },
  { method: 'GET', path: '/blueprint.html', public: true, summary: '蓝图页面', description: '`output --format html` 生成的自包含交互蓝图。' },
  { method: 'GET', path: '/openapi.json', public: true, role: 'read', summary: '本描述文档', description: 'OpenAPI 3.0 端点描述。' },
  {
    method: 'GET', path: '/api/status', role: 'read',
    summary: '服务状态与端点清单',
    description: '快照/蓝图就绪状态、鉴权与 WebSocket 配置、全部端点列表。',
    responses: { fields: ['ok', 'root', 'snapshotDir', 'snapshot.ready', 'blueprint.ready', 'endpoints', 'auth', 'ws'] },
  },
  {
    method: 'GET', path: '/api/stats', role: 'read',
    summary: '快照对象统计摘要',
    description: '项目画像、objectCounts、循环依赖与孤儿候选。',
    responses: { fields: ['ok', 'name', 'framework', 'generatedAt', 'counts', 'cycles', 'orphanCandidates'] },
  },
  {
    method: 'GET', path: '/api/schema', role: 'read',
    summary: '本体元模型',
    description: '对象类型 / 链接类型 / 动作清单 / 前缀映射（agent 能力发现入口）。',
  },
  {
    method: 'GET', path: '/api/objects/{type}', role: 'read',
    summary: '对象级查询',
    description: `按对象类型取数（SQLite 优先毫秒级，回退 JSON）；where 过滤语义与 CLI query 一致。可用 type: ${OBJECT_TYPES.map((t) => t.type).join(', ')}`,
    params: [
      { name: 'type', in: 'path', required: true, schema: { type: 'string' }, description: '对象类型名' },
      { name: 'where', in: 'query', schema: { type: 'string' }, description: '过滤条件 k=v,k2~v2（~ 为子串包含，忽略大小写）' },
      { name: 'limit', in: 'query', schema: { type: 'integer', default: 200 }, description: '返回条数上限（0 = 不限）' },
    ],
  },
  {
    method: 'GET', path: '/api/ask/context', role: 'read',
    summary: 'ask 上下文构建',
    description: '按问题关键词构建精简上下文（SQLite 4 次预过滤 <50ms，回退 JSON）。',
    params: [{ name: 'q', in: 'query', schema: { type: 'string' }, description: '问题文本（可省略，省略时为全量画像上下文）' }],
  },
  {
    method: 'GET', path: '/api/rate-limit', role: 'read',
    summary: '限流器观测',
    description: '--rate-limit 启用时的滑动窗口统计（未启用返回 enabled:false）。',
  },
  {
    method: 'POST', path: '/api/ask', role: 'write',
    summary: '直连模型问答',
    description: 'serve 内部调用已配置的 OpenAI 兼容模型服务回答问题（不依赖本地 AI CLI）。未配置模型服务返回 503 与配置指引。',
    requestBody: {
      required: ['question'],
      optional: ['session', 'save', 'toolCall'],
      example: { question: '这个项目有哪些功能域？', save: false },
      note: 'session 传入 id 开启多轮；save=true 时回答同时落盘到 answers/ 目录；toolCall=true 启用自治工具循环（≤5 步）',
    },
  },
  {
    method: 'POST', path: '/action', role: 'write',
    summary: '执行蓝图动作',
    description: '蓝图 UI 动作卡片提交端点（E-3，v0.35.0）。动作与 CLI `nice-aos action <name>` 同语义：markReviewed/addNote 写快照 + SQLite overlay 双写；refreshRepo 重扫并落盘到本服务数据源目录；analyzeFile 单文件只读分析。未知动作或缺参返回 400。',
    requestBody: {
      required: ['actionName', 'params'],
      optional: [],
      example: { actionName: 'analyzeFile', params: { file: 'src/index.ts' } },
      note: '可用动作名见 GET /api/schema 的 actionNames；refreshRepo 参数 {repoPath}，analyzeFile 参数 {file}，markReviewed 参数 {objectId}，addNote 参数 {objectId, note}',
    },
  },
  {
    method: 'WS', path: '/ws/snapshot', role: 'read',
    summary: '快照/蓝图变更推送',
    description: 'WebSocket：snapshot.json / blueprint.html mtime 轮询广播 {type:"snapshot:changed"|"blueprint:changed", ts, mtime, size}。需 token 时同 Bearer（?token= 可用于浏览器构造）。',
  },
];

// ---------- 版本号：包内 package.json 单次缓存 ----------

import { createRequire } from 'node:module';
const requirePkg = createRequire(import.meta.url);
let cachedVersion = null;
function serviceVersion() {
  if (cachedVersion == null) {
    try { cachedVersion = requirePkg('../../package.json')?.version ?? '0.0.0'; }
    catch { cachedVersion = '0.0.0'; }
  }
  return cachedVersion;
}

/**
 * 构建 OpenAPI 3.0.3 spec
 * @param {{ version?: string, host?: string, authEnabled?: boolean }} opts
 */
export function buildOpenApiSpec({ version = serviceVersion(), host = null, authEnabled = false } = {}) {
  const paths = {};
  for (const ep of ENDPOINTS) {
    if (ep.method === 'WS') continue; // WS 非 REST 操作，单独在 status/ws 字段说明
    const key = ep.path.replace(/{([^}]+)}/g, '{$1}');
    paths[key] ??= {};
    const paramNodes = (ep.params ?? [])
      .filter((p) => p.in === 'query')
      .map((p) => ({
        name: p.name, in: 'query', required: !!p.required,
        description: p.description,
        schema: p.schema ?? { type: 'string' },
      }));
    if (ep.path.includes('{type}')) {
      const p = ep.params.find((x) => x.in === 'path');
      if (p) paramNodes.push({ name: p.name, in: 'path', required: true, schema: { type: 'string' }, description: p.description });
    }
    paths[key][ep.method.toLowerCase()] = {
      summary: ep.summary,
      description: `${ep.description}${ep.public ? '' : `\n\n**鉴权**: 需要 ${ep.role ?? 'read'} 角色 token${authEnabled ? '' : '（当前服务未启用鉴权）'}。`}`,
      parameters: paramNodes.length ? paramNodes : undefined,
      ...(ep.method === 'POST' && ep.requestBody ? {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ep.requestBody.required,
                properties: Object.fromEntries((ep.requestBody.required ?? []).concat(ep.requestBody.optional ?? []).map((f) => [f, {}])),
              },
              example: ep.requestBody.example,
            },
          },
        },
      } : {}),
      responses: {
        200: { description: '成功（JSON）' },
        ...(ep.role === 'write' || !ep.public ? {
          401: { description: '缺少或无效 token' },
          403: { description: 'token 权限不足' },
        } : {}),
        ...(!ep.public && ep.method !== 'POST' ? {} : {}),
        ...(ep.requestBody ? { 400: { description: '请求体不合法' } } : {}),
        ...(ep.path === '/api/ask' ? { 503: { description: '未配置模型服务（ask config set 或环境变量）' } } : {}),
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'nice-aos serve 数据源 API',
      version,
      description: 'nice-aos 本体快照数据源：快照拉取 / 对象查询 / ask 上下文与直连问答 / 变更推送。本地知识源，供 AI agent 与蓝图页消费。',
    },
    servers: host ? [{ url: host }] : undefined,
    components: {
      securitySchemes: authEnabled
        ? { bearerAuth: { type: 'http', scheme: 'bearer' } }
        : undefined,
    },
    security: authEnabled ? [{ bearerAuth: [] }] : [],
    tags: [
      { name: 'static', description: '静态资源（豁免鉴权）' },
      { name: 'query', description: '只读查询（read 角色）' },
      { name: 'inference', description: '推理能力（write 角色）' },
    ],
    paths,
  };
}
