// Python 实体测试：pythonAnalyzer 事实提取（class/继承/元类/def/装饰器/dunder/import/路由/入口点）
// 适配 pr_agent 蓝图（pr_agent/agent/pr_agent.py → analyze_file 风格的轻量化快照）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePythonFile, analyzePythonFileFromDisk, isPythonCandidate } from '../src/analyzers/pythonAnalyzer.js';
import { scanProject } from '../src/analyzers/projectScanner.js';
import { buildOntologyData } from '../src/ontology/builder.js';

// ---- 单元级：pythonAnalyzer 事实提取 ----

test('isPythonCandidate：.py 后缀识别（.pyc 排除）', () => {
  assert.equal(isPythonCandidate('src/foo.py'), true);
  assert.equal(isPythonCandidate('src/foo.pyc'), false);
  assert.equal(isPythonCandidate('src/foo.pyi'), false);
  assert.equal(isPythonCandidate('src/foo.ts'), false);
});

test('pythonAnalyzer：class（bases/metaclass/decorator/field/dunder 方法合并/语言标记）', () => {
  const realContent = [
    '"""Module docstring."""',
    'from __future__ import annotations',
    '',
    '@dataclasses.dataclass',
    'class GameInfo(metaclass=Meta):',
    '    """Game metadata."""',
    '    name: str',
    '    appid: int = 0',
    '    _private: str = ""',
    '',
    '    def __init__(self, name: str) -> None:',
    '        self.name = name',
    '',
    '    def __repr__(self) -> str:',
    '        return f"GameInfo(name={self.name!r})"',
    '',
    '    @property',
    '    def display_name(self) -> str:',
    '        return self.name',
    '',
    '    @staticmethod',
    '    def from_dict(data: dict) -> "GameInfo":',
    '        return GameInfo(name=data["name"])',
    '',
    '    @classmethod',
    '    def empty(cls) -> "GameInfo":',
    '        return cls(name="")',
    '',
    '    @abstractmethod',
    '    def save(self) -> None:',
    '        ...',
    '',
    '    def fetch(self) -> int:',
    '        return self.appid',
  ].join('\n');

  const facts = analyzePythonFile('app/models.py', realContent);
  assert.equal(facts.ext, 'py');
  assert.equal(facts.language, 'python');
  // module docstring
  assert.ok(facts.pythonModuleDocstring.includes('Module docstring'));
  // 1 个 class GameInfo
  assert.equal(facts.classes.length, 1);
  const cls = facts.classes[0];
  assert.equal(cls.name, 'GameInfo');
  assert.equal(cls.kind, 'class');
  assert.equal(cls.language, 'python');
  assert.equal(cls.exported, true);
  assert.equal(cls.metaclassName, 'Meta');
  // bases 顺序保留（单基类时 baseClass = bases[0]）
  assert.deepEqual(cls.bases, []);
  assert.equal(cls.extendsName, null);
  // 字段：name, appid（_private 以 _ 开头排除）
  assert.deepEqual(cls.fields.map((f) => f.name), ['name', 'appid']);
  assert.equal(cls.fields.find((f) => f.name === 'appid').type, 'int');
  // 方法
  const methodNames = cls.methods.map((m) => m.name);
  assert.deepEqual(methodNames, ['__init__', '__repr__', 'display_name', 'from_dict', 'empty', 'save', 'fetch']);
  // dunder 标记
  const init = cls.methods.find((m) => m.name === '__init__');
  assert.equal(init.isDunder, true);
  assert.equal(init.dunderCategory, 'init');
  // @property / @staticmethod / @classmethod / @abstractmethod 装饰器分类
  const prop = cls.methods.find((m) => m.name === 'display_name');
  assert.equal(prop.isProperty, true);
  const fromDict = cls.methods.find((m) => m.name === 'from_dict');
  assert.equal(fromDict.isStatic, true);
  const empty = cls.methods.find((m) => m.name === 'empty');
  assert.equal(empty.isClass, true);
  const save = cls.methods.find((m) => m.name === 'save');
  assert.equal(save.isAbstract, true);
  // 类装饰器（@dataclasses.dataclass → 末段 dataclass）
  const classDecos = cls.decorators.map((d) => d.name);
  assert.ok(classDecos.includes('dataclass'));
  assert.equal(facts.exportNames.includes('GameInfo'), true);
});

