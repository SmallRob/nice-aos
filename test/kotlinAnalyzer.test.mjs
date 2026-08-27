// Kotlin 实体分析器单元测试：噪声剥离 / 实体抽取（class 变体 / interface / object / companion）/
// 主构造器字段 / supertype 解析 / 顶层 fun / import / package 归一 / 死代码契约（nameReferences）。
// 样本形态对齐 okhttp 真实代码（OkHttpClient.kt / Interceptor.kt 抽样）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeKotlinFile, isKotlinCandidate } from '../src/analyzers/kotlinAnalyzer.js';

const SAMPLE = `@file:OptIn(ExperimentalCoroutinesApi::class)

package okhttp3

import java.net.Proxy
import okhttp3.internal.connection.RealCall
import kotlin.collections.List as KList

data class User(val name: String, var age: Int = 0, email: String)

sealed class Result<out T> {
    data class Ok<T>(val value: T) : Result<T>()
    data class Err(val error: Throwable) : Result<Nothing>()
}

class OkHttpClient internal constructor(
    builder: Builder,
) : Call.Factory, WebSocket.Factory {
    @get:JvmName("dispatcher")
    val dispatcher: Dispatcher = builder.dispatcher

    open fun newCall(request: Request): Call = RealCall.newCall(this, request)
    suspend fun newCall(request: Request): Call = TODO()

    companion object {
        @JvmField
        val DEFAULT: OkHttpClient = OkHttpClient(Builder())
    }
}

interface Interceptor {
    fun intercept(chain: Chain): Response
}

fun interface Factory<T> {
    fun create(): T
}

fun topLevelHelper(x: Int): String {
    return "helper " + x
}
`;

test('isKotlinCandidate：.kt / .kts 命中，其余不命中', () => {
  assert.ok(isKotlinCandidate('src/main/kotlin/Foo.kt'));
  assert.ok(isKotlinCandidate('build.gradle.kts'));
  assert.ok(!isKotlinCandidate('src/Foo.java'));
  assert.ok(!isKotlinCandidate('src/Foo.php'));
});

test('analyzeKotlinFile：package 归一 moduleName', () => {
  const facts = analyzeKotlinFile('OkHttpClient.kt', SAMPLE);
  assert.equal(facts.moduleName, 'okhttp3');
  assert.equal(facts.language, 'kotlin');
});

test('analyzeKotlinFile：class 变体（data/sealed/object/companion 内嵌）', () => {
  const facts = analyzeKotlinFile('OkHttpClient.kt', SAMPLE);
  const byName = new Map(facts.classes.map((c) => [c.name, c]));
  // data class
  const user = byName.get('User');
  assert.ok(user, 'User 类被解析');
  assert.equal(user.kind, 'data_class');
  // 主构造器 val/var 字段（email 无 val/var 不入 fields）
  assert.deepEqual(user.fields.map((f) => f.name), ['name', 'age']);
  assert.equal(user.fields[1].isMutable, true);
  // sealed class + 嵌套 data class
  const result = byName.get('Result');
  assert.ok(result, 'sealed Result 被解析');
  assert.equal(result.kind, 'sealed_class');
});

test('analyzeKotlinFile：supertype 列表解析（含点号嵌套 Call.Factory）', () => {
  const facts = analyzeKotlinFile('OkHttpClient.kt', SAMPLE);
  const client = facts.classes.find((c) => c.name === 'OkHttpClient');
  assert.ok(client, 'OkHttpClient 被解析');
  assert.deepEqual(client.bases, ['Call.Factory', 'WebSocket.Factory']);
  // 内部 constructor(...) 前缀被跳过，方法提取不受影响
  assert.ok(client.methods.some((m) => m.name === 'newCall'), 'newCall 方法被提取');
});

test('analyzeKotlinFile：interface 提取（fun interface 不误判为顶层 fun）', () => {
  const facts = analyzeKotlinFile('OkHttpClient.kt', SAMPLE);
  const names = facts.interfaces.map((i) => i.name);
  assert.ok(names.includes('Interceptor'), 'Interceptor 接口');
  assert.ok(names.includes('Factory'), 'fun interface Factory 作为接口');
  const interceptor = facts.interfaces.find((i) => i.name === 'Interceptor');
  assert.ok(interceptor.methods.some((m) => m.name === 'intercept'));
  // fun interface 不应产生顶层函数 create
  assert.ok(!facts.moduleFunctions.some((f) => f.name === 'create'), 'fun interface 的方法不进 moduleFunctions');
});

