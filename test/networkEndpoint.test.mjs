// v0.41.0 统一 NetworkEndpoint 测试：
//   1. analyzer：Python HTTP 客户端 URL 抽取（`%` 格式化表达式 / f-string 前缀修复）
//   2. builder：Python outbound 端点建实体 + 跨文件聚合（v0.40.0 遗留的孤儿 fact 接进本体）
//   3. 实体模型：direction / lang / lib 三字段（油猴与 Python 同构）
//   4. incrementalParser：.py 变更加入 NetworkEndpoint 失效类型
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePythonFile } from '../src/analyzers/pythonAnalyzer.js';
import { buildOntologyData, buildSingleFileOntology } from '../src/ontology/builder.js';
import { exportToMarkdown } from '../src/ontology/exporter.js';
import { defaultTypesForFile } from '../src/analyzers/incrementalParser.js';

// ---- 1. analyzer 层：URL 抽取 ----

test('pythonAnalyzer：HTTP 客户端 URL 抽取（普通串 / % 格式化 / f-string / urllib）', () => {
  const src = [
    'import requests',
    '',
    'def main(idrac_ip, host):',
    '    requests.get("https://api.example.com/v1/users")',
    '    requests.get("https://%s/redfish/v1/Systems" % idrac_ip)',
    '    requests.get(f"https://{host}/redfish/v1/Chassis")',
    '    requests.get(rf"https://{host}/redfish/v1/Managers")',
    '    urllib.request.urlopen("https://legacy.example.com/v0")',
  ].join('\n');
  const f = analyzePythonFile('client.py', src);
  const urls = f.httpClientCalls.map((c) => c.url);
  // v0.41.0 修复：v0.40.0 会把 `" % idrac_ip` 一并留在 url 里
  assert.ok(urls.includes('https://api.example.com/v1/users'));
  assert.ok(urls.includes('https://%s/redfish/v1/Systems'), JSON.stringify(urls));
  assert.ok(urls.includes('https://{host}/redfish/v1/Chassis'), JSON.stringify(urls));
  assert.ok(urls.includes('https://{host}/redfish/v1/Managers'), JSON.stringify(urls));
  assert.ok(urls.includes('https://legacy.example.com/v0'));
  // 断言不存在被污染的 URL（v0.40.0 的 bug 形态）
  assert.equal(urls.some((u) => u.includes('% idrac_ip')), false, JSON.stringify(urls));
  assert.equal(urls.some((u) => u.startsWith('f"')), false, JSON.stringify(urls));
});

test('pythonAnalyzer：hasAuth / hasJson / hasData 请求特征标记', () => {
  const src = [
    'import requests',
    '',
    'def main():',
    '    requests.post("https://api.example.com/a", json={})',
    '    requests.post("https://api.example.com/b", auth=(u, p))',
    '    requests.post("https://api.example.com/c", data=b"x")',
  ].join('\n');
  const f = analyzePythonFile('client.py', src);
  const byPath = Object.fromEntries(f.httpClientCalls.map((c) => [c.url.slice(-1), c]));
  assert.equal(byPath.a.hasJson, true);
  assert.equal(byPath.a.hasAuth, false);
  assert.equal(byPath.b.hasAuth, true);
  assert.equal(byPath.c.hasData, true);
});

// ---- 2. builder 单文件模式 ----

const SINGLE_PY = [
  'import requests',
  'import httpx',
  '',
  'def fetch_users():',
  '    requests.get("https://api.example.com/v1/users")',
  '    requests.delete("https://api.example.com/v1/users/42", auth=(u, p))',
  '',
  'def fetch_orders():',
  '    httpx.get("https://api.example.com/v2/orders")',
].join('\n');