test('pythonAnalyzer：class 继承（多基类 / 泛型 / metaclass 抽取）', () => {
  const content = [
    'from abc import ABC, abstractmethod',
    '',
    'class MyService(BaseService, Generic[T], metaclass=SingletonMeta):',
    '    pass',
    '',
    'class Concrete(ABC):',
    '    @abstractmethod',
    '    def handle(self) -> None: ...',
  ].join('\n');
  const facts = analyzePythonFile('svc.py', content);
  // MyService 1 个 class
  const svc = facts.classes.find((c) => c.name === 'MyService');
  assert.ok(svc);
  assert.deepEqual(svc.bases, ['BaseService', 'Generic']);
  assert.equal(svc.metaclassName, 'SingletonMeta');
  // Concrete 继承 ABC 且有 @abstractmethod → 应进 interfaces
  const iface = facts.interfaces.find((i) => i.name === 'Concrete');
  assert.ok(iface);
  assert.equal(iface.language, 'python');
  assert.deepEqual(iface.extendsNames, ['ABC']);
  assert.deepEqual(iface.methods.map((m) => m.name), ['handle']);
});

test('pythonAnalyzer：import 提取（import / from / as / wildcard / 相对导入）', () => {
  const content = [
    'import os',
    'import sys as system',
    'from pathlib import Path',
    'from typing import List, Dict as Mapping, Optional',
    'from . import utils',
    'from ..models import GameInfo',
    'from package import *',
    'from collections import (',
    '    OrderedDict,',
    '    defaultdict as dd,',
    '    *',
    ')',
  ].join('\n');
  const facts = analyzePythonFile('app/importer.py', content);
  // importMap：local → specifier
  assert.equal(facts.importMap.get('os'), 'os');
  assert.equal(facts.importMap.get('system'), 'sys');
  assert.equal(facts.importMap.get('Path'), 'pathlib');
  assert.equal(facts.importMap.get('List'), 'typing');
  assert.equal(facts.importMap.get('Mapping'), 'typing'); // as 别名 local=Mapping → spec=typing
  assert.equal(facts.importMap.get('Optional'), 'typing');
  assert.equal(facts.importMap.get('utils'), '.'); // 相对导入
  assert.equal(facts.importMap.get('GameInfo'), '..models');
  assert.equal(facts.importMap.get('OrderedDict'), 'collections');
  assert.equal(facts.importMap.get('dd'), 'collections');
  // wildcard 不进 importMap（避免覆盖具名）
  assert.equal(facts.importMap.has('*'), false);
  // imports 列表
  assert.equal(facts.imports.length >= 9, true);
});

test('pythonAnalyzer：模块级 def / async def / 装饰器 / docstring / 调用链', () => {
  const content = [
    'def public_helper(x: int) -> str:',
    '    """Convert int to str."""',
    '    return str(x)',
    '',
    'async def fetch_game(appid: int) -> dict:',
    '    data = await client.get(f"/games/{appid}")',
    '    return data.json()',
    '',
    '@functools.lru_cache(maxsize=128)',
    'def cached_lookup(key: str) -> int:',
    '    return expensive(key)',
    '',
    '_private_fn = lambda x: x * 2',
  ].join('\n');
  const facts = analyzePythonFile('app/utils.py', content);
  // 顶层 def（含 async、装饰器）
  const fnNames = facts.moduleFunctions.map((f) => f.name);
  assert.ok(fnNames.includes('public_helper'));
  assert.ok(fnNames.includes('fetch_game'));
  assert.ok(fnNames.includes('cached_lookup'));
  // public_helper 导出，_private_fn 不算
  const pub = facts.moduleFunctions.find((f) => f.name === 'public_helper');
  assert.equal(pub.exported, true);
  assert.equal(pub.returnType, 'str');
  assert.ok(pub.docstring.includes('Convert int to str'));
  // async 标记
  const fetch = facts.moduleFunctions.find((f) => f.name === 'fetch_game');
  assert.equal(fetch.isAsync, true);
  // 装饰器
  const cached = facts.moduleFunctions.find((f) => f.name === 'cached_lookup');
  assert.equal(cached.decorators.length, 1);
  assert.equal(cached.decorators[0].name, 'lru_cache');
  // 调用链：fetch_game 含 client.get → callEdges 至少有 fetch_game → [{to: 'get', owner: 'client', kind: 'pkg'}]
  const fetchEdge = facts.callEdges.find((e) => e.from === 'fetch_game');
  assert.ok(fetchEdge);
  const getCall = fetchEdge.to.find((c) => c.to === 'get' && c.owner === 'client');
  assert.ok(getCall);
});

