import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Command } from 'commander';
import { fail } from '../shared.js';
import { getSnapshotDirOverride } from '../../ontology/snapshot.js';

// serve —— 在本地启动数据源 HTTP 服务。
// 作用：暴露本体快照 snapshot.json 与 blueprint.html，并带 CORS，
//       方便 AI agent（油猴脚本 / 网页 / curl）跨源拉取快照作为知识数据源。
// 默认 root = 当前项目目录，自动到 <root>/.nice-aos/data 找 snapshot.json，<root>/blueprint.html 找蓝图。

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

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
</table>
<h3 style="margin-top:28px">可用端点</h3>
<ul style="line-height:2">
<li><code>GET /snapshot.json</code> — 本体快照 JSON（供 AI agent 拉取）</li>
<li><code>GET /blueprint.html</code> — ${bpReady ? '蓝图页面' : '（未生成）'}</li>
<li><code>GET /api/status</code> — 服务状态与端点清单</li>
<li><code>GET /api/stats</code> — 快照对象统计摘要</li>
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
  .action((opts) => {
    const { root, dataDir } = resolveDirs(opts);
    const snapPath = path.join(dataDir, 'snapshot.json');
    const bpPath = path.join(root, 'blueprint.html');
    const port = Number(opts.port);
    const host = opts.host;
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`无效端口: ${opts.port}`);

    const server = http.createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      if (req.method === 'OPTIONS') { respond(res, 204, ''); return; }

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
          endpoints: ['/snapshot.json', '/blueprint.html', '/api/status', '/api/stats', '/'],
          cors: '*',
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
      respond(res, 404, JSON.stringify({ ok: false, error: `未支持路径: ${url}（可用端点见 /api/status）` }));
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') fail(`端口 ${port} 已被占用，请换一个端口: nice-aos serve --port <n>`);
      else fail(`服务启动失败: ${err.message}`);
    });

    server.listen(port, host, () => {
      const actualPort = server.address()?.port ?? port; // --port 0 时为实际分配端口
      const line = (label, ok, note) => `  ${ok ? '✓' : '✗'}  ${label.padEnd(18)} ${note || ''}`;
      const { state: snapState } = probeSnapshot(snapPath);
      const bpReady = fs.existsSync(bpPath);
      console.log(`\n  AOS 数据源服务已启动  →  http://${host}:${actualPort}\n`);
      console.log('  --- 数据源目录 ---');
      console.log(`  root        ${root}`);
      console.log(`  snapshot    ${dataDir}`);
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
      console.log('\n  按 Ctrl+C 停止\n');
    });
  });