// 单文件模式（buildSingleFileOntology / action analyzeFile）Kotlin / PHP 分发回归测试：
// v0.36.0 前 .kt/.kts/.php 回落 tsAnalyzer 产生错误解析；本测试锁定正确 analyzer 分发。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSingleFileOntology } from '../src/ontology/builder.js';

function tmpFile(name, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-single-'));
  const p = path.join(root, name);
  fs.writeFileSync(p, content);
  return p;
}

test('单文件模式：.php 分发到 phpAnalyzer（不再回落 tsAnalyzer）', async () => {
  const file = tmpFile('model.php', `<?php
namespace Zen\\Tao\\Module;

use Zen\\Tao\\Core\\Helper;

class bugModel extends model
{
    use SingletonTrait;

    public $name;

    public function getById($id)
    {
        return $this->dao->select('*')->from(TABLE_BUG)->where('id', $id)->fetch();
    }
}
`);
  try {
    const dataMap = await buildSingleFileOntology(file);
    // 文件对象：ext=php（tsAnalyzer 回落时 ext 会是 'php' 但实体为空，这里锁定实体产出）
    assert.equal(dataMap.SourceFile[0].ext, 'php');
    const cls = dataMap.Class.find((c) => c.name === 'bugModel');
    assert.ok(cls, 'bugModel 类被 phpAnalyzer 提取');
    assert.equal(cls.language, 'php');
    assert.equal(cls.isDataModel, true, 'extends model → isDataModel');
    const method = dataMap.Method.find((m) => m.name === 'getById');
    assert.ok(method, 'getById 方法被提取');
    assert.equal(method.ownerName, 'bugModel');
    // _meta 记账
    assert.ok(dataMap._meta.objectCounts.Class >= 1);
    assert.ok(dataMap._meta.objectCounts.Method >= 1);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('单文件模式：.php trait + 本文件 use 回填（usesTraitIds/usedByIds）', async () => {
  const file = tmpFile('trait.php', `<?php
trait SingletonTrait
{
    public static function instance() { return new self(); }
}

class userModel extends model
{
    use SingletonTrait;
}
`);
  try {
    const dataMap = await buildSingleFileOntology(file);
    const trait = dataMap.Trait.find((t) => t.name === 'SingletonTrait');
    assert.ok(trait, 'SingletonTrait 进入 dataMap.Trait');
    const cls = dataMap.Class.find((c) => c.name === 'userModel');
    assert.ok(cls, 'userModel 进入 dataMap.Class');
    assert.ok(cls.usesTraitIds.includes(trait.id), '单文件模式 usesTraitIds 回填');
    assert.ok(trait.usedByIds.includes(cls.id), '单文件模式 usedByIds 回填');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('单文件模式：.kt 分发到 kotlinAnalyzer（data class / suspend fun / supertype）', async () => {
  const file = tmpFile('Client.kt', `package com.example

interface Call {
    fun execute(): String
}

data class Request(val url: String)

class HttpClient(private val baseUrl: String) : Call {
    override fun execute(): String = "GET " + baseUrl

    suspend fun executeAsync(): String = execute()
}
`);
  try {
    const dataMap = await buildSingleFileOntology(file);
    assert.equal(dataMap.SourceFile[0].ext, 'kt');
    const cls = dataMap.Class.find((c) => c.name === 'HttpClient');
    assert.ok(cls, 'HttpClient 类被 kotlinAnalyzer 提取');
    assert.equal(cls.language, 'kotlin');
    const dataCls = dataMap.Class.find((c) => c.name === 'Request');
    assert.ok(dataCls, 'data class Request 提取');
    assert.equal(dataCls.kind, 'data_class');
    const iface = dataMap.Interface.find((i) => i.name === 'Call');
    assert.ok(iface, 'Call 接口提取');
    const async = dataMap.Method.find((m) => m.name === 'executeAsync');
    assert.ok(async, 'executeAsync 提取');
    assert.equal(async.isAsync, true, 'suspend fun → isAsync');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('单文件模式：.kts 分发到 kotlinAnalyzer（脚本变体 ext=kts）', async () => {
  const file = tmpFile('build_extra.kts', `plugins {
    kotlin("jvm")
}

fun greeting(name: String): String = "hello " + name
`);
  try {
    const dataMap = await buildSingleFileOntology(file);
    assert.equal(dataMap.SourceFile[0].ext, 'kts');
    const fn = dataMap.Method.find((m) => m.name === 'greeting');
    assert.ok(fn, '顶层 fun greeting 提取');
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