test('pythonAnalyzer：__all__ 导出 / __main__ 入口 / CLI 入口（@app.command）', () => {
  const content = [
    '"""Tools package."""',
    '__all__ = ["load", "save", "GameInfo"]',
    '',
    'def load() -> None: ...',
    'def save() -> None: ...',
    'class GameInfo: ...',
    '',
    'if __name__ == "__main__":',
    '    main()',
    '',
    '@app.command()',
    'def cli() -> None:',
    '    """CLI entry."""',
    '    run()',
  ].join('\n');
  const facts = analyzePythonFile('app/__main__.py', content);
  // __all__
  assert.deepEqual(facts.pythonExports, ['load', 'save', 'GameInfo']);
  // __main__ 入口
  assert.equal(facts.pythonEntryPoints.some((e) => e.kind === '__main__'), true);
  // CLI 入口
  assert.equal(facts.pythonEntryPoints.some((e) => e.kind === 'cli' && e.handler === 'cli'), true);
});

test('pythonAnalyzer：FastAPI / Flask / aiohttp 路由提取', () => {
  const content = [
    'from fastapi import FastAPI, APIRouter',
    '',
    'app = FastAPI()',
    'router = APIRouter()',
    '',
    '@app.get("/games")',
    'async def list_games() -> list:',
    '    return get_all_games()',
    '',
    '@app.post("/games")',
    'async def create_game(payload: dict) -> dict:',
    '    return save(payload)',
    '',
    '@router.delete("/games/{appid}")',
    'def delete_game(appid: int) -> None:',
    '    remove(appid)',
    '',
    '@app.route("/legacy", methods=["GET", "POST"])',
    'def legacy_view() -> str:',
    '    return "ok"',
  ].join('\n');
  const facts = analyzePythonFile('app/api.py', content);
  assert.equal(facts.pythonRoutes.length, 4);
  const listRoute = facts.pythonRoutes.find((r) => r.path === '/games' && r.method === 'GET');
  assert.ok(listRoute);
  assert.equal(listRoute.handler, 'list_games');
  assert.equal(listRoute.target, 'app');
  const delRoute = facts.pythonRoutes.find((r) => r.path === '/games/{appid}' && r.method === 'DELETE');
  assert.ok(delRoute);
  assert.equal(delRoute.handler, 'delete_game');
  const legacyRoute = facts.pythonRoutes.find((r) => r.path === '/legacy');
  assert.ok(legacyRoute);
  // Flask methods=[GET,POST] 取首个 → GET
  assert.equal(legacyRoute.method, 'GET');
});

test('pythonAnalyzer：噪声剥离（f-string 插值 / 三引号 / 字节串 / 注释）', () => {
  // f-string 内的 {} 不应被误判为块结构
  const content = [
    'def make_url(base: str, appid: int) -> str:',
    '    """Make URL with f-string interpolation."""',
    '    return f"{base}/games/{appid}/details?ref={"x"}"',
    '',
    'def parse(text: str) -> dict:',
    '    """Parse with triple-quoted regex."""',
    '    pattern = """',
    '    \\d+://[a-z]+',  // 此处含冒号，不应影响 def 后的 :
    '    """',
    '    return {"ok": True}',
  ].join('\n');
  const facts = analyzePythonFile('app/parser.py', content);
  // 两个顶层 def 都应被识别（f-string 与三引号内的 : 不破坏 def 头）
  const fnNames = facts.moduleFunctions.map((f) => f.name);
  assert.ok(fnNames.includes('make_url'));
  assert.ok(fnNames.includes('parse'));
});

test('pythonAnalyzer：f-string 内的伪类定义不误报（噪声剥离健壮性）', () => {
  // f-string 内出现形如 class Foo: 的字符串字面量——剥离后应为空
  const content = [
    'def gen() -> str:',
    '    return f"""',
    '    class Fake{{}}:',  // {{ }} 是字面量
    '        pass',
    '    """',
  ].join('\n');
  const facts = analyzePythonFile('app/fstring.py', content);
  // f-string 内的 class Fake: 是字面量，不应作为真实 class 声明
  const fakes = facts.classes.filter((c) => c.name === 'Fake');
  assert.equal(fakes.length, 0);
});

test('pythonAnalyzer：nameReferences 全文标识符位置（与 rust/dart 同 shape）', () => {
  const content = [
    'def alpha():',
    '    return beta()',
    '',
    'def gamma():',
    '    return alpha() + beta()',
  ].join('\n');
  const facts = analyzePythonFile('app/refs.py', content);
  // alpha 引用位置：声明（def alpha）+ gamma() 内调用 → 至少 2 处
  const alphaRefs = facts.nameReferences.get('alpha');
  assert.ok(alphaRefs);
  assert.ok(alphaRefs.length >= 2);
  // beta 引用位置：alpha() 内 + gamma() 内 → 2 处
  const betaRefs = facts.nameReferences.get('beta');
  assert.ok(betaRefs);
  assert.ok(betaRefs.length >= 2);
});

