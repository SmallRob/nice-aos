import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Command } from 'commander';
import { fail, parseWhere, matchesWhere } from '../shared.js';
import { checkAuth, parseTokens, authorizeRole, minRoleFor, ROLES } from './serveAuth.js';
import { createRateLimiter, clientKeyOf } from './rateLimiter.js';
import { buildOpenApiSpec, ENDPOINTS } from './serveOpenApi.js';
// srv-5 /api/ask 直连模型 + x-3 运行时广播（v0.34.0）
import { loadAskConfig } from './askConfig.js';
import { invokeApiChat } from './openaiCompat.js';
import { isValidSessionId, loadSession, appendTurn } from './askSession.js';
import { resolveSavePath, formatAskArchive, writeAskArchive } from './askSave.js';
import { writeServeRuntime, cleanupServeRuntime } from './notifyServe.js';
import { getSnapshotDirOverride, setSnapshotDir } from '../../paths.js';
import { loadType, buildAskContextFromSql } from '../../storage/index.js';
import { buildAskContext } from './askContext.js';
import { OBJECT_TYPES, LINK_TYPES, ACTION_NAMES, ONTOLOGY_META, createBlueprint } from '../../ontology/blueprint.js';
import { applyOverlay, saveSnapshot as sqlSaveSnapshot } from '../../storage/index.js'; // E-3 /action overlay 双写
import { parseObjectId } from '../../storage/objectId.js';
import {
  buildHandshakeResponse,
  parseFrame,
  buildTextFrame,
  buildPongFrame,
  buildCloseFrame,
  attachWebSocketUpgrade,
} from './serveWebSocket.js';

// serve —— 在本地启动数据源 HTTP 服务。
// 作用：暴露本体快照 snapshot.json 与 blueprint.html，并带 CORS，
//       方便 AI agent（油猴脚本 / 网页 / curl）跨源拉取快照作为知识数据源。
// 默认 root = 当前项目目录，自动到 <root>/.nice-aos/data 找 snapshot.json，<root>/blueprint.html 找蓝图。
//
// 鉴权（v0.34.0，参考 0002-code-review-report.md P0 安全债 + code-graph-rag 范式 6 "MCP server bearer"）：
//   - --token <secret> 启用 Bearer 鉴权；不传则鉴权关闭（向后兼容现有调用）
//   - /api/* 端点受保护：缺少/错误 Authorization header 返回 401 + JSON 提示
//   - 静态端点（/snapshot.json / /blueprint.html / /）豁免：只读 + 信息页
//   - 支持 Authorization: Bearer <token> 标准头 + ?token=<secret> query 参数（curl/油猴脚本方便）
//   - token 比较走 crypto.timingSafeEqual 防 timing attack
//   - 环境变量 NICE_AOS_SERVE_TOKEN 覆盖 --token（CI 场景）

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

/** 读取请求体（上限 1MB；超限抛错） */
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体超过 1MB 上限')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const isLoopbackAddr = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

// 鉴权实现已抽到 ./serveAuth.js（v0.33.0+ 拆分）。
// checkAuth / timingSafeEqualStr 单独可单测；serve.js 不再含 security-sensitive 代码。

function resolveDirs(opts) {
  const root = path.resolve(opts.root || process.cwd());
  // 数据源目录解析链：显式 --dir → 全局 --snapshot-dir（preAction 钩子经 setSnapshotDir 写入的覆盖值）
  //   → 环境变量 NICE_AOS_SNAPSHOT_DIR → <root>/.nice-aos/data
  // 注：不在 serve 上重复定义 --snapshot-dir 选项——Commander 中与全局选项重名的子命令选项会被父命令吞掉，子命令 action 拿不到值
  const explicitDir = opts.dir || getSnapshotDirOverride() || process.env.NICE_AOS_SNAPSHOT_DIR;
  const dataDir = explicitDir ? path.resolve(explicitDir) : path.join(root, '.nice-aos', 'data');
  return { root, dataDir };
}