test('analyzeKotlinFile：顶层 fun 与 suspend 修饰', () => {
  const facts = analyzeKotlinFile('OkHttpClient.kt', SAMPLE);
  const helper = facts.moduleFunctions.find((f) => f.name === 'topLevelHelper');
  assert.ok(helper, 'topLevelHelper 被提取');
  assert.ok(helper.signature.startsWith('topLevelHelper('));
  // suspend 方法标记 isAsync
  const client = facts.classes.find((c) => c.name === 'OkHttpClient');
  const suspendNewCall = client.methods.filter((m) => m.name === 'newCall').find((m) => m.isAsync);
  assert.ok(suspendNewCall, 'suspend fun 标记 isAsync=true');
});

test('analyzeKotlinFile：import 提取（普通 + as 别名）', () => {
  const facts = analyzeKotlinFile('OkHttpClient.kt', SAMPLE);
  const specifiers = facts.imports.map((i) => i.specifier);
  assert.ok(specifiers.includes('java.net.Proxy'));
  assert.ok(specifiers.includes('okhttp3.internal.connection.RealCall'));
  // as 别名：local = KList
  assert.equal(facts.importMap.get('KList'), 'kotlin.collections.List');
});

test('analyzeKotlinFile：字符串/注释噪声剥离（不产生幽灵实体）', () => {
  const noisy = [
    'package com.example',
    '// class GhostOne {}',
    '/* class GhostTwo {} */',
    'class Real {',
    '  val s: String = "class Fake { fun ghost() {} }"',
    '  fun real(): Int = 42',
    '}',
  ].join('\n');
  const facts = analyzeKotlinFile('Noisy.kt', noisy);
  const names = facts.classes.map((c) => c.name);
  assert.deepEqual(names, ['Real']);
  assert.ok(facts.classes[0].methods.some((m) => m.name === 'real'));
  assert.ok(!facts.classes[0].methods.some((m) => m.name === 'ghost'));
});

test('analyzeKotlinFile：三引号原始字符串（含 ${} 插值）剥离', () => {
  const raw = [
    'package com.example',
    'class Doc {',
    '  val template: String = """',
    '    Hello ${name} class NotReal { fun x() {} }',
    '  """',
    '  fun render(): String = template',
    '}',
  ].join('\n');
  const facts = analyzeKotlinFile('Doc.kt', raw);
  assert.deepEqual(facts.classes.map((c) => c.name), ['Doc']);
  assert.ok(!facts.classes[0].methods.some((m) => m.name === 'x'), '原始字符串内的 class 噪声被剥离');
});

test('analyzeKotlinFile：死代码契约（nameReferences 全文标识符记录）', () => {
  const facts = analyzeKotlinFile('OkHttpClient.kt', SAMPLE);
  assert.ok(facts.nameReferences.has('OkHttpClient'));
  assert.ok(facts.nameReferences.has('Builder'));
  // exportNames：顶层 public 标识符
  assert.ok(facts.exportNames.includes('User'));
  assert.ok(facts.exportNames.includes('Interceptor'));
  assert.ok(facts.exportNames.includes('topLevelHelper'));
});

test('analyzeKotlinFile：enum class 变体提取', () => {
  const src = [
    'package com.example',
    'enum class Color {',
    '    RED, GREEN, BLUE',
    '}',
  ].join('\n');
  const facts = analyzeKotlinFile('Color.kt', src);
  const color = facts.classes.find((c) => c.name === 'Color');
  assert.ok(color);
  assert.equal(color.kind, 'enum_class');
  assert.deepEqual(color.variants.map((v) => v.name), ['RED', 'GREEN', 'BLUE']);
});

test('analyzeKotlinFile：object 单例标记', () => {
  const src = [
    'package com.example',
    'object Config {',
    '    const val VERSION: String = "1.0"',
    '    fun load(): Config = Config',
    '}',
  ].join('\n');
  const facts = analyzeKotlinFile('Config.kt', src);
  const config = facts.classes.find((c) => c.name === 'Config');
  assert.ok(config);
  assert.equal(config.kind, 'object');
  assert.equal(config.isSingleton, true);
  assert.ok(config.methods.some((m) => m.name === 'load'));
});