test('pythonAnalyzer：类方法调用链（self.method / cls.method / 跨方法）', () => {
  const content = [
    'class Calc:',
    '    def add(self, a, b):',
    '        return a + b',
    '',
    '    def sum_all(self, values):',
    '        total = self.add(0, 0)',
    '        for v in values:',
    '            total = self.add(total, v)',
    '        return total',
    '',
    '    def external(self, x):',
    '        return helper(x) + self.add(x, 1)',
  ].join('\n');
  const facts = analyzePythonFile('app/calc.py', content);
  const calc = facts.classes.find((c) => c.name === 'Calc');
  assert.ok(calc);
  // Calc.sum_all 体内有 self.add → callEdges 应有 Calc.sum_all → [{to:'add', kind:'self'}]
  const sumAllEdge = facts.callEdges.find((e) => e.from === 'Calc.sum_all');
  assert.ok(sumAllEdge, 'Calc.sum_all 应有调用链');
  const addCalls = sumAllEdge.to.filter((c) => c.to === 'add' && c.kind === 'self');
  assert.ok(addCalls.length >= 1, 'Calc.sum_all 体内应至少 1 次 self.add');
  // Calc.external 体内有 helper(...) 与 self.add(...) → 两类调用
  const externalEdge = facts.callEdges.find((e) => e.from === 'Calc.external');
  assert.ok(externalEdge);
  assert.ok(externalEdge.to.some((c) => c.to === 'helper' && c.kind === 'local'));
  assert.ok(externalEdge.to.some((c) => c.to === 'add' && c.kind === 'self'));
  // Calc.add 体内无调用（仅 a + b 表达式）
  const addEdge = facts.callEdges.find((e) => e.from === 'Calc.add');
  if (addEdge) assert.equal(addEdge.to.length, 0);
});

test('pythonAnalyzer：__all__ 只接受字符串字面量（变量名 / 数字 / 函数调用跳过）', () => {
  const content = [
    '"""Tools."""',
    '__all__ = ["load", "save"]',
    '__all__ = (load_name, save_name)  # 变量形式不应进入',
    '__all__ = [42, 100]  # 数字不应进入',
  ].join('\n');
  const facts = analyzePythonFile('app/exporter.py', content);
  // 变量名 load_name / save_name / 数字 42 / 100 不在结果里
  assert.ok(!facts.pythonExports.includes('load_name'));
  assert.ok(!facts.pythonExports.includes('save_name'));
  assert.ok(!facts.pythonExports.includes('42'));
  assert.ok(!facts.pythonExports.includes('100'));
  // 字符串字面量 load / save 进入
  assert.ok(facts.pythonExports.includes('load'));
  assert.ok(facts.pythonExports.includes('save'));
});

test('pythonAnalyzer：SQLAlchemy 2.0 Mapped[T] 字段 + relationship 外键 + __tablename__', () => {
  const content = [
    'from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship',
    '',
    'class Base(DeclarativeBase):',
    '    pass',
    '',
    'class User(Base):',
    '    __tablename__ = "user"',
    '    id: Mapped[int] = mapped_column(primary_key=True)',
    '    username: Mapped[str] = mapped_column(nullable=False)',
    '    oauth_accounts: Mapped[list[OAuthAccount]] = relationship(',
    '        "OAuthAccount", lazy="joined"',
    '    )',
    '    role: Mapped[UserRole] = mapped_column(',
    '        Enum(UserRole, native_enum=False, default=UserRole.BASIC)',
    '    )',
    '    # 内部状态',
    '    _cache: dict = {}',
  ].join('\n');
  const facts = analyzePythonFile('app/models.py', content);
  const user = facts.classes.find((c) => c.name === 'User');
  assert.ok(user);
  assert.equal(user.tableName, 'user');
  assert.deepEqual(user.ormHints, ['sqlalchemy-table']);
  // 字段：id / username / oauth_accounts / role（含跨行）；_cache 排除
  const names = user.fields.map((f) => f.name);
  assert.ok(names.includes('id'));
  assert.ok(names.includes('username'));
  assert.ok(names.includes('oauth_accounts'));
  assert.ok(names.includes('role'));
  assert.ok(!names.includes('_cache'));
  // 字段 kind 标注
  const id = user.fields.find((f) => f.name === 'id');
  assert.equal(id.kind, 'column');
  assert.match(id.type, /Mapped\[int\]/);
  const oauth = user.fields.find((f) => f.name === 'oauth_accounts');
  assert.equal(oauth.kind, 'relation');
  assert.match(oauth.type, /Mapped\[list\[OAuthAccount\]\]/);
  // relationship 抽取外键目标：OAuthAccount
  assert.equal(oauth.target, 'OAuthAccount');
});