test('builder 单文件模式：Python 文件产出 outbound NetworkEndpoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-net-single-'));
  const file = path.join(dir, 'client.py');
  fs.writeFileSync(file, SINGLE_PY);
  const dm = await buildSingleFileOntology(file);

  const nets = dm.NetworkEndpoint ?? [];
  assert.equal(nets.length, 3, JSON.stringify(nets.map((n) => n.id)));
  assert.equal(dm._meta.objectCounts.NetworkEndpoint, 3);

  for (const n of nets) {
    assert.equal(n.direction, 'outbound');
    assert.equal(n.lang, 'python');
    assert.equal(n.kind, 'http-client');
    // 油猴专有字段在 Python 侧置 null，维持两端实体同构
    assert.equal(n.scriptId, null);
    assert.equal(n.allowedByConnect, null);
    assert.equal(n.filePath, 'client.py');
    assert.deepEqual(n.fileIds, ['file:client.py']);
  }

  const get = nets.find((n) => n.methods[0] === 'GET' && n.url.endsWith('/v1/users'));
  assert.equal(get.lib, 'requests');
  assert.equal(get.domain, 'api.example.com');
  assert.equal(get.hasAuth, false);

  const del = nets.find((n) => n.methods[0] === 'DELETE');
  assert.equal(del.hasAuth, true);
  assert.equal(del.callCount, 1);

  const orders = nets.find((n) => n.url.endsWith('/v2/orders'));
  assert.equal(orders.lib, 'httpx');
});

test('builder 单文件模式：非 Python 文件不产出 NetworkEndpoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-net-none-'));
  const file = path.join(dir, 'plain.py');
  fs.writeFileSync(file, 'def helper():\n    return 1\n');
  const dm = await buildSingleFileOntology(file);
  assert.deepEqual(dm.NetworkEndpoint, []);
});

// ---- 3. builder 全仓库模式：跨文件聚合 ----

const CLIENT_A = [
  'import requests',
  '',
  'def fetch():',
  '    requests.get("https://api.example.com/v1/users")',
  '    requests.post("https://api.example.com/v1/users", json={"name": "x"})',
  '    requests.get("https://%s/redfish/v1/Systems" % ip)',
].join('\n');

const CLIENT_B = [
  'import requests',
  'import httpx',
  '',
  'def refresh():',
  '    requests.get("https://api.example.com/v1/users")',
  '    httpx.get("https://api.example.com/v2/orders")',
].join('\n');

async function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-net-repo-'));
  fs.mkdirSync(path.join(dir, 'clients'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'clients', 'a.py'), CLIENT_A);
  fs.writeFileSync(path.join(dir, 'clients', 'b.py'), CLIENT_B);
  const dataMap = await buildOntologyData(dir);
  return dataMap;
}

test('builder 全仓库：同一 (method, url) 跨文件聚合为单个端点', async () => {
  const dm = await buildFixture();
  const nets = dm.NetworkEndpoint ?? [];

  const shared = nets.find((n) => n.methods[0] === 'GET' && n.url === 'https://api.example.com/v1/users');
  assert.ok(shared, JSON.stringify(nets.map((n) => `${n.methods[0]} ${n.url}`)));
  // 两个文件各调一次 → 聚合成 1 个端点，callCount 累加
  assert.equal(shared.callCount, 2);
  assert.deepEqual(shared.files.sort(), ['clients/a.py', 'clients/b.py']);
  assert.equal(shared.fileIds.length, 2);
  assert.equal(shared.lines.length, 2);
  assert.equal(shared.direction, 'outbound');
  assert.equal(shared.lang, 'python');

  // POST 与 GET 同 URL 但方法不同 → 独立端点
  const post = nets.find((n) => n.methods[0] === 'POST');
  assert.ok(post);
  assert.notEqual(post.id, shared.id);

  // 不同 lib 调用不同端点 → lib 分别标记
  const orders = nets.find((n) => n.url.endsWith('/v2/orders'));
  assert.equal(orders.lib, 'httpx');

  // 带插值占位符的 URL 原样保留（v0.42.0 再做占位符归一化）
  const redfish = nets.find((n) => n.url.includes('/redfish/v1/Systems'));
  assert.ok(redfish, JSON.stringify(nets.map((n) => n.url)));
  assert.equal(redfish.url, 'https://%s/redfish/v1/Systems');
});

