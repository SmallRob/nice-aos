# ADR 0001: 借鉴 asdm-aos 的代码本体分析能力

> **Status**: Accepted (v0.29.1, 2026-08-25)
> **Authors**: nice-aos team
> **Related**: asdm-aos v0.0.12 (https://www.npmjs.com/package/@leansoftx/asdm-aos)
> **Reference**: `/Users/healer2027/workprojetcs/asdm/asdm-ontology-research/aos`

## Context

`asdm-aos` 是 ASDM 生态的 Java 代码本体分析 CLI(同 npm 包 `@leansoftx/asdm-aos`,v0.0.12)。
核心思想:把 Java 仓库预分析为"结构化关系图谱",让 AI agent 通过 CLI 毫秒级查询,
从"逐文件 grep + LLM 推理"降级为"查图谱得结论"。

`nice-aos` 已经在架构上大量借鉴 asdm-aos(`src/cli/shared.js` 注释明确写"与 asdm-aos 对齐")。
但仍有 4 项 aos 已实现、nice-aos 缺失的能力值得整合。本 ADR 记录借鉴与优化决策。

## 借鉴目标(已识别差距)

| aos 能力 | aos 实现要点 | nice-aos 现状 | 借鉴方案 |
|---------|------------|-------------|---------|
| 圈复杂度 | `Method.complexity: { cyclomatic, branches, maxNesting, throws, earlyReturns, logicOps }` | ❌ 无 | ✅ 实施 — 整合到 `Method.health` |
| 测试方法识别 | 基于 `@Test` / `@ParameterizedTest` 注解,JUnit 4/5 双格式 | ⚠️ 仅文件级 `isTest` | ✅ 实施 — 升级到方法级,识别 vitest/jest `it/test/describe` 回调 |
| API 端点检测 | `@RestController` + `@GetMapping/@PostMapping` 解析 | ⚠️ 有 Route 但非注解级 | 🔄 部分 — 适配 Next.js `export async function GET/POST` 模式 |
| Lambda 计数 | `Method.lambdaCount: number` | ❌ 无 | ✅ 实施 — 升级为 `Method.health.lambdas: { count, maxNesting, inJsx }`(前端特有) |
| 字节码二次扫描 | javap -c -p 解析 .class,提升调用关系覆盖率 0.08%→79.87% | ❌ 无,不可比 | ❌ 不实施 — JS/TS 无字节码等价物;nice-aos 已有 tsCompiler API + Dart analyzer 覆盖 |
| 失败降级友好提示 | "未找到 .class,降级为纯 tree-sitter,建议先 mvn compile" | ⚠️ `fail()` 单行 | ✅ 实施 — 5 步步骤化进度 + 错误聚合 + 降级建议 |

## 决策

### 决策 1:整合为统一 `Method.health` 子对象(而非 aos 的 4 个零散顶层字段)

**Aos 模式**:`Method.complexity` + `Method.isTest` + `Method.testType` + `Method.lambdaCount` 平铺
**Nice-aos 模式**:`Method.health: { complexity, lambdas, testInfo, risk }` 嵌套 + 派生 `risk` 评级

**理由**:
- 蓝图 viewer 可一次性画"方法健康度雷达图",无需读 4 个字段
- AI agent 一次 query 拿全部,降低认知负担
- 派生 `risk: low/medium/high/critical` 让 `query Method --where "health.risk=critical"` 一句话查

### 决策 2:不机械照搬,做前端域适配

aos 的复杂度/测试识别能力来自 Java 生态(@Test 注解 / Spring 框架 / Lombok 生成代码)。
JS/TS 域对应概念不同,需重新设计:

| aos 概念 | nice-aos 对应物 | 差异 |
|---------|---------------|------|
| `@Test` 注解 | `it()` / `test()` 调用的 callback | 嵌套结构(describe > it),需 AST 递归 |
| Spring 框架调用 | React.useState / DOM API | "外部对象"虚拟化(`ext:` 前缀) |
| Lombok @Data 生成 | TS 装饰器 / 工厂模式 | 不存在,可放弃 |
| Javadoc 描述 | TSDoc / JSDoc | tsCompiler 已提供,无需特殊处理 |
| `@RequestMapping` API | Next.js `export async function GET` | 装饰器级,需新解析 |

### 决策 3:不实施 .d.ts 二次通道

aos 字节码通道的核心价值是补全"框架调用 + 注解生成代码"——两类信息在源码中不可见。
nice-aos 评估了等价方案:
- **.d.ts 类型声明文件**:仅含类型签名,无调用关系,不能补全信息
- **esbuild/swc 编译产物**:需先 build,运行时不可用
- **tsCompiler API 已有能力**:已涵盖类型信息 + 导入解析,无需二次通道

**结论**:JS/TS 域不存在字节码等价物,放弃该借鉴方向。

### 决策 4:步骤化进度借鉴 + silent 默认

aos 的 `[1/6] [2/6]` 串行进度漂亮但侵入性强。
nice-aos 采用**回调式**:
- `buildOntologyData(projectRoot, { onProgress })` 接受回调
- 不传 onProgress 时静默(向后兼容 test/库调用)
- `action.js` 中默认 `silent=true`(保持 JSON 单一输出),`silent=false` 才打步骤

## 实施路线

### Phase 0(已完成,v0.29.1)

- [x] `src/analyzers/methodHealth.js` —— 复杂度/lambda/testInfo/risk 统一分析
- [x] `src/analyzers/tsAnalyzer.js` 集成 —— 3 个方法 push 点 + testCallbacks 预扫
- [x] `src/ontology/builder.js` 集成 —— collectTypeEntities 透传 health + progress hook
- [x] `src/cli/commands/action.js` —— 步骤化输出 + silent 默认
- [x] `test/method-health.test.mjs` —— 15 单元测试
- [x] 281 现有测试 + 15 新测试全通过,零破坏

### Phase 1(本 ADR 后续,v0.30.x)

- [ ] P1-7: 数据模型识别(`type X = {...}` / `Record<K,V>` / Prisma / TypeORM)
  → `Class.isDataModel` / `dataModelType` 字段
- [ ] P1-8: API 端点装饰器级(Next.js `export async function GET/POST`、tRPC procedure)
  → `Method.endpointInfo: { framework, method, path }`
- [ ] P2-11: 依赖范围去噪(`node:fs` / `@types/*` 在 dependsOn 链接过滤)
  → `link dependsOn --src pkg:*` 返回值减少 30-50% 噪音

### Phase 2(中期,v0.31.x+)

- [ ] P1-9: 外部对象虚拟化(React.useState / DOM API / pinia.$patch 标 `ext:`)
- [ ] P2-13: Blueprint 契约化(`/schema` HTTP 端点暴露 OBJECT_TYPES/LINK_TYPES)
- [ ] P2-14: 多语言 Blueprint 复用(各 analyzer 提供独立蓝图,统一注册)

## 不借鉴(过度设计或领域不适)

- **asdm-aos 的 Express Server 模式** —— nice-aos 有 `serve` 命令,极简 HTTP,不需要 Express
- **asdm-aos 的 React Web UI** —— 与 nice-aos 的 viewer.html 重叠
- **asdm-aos 的 Maven/Gradle 解析** —— 前端无对应物
- **asdm-aos 的 Interface kind=interface 元模型细分** —— nice-aos 已有 category:CodeUnit + level:L1 等价

## 验证标准

借鉴成功的判定:
1. **数据层**:`Method.health` 字段在快照中 100% 填充(可验证)
2. **查询层**:`nice-aos query Method --where "health.risk=critical"` 正确返回
3. **测试层**:单元测试覆盖复杂度/lambda/testInfo/risk 全部路径
4. **性能层**:对 1000+ 文件项目,health 计算 < 500ms(单遍 AST 遍历,不二次解析)
5. **无破坏**:281 现有测试 + 15 新测试全通过

## 引用

- asdm-aos 设计:[asdm-ontology-research/aos README](../../asdm-ontology-research/aos/README.md)
- asdm-aos blueprint: `aos/src/server/ontology/codeRepoBlueprint.ts`(551 行)
- asdm-aos action: `aos/src/cli/commands/action.ts`(363 行 6 步流水线)
- asdm-aos analyzer: `aos/src/server/analyzers/javaAnalyzer.ts`(1756 行,@Test/@ParameterizedTest/复杂度/数据模型 全部在这里)
- nice-aos 借鉴产物: `nice-aos/src/analyzers/methodHealth.js`