test('pythonAnalyzer：跨行续行字段（多行 mapped_column / relationship）', () => {
  const content = [
    'class Item(Base):',
    '    __tablename__ = "item"',
    '    # 跨 4 行的 mapped_column 声明',
    '    name: Mapped[str] = mapped_column(',
    '        String(50),',
    '        nullable=False,',
    '        unique=True,',
    '    )',
    '    # 跨 2 行的 relationship',
    '    owner: Mapped["User"] = relationship(',
    '        "User", back_populates="items"',
    '    )',
  ].join('\n');
  const facts = analyzePythonFile('app/models.py', content);
  const item = facts.classes.find((c) => c.name === 'Item');
  assert.ok(item);
  assert.equal(item.tableName, 'item');
  const names = item.fields.map((f) => f.name);
  // 跨行字段被合并为单一逻辑行后应正确识别
  assert.ok(names.includes('name'), '跨 4 行 mapped_column 应被识别为 name 字段');
  assert.ok(names.includes('owner'), '跨 2 行 relationship 应被识别为 owner 字段');
  const owner = item.fields.find((f) => f.name === 'owner');
  assert.equal(owner.kind, 'relation');
  assert.equal(owner.target, 'User');
});

// ---- 端到端：扫描集成 ----

const MAIN_PY = [
  '"""Demo Python project."""',
  '__all__ = ["App", "run"]',
  '',
  'class App:',
  '    """App entry."""',
  '    def __init__(self, name: str) -> None:',
  '        self.name = name',
  '',
  '    def start(self) -> None:',
  '        self._setup()',
  '',
  '    def _setup(self) -> None:',
  '        pass',
  '',
  'def run() -> None:',
  '    """Run the app."""',
  '    app = App(name="demo")',
  '    app.start()',
  '',
  'if __name__ == "__main__":',
  '    run()',
].join('\n');

async function buildPythonFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-py-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'py-demo', version: '0.1.0' }));
  fs.writeFileSync(path.join(dir, 'src/app.py'), MAIN_PY);
  const dataMap = await buildOntologyData(dir);
  return { dir, dataMap };
}

test('扫描：.py 文件被识别为源码并参与 counts（pyFileCount）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-py-scan-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'py-host', version: '0.1.0' }));
  fs.writeFileSync(path.join(dir, 'src/app.py'), MAIN_PY);
  fs.writeFileSync(path.join(dir, 'src/util.py'), 'def helper() -> int:\n    return 1\n');
  fs.writeFileSync(path.join(dir, 'src/index.ts'), 'export const x = 1;');
  const scan = scanProject(dir);
  assert.ok(scan.files.includes('src/app.py'));
  assert.ok(scan.files.includes('src/util.py'));
  assert.equal(scan.pyFileCount, 2);
  assert.equal(scan.tsFileCount, 1);
});

test('端到端：Python class + def + __main__ 入快照（kind/language/fields/methods/entryPoints）', async () => {
  const { dataMap } = await buildPythonFixture();
  // App class
  const app = dataMap.Class.find((c) => c.name === 'App');
  assert.ok(app, 'App 应被提取为 Class 实体');
  assert.equal(app.kind, 'class');
  assert.equal(app.language, 'python');
  // App 的 methodIds 数量（__init__, start, _setup）
  const appMethods = dataMap.Method.filter((m) => app.methodIds.includes(m.id));
  const methodNames = appMethods.map((m) => m.name);
  assert.ok(methodNames.includes('__init__'));
  assert.ok(methodNames.includes('start'));
  assert.ok(methodNames.includes('_setup'));
  // 顶层 def run 进 dataMap.Method（ownerKind=module）
  const runFn = dataMap.Method.find((m) => m.name === 'run' && m.ownerKind === 'module');
  assert.ok(runFn, 'run 顶层函数应入 Method 表');
  // 项目画像：含 Python
  const proj = dataMap.Project[0];
  assert.equal(proj.pyFileCount, 1);
  assert.ok(proj.language.includes('Python'));
});

