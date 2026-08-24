# Backend Service Review Rules — Java 后端服务评审（nice-aos-code-review-skill）

> 本文件定义 Java 后端项目评审的五维规则。数据源：`nice-aos service audit all`
> （基于 asdm-aos 本体快照构建）。所有规则与 nice-aos serviceAuditor.js 的实现保持一致。

## 1. Complexity（复杂度）

数据源：`audits.complexity.stats.{hotspotCount, hotspotRatio}` + `audits.complexity.findings[]`

| ID | 规则 | 等级 | 判定逻辑 |
|----|------|------|---------|
| BACK-CX-01 | 圈复杂度热点占比 | **P0** / P1 | hotspotRatio > 50% → P0；30~50% → P1 |
| BACK-CX-02 | 单方法圈复杂度 | P1 / **P0** | cyclomaticComplexity ≥ 25 → P0；15~24 → P1 |
| BACK-CX-03 | 最大嵌套深度 | P2 | maxNestingDepth > 5 → P2（与 BACK-CX-02 复合时升级） |

**热点定义**：`cyclomaticComplexity >= 15`（nice-aos serviceAuditor 内置阈值）。

**报告输出模板**：

```markdown
#### [BACK-CX-01] 圈复杂度热点占比 47.2%
- **统计**: hotspotCount=94 / methodCount=199（47.2%）
- **TOP3 热点**:
  - `Helper.parseComplex(cc=20, depth=8, location=com.x.Helper#parseComplex)`
  - `OrderService.calc(cc=18, depth=6)`
  - `UserService.find(cc=15, depth=5)`
- **建议**: 拆分 `parseComplex` 为 parseToken / parseGroup / merge 三步；考虑提取策略类
```

## 2. Data Health（数据层）

数据源：`audits.dataHealth.findings[]`（基于 asdm-aos 解析的 Table + Mapper + Entity）

| ID | 规则 | 等级 | 判定逻辑 |
|----|------|------|---------|
| BACK-DATA-01 | 无主键表 | **P0** | 任意表缺主键 → P0 |
| BACK-DATA-02 | 无 Mapper 表 | P1 / P2 | 全表无对应 Mapper → P1（疑似死表）；部分表缺 Mapper → P2 |
| BACK-DATA-03 | FK 悬空 | P1 | FK 引用的列在目标表不存在 → P1 |
| BACK-DATA-04 | 列名冲突 | P2 | JPA Entity @Column 与 DDL 列名不一致 → P2 |

**报告输出模板**：

```markdown
#### [BACK-DATA-02] 12 张表无对应 Mapper
- **清单**: `audit_logs / temp_import / v_xxx (3)` 等
- **建议**: 补齐 Mapper（确认为静态字典表可在表注释中标注 "static dict" 排除）
```

## 3. Test Coverage（测试覆盖）

数据源：`audits.testCoverage.stats.{testMethodCount, totalMethodCount, coverage}`

| ID | 规则 | 等级 | 判定逻辑 |
|----|------|------|---------|
| BACK-TEST-01 | 总体测试覆盖率 | **P0** / P1 | coverage < 10% → P0；10~30% → P1 |
| BACK-TEST-02 | 关键模块无测试 | P1 | 任意 `@Service` / `@Controller` 类 0 测试方法 → P1 |
| BACK-TEST-03 | 集成测试覆盖 | P2 | `testType=IntegrationTest` < 总测试 10% → P2 |

**报告输出模板**：

```markdown
#### [BACK-TEST-01] 总体测试覆盖率 7.2%
- **统计**: testMethodCount=14 / totalMethodCount=193
- **关键无测试模块**: `OrderService / UserController / PaymentGateway`
- **建议**: 为 OrderService 补单测；为 PaymentGateway 补集成测试（含沙箱环境）
```

## 4. Analysis Quality（分析质量）

数据源：`audits.analysisQuality.findings[]`（基于 asdm-aos 解析错误）

| ID | 规则 | 等级 | 判定逻辑 |
|----|------|------|---------|
| BACK-QA-01 | 解析错误 | **P0** / P2 | `analysisErrors[]` 任意 1 项 → P0（如 .java 编译失败）；> 10 → P0 |
| BACK-QA-02 | 未分类方法 | P2 | `unparsedMethods[]` 命中 ≥ 3 → P2（提示部分逻辑未被本体建模） |

**报告输出模板**：

```markdown
#### [BACK-QA-01] 检测到 3 个解析错误
- **清单**: `LegacyJavaParser.java:142` (未知注解) / `UnsafeCode.java:88` (语法错误)
- **建议**: 检查源代码；如为故意为之请在 asdm-aos 解析器增加豁免
```

## 5. Dependency Health（依赖健康）

数据源：`audits.dependencyHealth.findings[]`（基于 Dependency + Maven pom.xml）

| ID | 规则 | 等级 | 判定逻辑 |
|----|------|------|---------|
| BACK-DEP-01 | 依赖多版本 | P1 | 同一 groupId:artifactId 多个不同 version → P1（Maven 属性占位符豁免） |
| BACK-DEP-02 | 依赖作用域异常 | P2 | runtime 依赖被 compile 模块引用 → P2 |
| BACK-DEP-03 | 依赖漏洞 | **P0** | Trivy / OWASP 扫描 JSON 中 CRITICAL → P0；HIGH → P1 |
| BACK-DEP-04 | 未声明依赖 | P1 | import 但未在 pom.xml 出现 → P1 |

**Maven 属性占位符豁免示例**：`${jjwt.version}` 与真实版本同时存在 → 不算多版本（避免 BOM 误报）。

**报告输出模板**：

```markdown
#### [BACK-DEP-01] 依赖多版本 `io.jsonwebtoken:jjwt-api`
- **冲突**: 0.11.5 / 0.12.3
- **建议**: 在 pom.xml 顶层 `<properties>` 统一 `<jjwt.version>0.12.3</jjwt.version>`，子模块引用属性占位符

#### [BACK-DEP-03] Trivy 报告 spring-core 6.0.5 含 CVE-2023-20860
- **漏洞**: RCE via Data Binding (CVSS 9.8)
- **建议**: 升级到 6.0.6+；参考 Trivy 报告 `reports/scan/trivy.json`
```

## 6. 服务蓝图评审

数据源：`nice-aos service export --format viewmodel`（聚合视图模型 JSON）

| ID | 规则 | 等级 | 判定逻辑 |
|----|------|------|---------|
| BACK-BP-01 | 模块划分合理 | P1 | `modules[]` 数量 > 5 且无 `adapter` / `portal` 分类 → P1 |
| BACK-BP-02 | 分层完整性 | P1 | `layers[]` 缺 controller / service / repository / entity 任一 → P1 |
| BACK-BP-03 | 模块依赖方向 | P1 | `moduleGraph.edges` 中 portal → core 反向依赖 → P1 |
| BACK-BP-04 | 端点命名一致 | P3 | `endpoints[]` 路径命名风格不统一（kebab-case / camelCase 混用）→ P3 |

**报告输出模板**：

```markdown
#### [BACK-BP-02] 分层缺 `repository` 包
- **证据**: `service query layers --where "name=repository"` 无结果
- **建议**: 确认是否用 JPA EntityManager 直接操作（无 Repository 接口）；若是则降级为 P3 备注
```

## 7. 五维聚合评分（聚合健康度）

数据源：`audits.health.score` + `audits.health.dimensions[]`

| 总分区间 | 等级 | 报告结论 |
|---------|------|---------|
| 80~100 | 健康 | 通过 |
| 60~79 | 良好 | 有条件通过 |
| 40~59 | 关注 | 本迭代修复 P0 |
| 0~39 | 不健康 | 需重构 |

**完整维度评分详见** `nice-aos service audit health` 输出。