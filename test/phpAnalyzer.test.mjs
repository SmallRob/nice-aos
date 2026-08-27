// PHP 实体分析器单元测试：class/interface/trait 实体 / extends model|control 语义 /
// 方法与修饰（static/abstract/visibility）/ 属性 / trait use / namespace 归一 / use 导入 /
// control.php 路由生成（zentaopms 惯例）/ 死代码契约（nameReferences）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePhpFile, isPhpCandidate } from '../src/analyzers/phpAnalyzer.js';

const ZENTAO_MODEL = `<?php
class bugModel extends model
{
    public function create($bug, $from = '')
    {
        $this->dao->insert(TABLE_BUG)->data($bug)->autoCheck()->exec();
        return $bugID;
    }

    public static function getById(int $id): ?object
    {
        return null;
    }

    private function checkPriv()
    {
        return true;
    }
}
`;

const ZENTAO_CONTROL = `<?php
class bug extends control
{
    public function __construct()
    {
        parent::__construct();
        $this->loadModel('product');
        $this->loadLang('bug');
    }

    public function browse($productID = 0, $branch = '')
    {
        $this->view->bugs = array();
        $this->display();
    }

    public function create()
    {
        $this->display();
    }
}
`;

const TRAIT_SAMPLE = `<?php
trait SingletonTrait
{
    public static function instance()
    {
        return new self();
    }
}

class UserService extends model
{
    use SingletonTrait;

    public $id;
    public string $name;

    public function find($id)
    {
        return $this->dao->select('*')->from(TABLE_USER)->where('id = ' . $id)->fetch();
    }
}
`;

test('isPhpCandidate：.php 命中，.blade.php 不命中', () => {
  assert.ok(isPhpCandidate('module/bug/model.php'));
  assert.ok(isPhpCandidate('src/index.php'));
  assert.ok(!isPhpCandidate('resources/views/home.blade.php'));
  assert.ok(!isPhpCandidate('src/Foo.kt'));
});

test('analyzePhpFile：extends model → isDataModel + kind=data_model', () => {
  const facts = analyzePhpFile('module/bug/model.php', ZENTAO_MODEL);
  assert.equal(facts.classes.length, 1);
  const cls = facts.classes[0];
  assert.equal(cls.name, 'bugModel');
  assert.deepEqual(cls.extendsNames, ['model']);
  assert.deepEqual(cls.bases, ['model']);
  assert.equal(cls.isDataModel, true);
  assert.equal(cls.kind, 'data_model');
  assert.equal(cls.language, 'php');
});

test('analyzePhpFile：方法提取（visibility/static/构造器）', () => {
  const facts = analyzePhpFile('module/bug/model.php', ZENTAO_MODEL);
  const methods = facts.classes[0].methods;
  const names = methods.map((m) => m.name);
  assert.deepEqual(names.sort(), ['checkPriv', 'create', 'getById']);
  const getById = methods.find((m) => m.name === 'getById');
  assert.equal(getById.isStatic, true);
  assert.equal(getById.visibility, 'public');
  assert.ok(getById.signature.includes('getById('));
  assert.ok(getById.signature.includes(': ?object'));
  const checkPriv = methods.find((m) => m.name === 'checkPriv');
  assert.equal(checkPriv.visibility, 'private');
});

test('analyzePhpFile：control.php → Route 生成（zentaopms 惯例）', () => {
  const facts = analyzePhpFile('module/bug/control.php', ZENTAO_CONTROL);
  const cls = facts.classes[0];
  assert.equal(cls.isController, true);
  assert.equal(cls.kind, 'controller');
  // 路由：__construct 不算（构造器）；browse/create 各一条
  const paths = facts.routes.map((r) => r.path);
  assert.ok(paths.includes('/bug-browse'), 'browse 路由');
  assert.ok(paths.includes('/bug-create'), 'create 路由');
  assert.ok(!paths.some((p) => p.includes('__construct')), '构造器不生成路由');
  const browseRoute = facts.routes.find((r) => r.handler === 'browse');
  assert.equal(browseRoute.routeType, 'php');
  assert.equal(browseRoute.module, 'bug');
});