test('builder 全仓库：端点 id 唯一且稳定（不依赖扫描顺序）', async () => {
  const dm = await buildFixture();
  const ids = (dm.NetworkEndpoint ?? []).map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, `id 存在重复: ${JSON.stringify(ids)}`);
  for (const id of ids) assert.ok(id.startsWith('net:out:'), id);
});

test('builder 全仓库：v0.41.0 不做函数级归属（fns 留空，避免误报）', async () => {
  const dm = await buildFixture();
  for (const n of dm.NetworkEndpoint ?? []) {
    assert.deepEqual(n.fns, []);
    assert.deepEqual(n.fnIds, []);
  }
});

// ---- 4. 实体模型同构：油猴侧 direction ----

test('油猴端点带 direction=outbound / lang=javascript（与 Python 端点同构）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-net-us-'));
  const file = path.join(dir, 'demo.user.js');
  fs.writeFileSync(file, [
    '// ==UserScript==',
    '// @name         Demo',
    '// @namespace    http://example.com/',
    '// @version      1.0',
    '// @match        https://example.com/*',
    '// @connect      api.example.com',
    '// @grant        GM_xmlhttpRequest',
    '// ==/UserScript==',
    '(function () {',
    "  GM_xmlhttpRequest({ method: 'GET', url: 'https://api.example.com/v1/ping' });",
    '})();',
  ].join('\n'));
  const dm = await buildSingleFileOntology(file);
  const nets = dm.NetworkEndpoint ?? [];
  assert.ok(nets.length > 0, '油猴端点应被抽取');
  for (const n of nets) {
    assert.equal(n.direction, 'outbound');
    assert.equal(n.lang, 'javascript');
    assert.equal(n.lib, null);
    assert.equal(n.scriptName, 'Demo');
    assert.ok(n.scriptId);
    assert.deepEqual(n.files, ['demo.user.js']);
  }
});

// ---- 5. exporter 混排渲染 ----

test('exporter：油猴与 Python 端点混排渲染，同 URL 不同方法不重行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-net-md-'));
  fs.writeFileSync(path.join(dir, 'demo.user.js'), [
    '// ==UserScript==',
    '// @name         Demo',
    '// @namespace    http://example.com/',
    '// @version      1.0',
    '// @match        https://example.com/*',
    '// @connect      api.example.com',
    '// @grant        GM_xmlhttpRequest',
    '// ==/UserScript==',
    '(function () {',
    "  GM_xmlhttpRequest({ method: 'GET', url: 'https://api.example.com/v1/ping' });",
    '})();',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'client.py'), [
    'import requests',
    '',
    'def main():',
    '    requests.get("https://api.example.com/v1/users")',
    '    requests.post("https://api.example.com/v1/users", json={})',
  ].join('\n'));
  const dm = await buildOntologyData(dir);
  const md = exportToMarkdown(dm);
  const section = md.slice(md.indexOf('网络请求与请求劫持'));
  // 来源列：油猴取 scriptName，Python 取 filePath
  assert.ok(section.includes('| Demo |'), '油猴端点应显示脚本名');
  assert.ok(section.includes('| client.py | requests 客户端 | GET |'), 'Python GET 端点缺失');
  assert.ok(section.includes('| client.py | requests 客户端 | POST |'), 'Python POST 端点缺失');
  // 无 method 列时 GET/POST 会渲染成两行完全相同的"重复行"
  const rows = section.split('\n').filter((l) => l.includes('| client.py |'));
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0], rows[1]);
});

// ---- 6. incrementalParser 失效类型 ----

test('incrementalParser：.py 变更触发 NetworkEndpoint 重建', () => {
  const types = defaultTypesForFile('clients/a.py');
  assert.ok(types.includes('NetworkEndpoint'), JSON.stringify(types));
});

test('incrementalParser：非 .py 文件不触发 NetworkEndpoint', () => {
  for (const f of ['src/app.ts', 'main.go', 'lib.rs']) {
    assert.equal(defaultTypesForFile(f).includes('NetworkEndpoint'), false, f);
  }
});