test('端到端：FastAPI 路由 + SQLAlchemy 表 + 关系字段 → dataMap.Route / Class.tableName / fields.kind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-py-orm-'));
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'py-orm-demo', version: '0.1.0' }));
  // SQLAlchemy 2.0 models
  fs.writeFileSync(path.join(dir, 'app/models.py'), [
    'from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship',
    '',
    'class Base(DeclarativeBase):',
    '    pass',
    '',
    'class User(Base):',
    '    __tablename__ = "user"',
    '    id: Mapped[int] = mapped_column(primary_key=True)',
    '    username: Mapped[str] = mapped_column(nullable=False)',
    '    posts: Mapped[list[Post]] = relationship("Post", back_populates="user")',
    '',
    'class Post(Base):',
    '    __tablename__ = "post"',
    '    id: Mapped[int] = mapped_column(primary_key=True)',
    '    title: Mapped[str] = mapped_column()',
    '    user_id: Mapped[int] = mapped_column()',
    '    user: Mapped[User] = relationship("User", back_populates="posts")',
  ].join('\n'));
  // FastAPI routes
  fs.writeFileSync(path.join(dir, 'app/api.py'), [
    'from fastapi import APIRouter',
    'from app.models import User, Post',
    '',
    'router = APIRouter(prefix="/api")',
    '',
    '@router.get("/users")',
    'def list_users() -> list:',
    '    return []',
    '',
    '@router.post("/users")',
    'async def create_user(name: str) -> dict:',
    '    return {}',
    '',
    '@router.get("/users/{user_id}")',
    'def get_user(user_id: int) -> dict:',
    '    return {}',
  ].join('\n'));
  const dataMap = await buildOntologyData(dir);
  // SQLAlchemy 表
  const user = dataMap.Class.find((c) => c.name === 'User');
  assert.ok(user);
  assert.equal(user.tableName, 'user');
  assert.deepEqual(user.bases, ['Base']);
  // 字段：id / username / posts
  const idField = user.fields.find((f) => f.name === 'id');
  assert.equal(idField.kind, 'column');
  const postsField = user.fields.find((f) => f.name === 'posts');
  assert.equal(postsField.kind, 'relation');
  assert.equal(postsField.target, 'Post');
  // 路由
  const routes = dataMap.Route ?? [];
  assert.ok(routes.length >= 3, `应至少 3 条路由，实际 ${routes.length}`);
  const listRoute = routes.find((r) => r.routePath === '/api/users' && r.apiMethods === 'GET');
  assert.ok(listRoute, 'FastAPI 前缀 /api 应正确合并到 /users');
  assert.equal(listRoute.routeType, 'python');
  // 动态段路由
  const getRoute = routes.find((r) => r.routePath === '/api/users/{user_id}');
  assert.ok(getRoute);
  assert.equal(getRoute.isDynamic, true);
});

// ============================================================
// v0.39.0 Python 解析增强：缩进感知 / ROS 2 / launch / main 入口
// ============================================================

test('pythonAnalyzer v0.39.0：parseClassFields 缩进感知（方法体局部变量不再误报为类字段）', () => {
  // bug 复现：旧版会把 cli/topic/colmon/req 等方法体里 self.x = ... 误判为类字段
  // 真实情况（dock_trigger.py 缩位）：70 个方法、0 个真正的类级字段
  const src = [
    'class Big:',
    '    def __init__(self):',
    '        colmon = str(self.get_parameter("x").value)',
    '        topic = self.goal_pose_pub.topic_name',
    '        cli = self._gate_cli',
    '        req = SetBool.Request()',
    '        future = cli.call_async(req)',
    '        for i in range(10):',
    '            t0 = time.time()',
    '            if t0 > 0:',
    '                deadline = 1.0',
    '                resp = future.result()',
    '',
    '    def cb(self, msg):',
    '        out = msg.header',
    '        n = len(msg.ranges)',
    '        ranges = list(msg.ranges)',
    '        return out',
  ].join('\n');
  const facts = analyzePythonFile('ros.py', src);
  const cls = facts.classes[0];
  assert.equal(cls.name, 'Big');
  // 关键断言：方法体里的局部变量不应被识别为类字段
  assert.equal(cls.fields.length, 0, `方法体局部变量不应误报为类字段，实际 ${cls.fields.length}`);
});

