import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Command } from 'commander';
import { fail, parseWhere, matchesWhere } from '../shared.js';
import { checkAuth } from './serveAuth.js';
import { getSnapshotDirOverride, setSnapshotDir } from '../../paths.js';
import { loadType, buildAskContextFromSql } from '../../storage/index.js';
import { buildAskContext } from './askContext.js';
import { OBJECT_TYPES, LINK_TYPES, ACTION_NAMES, ONTOLOGY_META } from '../../ontology/blueprint.js';
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

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
  res.writeHead(status, { ...corsHeaders(), 'Content-Type': headers['Content-Type'] || (isHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'), 'Cache-Control': 'no-store' });
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

function buildIndexHtml({ root, dataDir, snapReady, bpReady }) {
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
${row('本体元模型', true, `<a href="/api/schema">/api/schema</a> — ${OBJECT_TYPES.length} 对象 / ${LINK_TYPES.length} 链接`)}
</table>
<h3 style="margin-top:28px">可用端点</h3>
<ul style="line-height:2">
<li><code>GET /snapshot.json</code> — 本体快照 JSON（供 AI agent 拉取）</li>
<li><code>GET /blueprint.html</code> — ${bpReady ? '蓝图页面' : '（未生成）'}</li>
<li><code>GET /api/status</code> — 服务状态与端点清单</li>
<li><code>GET /api/stats</code> — 快照对象统计摘要</li>
<li><code>GET /api/schema</code> — 本体元模型（对象/链接/动作 schema,借鉴 asdm-aos）</li>
<li><code>GET /api/objects/:type</code> — 对象级查询（?where=k=v,k2~v2&amp;limit=200；SQLite 优先，回退 JSON）</li>
<li><code>GET /api/ask/context</code> — ask 上下文（?q=问题；4 次 SQL 预过滤，回退 JSON）</li>
<li><code>GET /</code> — 本页</li>
</ul>
<p style="color:#64748b;font-size:12px;margin-top:24px">提示：若快照缺失请先执行 <code>nice-aos action refreshRepo</code>；蓝图为 <code>nice-aos export --format html</code>。</p>
</body></html>`;
}

export const serveCommand = new Command('serve')
  .description('在本地启动数据源 HTTP 服务：暴露本体快照 snapshot.json 与 blueprint.html，便于 AI agent 等跨源拉取')
  .option('--root <dir>', '项目根目录（默认当前目录，用于定位 blueprint.html 与 .nice-aos/data）', process.cwd())
  .option('--dir <path>', '数据源目录（含 snapshot.json；默认 <root>/.nice-aos/data；等价于全局 --snapshot-dir，亦可用 NICE_AOS_SNAPSHOT_DIR 覆盖）')
  .option('--host <host>', '监听地址（默认 127.0.0.1，仅本机可访问）', '127.0.0.1')
  .option('--port <n>', '监听端口（默认 8420；传 0 自动分配可用端口）', '8420')
  .option('--token <secret>', '启用 Bearer 鉴权（保护 /api/* 端点 + WebSocket /ws/snapshot；静态端点 /snapshot.json / /blueprint.html / / 豁免）。Authorization: Bearer <token> 头或 ?token=<secret> query 都可；NICE_AOS_SERVE_TOKEN 环境变量覆盖 --token')
  .option('--ws-interval <ms>', 'WebSocket 推送：mtime 轮询间隔（毫秒；默认 2000；设 0 关闭）', '2000')
  .action((opts) => {
    const { root, dataDir } = resolveDirs(opts);
    const snapPath = path.join(dataDir, 'snapshot.json');
    const bpPath = path.join(root, 'blueprint.html');
    const port = Number(opts.port);
    const host = opts.host;
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`无效端口: ${opts.port}`);
    // 鉴权 token：NICE_AOS_SERVE_TOKEN 覆盖 --token（CI 场景优先）
    const authToken = process.env.NICE_AOS_SERVE_TOKEN?.trim() || opts.token?.trim() || null;

    // SQL 端点数据目录对齐：storage 层 getSqlitePath 走 paths.js 的覆盖链，
    // 不设的话会用 cwd/.nice-aos/data 而非 serve 解析出的 --dir/--root 目录
    setSnapshotDir(dataDir);

    const server = http.createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      if (req.method === 'OPTIONS') { respond(res, 204, ''); return; }

      // 鉴权：仅 /api/* 端点受保护；静态端点（/snapshot.json / /blueprint.html / /）豁免
      if (authToken && url.startsWith('/api/')) {
        const auth = checkAuth(req, authToken);
        if (!auth.ok) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="aos"');
          respond(res, 401, JSON.stringify({ ok: false, error: auth.reason }), { 'Content-Type': 'application/json; charset=utf-8' });
          return;
        }
      }

      // 就绪状态实时探测（服务运行期间 refreshRepo / export 生成的文件可被立即读取）
      const { state: snapState, snap } = probeSnapshot(snapPath);
      const bpReady = fs.existsSync(bpPath);

      if (url === '/') {
        respond(res, 200, buildIndexHtml({ root, dataDir, snapReady: snapState, bpReady }), { 'Content-Type': 'text/html; charset=utf-8' });
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
      if (url === '/api/status') {
        respond(res, 200, JSON.stringify({
          ok: true,
          root, snapshotDir: dataDir,
          snapshot: { ready: snapState === 'ok', path: snapPath, state: snapState },
          blueprint: { ready: bpReady, path: bpPath },
          endpoints: ['/snapshot.json', '/blueprint.html', '/api/status', '/api/stats', '/api/schema', '/api/objects/:type', '/api/ask/context', '/ws/snapshot', '/'],
          cors: '*',
          auth: { enabled: !!authToken, protected: ['/api/*', '/ws/snapshot'], public: ['/snapshot.json', '/blueprint.html', '/'] },
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

    server.listen(port, host, () => {
      const actualPort = server.address()?.port ?? port; // --port 0 时为实际分配端口
      const line = (label, ok, note) => `  ${ok ? '✓' : '✗'}  ${label.padEnd(18)} ${note || ''}`;
      const { state: snapState } = probeSnapshot(snapPath);
      const bpReady = fs.existsSync(bpPath);
      console.log(`\n  AOS 数据源服务已启动  →  http://${host}:${actualPort}\n`);
      console.log('  --- 数据源目录 ---');
      console.log(`  root        ${root}`);
      console.log(`  snapshot    ${dataDir}`);
      if (authToken) {
        console.log(`  auth        Bearer 鉴权启用（/api/* + /ws/snapshot 需 token；长度 ${authToken.length}）`);
      } else {
        console.log(`  auth        关闭（不传 --token 时所有端点公开；生产请加 --token <secret> 或 NICE_AOS_SERVE_TOKEN）`);
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
      console.log('\n  按 Ctrl+C 停止\n');
    });
  });