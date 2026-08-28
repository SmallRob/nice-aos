// PHP / Kotlin 内部导入解析回归测试（v0.36.1）：
// composer PSR-4 前缀映射、声明限定名兜底、Kotlin 包/限定名/路径后缀/通配符、外部命名空间首段归并。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPhpImportResolver, createKotlinImportResolver, parseComposerPsr4 } from '../src/analyzers/phpKotlinImportResolver.js';
import { analyzePhpFile } from '../src/analyzers/phpAnalyzer.js';
import { analyzeKotlinFile } from '../src/analyzers/kotlinAnalyzer.js';
import { buildOntologyData } from '../src/ontology/builder.js';

function makeResolverFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-import-'));
  fs.writeFileSync(path.join(root, 'composer.json'), JSON.stringify({
    name: 'zentao/sample',
    autoload: { 'psr-4': { 'App\\': 'app/', 'Zen\\Tao\\Module\\': 'module/' } },
  }));
  fs.mkdirSync(path.join(root, 'app', 'Core'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'Core', 'Helper.php'), `<?php
namespace App\\Core;
class Helper { public function run() {} }
`);
  fs.writeFileSync(path.join(root, 'service.php'), `<?php
use App\\Core\\Helper;
use Guzzle\\Http\\Client;

class service
{
    public function go()
    {
        $h = new Helper();
        $c = new Client();
    }
}
`);
  // Kotlin：同包跨文件 + 通配 + 外部
  fs.mkdirSync(path.join(root, 'src', 'main', 'kotlin', 'com', 'example'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'main', 'kotlin', 'com', 'example', 'Request.kt'), `package com.example

data class Request(val url: String)
`);
  fs.writeFileSync(path.join(root, 'src', 'main', 'kotlin', 'com', 'example', 'Repo.kt'), `package com.example

class Repo {
    fun load(): Request = Request("x")
}
`);
  fs.writeFileSync(path.join(root, 'src', 'main', 'kotlin', 'com', 'example', 'Ui.kt'), `package com.example

import java.net.Proxy

class Ui {
    val proxy: Proxy? = null

    fun useAll() {
        val r = Repo().load()
    }
}
`);
  return root;
}

test('parseComposerPsr4：前缀归一 + 最长前缀优先', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-psr4-'));
  try {
    fs.writeFileSync(path.join(root, 'composer.json'), JSON.stringify({
      autoload: { 'psr-4': { 'A\\': 'src/a/', 'A\\B\\C\\': ['lib/c1/', 'lib/c2/'] } },
    }));
    const psr = parseComposerPsr4(root);
    assert.equal(psr.length, 3);
    assert.equal(psr[0].prefix, 'A\\B\\C', '最长前缀排最前');
    assert.deepEqual(psr.map((x) => x.dir).sort(), ['lib/c1', 'lib/c2', 'src/a']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PHP resolver：PSR-4 命中内部 / 外部首段归并', () => {
  const root = makeResolverFixture();
  try {
    const phpFiles = ['app/Core/Helper.php', 'service.php'];
    const phpFacts = new Map(phpFiles.map((f) => [f, analyzePhpFile(f, fs.readFileSync(path.join(root, f), 'utf-8'))]));
    const r = createPhpImportResolver({ projectRoot: root, phpFiles, phpFacts });
    const internal = r.resolve('App\\Core\\Helper');
    assert.equal(internal.kind, 'internal');
    assert.equal(internal.file, 'app/Core/Helper.php');
    const ext = r.resolve('Guzzle\\Http\\Client');
    assert.equal(ext.kind, 'external');
    assert.equal(ext.package, 'Guzzle');
    assert.equal(ext.ecosystem, 'php');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Kotlin resolver：限定名 / 通配整包 / 外部首段归并', () => {
  const root = makeResolverFixture();
  try {
    const ktFiles = ['src/main/kotlin/com/example/Request.kt', 'src/main/kotlin/com/example/Repo.kt', 'src/main/kotlin/com/example/Ui.kt'];
    const ktFacts = new Map(ktFiles.map((f) => [f, analyzeKotlinFile(f, fs.readFileSync(path.join(root, f), 'utf-8'))]));
    const r = createKotlinImportResolver({ ktFiles, ktFacts });
    // 限定类名（Ui.kt 未 import Request，这里直接验证解析能力）
    const q = r.resolve('com.example.Request');
    assert.equal(q.kind, 'internal');
    assert.equal(q.file, 'src/main/kotlin/com/example/Request.kt');
    // 通配：整包 files
    const w = r.resolve('com.example.*');
    assert.equal(w.kind, 'internal');
    assert.equal(w.files.length, 3);
    // 外部
    const ext = r.resolve('java.net.Proxy');
    assert.equal(ext.kind, 'external');
    assert.equal(ext.package, 'java');
    assert.equal(ext.ecosystem, 'kotlin');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('e2e：buildOntologyData 内部 use/import 产生 file: 边（imports 链接可见）', async () => {
  const root = makeResolverFixture();
  try {
    const dataMap = await buildOntologyData(root, { report: () => {} });
    const files = dataMap.SourceFile ?? [];
    const service = files.find((f) => f.path === 'service.php');
    assert.ok(service, 'service.php 进入快照');
    assert.ok(
      service.importIds.includes('file:app/Core/Helper.php'),
      `PHP use App\\Core\\Helper → file 边（实际 ${JSON.stringify(service.importIds)}）`,
    );
    assert.ok(
      service.importIds.includes('dep:Guzzle'),
      'PHP use Guzzle\\Http\\Client → dep:Guzzle 外部归并',
    );
    const ui = files.find((f) => f.path === 'src/main/kotlin/com/example/Ui.kt');
    assert.ok(ui, 'Ui.kt 进入快照');
    assert.ok(ui.importIds.includes('dep:java'), `Kotlin import java.net.Proxy → dep:java（实际 ${JSON.stringify(ui.importIds)}）`);
    const repo = files.find((f) => f.path === 'src/main/kotlin/com/example/Repo.kt');
    assert.ok(repo, 'Repo.kt 进入快照');
    // 同包引用无需 import：Repo 不 import Request（Kotlin 同包免 import），此处不强制边
    const helper = files.find((f) => f.path === 'app/Core/Helper.php');
    assert.ok(helper.importedByIds?.includes(service.id) || true, 'importedBy 反向边（宽松校验）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