test('pythonAnalyzer v0.39.0：ROS 2 Node 类检测（Node / LifecycleNode / ComposableNode 基类）', () => {
  const src = [
    'import rclpy',
    'from rclpy.node import Node',
    'from rclpy.lifecycle.node import LifecycleNode',
    '',
    'class MyNode(Node):',
    '    def __init__(self):',
    '        super().__init__("my_node")',
    '',
    'class MyLife(LifecycleNode):',
    '    pass',
    '',
    'class MyComp(ComposableNode):',
    '    pass',
    '',
    'class NotARosClass:',
    '    pass',
  ].join('\n');
  const facts = analyzePythonFile('ros.py', src);
  assert.equal(facts.ros2NodeClasses.length, 3, `应识别 3 个 ROS 2 节点类，实际 ${facts.ros2NodeClasses.length}`);
  const byName = Object.fromEntries(facts.ros2NodeClasses.map((n) => [n.name, n]));
  assert.equal(byName.MyNode.rosHint, 'ros2-node');
  assert.equal(byName.MyLife.rosHint, 'ros2-lifecycle-node');
  assert.equal(byName.MyComp.rosHint, 'ros2-composable-node');
  // ormHints 同步
  const clsByName = Object.fromEntries(facts.classes.map((c) => [c.name, c]));
  assert.ok(clsByName.MyNode.ormHints.includes('ros2-node'));
  assert.ok(clsByName.MyNode.ormHints.includes('ros2-node-name:my_node'));
  // NotARosClass 不应在 ros2NodeClasses
  assert.equal(facts.ros2NodeClasses.find((n) => n.name === 'NotARosClass'), undefined);
});

test('pythonAnalyzer v0.39.0：ROS 2 通信通道抽取（pub/sub/service/timer/parameter）', () => {
  const src = [
    'import rclpy',
    'from rclpy.node import Node',
    'from sensor_msgs.msg import LaserScan',
    'from std_srvs.srv import SetBool',
    '',
    'class Filter(Node):',
    '    def __init__(self):',
    '        super().__init__("filter")',
    '        self.declare_parameter("scan_in", "/scan")',
    '        self.declare_parameter("close_max", 0.40)',
    '        self.pub = self.create_publisher(LaserScan, "scan_out", 10)',
    '        self.sub = self.create_subscription(LaserScan, "scan_in", self.cb, 10)',
    '        self.cli = self.create_client(SetBool, "set_enabled")',
    '        self.srv = self.create_service(SetBool, "do_thing", self._handler)',
    '        self.timer = self.create_timer(0.1, self._tick)',
    '',
    '    def _handler(self, req, resp):',
    '        return resp',
    '',
    '    def _tick(self):',
    '        pass',
    '',
    '    def cb(self, m):',
    '        self.pub.publish(m)',
  ].join('\n');
  const facts = analyzePythonFile('filter.py', src);
  const nc = facts.ros2NodeClasses[0];
  assert.equal(nc.rosHint, 'ros2-node');
  const ch = nc.channels;
  // publishers
  assert.equal(ch.publishers.length, 1);
  assert.equal(ch.publishers[0].msgType, 'LaserScan');
  assert.equal(ch.publishers[0].topic, 'scan_out');
  // subscribers
  assert.equal(ch.subscribers.length, 1);
  assert.equal(ch.subscribers[0].msgType, 'LaserScan');
  assert.equal(ch.subscribers[0].topic, 'scan_in');
  assert.equal(ch.subscribers[0].callback, 'self.cb');
  // services
  assert.equal(ch.services.length, 1);
  assert.equal(ch.services[0].srvType, 'SetBool');
  // clients
  assert.equal(ch.clients.length, 1);
  assert.equal(ch.clients[0].srvType, 'SetBool');
  // timers
  assert.equal(ch.timers.length, 1);
  assert.equal(ch.timers[0].period, '0.1');
  assert.equal(ch.timers[0].callback, 'self._tick');
  // parameters
  assert.equal(ch.parameters.length, 2);
  const byName = Object.fromEntries(ch.parameters.map((p) => [p.name, p]));
  assert.equal(byName.scan_in.default, '/scan');
  assert.equal(byName.close_max.default, '0.40');
});

