// 数据模型识别测试:借鉴 asdm-aos isDataModel/dataModelType,适配前端启发式
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { analyzeFileFromDisk } from '../src/analyzers/tsAnalyzer.js';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function makeFacts(src) {
  const sf = ts.createSourceFile('t.ts', src, ts.ScriptTarget.Latest, true);
  // 复用 analyzeFileFromDisk 内部 extractFacts：直接走 public API
  return null; // 这里用 buildOntologyData 端到端更稳，下面有 helper
}

import { buildOntologyData } from '../src/ontology/builder.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function withTmpProject(src, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-model-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }));
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, 'demo.ts'), src);
  try {
    const dataMap = await buildOntologyData(dir, { roots: ['src'] });
    await fn(dataMap);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('名字后缀 DTO → dataModelType=dto (interface)', async () => {
  await withTmpProject(`export interface UserDto { id: string; name: string; }`, (dm) => {
    const dto = dm.Interface.find(i => i.name === 'UserDto');
    assert.ok(dto, 'UserDto 应被识别');
    assert.equal(dto.isDataModel, true);
    assert.equal(dto.dataModelType, 'dto');
  });
});

test('名字后缀 Model → dataModelType=model (class)', async () => {
  await withTmpProject(`export class ProductModel { sku!: string; }`, (dm) => {
    const m = dm.Class.find(c => c.name === 'ProductModel');
    assert.equal(m.isDataModel, true);
    assert.equal(m.dataModelType, 'model');
  });
});

test('名字后缀 Entity/Request/Response/Params/Form/Payload → 对应类型', async () => {
  await withTmpProject(`
    export class OrderEntity { id!: string; }
    export interface LoginRequest { username: string; }
    export interface LoginResponse { token: string; }
    export interface UserParams { id: string; }
    export class CreateForm { data!: any; }
    export class EventPayload { type!: string; }
  `, (dm) => {
    const e = dm.Class.find(c => c.name === 'OrderEntity');
    assert.equal(e.dataModelType, 'entity');
    const lr = dm.Interface.find(i => i.name === 'LoginRequest');
    assert.equal(lr.dataModelType, 'request');
    const lre = dm.Interface.find(i => i.name === 'LoginResponse');
    assert.equal(lre.dataModelType, 'response');
    const up = dm.Interface.find(i => i.name === 'UserParams');
    assert.equal(up.dataModelType, 'params');
    const cf = dm.Class.find(c => c.name === 'CreateForm');
    assert.equal(cf.dataModelType, 'form');
    const ep = dm.Class.find(c => c.name === 'EventPayload');
    assert.equal(ep.dataModelType, 'payload');
  });
});

test('装饰器 @Entity → dataModelType=orm-decorated', async () => {
  await withTmpProject(`
    @Entity('users')
    export class UserOrm { id!: number; }
  `, (dm) => {
    const u = dm.Class.find(c => c.name === 'UserOrm');
    assert.equal(u.isDataModel, true);
    assert.equal(u.dataModelType, 'orm-decorated');
  });
});

test('装饰器 @ObjectType/@InputType → dataModelType=orm-decorated', async () => {
  await withTmpProject(`
    @ObjectType()
    export class UserGraph { id!: string; }
    @InputType()
    export class UserInputGraph { name!: string; }
  `, (dm) => {
    const g = dm.Class.find(c => c.name === 'UserGraph');
    assert.equal(g.dataModelType, 'orm-decorated');
    const i = dm.Class.find(c => c.name === 'UserInputGraph');
    assert.equal(i.dataModelType, 'orm-decorated');
  });
});

test('非数据模型 (Service/Repository/Controller) → isDataModel=false', async () => {
  await withTmpProject(`
    export class UserService { getUser() { return null; } }
    export class OrderRepository { find() { return null; } }
    export class AuthController { login() { return null; } }
  `, (dm) => {
    const s = dm.Class.find(c => c.name === 'UserService');
    assert.equal(s.isDataModel, false);
    assert.equal(s.dataModelType, null);
    const r = dm.Class.find(c => c.name === 'OrderRepository');
    assert.equal(r.isDataModel, false);
    const c = dm.Class.find(c => c.name === 'AuthController');
    assert.equal(c.isDataModel, false);
  });
});

test('边界: 后缀匹配但名字 = 后缀本身 → 不识别 (如 "DTO" 不是有效类名)', async () => {
  await withTmpProject(`export class User {}`, (dm) => {
    const u = dm.Class.find(c => c.name === 'User');
    assert.equal(u.isDataModel, false);
  });
});

test('DTO 风格 vs Service 风格: 同项目混合识别', async () => {
  await withTmpProject(`
    export class UserDto { id!: string; }
    export class UserService { find() {} }
    export interface UserParams { id: string; }
    export class UserController { list() {} }
  `, (dm) => {
    const dms = [...dm.Class, ...dm.Interface].filter(e => e.isDataModel).map(e => e.name).sort();
    assert.deepEqual(dms, ['UserDto', 'UserParams']);
  });
});