test('analyzePhpFile：非 control.php 文件不生成路由', () => {
  const facts = analyzePhpFile('module/bug/model.php', ZENTAO_MODEL);
  assert.equal(facts.routes.length, 0);
});

test('analyzePhpFile：trait 实体 + class usesTraits', () => {
  const facts = analyzePhpFile('module/user/model.php', TRAIT_SAMPLE);
  assert.equal(facts.traits.length, 1);
  const tr = facts.traits[0];
  assert.equal(tr.name, 'SingletonTrait');
  assert.equal(tr.kind, 'trait');
  assert.ok(tr.methods.some((m) => m.name === 'instance'));
  const cls = facts.classes[0];
  assert.equal(cls.name, 'UserService');
  assert.deepEqual(cls.usesTraits, ['SingletonTrait']);
  // 属性提取
  const propNames = cls.properties.map((p) => p.name);
  assert.deepEqual(propNames.sort(), ['id', 'name']);
});

test('analyzePhpFile：namespace 归一 + use 导入（含群组）', () => {
  const src = [
    '<?php',
    'namespace App\\Lib\\Core;',
    'use Foo\\Bar;',
    'use Baz\\{ Qux, Quux as Q };',
    'class Boot {}',
  ].join('\n');
  const facts = analyzePhpFile('Boot.php', src);
  assert.equal(facts.moduleName, 'App.Lib.Core');
  const specifiers = facts.imports.map((i) => i.specifier);
  assert.ok(specifiers.includes('Foo\\Bar'));
  assert.ok(specifiers.includes('Baz\\Qux'));
  assert.ok(specifiers.includes('Baz\\Quux'));
  assert.equal(facts.importMap.get('Q'), 'Baz\\Quux');
});

test('analyzePhpFile：字符串/注释噪声剥离（DAO 链中的字符串不产生幽灵实体）', () => {
  const noisy = [
    '<?php',
    '// class GhostOne {}',
    '/* class GhostTwo {} */',
    'class Real {',
    '    public function run()',
    '    {',
    "        $msg = 'class Fake { function ghost() {} }';",
    '        return $msg;',
    '    }',
    '}',
  ].join('\n');
  const facts = analyzePhpFile('Real.php', noisy);
  assert.deepEqual(facts.classes.map((c) => c.name), ['Real']);
  const methods = facts.classes[0].methods.map((m) => m.name);
  assert.deepEqual(methods, ['run']);
});

test('analyzePhpFile：interface / abstract class / implements', () => {
  const src = [
    '<?php',
    'interface Repository {',
    '    public function find($id);',
    '}',
    'abstract class BaseRepo implements Repository {',
    '    abstract protected function find($id);',
    '}',
  ].join('\n');
  const facts = analyzePhpFile('Repo.php', src);
  assert.equal(facts.interfaces.length, 1);
  const iface = facts.interfaces[0];
  assert.equal(iface.name, 'Repository');
  assert.ok(iface.methods.some((m) => m.name === 'find'));
  const base = facts.classes[0];
  assert.equal(base.name, 'BaseRepo');
  assert.equal(base.isAbstract, true);
  assert.deepEqual(base.implementsNames, ['Repository']);
  const abstractFind = base.methods.find((m) => m.name === 'find');
  assert.equal(abstractFind.isAbstract, true);
});

test('analyzePhpFile：死代码契约（nameReferences + exportNames）', () => {
  const facts = analyzePhpFile('module/bug/model.php', ZENTAO_MODEL);
  assert.ok(facts.nameReferences.has('bugModel'));
  assert.ok(facts.nameReferences.has('TABLE_BUG'));
  assert.ok(facts.exportNames.includes('bugModel'));
});

test('analyzePhpFile：DAO 链与跨模块引用（Phase-1 不抽取，字段为空数组契约）', () => {
  const facts = analyzePhpFile('module/bug/control.php', ZENTAO_CONTROL);
  // Phase-1：DAO/loadModel 抽取移交 builder 通道；analyzer 输出稳定契约（空数组）
  assert.deepEqual(facts.sqlQueries, []);
  assert.deepEqual(facts.crossModuleImports, []);
});
