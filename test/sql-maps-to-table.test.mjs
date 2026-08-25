// DataModel ↔ DB Table 链接测试:借鉴 asdm-aos mapperMapsTable
// 适配:方法体里的 SQL 字符串提取表名 + 命名约定匹配 + mappedFromCode 反向
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';
import { createBlueprint } from '../src/ontology/blueprint.js';

async function withTmpProject(codeFiles, opts = {}, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-mt-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  for (const [rel, content] of Object.entries(codeFiles)) {
    const full = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  try {
    const dm = await buildOntologyData(dir, { roots: ['src'] });
    // 注入 Table(模拟 db scan 合并)
    if (opts.tables) dm.Table = opts.tables;
    await fn(dm);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TABLES = [
  { id: 'table:users', name: 'users' },
  { id: 'table:orders', name: 'orders' },
  { id: 'table:products', name: 'products' },
];

test('SELECT FROM users → method.sqlQueries 含 kind=SELECT, table=users', async () => {
  await withTmpProject({
    'api/users.ts': `export function getUser() { return query("SELECT * FROM users WHERE id = 1"); }`,
  }, {}, (dm) => {
    const m = dm.Method.find(m => m.name === 'getUser');
    assert.ok(m);
    assert.equal(m.sqlQueries.length, 1);
    assert.equal(m.sqlQueries[0].kind, 'SELECT');
    assert.equal(m.sqlQueries[0].table, 'users');
    assert.equal(m.sqlQueries[0].dynamic, false);
  });
});

test('INSERT INTO orders → method.sqlQueries 含 INSERT', async () => {
  await withTmpProject({
    'api/orders.ts': `export function createOrder() { return query("INSERT INTO orders (total) VALUES (10)"); }`,
  }, {}, (dm) => {
    const m = dm.Method.find(m => m.name === 'createOrder');
    assert.equal(m.sqlQueries[0].kind, 'INSERT');
    assert.equal(m.sqlQueries[0].table, 'orders');
  });
});

test('UPDATE users / DELETE FROM products → 正确识别', async () => {
  await withTmpProject({
    'api/mixed.ts': `
      export function updateUser() { return query("UPDATE users SET name = 'x'"); }
      export function deleteProduct() { return query("DELETE FROM products WHERE id = 1"); }
    `,
  }, {}, (dm) => {
    const u = dm.Method.find(m => m.name === 'updateUser');
    assert.equal(u.sqlQueries[0].kind, 'UPDATE');
    const d = dm.Method.find(m => m.name === 'deleteProduct');
    assert.equal(d.sqlQueries[0].kind, 'DELETE');
  });
});

test('动态 SQL(模板字符串含 ${}) → 标 dynamic=true', async () => {
  await withTmpProject({
    'api/dyn.ts': `export function getByTable(name: string) { return query(\`SELECT * FROM \${name}\`); }`,
  }, {}, (dm) => {
    const m = dm.Method.find(m => m.name === 'getByTable');
    // 动态场景:table 名是 ${name},应被识别但 dynamic=true
    assert.ok(m.sqlQueries.length > 0);
    assert.equal(m.sqlQueries[0].dynamic, true);
  });
});

test('mapsToTable: Method → Table', async () => {
  await withTmpProject({
    'api/users.ts': `export function getUser() { return query("SELECT * FROM users"); }`,
  }, { tables: TABLES }, (dm) => {
    const bp = createBlueprint(dm);
    const m = dm.Method.find(m => m.name === 'getUser');
    const targets = bp.link('mapsToTable', m.id);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].id, 'table:users');
  });
});

test('mapsToTable: 命名约定(类名 UserEntity → table:users)', async () => {
  await withTmpProject({
    'models/user.ts': `export class UserEntity { id!: number; }`,
  }, { tables: TABLES }, (dm) => {
    const bp = createBlueprint(dm);
    const cls = dm.Class.find(c => c.name === 'UserEntity');
    const targets = bp.link('mapsToTable', cls.id);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].name, 'users');
  });
});

test('mapsToTable: 命名约定(类名 Product → table:products)', async () => {
  await withTmpProject({
    'models/product.ts': `export class Product { id!: number; }`,
  }, { tables: TABLES }, (dm) => {
    const bp = createBlueprint(dm);
    const cls = dm.Class.find(c => c.name === 'Product');
    const targets = bp.link('mapsToTable', cls.id);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].name, 'products');
  });
});

test('mappedFromCode: Table → Method 反向链接', async () => {
  await withTmpProject({
    'api/users.ts': `export function getUser() { return query("SELECT * FROM users"); }`,
    'api/orders.ts': `export function createOrder() { return query("INSERT INTO orders (total) VALUES (10)"); }`,
  }, { tables: TABLES }, (dm) => {
    const bp = createBlueprint(dm);
    const usersSrcs = bp.link('mappedFromCode', 'table:users');
    assert.equal(usersSrcs.length, 1);
    assert.equal(usersSrcs[0].name, 'getUser');
    const ordersSrcs = bp.link('mappedFromCode', 'table:orders');
    assert.equal(ordersSrcs.length, 1);
    assert.equal(ordersSrcs[0].name, 'createOrder');
  });
});

test('向后兼容: 旧代码(无 sqlQueries / mappedTableIds)→ 返回空', async () => {
  await withTmpProject({
    'no-sql.ts': `export function helper() { return 42; }`,
  }, { tables: TABLES }, (dm) => {
    const bp = createBlueprint(dm);
    const m = dm.Method.find(m => m.name === 'helper');
    const targets = bp.link('mapsToTable', m.id);
    assert.equal(targets.length, 0);
  });
});

test('向后兼容: 空快照(无 Table)→ mapsToTable 不报错', async () => {
  await withTmpProject({
    'users.ts': `export function getUser() { return query("SELECT * FROM users"); }`,
  }, {}, (dm) => {
    // 不注入 Table,模拟纯代码快照
    const bp = createBlueprint(dm);
    const m = dm.Method.find(m => m.name === 'getUser');
    const targets = bp.link('mapsToTable', m.id);
    // 无 Table → 不抛错,返回空
    assert.equal(targets.length, 0);
  });
});

test('端到端: 同一函数多 SQL → 多 Table 链接', async () => {
  await withTmpProject({
    'api/multi.ts': `export function syncData() {
      query("SELECT * FROM users");
      query("SELECT * FROM orders");
      query("SELECT * FROM products");
    }`,
  }, { tables: TABLES }, (dm) => {
    const bp = createBlueprint(dm);
    const m = dm.Method.find(m => m.name === 'syncData');
    const targets = bp.link('mapsToTable', m.id);
    assert.equal(targets.length, 3);
    const names = targets.map(t => t.name).sort();
    assert.deepEqual(names, ['orders', 'products', 'users']);
  });
});
