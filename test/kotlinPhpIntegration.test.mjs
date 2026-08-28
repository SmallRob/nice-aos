// Kotlin / PHP 端到端集成测试：临时 fixture 项目 → buildOntologyData 全链路 →
// Trait 对象 / usesTrait 链接 / PHP 路由（routeType=php）/ 架构层归层 / 语言计数。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';
import { createBlueprint } from '../src/ontology/blueprint.js';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-kotlin-php-'));
  // Kotlin 侧（okhttp 形态抽样）
  fs.mkdirSync(path.join(root, 'src', 'main', 'kotlin', 'com', 'example'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build.gradle.kts'), 'plugins { kotlin("jvm") }\n');
  fs.writeFileSync(path.join(root, 'src', 'main', 'kotlin', 'com', 'example', 'Client.kt'), `package com.example

interface Call {
    fun execute(): String
}

class HttpClient(private val baseUrl: String) : Call {
    override fun execute(): String = "GET " + baseUrl

    suspend fun executeAsync(): String = execute()
}
`);
  // PHP 侧（zentaopms module 形态抽样）
  fs.mkdirSync(path.join(root, 'module', 'bug'), { recursive: true });
  fs.writeFileSync(path.join(root, 'composer.json'), JSON.stringify({ name: 'zentao/sample', require: {} }));
  fs.writeFileSync(path.join(root, 'module', 'bug', 'model.php'), `<?php
class bugModel extends model
{
    public function getById($id)
    {
        return $this->dao->select('*')->from(TABLE_BUG)->where('id', $id)->fetch();
    }
}
`);
  fs.writeFileSync(path.join(root, 'module', 'bug', 'control.php'), `<?php
class bug extends control
{
    public function browse($productID = 0)
    {
        $this->view->bugs = array();
        $this->display();
    }
}
`);
  fs.mkdirSync(path.join(root, 'module', 'user'), { recursive: true });
  fs.writeFileSync(path.join(root, 'module', 'user', 'trait.php'), `<?php
trait SingletonTrait
{
    public static function instance()
    {
        return new self();
    }
}
`);
  fs.writeFileSync(path.join(root, 'module', 'user', 'model.php'), `<?php
class userModel extends model
{
    use SingletonTrait;

    public function find($id)
    {
        return $this->dao->select('*')->from(TABLE_USER)->fetch();
    }
}
`);
  return root;
}

test('端到端：Kotlin + PHP fixture → buildOntologyData 全链路', async () => {
  const root = makeFixture();
  try {
    const dataMap = await buildOntologyData(root, { report: () => {} });
    const _meta = dataMap._meta ?? {};

    // 1. 文件计数：kotlinFileCount / phpFileCount
    const project = dataMap.Project[0];
    assert.ok(project.kotlinFileCount >= 1, 'kotlinFileCount 统计');
    assert.ok(project.phpFileCount >= 3, 'phpFileCount 统计');
    // 框架检测暴露（与 goDetected / flutterDetected 对齐）
    assert.equal(project.kotlinDetected, true, 'kotlinDetected 暴露到 Project');
    assert.equal(project.phpDetected, true, 'phpDetected 暴露到 Project');
    assert.equal(project.goDetected, false, '非 Go 项目 goDetected=false');
    // 语言画像
    assert.ok(project.language.includes('Kotlin'));
    assert.ok(project.language.includes('PHP'));

    // 2. Kotlin 实体：HttpClient（bases=Call）+ 接口 Call + 方法
    const classes = dataMap.Class ?? [];
    const httpClient = classes.find((c) => c.name === 'HttpClient');
    assert.ok(httpClient, 'HttpClient 类进入 dataMap.Class');
    assert.equal(httpClient.language, 'kotlin');
    assert.equal(httpClient.kind, 'class');
    const callIface = (dataMap.Interface ?? []).find((i) => i.name === 'Call');
    assert.ok(callIface, 'Call 接口进入 dataMap.Interface');
    // Kotlin 方法：execute / executeAsync（suspend → isAsync）
    const methods = dataMap.Method ?? [];
    const ktExecute = methods.find((m) => m.name === 'execute' && m.ownerName === 'HttpClient');
    assert.ok(ktExecute, 'HttpClient.execute 方法');
    const ktAsync = methods.find((m) => m.name === 'executeAsync');
    assert.ok(ktAsync, 'HttpClient.executeAsync 方法');
    assert.equal(ktAsync.isAsync, true, 'suspend fun 标记 isAsync');

    // 3. PHP 实体：bugModel（isDataModel）+ bug（isController）
    const bugModel = classes.find((c) => c.name === 'bugModel');
    assert.ok(bugModel, 'bugModel 进入 dataMap.Class');
    assert.equal(bugModel.isDataModel, true);
    assert.equal(bugModel.language, 'php');
    const bugCtrl = classes.find((c) => c.name === 'bug');
    assert.ok(bugCtrl, 'bug 控制器进入 dataMap.Class');
    assert.equal(bugCtrl.isController, true);

    // 4. Trait 对象 + usesTrait/usedByTrait 双向链接
    const traits = dataMap.Trait ?? [];
    const singleton = traits.find((t) => t.name === 'SingletonTrait');
    assert.ok(singleton, 'SingletonTrait 进入 dataMap.Trait');
    assert.ok(singleton.methodIds.length >= 1, 'trait 方法挂 methodIds');
    const userModel = classes.find((c) => c.name === 'userModel');
    assert.ok(userModel, 'userModel 进入 dataMap.Class');
    assert.ok(userModel.usesTraitIds.includes(singleton.id), 'userModel.usesTraitIds 含 SingletonTrait');
    assert.ok(singleton.usedByIds.includes(userModel.id), 'SingletonTrait.usedByIds 含 userModel');

    // 5. blueprint 链接消费：usesTrait / usedByTrait
    const bp = createBlueprint(dataMap);
    const used = bp.link('usesTrait', userModel.id);
    assert.equal(used.length, 1);
    assert.equal(used[0].id, singleton.id);
    const users = bp.link('usedByTrait', singleton.id);
    assert.equal(users.length, 1);
    assert.equal(users[0].id, userModel.id);
    // contains：file: → trait
    const fileChildren = bp.link('contains', `file:${singleton.filePath}`);
    assert.ok(fileChildren.some((o) => o.id === singleton.id), 'contains(file) 含 trait 对象');

    // 6. PHP 路由：/bug-browse（routeType=php）
    const routes = dataMap.Route ?? [];
    const browseRoute = routes.find((r) => r.routePath === '/bug-browse');
    assert.ok(browseRoute, 'browse 方法生成 /bug-browse 路由');
    assert.equal(browseRoute.routeType, 'php');
    assert.equal(browseRoute.componentFileId, 'file:module/bug/control.php');
    // handler Method 关联：bug#browse
    assert.ok(browseRoute.componentId, '路由关联 handler Method');

    // 7. 架构层：control.php → presentation；model.php → service
    const files = dataMap.SourceFile ?? [];
    const controlFile = files.find((f) => f.path === 'module/bug/control.php');
    assert.equal(controlFile.archLayer, 'presentation');
    const modelFile = files.find((f) => f.path === 'module/bug/model.php');
    assert.equal(modelFile.archLayer, 'service');

    // 8. objectCounts 记账
    assert.ok(_meta.objectCounts.Trait >= 1, 'objectCounts.Trait 记账');

    // 9. 不崩溃且有解析产出（analysisError 不含 Kotlin/PHP 文件）
    assert.ok((dataMap.SourceFile ?? []).length >= 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