function respond(res, status, body, headers = {}) {
  const isHtml = typeof body === 'string' && headers['Content-Type']?.includes('html');
  const contentType = headers['Content-Type'] ?? (isHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8');
  res.writeHead(status, { ...corsHeaders(), 'Content-Type': contentType, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return undefined; } // 存在但解析失败，区分处理
}

// 就绪状态每次请求实时探测：支持"先起服务、后 refreshRepo / export"的工作流（文件随后生成时端点自动变为可用）
function probeSnapshot(snapPath) {
  const snap = readJson(snapPath);
  if (snap === null) return { state: 'none', snap: null };
  if (snap === undefined) return { state: 'gone', snap: null };
  return { state: 'ok', snap };
}

function buildIndexHtml({ root, dataDir, docsDir, snapReady, bpReady, docsReady }) {
  const row = (label, ok, extra) =>
    `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${label}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;color:${ok ? '#15803d' : '#b91c1c'}">${ok ? '就绪' : '缺失'}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;color:#64748b;font-size:12px">${extra || ''}</td></tr>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>AOS serve</title>
<style>body{font:14px/1.6 system-ui;max-width:760px;margin:40px auto;color:#0f172a;padding:0 16px}code{background:#f1f5f9;padding:2px 6px;border-radius:5px;font-size:12px}a{color:#4f46e5;text-decoration:none}</style>
</head><body>
<h1>AOS 数据源服务 <span style="font-size:13px;color:#64748b">nice-aos serve</span></h1>
<p style="color:#475569">为 AI agent / 蓝图页提供本体快照数据。</p>
<table style="border-collapse:collapse;min-width:100%">
<tr style="background:#f8fafc"><th style="text-align:left;padding:6px 12px">项目</th><th style="text-align:left;padding:6px 12px">状态</th><th style="text-align:left;padding:6px 12px">说明</th></tr>
${row('项目根目录', true, root)}
${row('快照目录', snapReady !== 'none', dataDir)}
${row('快照 snapshot.json', snapReady === 'ok', `<a href="/snapshot.json">/snapshot.json</a>`)}
${row('蓝图 blueprint.html', bpReady, bpReady ? '<a href="/blueprint.html">/blueprint.html</a>' : '' )}
${row('项目文档（output docs）', docsReady, docsReady ? '<a href="/docs">/docs</a> · <a href="/context/index.md">/context/index.md</a>' : `<code>nice-aos output docs</code> 生成（${docsDir}）`)}
${row('本体元模型', true, `<a href="/api/schema">/api/schema</a> — ${OBJECT_TYPES.length} 对象 / ${LINK_TYPES.length} 链接`)}
</table>
<h3 style="margin-top:28px">可用端点</h3>
<ul style="line-height:2">
<li><code>GET /snapshot.json</code> — 本体快照 JSON（供 AI agent 拉取）</li>
<li><code>GET /blueprint.html</code> — ${bpReady ? '蓝图页面' : '（未生成）'}</li>
<li><code>GET /docs</code> — ${docsReady ? '项目文档浏览页' : '（未生成，先 output docs）'}；<code>GET /context/&lt;path&gt;</code> — 文档 md/json 静态资源</li>
<li><code>GET /api/status</code> — 服务状态与端点清单</li>
<li><code>GET /api/stats</code> — 快照对象统计摘要</li>
<li><code>GET /api/schema</code> — 本体元模型（对象/链接/动作 schema,借鉴 asdm-aos）</li>
<li><code>GET /api/objects/:type</code> — 对象级查询（?where=k=v,k2~v2&amp;limit=200；SQLite 优先，回退 JSON）</li>
<li><code>GET /api/ask/context</code> — ask 上下文（?q=问题；4 次 SQL 预过滤，回退 JSON）</li>
<li><code>GET /</code> — 本页</li>
</ul>
<p style="color:#64748b;font-size:12px;margin-top:24px">提示：若快照缺失请先执行 <code>nice-aos action refreshRepo</code>；蓝图为 <code>nice-aos export --format html</code>；文档为 <code>nice-aos output docs</code>。</p>
</body></html>`;
}

export const serveCommand = new Command('serve')
  .description('在本地启动数据源 HTTP 服务：暴露本体快照 snapshot.json 与 blueprint.html，便于 AI agent 等跨源拉取')
  .option('--root <dir>', '项目根目录（默认当前目录，用于定位 blueprint.html 与 .nice-aos/data）', process.cwd())
  .option('--dir <path>', '数据源目录（含 snapshot.json；默认 <root>/.nice-aos/data；等价于全局 --snapshot-dir，亦可用 NICE_AOS_SNAPSHOT_DIR 覆盖）')
  .option('--docs-dir <path>', '文档目录（output docs 产物所在目录；默认 <root>/.nice-aos/context）')
  .option('--host <host>', '监听地址（默认 127.0.0.1，仅本机可访问）', '127.0.0.1')
  .option('--port <n>', '监听端口（默认 8420；传 0 自动分配可用端口）', '8420')
  .option('--token <secrets...>', '启用 Bearer 鉴权，可多值实现角色分级：--token admin-secret 等价 admin；--token ro-secret:read --token rw-secret:write（read<write<admin）。静态端点豁免。env: NICE_AOS_SERVE_TOKENS="s1,s2:read"（优先）或 NICE_AOS_SERVE_TOKEN（单值 admin）')
  .option('--rate-limit <max>', '滑动窗口限流：窗口内每 IP 最大请求数（超限返回 429 + Retry-After）；不传关闭。配合 --window-ms（默认 60000）')
  .option('--window-ms <ms>', '限流窗口时长毫秒（默认 60000）', '60000')
  .option('--ws-interval <ms>', 'WebSocket 推送：mtime 轮询间隔（毫秒；默认 2000；设 0 关闭）', '2000')
  .action((opts) => {
    const { root, dataDir } = resolveDirs(opts);
    const snapPath = path.join(dataDir, 'snapshot.json');
    const bpPath = path.join(root, 'blueprint.html');
    // v0.38：docs 文档目录（output docs 产物）；/docs 浏览器入口 + /context/* 静态资源
    const docsDir = path.resolve(opts.docsDir || path.join(root, '.nice-aos', 'context'));
    const docsViewerPath = path.join(docsDir, 'docs.html');
    const port = Number(opts.port);
    const host = opts.host;
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`无效端口: ${opts.port}`);
    // 鉴权 tokens 分级（srv-6）：NICE_AOS_SERVE_TOKENS="s1,s2:read" > NICE_AOS_SERVE_TOKEN > --token...
    // 单值形态等价 admin —— v0.33 用法完全向后兼容
    const rawTokenSpec = process.env.NICE_AOS_SERVE_TOKENS
      ?? process.env.NICE_AOS_SERVE_TOKEN?.trim()
      ?? (Array.isArray(opts.token) ? opts.token.join(',') : opts.token)
      ?? null;
    const authTokens = parseTokens(rawTokenSpec);
    const authToken = authTokens[0]?.secret ?? null; // WS 模块沿用单 secret 签名（ws 为 read 端点）

    // srv-4 限流：--rate-limit 启用；对所有 HTTP 请求生效（含未鉴权探测，防爆破）
    const rateMax = opts.rateLimit != null ? parseInt(opts.rateLimit, 10) : null;
    const limiter = Number.isInteger(rateMax) && rateMax > 0
      ? createRateLimiter({ max: rateMax, windowMs: Math.max(1000, parseInt(opts.windowMs, 10) || 60_000) })
      : null;

    // SQL 端点数据目录对齐：storage 层 getSqlitePath 走 paths.js 的覆盖链，
    // 不设的话会用 cwd/.nice-aos/data 而非 serve 解析出的 --dir/--root 目录
    setSnapshotDir(dataDir);

    const server = http.createServer(async (req, res) => {
      const url = (req.url || '/').split('?')[0];
      if (req.method === 'OPTIONS') { respond(res, 204, ''); return; }

      // srv-4 限流先行（先于鉴权——防止无 token 爆破 /api/* 绕过计数）
      if (limiter) {
        const verdict0 = limiter.check(clientKeyOf(req));
        if (!verdict0.allowed) {
          res.setHeader('Retry-After', String(verdict0.retryAfterSec));
          respond(res, 429, JSON.stringify({ ok: false, error: `请求过于频繁（窗口内每 IP 上限 ${rateMax}），请 ${verdict0.retryAfterSec}s 后重试`, retryAfterSec: verdict0.retryAfterSec }));
          return;
        }
      }

      // 鉴权 + 端点分级（srv-6）：静态端点豁免；其余按 minRoleFor(method,url) 校验角色
      // v0.38：/docs/ 与 /context/ 为 output docs 产物（md/json/浏览器），与 blueprint.html 同为公共静态端点
      const PUBLIC_PATHS = new Set(['/', '/snapshot.json', '/blueprint.html', '/openapi.json', '/docs', '/docs/']);
      const isPublicStatic = PUBLIC_PATHS.has(url) || url.startsWith('/docs/') || url.startsWith('/context/');
      if (authTokens.length > 0 && !isPublicStatic) {
        const verdict = authorizeRole(req, authTokens, minRoleFor(req.method, url));
        if (!verdict.ok) {
          const insufficient = verdict.reason.includes('权限不足');
          res.setHeader('WWW-Authenticate', 'Bearer realm="aos"');
          respond(res, insufficient ? 403 : 401, JSON.stringify({ ok: false, error: verdict.reason }), { 'Content-Type': 'application/json; charset=utf-8' });
          return;
        }
      }

      // 就绪状态实时探测（服务运行期间 refreshRepo / export / output docs 生成的文件可被立即读取）
      const { state: snapState, snap } = probeSnapshot(snapPath);
      const bpReady = fs.existsSync(bpPath);
      const docsReady = fs.existsSync(docsViewerPath);

      if (url === '/') {
        respond(res, 200, buildIndexHtml({ root, dataDir, docsDir, snapReady: snapState, bpReady, docsReady }), { 'Content-Type': 'text/html; charset=utf-8' });
        return;
      }
      if (url === '/snapshot.json') {
        if (snapState === 'none') return respond(res, 404, JSON.stringify({ ok: false, error: '未找到快照，请先执行 nice-aos action refreshRepo', snapshotDir: dataDir }));
        if (snapState === 'gone') return respond(res, 500, JSON.stringify({ ok: false, error: 'snapshot.json 无法解析为合法 JSON', snapshotDir: dataDir }));
        respond(res, 200, JSON.stringify(snap), { 'Content-Type': 'application/json; charset=utf-8' });
        return;
      }
      if (url === '/blueprint.html') {
        if (!bpReady) return respond(res, 404, JSON.stringify({ ok: false, error: '未找到 blueprint.html，请先执行 nice-aos export --format html', root }));
        respond(res, 200, fs.readFileSync(bpPath), { 'Content-Type': 'text/html; charset=utf-8' });
        return;
      }
      // v0.38：/docs/ —— output docs 生成的自包含文档浏览器（运行时按需 fetch ./tree.json 与 ./<path>.md）。
      // /docs（无尾斜杠）302 → /docs/：浏览器页内相对路径 ./tree.json、./<path>.md 以 /docs/ 为基解析，
      // 故文档静态资源统一挂 /docs/<path>（/context/<path> 作为 agent 直取原始资源的等价别名保留）。
      if (url === '/docs') {
        return respond(res, 302, '', { Location: '/docs/' });
      }
      if (url === '/docs/') {
        if (!docsReady) return respond(res, 404, JSON.stringify({ ok: false, error: '未找到 docs.html，请先执行 nice-aos output docs', docsDir }));
        respond(res, 200, fs.readFileSync(docsViewerPath), { 'Content-Type': 'text/html; charset=utf-8' });
        return;
      }
      // /docs/<path> 与 /context/<path> —— 文档目录静态服务（md / tree.json 等）；
      // 路径穿越三重防护：逐段解码拒 .. + resolve 词法前缀校验 + realpath 解析后前缀校验（防目录内 symlink 指向 docs 目录之外）
      const staticMatch = url.match(/^\/(?:docs|context)\/(.+)$/);
      if (staticMatch) {
        let segments;
        try {
          segments = staticMatch[1].split('/').map((s) => decodeURIComponent(s));
        } catch {
          return respond(res, 400, JSON.stringify({ ok: false, error: '路径编码非法（decodeURIComponent 失败）' }));
        }
        if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\0'))) {
          return respond(res, 400, JSON.stringify({ ok: false, error: '非法路径段（拒绝空段/. /..）' }));
        }
        const target = path.resolve(docsDir, ...segments);
        if (target !== docsDir && !target.startsWith(docsDir + path.sep)) {
          return respond(res, 403, JSON.stringify({ ok: false, error: '路径越界（docs 目录之外）' }));
        }
        let stat = null;
        try { stat = fs.statSync(target); } catch { /* 落到 404 */ }
        if (!stat || !stat.isFile()) {
          return respond(res, 404, JSON.stringify({ ok: false, error: '文档不存在', path: target, hint: 'nice-aos output docs 重新生成' }));
        }
        // realpath 解析 symlink 后再校验一次前缀（docsDir 本身也 realpath，吸收 /tmp→/private/tmp 类别名）
        try {
          const realTarget = fs.realpathSync(target);
          const realDocs = fs.realpathSync(docsDir);
          if (realTarget !== realDocs && !realTarget.startsWith(realDocs + path.sep)) {
            return respond(res, 403, JSON.stringify({ ok: false, error: '路径越界（symlink 解析后位于 docs 目录之外）' }));
          }
        } catch { /* docsDir/target realpath 失败极罕见；词法校验已过，放行 */ }
        const ext = path.extname(target).toLowerCase();
        const type = ext === '.md' ? 'text/markdown; charset=utf-8'
          : ext === '.json' ? 'application/json; charset=utf-8'
            : ext === '.html' ? 'text/html; charset=utf-8'
              : ext === '.txt' ? 'text/plain; charset=utf-8'
                : 'application/octet-stream';
        respond(res, 200, fs.readFileSync(target), { 'Content-Type': type });
        return;
      }
      // srv-3：OpenAPI 端点描述（与 /api/status 的端点清单同源于 ENDPOINTS）
      if (url === '/openapi.json') {
        respond(res, 200, JSON.stringify(buildOpenApiSpec({ authEnabled: authTokens.length > 0, host: `http://${host}:${boundPort}` }), null, 2));
        return;
      }
      // srv-4 观测端点
      if (url === '/api/rate-limit') {
        respond(res, 200, JSON.stringify({ ok: true, rateLimit: limiter ? limiter.stats() : { enabled: false } }));
        return;
      }
      if (url === '/api/status') {
        respond(res, 200, JSON.stringify({
          ok: true,
          root, snapshotDir: dataDir,
          snapshot: { ready: snapState === 'ok', path: snapPath, state: snapState },
          blueprint: { ready: bpReady, path: bpPath },
          docs: { ready: docsReady, dir: docsDir, viewer: '/docs', context: '/context/<path>' },
          endpoints: [...ENDPOINTS.map((e) => e.path), '/ws/snapshot'].filter((v, i, a) => a.indexOf(v) === i),
          cors: '*',
          auth: {
            enabled: authTokens.length > 0,
            roles: authTokens.length > 0 ? Object.fromEntries(authTokens.map((t) => [`${t.secret.slice(0, 3)}***`, t.role])) : undefined,
            public: [...PUBLIC_PATHS],
            protected: ['/api/*', '/internal/broadcast', '/ws/snapshot'],
          },
          rateLimit: limiter ? limiter.stats() : { enabled: false },
          ws: { enabled: wsIntervalMs > 0, intervalMs: wsIntervalMs, clients: wsClients.size },
        }));
        return;
      }
      if (url === '/api/stats') {
        if (snapState === 'none') return respond(res, 404, JSON.stringify({ ok: false, error: '快照缺失，请先执行 nice-aos action refreshRepo', snapshotDir: dataDir }));
        if (snapState === 'gone') return respond(res, 500, JSON.stringify({ ok: false, error: '快照 JSON 损坏', snapshotDir: dataDir }));
        const counts = snap._meta?.objectCounts || Object.fromEntries(Object.entries(snap).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length]));
        const project = snap.Project?.[0];
        respond(res, 200, JSON.stringify({
          ok: true, name: project?.name, framework: project?.framework, branch: project?.branch,
          generatedAt: snap._meta?.generatedAt, counts,
          cycles: snap._meta?.cycles || [], orphanCandidates: snap._meta?.orphanCandidates || [],
        }));
        return;
      }
      // 本体元模型：暴露 OBJECT_TYPES / LINK_TYPES / ACTION_NAMES / 概念范畴
      // 借鉴 asdm-aos 的 ObjectTypeDef / LinkTypeDef / ActionDef 设计，
      // 让外部 agent 可自动发现能力（哪些对象可查、哪些链接可走、哪些动作可调）
      if (url === '/api/schema') {
        respond(res, 200, JSON.stringify({
          ok: true,
          meta: {
            version: ONTOLOGY_META.version,
            abstractionLevels: ONTOLOGY_META.abstractionLevels,
            categories: ONTOLOGY_META.categories,
          },
          objectTypes: OBJECT_TYPES,
          linkTypes: LINK_TYPES,
          actionNames: ACTION_NAMES,
          // 辅助方法：prefix → type(给 agent 反查 src id 前缀映射到对象类型)
          prefixMap: Object.fromEntries(OBJECT_TYPES.map((t) => [t.prefix, t.type])),
        }, null, 2), { 'Content-Type': 'application/json; charset=utf-8' });
        return;
      }
      // 对象级查询：GET /api/objects/:type?where=k=v,k2~v2&limit=200
      // 取数走 SQL（loadType 毫秒级），SQLite 不可用/无快照时回退 JSON；过滤统一内存（两路 where 语义一致）
      const objMatch = url.match(/^\/api\/objects\/([A-Za-z]+)$/);
      if (objMatch) {
        const type = objMatch[1];
        if (!OBJECT_TYPES.some((t) => t.type === type)) {
          respond(res, 400, JSON.stringify({ ok: false, error: `未知对象类型: ${type}`, validTypes: OBJECT_TYPES.map((t) => t.type) }));
          return;
        }
        const query = new URL(req.url, 'http://x').searchParams;
        const limitRaw = parseInt(query.get('limit') ?? '200', 10);
        const limit = Number.isInteger(limitRaw) && limitRaw >= 0 ? limitRaw : 200;

        let objects = loadType({ kind: 'code', type });
        let source = 'sqlite';
        if (objects === null || objects === undefined) {
          if (snapState === 'none') {
            respond(res, 404, JSON.stringify({ ok: false, error: '快照缺失，请先执行 nice-aos action refreshRepo 或 storage rebuild', snapshotDir: dataDir }));
            return;
          }
          if (snapState === 'gone') {
            respond(res, 500, JSON.stringify({ ok: false, error: '快照 JSON 损坏', snapshotDir: dataDir }));
            return;
          }
          objects = snap[type] || [];
          source = 'json';
        }

        const conditions = parseWhere(query.get('where'));
        const filtered = conditions ? objects.filter((o) => matchesWhere(o, conditions)) : objects;
        const total = filtered.length;
        const truncated = limit > 0 && total > limit;
        respond(res, 200, JSON.stringify({
          ok: true,
          type,
          source,
          count: truncated ? limit : total,
          total,
          truncated,
          objects: truncated ? filtered.slice(0, limit) : filtered,
        }));
        return;
      }

      // ask 上下文：GET /api/ask/context?q=<question>
      // SQL 优先（4 次查询 <50ms），回退 JSON 构建；供 AI agent 拉取精简上下文
      if (url === '/api/ask/context') {
        const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
        let context = buildAskContextFromSql({ kind: 'code', question: q || undefined });
        let source = 'sqlite';
        if (!context) {
          if (snapState === 'none') {
            respond(res, 404, JSON.stringify({ ok: false, error: '快照缺失，请先执行 nice-aos action refreshRepo 或 storage rebuild', snapshotDir: dataDir }));
            return;
          }
          if (snapState === 'gone') {
            respond(res, 500, JSON.stringify({ ok: false, error: '快照 JSON 损坏', snapshotDir: dataDir }));
            return;
          }
          context = buildAskContext(snap);
          if (q) context += `\n\n## 问题\n${q}`;
          source = 'json';
        }
        respond(res, 200, JSON.stringify({ ok: true, source, context }));
        return;
      }

      // srv-5 / x-4：POST /api/ask —— serve 内直连已配置的 OpenAI 兼容模型服务回答问题
      // （不依赖本地 AI CLI；未配置模型服务返回 503 与配置指引）
      if (req.method === 'POST' && url === '/api/ask') {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          respond(res, 400, JSON.stringify({ ok: false, error: `请求体须为 JSON: ${err.message}` }));
          return;
        }
        const question = typeof body?.question === 'string' ? body.question.trim() : '';
        if (!question) {
          respond(res, 400, JSON.stringify({ ok: false, error: '缺少 question 字段（string）' }));
          return;
        }
        const cfg = loadAskConfig();
        if (!cfg) {
          respond(res, 503, JSON.stringify({
            ok: false,
            error: '未配置模型服务。请执行 nice-aos ask config set --provider deepseek --api-key <key>，或设置 NICE_AOS_API_KEY / NICE_AOS_BASE_URL / NICE_AOS_MODEL 环境变量后重启本服务',
          }));
          return;
        }
        // 会话续聊（可选）
        let historyPart = '';
        if (body.session != null) {
          if (!isValidSessionId(String(body.session))) {
            respond(res, 400, JSON.stringify({ ok: false, error: `非法 session id: ${body.session}` }));
            return;
          }
          const loaded = loadSession(String(body.session));
          if (loaded.turns.length > 0) {
            historyPart = loaded.turns.slice(-6).map((t) => `<turn>\nQ: ${t.question}\nA: ${String(t.answer).slice(0, 4000)}\n</turn>`).join('\n');
          }
        }
        // 上下文两路取数（与 GET /api/ask/context 一致）
        let context = buildAskContextFromSql({ kind: 'code', question });
        let source = 'sqlite';
        if (!context) {
          context = snapState === 'ok' ? buildAskContext(snap) : '';
          source = 'json';
        }
        const fullPrompt = [context, historyPart, `## 问题\n${question}`].filter(Boolean).join('\n\n');
        try {
          const t0 = Date.now();
          const answer = await invokeApiChat({ ...cfg, prompt: fullPrompt, timeout: 120_000 });
          const metaOut = { agent: 'api', model: cfg.model, provider: cfg.provider ?? 'custom', contextSource: source, durationMs: Date.now() - t0 };
          const outPayload = { ok: true, ...metaOut, session: null, savedPath: null, answer };
          if (body.session != null) {
            try {
              outPayload.session = { id: String(body.session), turnCount: appendTurn(String(body.session), { question, answer, agent: 'api', model: cfg.model, durationMs: metaOut.durationMs }) };
            } catch (err) {
              console.error(`⚠️  session 写入失败: ${err.message}`);
            }
          }
          if (body.save === true) {
            const { filePath } = resolveSavePath(undefined, dataDir);
            writeAskArchive(filePath, formatAskArchive({
              question, answer,
              agent: 'api', model: cfg.model, provider: cfg.provider ?? 'custom',
              contextSource: source, durationMs: metaOut.durationMs,
              ...(outPayload.session ? { session: outPayload.session.id } : {}),
            }));
            outPayload.savedPath = filePath;
          }
          respond(res, 200, JSON.stringify(outPayload));
        } catch (err) {
          respond(res, 502, JSON.stringify({ ok: false, error: `模型服务调用失败: ${err.message}` }));
        }
        return;
      }

      // x-3：POST /internal/broadcast —— 本机回环专用；export 完成后触发 WS 广播
      if (req.method === 'POST' && url === '/internal/broadcast') {
        const remote = req.socket?.remoteAddress ?? '';
        if (!isLoopbackAddr(remote)) {
          respond(res, 403, JSON.stringify({ ok: false, error: '仅限本机回环调用' }));
          return;
        }
        let body = {};
        try { body = JSON.parse(await readBody(req)); } catch { /* 空/坏体容忍 */ }
        wsClients.size > 0
          ? wsState.broadcast?.({
              type: typeof body.event === 'string' && /^[\w:-]+$/.test(body.event) ? body.event : 'report:changed',
              paths: Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === 'string').slice(0, 20) : [],
              ts: Date.now(),
            })
          : null;
        respond(res, 200, JSON.stringify({ ok: true, broadcast: true, clients: wsClients.size }));
        return;
      }

      // E-3（v0.35.0）：POST /action —— 蓝图 UI 动作卡片的提交端点。
      // 四个动作与 CLI `nice-aos action <name>` 同语义；viewer 前端提交体为 {actionName, params}，
      // 响应 {ok, message} 与前端 `j.ok ? '✓' : '✗'` 消费格式一致。角色裁决：minRoleFor → write。
      if (req.method === 'POST' && url === '/action') {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          respond(res, 400, JSON.stringify({ ok: false, message: `请求体须为 JSON: ${err.message}` }));
          return;
        }
        const name = typeof body?.actionName === 'string' ? body.actionName.trim() : '';
        const params = body?.params && typeof body.params === 'object' ? body.params : {};
        if (!ACTION_NAMES.includes(name)) {
          respond(res, 400, JSON.stringify({ ok: false, message: `未知动作: ${name || '(空)'}。可用动作: ${ACTION_NAMES.join(', ')}` }));
          return;
        }
        if (name === 'analyzeFile') {
          // 只读动作：无需快照在场
          const ops = await import('../../ontology/actionOps.js');
          const result = await ops.runAnalyzeFile(params);
          respond(res, result.ok ? 200 : 400, JSON.stringify(result));
          return;
        }
        if (name === 'refreshRepo') {
          // 重扫后直接落盘到本服务的数据源目录（saveTo），运行期实时探测立即生效
          const ops = await import('../../ontology/actionOps.js');
          const result = await ops.runRefreshRepo(params, { saveTo: snapPath });
          respond(res, result.ok ? 200 : 400, JSON.stringify(result));
          return;
        }
        // markReviewed / addNote：写快照 + SQLite overlay 双写（与 action.js 同语义）
        if (snapState !== 'ok') {
          const reason = snapState === 'gone' ? '快照 JSON 损坏，请先执行 nice-aos action refreshRepo' : '快照缺失，请先执行 refreshRepo 动作或 nice-aos action refreshRepo';
          respond(res, snapState === 'gone' ? 500 : 404, JSON.stringify({ ok: false, message: reason }));
          return;
        }
        const objectId = params.objectId;
        if (!objectId || typeof objectId !== 'string') {
          respond(res, 400, JSON.stringify({ ok: false, message: '缺少参数 objectId' }));
          return;
        }
        let blueprintV1;
        try {
          blueprintV1 = createBlueprint(snap);
        } catch (err) {
          respond(res, 500, JSON.stringify({ ok: false, message: `快照蓝图构建失败: ${err?.message ?? err}` }));
          return;
        }
        const obj = blueprintV1.find(objectId);
        if (!obj) {
          respond(res, 400, JSON.stringify({ ok: false, message: `对象不存在: ${objectId}` }));
          return;
        }
        /** @type {Record<string, unknown>} 写回字段集 */
        let patchFields;
        if (name === 'markReviewed') {
          obj.reviewed = true;
          obj.reviewedAt = new Date().toISOString();
          patchFields = { reviewed: true, reviewedAt: obj.reviewedAt };
        } else {
          const note = params.note;
          if (!note || !String(note).trim()) {
            respond(res, 400, JSON.stringify({ ok: false, message: 'note 不可为空' }));
            return;
          }
          obj.notes = obj.notes ? `${obj.notes}\n${note}` : note;
          patchFields = { notes: obj.notes };
        }
        fs.writeFileSync(snapPath, JSON.stringify(snap), 'utf-8');
        // SQLite overlay 双写；no-snapshot 时先镜像当前 dataMap 再补 overlay（同 action.js 回退链）
        let overlayNote = '';
        try {
          const { type, id } = parseObjectId(objectId);
          let r = applyOverlay({ kind: 'code', type, id, patch: patchFields });
          if (r && r.ok === false && r.reason === 'no-snapshot') {
            const w = sqlSaveSnapshot({ kind: 'code', dataMap: snap });
            if (w.ok) r = applyOverlay({ kind: 'code', type, id, patch: patchFields });
          }
          if (r && r.ok === false) overlayNote = `（SQLite 双写跳过: ${r.reason}，JSON 快照已更新）`;
        } catch (err) {
          overlayNote = `（SQLite 双写异常: ${err?.message ?? err}，JSON 快照已更新）`;
        }
        respond(res, 200, JSON.stringify({
          ok: true,
          message: name === 'markReviewed'
            ? `已标记 ${objectId} 为已审查${overlayNote}`
            : `已为 ${objectId} 添加注释${overlayNote}`,
        }));
        return;
      }

      respond(res, 404, JSON.stringify({ ok: false, error: `未支持路径: ${url}（可用端点见 /api/status）` }));
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') fail(`端口 ${port} 已被占用，请换一个端口: nice-aos serve --port <n>`);
      else fail(`服务启动失败: ${err.message}`);
    });

    // ---- WebSocket：/ws/snapshot 推送（mtime 轮询）----
    // 整段 upgrade handler + 轮询定时器抽到 serveWebSocket.js 的 attachWebSocketUpgrade
    // （v0.33.0 精简：serve.js 不再混合 WS 实现细节，只传 authToken / 路径给模块）
    const wsIntervalMs = Math.max(0, parseInt(opts.wsInterval, 10) || 0);
    const wsState = attachWebSocketUpgrade(server, {
      snapPath,
      bpPath,
      intervalMs: wsIntervalMs,
      authToken,
      checkAuth,
    });
    const wsClients = wsState.clients;
    let boundPort = port;

    server.listen(port, host, () => {
      boundPort = server.address()?.port ?? port; // --port 0 时为实际分配端口
      const actualPort = boundPort;
      // x-3：写运行时记录供 output/refreshRepo 进程发现并触发广播；进程退出时清理
      writeServeRuntime(dataDir, { pid: process.pid, port: actualPort });
      const cleanupOnce = () => cleanupServeRuntime(dataDir);
      process.on('exit', cleanupOnce);
      for (const sig of ['SIGINT', 'SIGTERM']) {
        try {
          process.on(sig, () => { cleanupOnce(); process.exit(0); });
        } catch { /* ignore */ }
      }
      const line = (label, ok, note) => `  ${ok ? '✓' : '✗'}  ${label.padEnd(18)} ${note || ''}`;
      const { state: snapState } = probeSnapshot(snapPath);
      const bpReady = fs.existsSync(bpPath);
      console.log(`\n  AOS 数据源服务已启动  →  http://${host}:${actualPort}\n`);
      console.log('  --- 数据源目录 ---');
      console.log(`  root        ${root}`);
      console.log(`  snapshot    ${dataDir}`);
      if (authTokens.length > 0) {
        const roleSummary = authTokens.map((t) => `${t.secret.slice(0, 3)}***:${t.role}`).join(' ');
        console.log(`  auth        Bearer 鉴权启用（角色分级 ${Object.keys(ROLES).join('/')}）：${roleSummary}`);
      } else {
        console.log(`  auth        关闭（不传 --token 时所有端点公开；生产请加 --token <secret> 或 NICE_AOS_SERVE_TOKENS）`);
      }
      if (limiter) {
        console.log(`  rate-limit  每 IP 窗口内上限 ${rateMax}（${Math.round((parseInt(opts.windowMs, 10) || 60000) / 1000)}s 窗口）`);
      }
      if (wsIntervalMs > 0) {
        console.log(`  ws          /ws/snapshot 推送启用（mtime 轮询 ${wsIntervalMs}ms）`);
      } else {
        console.log(`  ws          关闭（--ws-interval 0）`);
      }
      console.log(line('snapshot.json', snapState === 'ok', snapPath));
      console.log(line('blueprint.html', bpReady, bpPath));
      if (snapState === 'none') console.log('  （未找到快照，可先执行: nice-aos action refreshRepo）');
      if (snapState === 'gone') console.log('  （snapshot.json 存在但解析失败）');
      if (!bpReady) console.log('  （未找到蓝图，可先执行: nice-aos export --format html）');
      console.log('\n  --- 端点 ---');
      console.log('    GET /snapshot.json      本体快照（供 AI agent / 油猴脚本跨源拉取）');
      if (bpReady) console.log(`    GET /blueprint.html    蓝图页面 http://${host}:${actualPort}/blueprint.html`);
      console.log('    GET /api/status         服务状态与端点清单');
      console.log('    GET /api/stats          快照对象统计摘要');
      console.log('    GET /api/schema         本体元模型(对象/链接/动作 schema,借鉴 asdm-aos)');
      console.log('    GET /api/objects/:type  对象级查询 ?where=k=v,k2~v2&limit=200 (SQLite 优先)');
      console.log('    GET /api/ask/context    ask 上下文 ?q=问题 (4 次 SQL 预过滤)');
      console.log('    POST /api/ask           直连模型问答 {question, session?, save?} (write 角色 token)');
      console.log('    GET /openapi.json       OpenAPI 3.0 端点描述');
      if (limiter) console.log('    GET /api/rate-limit     限流器观测');
      console.log('\n  按 Ctrl+C 停止\n');
    });
  });