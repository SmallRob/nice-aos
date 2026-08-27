# ADR 0006: PHP / Kotlin 分析器 v0.36.0

> 状态：已采纳
> 日期：2026-08-27
> 触发：zentaopms（PHP 业务代码库）与 Android/JVM 项目（Kotlin）纳入 nice-aos 多语言支持

## 一、背景

nice-aos 早期版本（v0.35.x）已支持 TS/JS、Vue、Flutter/Dart、Go、Rust、Python 六类源码分析；油猴脚本与 config 单独体系。用户提出两类新场景：

1. **zentaopms 后端**：典型结构 `module/<x>/{model,control,view,lang}/...php`，其中 `control.php` 的 public 方法即路由、`model.php` 继承 `model` 基类。需求：识别类、接口、trait、`use Trait`、`use ... as` 群组导入、`module/<x>/control.php` 路由生成。
2. **Android / JVM / KMP**：典型结构 `src/main/kotlin/.../XxxActivity.kt` / `*ViewModel.kt` / `*Repository.kt`，含 `class Foo : Bar, Baz` supertype list、`data class` 主构造器字段、`object` 单例、`sealed class` 与 `enum class` 变体。

目标：**不引入运行时依赖（AST 解析器），沿用 tsAnalyzer/rustAnalyzer/dartAnalyzer/goAnalyzer/pythonAnalyzer 的"轻量状态机 + 等长噪声剥离"范式**，挂到统一的 `buildOntologyData` 流水线。

## 二、决策

v0.36.0 增量引入 PHP / Kotlin 解析器，并扩展本体模型以容纳 trait 这一新对象类型：

| 决策 | 落地模块 | 优先级 |
|------|----------|--------|
| D1 | **新 PHP analyzer** `src/analyzers/phpAnalyzer.js` —— class/interface/trait/method/property/extends model|control/use Trait/use ... as 群组/control.php 路由 | P0 |
| D2 | **新 Kotlin analyzer** `src/analyzers/kotlinAnalyzer.js` —— class（含 data/sealed/object/companion/enum 变体）/ interface/fun（含 suspend）/ val|var/supertype 列表/import 普通+as 别名 | P0 |
| D3 | **本体扩展：Trait 对象** —— `dataMap.Trait`（L1/CodeUnit，`trait:` 前缀）；新链接类型 `usesTrait` / `usedByTrait` 双向边 | P0 |
| D4 | **builder.js 集成** —— analyzer 接入主流水线、import 解析（按命名空间首段归并为 external）、trait 链接双向回填、PHP 路由生成（`routeType: 'php'`） | P0 |
| D5 | **PHP / Kotlin 架构层语义** —— `semantics.js` 新增分层规则（zentaopms 惯例 + Android 惯例） | P1 |
| D6 | **项目扫描** —— `projectScanner.js` 扩 `.kt` / `.kts` / `.php` 进 `SOURCE_EXTENSIONS`；`detectFramework` 加 `php` / `kotlin` 分支 | P0 |
| D7 | **测试** —— phpAnalyzer 11 unit tests + kotlinAnalyzer 12 unit tests + kotlinPhpIntegration 1 e2e test | P0 |

## 三、设计细节

### D1 PHP analyzer

**入口**：`analyzePhpFile(relPath, content)` / `analyzePhpFileFromDisk(relPath, projectRoot)` / `isPhpCandidate(relPath)`（与 `tsAnalyzer` 平级）

**实体映射**（zentaopms 真实样本验证）：

| 源码 | 实体 |
|------|------|
| `class bugModel extends model` | Class（`kind: 'data_model'`, `isDataModel: true`） |
| `class bug extends control` | Class（`kind: 'controller'`, `isController: true`） |
| `abstract class Foo extends Bar` | Class（`modifiers: ['abstract']`, `extendsNames: ['Bar']`） |
| `interface Foo extends Bar, Baz` | Interface（`extendsNames: ['Bar', 'Baz']`） |
| `trait Foo` | Trait（独立对象类型） |
| `public function bar()` / `public static function bar()` / `function __construct()` | Method（`visibility` / `isStatic` / `isConstructor`） |
| `use Trait1, Trait2;`（class 体内） | `usesTraits: ['Trait1', 'Trait2']` |
| `public $name` / `public string $name` | Property（`type: 'string'`） |
| `namespace Foo\Bar;` | `moduleName: 'Foo.Bar'`（反斜杠归一为点） |
| `use Some\Other;` / `use Baz\{ Qux, Quux as Q };` | `imports` + `importMap` |