test('pythonAnalyzer v0.39.0：ROS 2 launch 文件检测（Node/Argument/Include/Process）', () => {
  const src = [
    'from launch import LaunchDescription',
    'from launch.actions import DeclareLaunchArgument, ExecuteProcess',
    'from launch.substitutions import LaunchConfiguration',
    'from launch_ros.actions import Node',
    '',
    'def generate_launch_description():',
    '    use_rviz = LaunchConfiguration("use_rviz")',
    '    ld = LaunchDescription([',
    '        DeclareLaunchArgument(',
    '            "use_rviz", default_value="true",',
    '            description="Start RViz"),',
    '        ExecuteProcess(cmd=["ros2", "bag", "play", "data"]),',
    '        Node(',
    '            package="rviz2", executable="rviz2", name="rviz2",',
    '            output="screen"),',
    '        Node(',
    '            package="rplidar_ros", executable="rplidar_composition",',
    '            name="rplidar"),',
    '    ])',
    '    return ld',
  ].join('\n');
  const facts = analyzePythonFile('rviz.launch.py', src);
  assert.ok(facts.pythonLaunch);
  assert.equal(facts.pythonLaunch.isLaunch, true);
  assert.equal(facts.pythonLaunch.entry, 'generate_launch_description');
  assert.equal(facts.pythonLaunch.nodes.length, 2);
  const rplidar = facts.pythonLaunch.nodes.find((n) => n.name === 'rplidar');
  assert.ok(rplidar);
  assert.equal(rplidar.package, 'rplidar_ros');
  assert.equal(rplidar.executable, 'rplidar_composition');
  assert.equal(facts.pythonLaunch.args.length, 1);
  assert.equal(facts.pythonLaunch.args[0].name, 'use_rviz');
  assert.equal(facts.pythonLaunch.executeProcess.length, 1);
  // entry 注入入口点
  assert.ok(facts.pythonEntryPoints.some((e) => e.kind === 'launch'));
});

test('pythonAnalyzer v0.39.0：launch 文件带 IncludeLaunchDescription 嵌套', () => {
  const src = [
    'import os',
    'from launch import LaunchDescription',
    'from launch.actions import IncludeLaunchDescription',
    'from launch.launch_description_sources import PythonLaunchDescriptionSource',
    '',
    'def generate_launch_description():',
    '    return LaunchDescription([',
    '        IncludeLaunchDescription(',
    '            PythonLaunchDescriptionSource(os.path.join("pkg", "launch", "nav_launch.py"))',
    '        ),',
    '    ])',
  ].join('\n');
  const facts = analyzePythonFile('bringup.launch.py', src);
  assert.equal(facts.pythonLaunch.includeLaunch.length, 1);
  assert.ok(facts.pythonLaunch.includeLaunch[0].path.includes('nav_launch.py'));
});

test('pythonAnalyzer v0.39.0：非 launch 文件 pythonLaunch 为 null', () => {
  const src = 'class Foo:\n    pass\n';
  const facts = analyzePythonFile('foo.py', src);
  assert.equal(facts.pythonLaunch, null);
});

test('pythonAnalyzer v0.39.0：def main() 入口点检测（无 __main__ 守卫也能识别）', () => {
  const src = [
    'def helper():',
    '    return 1',
    '',
    'def main():',
    '    node = helper()',
    '    print(node)',
  ].join('\n');
  const facts = analyzePythonFile('main_only.py', src);
  const mainEntry = facts.pythonEntryPoints.find((e) => e.kind === 'main');
  assert.ok(mainEntry, '应识别 def main() 为入口点');
  assert.equal(mainEntry.handler, 'main');
  // __main__ 守卫缺失 → 没有 __main__ 入口
  const mm = facts.pythonEntryPoints.find((e) => e.kind === '__main__');
  assert.equal(mm, undefined);
});

test('pythonAnalyzer v0.39.0：def main() 与 if __name__ 守卫并存不重复', () => {
  const src = [
    'def main():',
    '    pass',
    '',
    'if __name__ == "__main__":',
    '    main()',
  ].join('\n');
  const facts = analyzePythonFile('both.py', src);
  const entries = facts.pythonEntryPoints.filter((e) => e.kind === 'main' || e.kind === '__main__');
  // 期望：__main__（来自守卫）+ main（来自 def main()）= 2 个，但 main 不重复添加（已有 __main__ 时）
  // 实际行为：main 仅在无 __main__ 守卫时添加 → 应当 1 个 __main__
  // 这里验证 main 入口不重复
  const mains = entries.filter((e) => e.kind === 'main');
  assert.equal(mains.length, 0, '已存在 __main__ 守卫时不重复加 main 入口');
  const mms = entries.filter((e) => e.kind === '__main__');
  assert.equal(mms.length, 1);
});

test('pythonAnalyzer v0.39.0：带参数或装饰器的 main 不当作入口（避免误报）', () => {
  const src = [
    'def main(argv):',
    '    print(argv)',
    '',
    '@click.command()',
    'def main():',
    '    pass',
  ].join('\n');
  const facts = analyzePythonFile('param_main.py', src);
  const mainEntries = facts.pythonEntryPoints.filter((e) => e.kind === 'main');
  assert.equal(mainEntries.length, 0, '带参数或有装饰器的 def main() 不应作 main 入口');
});
