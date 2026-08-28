// serve docs 端点测试：/docs 浏览器入口 + /docs/<path>、/context/<path> 静态服务
// 覆盖：302 重定向、Content-Type 映射、嵌套/中文路径、路径穿越防护、缺失降级 404、/api/status 端点登记
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.js');

function mkFixture({ withDocs = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-serve-docs-'));
  fs.mkdirSync(path.join(dir, '.nice-aos', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nice-aos', 'data', 'snapshot.json'), JSON.stringify({
    _meta: { generatedAt: '2026-08-22T00:00:00.000Z', cycles: [], objectCounts: {} },
    Project: [{ id: 'proj:x', name: 'serve-docs-fixture', framework: 'react' }],
  }));
  if (withDocs) {
    const ctx = path.join(dir, '.nice-aos', 'context');
    fs.mkdirSync(path.join(ctx, 'domains', '子目录'), { recursive: true });
    fs.writeFileSync(path.join(ctx, 'index.md'), '---\ntitle: 首页\nlayer: L1\n---\n\n# serve-docs-fixture 首页\n');
    fs.writeFileSync(path.join(ctx, 'tree.json'), JSON.stringify({ generated: '2026-08-22T00:00:00.000Z', totalFiles: 2, tree: [] }));
    fs.writeFileSync(path.join(ctx, 'docs.html'), '<!doctype html><html><title>docs-marker</title><body>docs-marker</body></html>');
    fs.writeFileSync(path.join(ctx, 'domains', 'shop.md'), '# shop 领域\n');
    fs.writeFileSync(path.join(ctx, 'domains', '子目录', '中文文档.md'), '# 中文路径文档\n');
  }
  return dir;
}

function startServe(args, t) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let out = '';
    const timer = setTimeout(() => reject(new Error(`serve 启动超时，输出: ${out}`)), 20_000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`serve 提前退出(${code})，输出: ${out}`)); });
  });
}

test('/docs/ 浏览器 + /docs/<path> 与 /context/<path> 静态资源契约', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir], t);
  const base = `http://127.0.0.1:${port}`;

  // /docs 无尾斜杠 → 302 到 /docs/
  const noSlash = await fetch(`${base}/docs`, { redirect: 'manual' });
  assert.equal(noSlash.status, 302);
  assert.equal(noSlash.headers.get('location'), '/docs/');

  // /docs/ → 自包含浏览器
  const viewer = await fetch(`${base}/docs/`);
  assert.equal(viewer.status, 200);
  assert.match(viewer.headers.get('content-type'), /text\/html/);
  assert.match(await viewer.text(), /docs-marker/);

  // tree.json → application/json
  const tree = await fetch(`${base}/docs/tree.json`);
  assert.equal(tree.status, 200);
  assert.match(tree.headers.get('content-type'), /application\/json/);
  assert.equal(JSON.parse(await tree.text()).totalFiles, 2);

  // md → text/markdown；嵌套 + 中文路径按段编码可取
  const index = await fetch(`${base}/docs/index.md`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/markdown/);
  assert.match(await index.text(), /serve-docs-fixture 首页/);
  const nested = await fetch(`${base}/docs/domains/shop.md`);
  assert.equal(nested.status, 200);
  assert.match(await nested.text(), /shop 领域/);
  const cjk = await fetch(`${base}/docs/domains/${encodeURIComponent('子目录')}/${encodeURIComponent('中文文档.md')}`);
  assert.equal(cjk.status, 200);
  assert.match(await cjk.text(), /中文路径文档/);

  // /context/<path> 别名等价
  const alias = await fetch(`${base}/context/index.md`);
  assert.equal(alias.status, 200);
  assert.match(alias.headers.get('content-type'), /text\/markdown/);

  // CORS 放开（与既有静态端点一致）
  assert.equal((await fetch(`${base}/docs/`)).headers.get('access-control-allow-origin'), '*');
});

// node:http 直发原始路径（fetch/WHATWG URL 会在客户端规范化 .. 与 %2e，请求到不了服务端）
const rawGet = (port, rawPath) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

test('路径穿越与非法路径防护', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir], t);

  // 段级 ..（原始路径直发）→ 400
  const up = await rawGet(port, '/docs/../../data/snapshot.json');
  assert.equal(up.status, 400, `段级 .. 应被拒，实际 ${up.status}`);
  // 段内编码斜杠 → 段检查放过但 resolve 越界防护拒绝 → 403
  const encoded = await rawGet(port, '/docs/..%2Fdata%2Fsnapshot.json');
  assert.equal(encoded.status, 403, `段内编码斜杠穿越应被拒，实际 ${encoded.status}`);

  // 目录内 symlink 指向 docs 目录之外 → realpath 解析后 403（词法校验放不过 symlink）
  const secretFile = path.join(os.tmpdir(), `aos-docs-secret-${process.pid}.md`);
  fs.writeFileSync(secretFile, '# secret\n');
  t.after(() => fs.rmSync(secretFile, { force: true }));
  fs.symlinkSync(secretFile, path.join(dir, '.nice-aos', 'context', 'leak.md'));
  const leak = await fetch(`http://127.0.0.1:${port}/docs/leak.md`);
  assert.equal(leak.status, 403, `symlink 逃逸应被拒，实际 ${leak.status}`);

  // 正常文件不受 realpath 校验影响
  const ok = await fetch(`http://127.0.0.1:${port}/docs/index.md`);
  assert.equal(ok.status, 200);

  // 段内不存在的文件 → 404 + hint
  const missing = await fetch(`http://127.0.0.1:${port}/docs/not-exist.md`);
  assert.equal(missing.status, 404);
  assert.match(JSON.parse(await missing.text()).hint, /output docs/);
});

test('docs 缺失降级：/docs/ 404 带生成提示；--docs-dir 自定义目录生效', async (t) => {
  const noDocsDir = mkFixture({ withDocs: false });
  const a = await startServe(['--root', noDocsDir], t);
  const missing = await fetch(`http://127.0.0.1:${a.port}/docs/`);
  assert.equal(missing.status, 404);
  const body = JSON.parse(await missing.text());
  assert.match(body.error, /output docs/);

  // --docs-dir 指向别处
  const customDocs = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-docs-custom-'));
  fs.writeFileSync(path.join(customDocs, 'docs.html'), '<title>custom-docs</title>');
  fs.writeFileSync(path.join(customDocs, 'tree.json'), '{"totalFiles":0,"tree":[]}');
  const b = await startServe(['--root', noDocsDir, '--docs-dir', customDocs], t);
  const custom = await fetch(`http://127.0.0.1:${b.port}/docs/`);
  assert.equal(custom.status, 200);
  assert.match(await custom.text(), /custom-docs/);
});

test('/api/status 与首页同步 docs 信息', async (t) => {
  const dir = mkFixture();
  const { port } = await startServe(['--root', dir], t);
  const base = `http://127.0.0.1:${port}`;

  const st = await (await fetch(`${base}/api/status`)).json();
  assert.equal(st.docs.ready, true);
  assert.equal(st.docs.viewer, '/docs');
  assert.match(st.docs.dir, /\.nice-aos[/\\]context$/);
  assert.ok(st.endpoints.includes('/docs'));
  assert.ok(st.endpoints.includes('/context/{path}'));

  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /项目文档/);
  assert.match(home, /href="\/docs"/);
});