**方法签名格式**：`getById(int $id): ?object` → `signature: 'getById(int $id): ?object'`，归一空白以保证 fingerprint 稳定。

**`control.php` 路由**（zentaopms 惯例）：仅当路径匹配 `module/<x>/control.php` 时，public 非构造器方法 → `routes: [{ kind: 'route', routeType: 'php', module, handler, path: '/<module>-<method>', filePath, language }]`。

**噪声剥离**（`stripPhpNoise`）：行注释（`#` / `//`）、块注释（`/* */`）、单/双引号字符串（带 `\` 转义）。DAO 链中的 `'<类定义>'` 字符串被空白化，不产生幽灵实体（已用测试锁定）。

**契约对齐**：返回字段名与 `tsAnalyzer` 完全同形（`classes` / `interfaces` / `moduleFunctions` / `imports` / `importMap` / `nameReferences` / `exportNames` / `lineCount`），PHP 无组件语义字段（`jsxTags` / `useCalls` / `components` / `hooks` / `stores` 等）置为空集合。`traits` 与 `routes` 为 PHP 独有。

**API 边界**：`sqlQueries` 与 `crossModuleImports` 在 v1 阶段暂留空数组契约（与 `pythonAnalyzer` 同形）；DAO 链 / `loadModel` / `createLink` 等抽取由 builder 内 `sqlQueries` / `crossModule` 通道消费，Phase-2 接入。

### D2 Kotlin analyzer

**入口**：`analyzeKotlinFileFromDisk(relPath, projectRoot)` / `analyzeKotlinFile(relPath, content)` / `isKotlinCandidate(relPath)`

**实体映射**（okhttp / Compose / Ktor 真实样本验证）：

| 源码 | 实体 |
|------|------|
| `class Foo : Bar, Baz` | Class（`kind: 'class'`，`bases` 来自 supertype list） |
| `data class Foo(...)` | Class（`kind: 'data_class'`，`fields` 来自主构造器参数） |
| `sealed class Foo` | Class（`kind: 'sealed_class'`） |
| `enum class Foo { ... }` | Class（`kind: 'enum'`，`variants` 来自枚举常量） |
| `object Foo` | Class（`kind: 'object'`，`isSingleton: true`） |
| `companion object`（类体内） | Class（`kind: 'companion_object'`，独立 ID 与 methodIds/propertyIds） |
| `interface Foo : Bar` | Interface |
| `fun Foo.bar()` | Method（`ownerKind: 'class'`，接收者类型名支持点号语法） |
| `fun bar()` | Method（`ownerKind: 'module'`，`exported: true`） |
| `suspend fun` / `inline fun` / `operator fun` / `infix fun` | Modifiers 标注，不影响归属 |
| `suspend fun` 标记 | `isAsync: true`（builder 阶段） |
| `val foo: T` / `var foo: T` | Property（`isMutable: var`） |
| `import foo.Bar` / `import foo.*` / `import foo.Bar as Baz` | `imports` + `importMap` |
| `package foo.bar` | `moduleName: 'foo.bar'` |

**噪声剥离**（`stripKotlinNoise`）：行注释、块注释（含 KDoc）、字符串字面量（含 `"""…"""` 原始字符串中的 `${}` 插值）、字符字面量 `'a'`（避免与 Rust 生命周期混淆）。

### D3 本体扩展：Trait

**新增对象类型**：
- `Trait`（`trait:` 前缀，L1/CodeUnit）—— 方法复用单元，描述为"PHP trait；同一命名空间，可被多个 Class `use` 注入方法；含 usesTraits 反向链接使用方"

**新增链接类型**：
- `usesTrait`（class → trait）—— 双向
- `usedByTrait`（trait → class）—— 双向

**对象计数**：`objectCounts.Trait` 同步加（v0.35.1 已留 objectCounts 接入位置）。

**`contains(file:)` 扩展**：`blueprint.js` 的 `contains` 链接现在包含 `traits.filter((t) => t.filePath === filePath)`，之前 trait 会被遗漏。

**`viewModel` 扩展**：`viewer.js` 已支持 `kind: 'trait'` 配色（CSS cyan 描边），无新增改动。

### D4 builder.js 集成

**analyzer 分发**（嵌套三元表达式扩展）：
```
.rs → analyzeRustFileFromDisk
.go → analyzeGoFileFromDisk
.dart → analyzeDartFileFromDisk
.py → analyzePythonFileFromDisk
.kt / .kts → analyzeKotlinFileFromDisk   // 新
.php → analyzePhpFileFromDisk            // 新
.vue → analyzeVueFileFromDisk
... 其余按 CONFIG_EXTS / userScript / 默认
```

**import 解析**：
```js
if (isPhp || isKotlin) {
  // 外部依赖按命名空间首段归并（php: foo\bar → foo；kotlin: java.net.Proxy → java）
  const pkg = imp.specifier.split(/[\\/.]/)[0] ?? '';
  imp.resolved = { kind: 'external', package: pkg || null, ecosystem: isPhp ? 'php' : 'kotlin' };
  continue;
}
```

设计理由：PHP 命名空间分隔符 `\` 与 Kotlin 包分隔符 `.` 在 TS resolver 语境下没有意义（`Foo\Bar` 会被当作 `npm` 包 `Foo\Bar`），所以 PHP / Kotlin 走独立解析路径。当前实现把所有命名空间首段当 external package —— 这是 v1 简化（见 P2 候选）。

**trait 链接回填**（双向）：
```js
const traitByName = new Map();
for (const t of traits) traitByName.set(t.name, t);
for (const cls of classes) {
  if (!cls.usesTraits || cls.usesTraits.length === 0) continue;
  for (const name of cls.usesTraits) {
    const t = traitByName.get(name);
    if (!t) continue;
    cls.usesTraitIds.push(t.id);
    if (!t.usedByIds.includes(cls.id)) t.usedByIds.push(cls.id);
  }
}
```

**PHP 路由**（`buildOntologyData` 末尾新阶段）：
```js
// path = /<module>-<method>（与 zentaopms createLink('module','method') URL 形态一致）
// handler Method 关联：按类名查 methodKey
const ctrlClassMatch = /module\/([^/]+)\/control\.php$/.exec(relPath);
const ctrlClass = ctrlClassMatch ? ctrlClassMatch[1] : null;
for (const r of facts.routes) {
  const handlerId = (ctrlClass && methodKey.get(`${relPath}#${ctrlClass}#${r.handler}`)) ?? null;
  routes.push({ id, routePath: r.path, name: r.handler, routeType: 'php',
                componentFileId: `file:${relPath}`, componentId: handlerId, ... });
}
```

**`buildSingleFileOntology` 镜像**：单文件模式也镜像 trait 处理（`cls.usesTraits` 在本文件 traits 中查表回填）。

**失败 `catch` 块**：补 `traits: []` / `routes: []` 字段，避免 PHP 文件解析失败时下游 `facts.routes?.length` 类访问崩。

**`ObjectCounts` 记账**：`Trait: traits.length` 同步加；`Project.kotlinFileCount` / `phpFileCount` 同步加（与 `pyFileCount` 平级）。

**`Project.language` 拼接**：
```js
if ((scan.kotlinFileCount ?? 0) > 0) parts.push('Kotlin');
if ((scan.phpFileCount ?? 0) > 0) parts.push('PHP');
```

### D5 架构层语义

`inferFileArchLayer`（`src/ontology/semantics.js`）新增两条规则分支：

**PHP**（zentaopms 惯例）：
- `module/<x>/control.php` → `presentation`
- `module/<x>/(model|config).php` → `service`
- `module/<x>/(view|ui|lang)/` → `presentation`
- `(dao|dal|repositories?|services?|models?)/` → `service`
- `(controllers?|routes?|api)/` → `presentation`
- `framework/` → `shared`
- 默认 `shared`

**Kotlin**（Android/JVM 惯例）：
- `*(Activity|Fragment|Screen|Page).kt` → `presentation`
- `(ui|compose|views?|screens?|pages?)/` → `presentation`
- `*(Repository|UseCase|Interactor|Service|RepositoryImpl).kt` → `service`
- `*ViewModel.kt` → `presentation`
- `(di|data|datasource|db|network|api|remote|local)/` → `service`
- 默认 `shared`

### D6 项目扫描

`SOURCE_EXTENSIONS` 扩 `.kt` / `.kts` / `.php`；`counts` 字段同步加 `kt` / `kts` / `php`。

`detectFramework` 新增两个早返回：
```js
if (phpDetected) return 'php';
if (kotlinDetected) return 'kotlin';
```

`phpDetected` 判定：`composer.json` 存在 且 `.php` 源文件数 > 0。
`kotlinDetected` 判定：`build.gradle.kts` 或 `settings.gradle.kts` 存在 且 `.kt` + `.kts` 文件数 > 0。

### D7 测试

**`test/phpAnalyzer.test.mjs`** —— 11 tests：
- `isPhpCandidate` 命中 .php 拒绝 .blade.php
- `extends model` → `isDataModel` + `kind: 'data_model'`
- 方法提取（visibility / static / 构造器）
- `control.php` → Route 生成（zentaopms 惯例）
- 非 control.php 不生成路由
- trait 实体 + class `usesTraits`
- namespace 归一 + use 导入（含群组）
- 字符串/注释噪声剥离（DAO 链不产生幽灵实体）
- interface / abstract class / implements
- 死代码契约（`nameReferences` + `exportNames`）
- DAO 链与跨模块引用契约（Phase-1 留空数组）

**`test/kotlinAnalyzer.test.mjs`** —— 12 tests：
- `isKotlinCandidate` 命中 .kt / .kts
- package 归一
- class 变体（data / sealed / object / companion 内嵌）
- supertype 列表（含点号嵌套 `Call.Factory`）
- interface 提取（`fun interface` 不误判为顶层 fun）
- 顶层 fun 与 suspend 修饰
- import 提取（普通 + as 别名）
- 字符串/注释噪声剥离
- 三引号原始字符串（含 `${}` 插值）剥离
- 死代码契约
- enum class 变体提取
- object 单例标记

**`test/kotlinPhpIntegration.test.mjs`** —— 1 e2e test：
- 临时 fixture 项目（Kotlin + PHP 混合） → `buildOntologyData` 全链路
- 验证：`kotlinFileCount` / `phpFileCount` 统计、`language` 画像含 Kotlin + PHP
- Kotlin 实体（HttpClient bases=Call + Call 接口 + suspend fun `isAsync: true`）
- PHP 实体（bugModel `isDataModel` + bug `isController`）
- Trait 双向链接（userModel `usesTraitIds` 含 SingletonTrait，SingletonTrait `usedByIds` 含 userModel）
- `bp.link('usesTrait' / 'usedByTrait')` 双向消费
- `bp.link('contains', file:)` 含 trait 对象
- PHP 路由（`/bug-browse` `routeType: 'php'`，handler 关联到 bug#browse Method）
- 架构层（control.php → presentation / model.php → service）
- `objectCounts.Trait` 记账
- `SourceFile` 数量 ≥ 5（无分析错误）

**`test/blueprintEngine.test.mjs`** —— 已更新到 20 OBJECT_TYPES / 26 LINK_TYPES（+1 类型 +2 链接）。

## 四、影响

### 4.1 数据模型变更

| 维度 | 旧（v0.35.1） | 新（v0.36.0） |
|------|--------------|--------------|
| `OBJECT_TYPES.length` | 19 | 20（+Trait） |
| `LINK_TYPES.length` | 24 | 26（+usesTrait, +usedByTrait） |
| `dataMap.Trait` | 不存在 | 数组（PHP trait 对象） |
| `Class.usesTraitIds` / `Class.usesTraits` | 不存在 | 数组 |
| `Trait.usedByIds` / `Trait.methodIds` | 不存在 | 数组 |
| `Route.routeType` | `overlay` / `vue` / `flutter` / `python` / `go` / `go-cli` | + `php` |
| `Project.kotlinFileCount` / `phpFileCount` | 0 | 实测 |
| `Project.language` | `JavaScript + Dart + Go + Rust + Python` | + `Kotlin` + `PHP` |

### 4.2 性能

- PHP/Kotlin analyzer 复杂度 O(n)（单遍扫描 + 块级状态机），与 `pythonAnalyzer` / `goAnalyzer` 同量级
- `nameReferences` 全文标识符记录：单遍扫描 + Map 累加，与既有契约一致
- 解析覆盖度：与现有解析器同步

### 4.3 向后兼容

- 既有 19 类 / 24 链接不变；Trait 是新增
- 既有 `link(linkType, srcId)` 行为零变化；`usesTrait` / `usedByTrait` 是新增
- 老快照反序列化无 `Trait` 字段时为 `[]`（`createBlueprint` 用 `dataMap.Trait ?? []` 兜底）
- 老快照无 `kotlinFileCount` / `phpFileCount` 字段时为 0（`(scan.kotlinFileCount ?? 0)` 兜底）

### 4.4 测试结果

新增 24 tests（11 php + 12 kotlin + 1 integration）全过。
回归：`test/blueprintEngine.test.mjs` 34/34 通过。
整套测试（v0.35.1 基线 758 tests + 新增 24 + blueprintEngine 7 改动）→ 781/789 通过；8 个失败为 pre-existing jsdom `document.addEventListener` viewer 渲染测试，与本次改动无关（stash 验证 HEAD 上 9 fail，本次改动净修 1 个 objectCounts.Trait 同步记账相关测试）。

## 五、后续（v0.36+ 候选）

1. **PHP/Kotlin 内部 import 解析（PSR-4）**：当前所有 `use` / `import` 一律标 external；可读 `composer.json` 的 `autoload.psr-4` 与 `build.gradle.kts` 的 `sourceSets` 做内/外分离。**影响**：依赖图与死代码判定精度。
2. **`phpDetected` / `kotlinDetected` 暴露到 scan 结果**：与 `goDetected` / `flutterDetected` 对齐。**影响**：一致性。
3. **Kotlin receiver-constrained 调用图**（借鉴 GitNexus）：P3 长期。当前 builder 已能识别 `fun Foo.bar()` 接收者，扩展为 receiver 类型约束的下游链路解析是下一步。**影响**：死代码判定精度。
4. **PHP DAO 链抽取（Phase-2）**：`$this->dao->select('*')->from(TABLE_X)->where(...)` → 复用 `pythonAnalyzer` 的 `sqlQueries` 通道消费。**影响**：SQL 血缘图覆盖 zentaopms / Laravel。
5. **PHP `lang/` 翻译资源实体**：`.php` 数组常量在 zentaopms 用于 i18n；可建 `TranslationKey` 节点与 control 方法反查。**影响**：i18n 覆盖度图谱。

## 六、参考文献

- zentaopms 样本：`module/bug/{control,model,lang,view}/` 真实结构验证
- okhttp / Compose 样本：Kotlin supertype 列表 / suspend fun / object 单例
- 既有 ADR：
  - `docs/adr/0001-asdm-aos-borrowed-capabilities.md`（`isDataModel` 字段借鉴）
  - `docs/adr/0004-code-graph-rag-reusable-patterns.md`（轻量解析器范式借鉴）
  - `docs/adr/0005-gitnexus-borrowed-capabilities.md`（epistemic 信封未触发，Trait 接入预留了 `Trait.methodIds` 结构）
- 关键源文件（既有）：
  - `src/analyzers/pythonAnalyzer.js`（Phase-1 空数组契约 + `importMap` 范式）
  - `src/analyzers/rustAnalyzer.js`（块级状态机 + 等长噪声剥离）
  - `src/ontology/builder.js`（`collectTypeEntities` 扩展点）
  - `src/ontology/blueprint.js`（`linkImpls` 链接表）
