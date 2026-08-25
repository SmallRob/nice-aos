// API 端点检测测试:借鉴 asdm-aos Method.endpointInfo
// 适配:Next.js App Router / Next.js Pages Router / Nuxt 3
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';

async function withTmpProject(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-endpoint-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  try {
    const dm = await buildOntologyData(dir, { roots: ['src'] });
    await fn(dm);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Next.js App Router: GET /api/users', async () => {
  await withTmpProject({
    'app/api/users/route.ts': `export async function GET() { return Response.json({ users: [] }); }`,
  }, (dm) => {
    const m = dm.Method.find(m => m.endpointInfo);
    assert.ok(m, '应识别一个 endpoint');
    assert.equal(m.endpointInfo.framework, 'next-app-router');
    assert.equal(m.endpointInfo.method, 'GET');
    assert.equal(m.endpointInfo.path, '/api/users');
  });
});

test('Next.js App Router: 多个 HTTP method (GET+POST)', async () => {
  await withTmpProject({
    'app/api/users/route.ts': `
      export async function GET() { return Response.json({ users: [] }); }
      export async function POST() { return Response.json({ id: 1 }); }
    `,
  }, (dm) => {
    const endpoints = dm.Method.filter(m => m.endpointInfo);
    assert.equal(endpoints.length, 2);
    const methods = endpoints.map(m => m.endpointInfo.method).sort();
    assert.deepEqual(methods, ['GET', 'POST']);
  });
});

test('Next.js App Router: 动态参数 [id]', async () => {
  await withTmpProject({
    'app/api/posts/[id]/route.ts': `
      export async function GET() { return Response.json({ id: 1 }); }
      export async function DELETE() { return Response.json({ ok: true }); }
    `,
  }, (dm) => {
    const endpoints = dm.Method.filter(m => m.endpointInfo);
    assert.equal(endpoints.length, 2);
    const paths = endpoints.map(m => m.endpointInfo.path).sort();
    assert.deepEqual(paths, ['/api/posts/[id]', '/api/posts/[id]']);
    endpoints.forEach(m => {
      assert.equal(m.endpointInfo.framework, 'next-app-router');
    });
  });
});

test('Next.js App Router: (group) 分组', async () => {
  await withTmpProject({
    'app/(admin)/api/dashboard/route.ts': `export async function GET() { return {}; }`,
  }, (dm) => {
    const m = dm.Method.find(m => m.endpointInfo);
    assert.equal(m.endpointInfo.path, '/api/dashboard');
  });
});

test('Next.js App Router: app/page.tsx 不识别(非 API)', async () => {
  await withTmpProject({
    'app/page.tsx': `export default function Home() { return <div>Hello</div>; }`,
  }, (dm) => {
    const endpoints = dm.Method.filter(m => m.endpointInfo);
    assert.equal(endpoints.length, 0);
  });
});

test('Next.js Pages Router: pages/api/users.ts (handler)', async () => {
  await withTmpProject({
    'pages/api/users.ts': `export default function handler(req, res) { res.json({ users: [] }); }`,
  }, (dm) => {
    const m = dm.Method.find(m => m.endpointInfo);
    assert.equal(m.endpointInfo.framework, 'next-pages-router');
    // Pages Router 的 handler 不区分 method(从 req.method 取),标 'ANY'
    assert.equal(m.endpointInfo.method, 'ANY');
    assert.equal(m.endpointInfo.path, '/api/users');
  });
});

test('Nuxt 3: server/api/users.get.ts + export default function', async () => {
  await withTmpProject({
    'server/api/users.get.ts': `export default async function () { return { users: [] }; }`,
  }, (dm) => {
    const m = dm.Method.find(m => m.endpointInfo);
    assert.ok(m, 'Nuxt 端点应被识别');
    assert.equal(m.endpointInfo.framework, 'nuxt');
    assert.equal(m.endpointInfo.method, 'GET');
    assert.equal(m.endpointInfo.path, '/api/users');
  });
});

test('Nuxt 3: server/api/posts.post.ts', async () => {
  await withTmpProject({
    'server/api/posts.post.ts': `export default async function () { return { id: 1 }; }`,
  }, (dm) => {
    const m = dm.Method.find(m => m.endpointInfo);
    assert.equal(m.endpointInfo.method, 'POST');
    assert.equal(m.endpointInfo.path, '/api/posts');
    assert.equal(m.endpointInfo.framework, 'nuxt');
  });
});

test('非 API 路径: src/utils/helper.ts 中的函数不识别为 endpoint', async () => {
  await withTmpProject({
    'utils/helper.ts': `export function GET() { return 1; }`,
  }, (dm) => {
    // 文件不在 app/api / pages/api / server/api 路径,即使是 GET 也不识别
    const endpoints = dm.Method.filter(m => m.endpointInfo);
    assert.equal(endpoints.length, 0);
  });
});

test('端到端: Next.js + Nuxt 混合', async () => {
  await withTmpProject({
    'app/api/health/route.ts': `export async function GET() { return { ok: true }; }`,
    'server/api/items.get.ts': `export default async function () { return []; }`,
    'utils/other.ts': `export function POST() {}`,
  }, (dm) => {
    const endpoints = dm.Method.filter(m => m.endpointInfo);
    assert.equal(endpoints.length, 2);
    const fws = endpoints.map(m => m.endpointInfo.framework).sort();
    assert.deepEqual(fws, ['next-app-router', 'nuxt']);
  });
});
