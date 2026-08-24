# Code Review Report Template — 综合评审报告模板（nice-aos-code-review-skill）

> 本文件是综合代码评审 Markdown 报告的标准结构。
> 设计参考：ASDM `.asdm/toolsets/code-review/spec/review-template.md`。
> 适用范围：综合评审（Step 1-7 全开）/ commit 评审 / 领域评审 / 后端服务评审。

## 评审元信息

| 字段 | 值 |
|------|-----|
| 评审日期 | {{date}} |
| 评审范围 | {{scope}}（commit: {{commitHash}} / 领域: {{domain}} / 综合） |
| 项目类型 | {{projectType}}（react/vue/flutter/userscript/java-backend/fullstack） |
| 评审人 | Nice AOS Code Review Bot |
| 关联 Skill | nice-aos-code-review-skill v1.0.0 |
| 数据源 | {{dataSources}}（本体快照 / 服务快照 / ESLint JSON / Sonar JSON / 蓝图 HTML） |

---

## 评审摘要

### 通用维度

| 维度 | P0 | P1 | P2 | P3 | 小计 |
|------|----|----|----|----|------|
| Architecture | | | | | |
| Type Safety | | | | | |
| Performance | | | | | |
| UX | | | | | |
| Security | | | | | |
| Style | | | | | |

### 领域维度

| 维度 | P0 | P1 | P2 | P3 | 小计 |
|------|----|----|----|----|------|
| Domain Boundary | | | | | |
| Code Reuse | | | | | |
| Coupling | | | | | |
| Cohesion | | | | | |

### 死代码维度（继承 nice-aos-deadcode-skill）

| 级别 | 候选数 | 经复核确认 | 误报 | 实际死代码 |
|------|--------|----------|------|----------|
| 孤儿文件 | | | | |
| 未使用导出 | | | | |
| 死接口/类 | | | | |
| 死函数 | | | | |

### 后端服务维度（仅 Java 后端项目）

| 维度 | 评分 | 关键 findings |
|------|------|--------------|
| Complexity（复杂度） | | |
| Data Health（数据层） | | |
| Test Coverage（测试覆盖） | | |
| Analysis Quality（分析质量） | | |
| Dependency Health（依赖健康） | | |
| **总分** | | |

### 总计

| 维度 | P0 | P1 | P2 | P3 | 小计 |
|------|----|----|----|----|------|
| **总计** | | | | | |

---

## 评审结论

- [ ] **通过** — 无 P0/P1 问题
- [ ] **有条件通过** — P1 问题可后续修复
- [ ] **需修改** — 存在 P0 问题，必须修复

---

## 项目画像（Snapshot Summary）

```markdown
- 项目名：{{projectName}}
- 框架：{{framework}}（{{tsxFileCount}} TSX / {{vueFileCount}} Vue / {{dartFileCount}} Dart / {{userScriptFileCount}} user.js）
- 总文件数：{{fileCount}}
- 组件数：{{componentCount}}
- Store 数：{{storeCount}}
- Service 数：{{serviceCount}}
- Interface / Class / Method：{{interfaceCount}} / {{classCount}} / {{methodCount}}
- 循环依赖：{{cycleCount}}（{{cycles | length }} 个环）
- 死代码候选：{{deadFunctionCount}} / {{deadTypeCount}} / {{deadExportCount}} / {{orphanFileCount}}
- 解析错误：{{analysisErrors}}
- 功能域：{{domains | map(.name) | join(', ')}}
```

---

## 领域分析

### 涉及领域

| 领域 | 文件数 | 主要内容 | 评审关注点 |
|------|--------|---------|----------|
| {{domain}} | {{fileCount}} | {{capability}} | {{watchPoints}} |

### 领域依赖图（mermaid）

```mermaid
graph TD
    {{dependencies}}
```

### 蓝图评审（如有 HTML 蓝图）

- 蓝图路径：`reports/blueprint-{{date}}.html`
- 视觉评审要点：模块分布均匀性 / 高扇出节点 / 跨域直接依赖 / 循环依赖环

---

## 详细发现

### P0 - Critical（必须修复）

<!-- 模板：
#### [规则ID] 问题简述
- **文件**: `file:line`
- **证据**: 数据源（CLI 输出 / 扫描 JSON / 蓝图）
- **影响**: 影响范围（哪些功能 / 哪些依赖）
- **建议**: 具体修复步骤

示例：

#### [ARCH-04] App.tsx ↔ utils/format.ts 循环依赖
- **文件**: `App.tsx:1-50`, `src/utils/format.ts:1-30`
- **证据**: `nice-aos export --format json | jq '._meta.cycles'` 命中环
- **影响**: 影响 App.tsx / store / 3 个 component
- **建议**: 提取 `formatDate` 到 `utils/date/format.ts` 由 App.tsx 单独引用

#### [SEC-01] 硬编码 Gemini API Key
- **文件**: `src/services/gemini/client.ts:42`
- **证据**: 外部扫描 `eslint.json` 中 `no-secrets` 命中 1 处
- **影响**: 安全风险（密钥泄露）
- **建议**: 改为 VITE_GEMINI_API_KEY 环境变量 + 服务端代理
-->

### P1 - Major（强烈建议修复）

### P2 - Minor（建议优化）

### P3 - Info（信息/建议）

---

## 死代码评审（继承 nice-aos-deadcode-skill）

### 四级候选清单

#### 孤儿文件（DEAD-FILE-01）

| 路径 | 行数 | 复核状态 | 备注 |
|------|------|---------|------|
| | | 待定 / 保留 / 删除 | |

#### 未使用导出（DEAD-EXPORT-01）

| 文件 | 导出名 | 复核状态 | 备注 |
|------|--------|---------|------|
| | | | |

#### 死接口/死类（DEAD-TYPE-01）

| 类型 | 路径 | deadReason | 复核状态 |
|------|------|----------|---------|
| | | | |

#### 死函数（DEAD-FN-01/03）

| 方法 | 位置 | ownerKind | deadReason | 复核状态 |
|------|------|----------|----------|---------|
| | | | | |

### 死代码复核说明

（人工/agent 复核结论：动态引用豁免 / 测试引用豁免 / 接口实现约束 / re-export 链 / barrel file 等）

---

## 外部扫描发现（Step 6 融合）

> 融合多扫描器 JSON：{{scanFiles}}

| 文件 | 规则 | 工具 | 等级 | 描述 |
|------|------|------|------|------|
| | | ESLint/Sonar/Checkstyle/Semgrep/Trivy | P0/P1/P2/P3 | |

### 工具命中统计

| 工具 | P0 | P1 | P2 | P3 | 总计 |
|------|----|----|----|----|------|
| ESLint | | | | | |
| SonarQube | | | | | |
| Checkstyle | | | | | |
| Semgrep | | | | | |
| Trivy | | | | | |
| npm audit | | | | | |

---

## 后端服务评审（仅 Java 后端项目）

### 五维评分

```
Complexity:        {{complexityScore}}    {{complexityLevel}}
Data Health:       {{dataHealthScore}}     {{dataHealthLevel}}
Test Coverage:     {{testCoverageScore}}   {{testCoverageLevel}}
Analysis Quality:  {{analysisQualityScore}}{{analysisQualityLevel}}
Dependency Health: {{dependencyScore}}     {{dependencyLevel}}
─────────────────
总分:              {{overallScore}}        {{overallLevel}}
```

### 模块与分层

（来自 `nice-aos service export --format viewmodel`）

| 模块 | 包前缀 | 类数 | 方法数 | API 端点 | 表数 |
|------|--------|------|--------|---------|------|
| | | | | | |

### 复杂度热点 TOP10

| 方法 | 类 | 圈复杂度 | 嵌套深度 | 路径 |
|------|----|---------|---------|------|
| | | | | |

### 数据层健康

| 指标 | 值 | 备注 |
|------|----|----|
| 总表数 | | |
| 无主键表 | | |
| 无 Mapper 表 | | |
| FK 关系数 | | |
| FK 悬空 | | |

### 测试覆盖

| 类型 | 数量 | 占比 |
|------|------|------|
| 单元测试 | | |
| 集成测试 | | |
| 总测试方法 | | |
| 总生产方法 | | |
| **覆盖率** | | |

### 依赖健康

| 指标 | 值 |
|------|----|
| 总依赖数 | |
| 多版本冲突 | |
| 漏洞（CRITICAL/HIGH） | |
| 未声明依赖 | |

---

## 复用机会汇总

| 重复代码 | 涉及文件 | 重复次数 | 建议提取 | 预期收益 |
|----------|----------|----------|----------|----------|
| | | | | |

---

## 耦合度评估

| 指标 | 评分 | 说明 |
|------|------|------|
| 接口使用率 | | |
| 循环依赖 | | |
| 依赖方向 | | |
| **整体集成度** | 低 / 中 / 高 | |

---

## 内聚度评估

| 指标 | 评分 | 说明 |
|------|------|------|
| 职责单一性 | | |
| 组件相关性 | | |
| 状态独立性 | | |
| **整体内聚度** | 低 / 中 / 高 | |

---

## 变更文件清单

| 文件 | 维度 | 类型 | 行数 | 规则命中 | 备注 |
|------|------|------|------|---------|------|
| | ARCH/TYPE/PERF/... | add/mod/del | +X/-Y | RULE-ID | |

---

## 亮点

<!-- 值得肯定的代码实践 -->

- {{highlight-1}}
- {{highlight-2}}

---

## 改进建议

### 短期改进（本次迭代）

1. {{short-term-1}}
2. {{short-term-2}}

### 中期改进（下个迭代）

1. {{medium-term-1}}
2. {{medium-term-2}}

### 长期改进（规划中）

1. {{long-term-1}}
2. {{long-term-2}}

---

## 评审闭环（markReviewed / addNote）

| 对象 ID | 评审结论 | 备注 |
|---------|---------|------|
| file:src/utils/legacy.ts | 保留 | 仅测试引用 + 动态注册双豁免 |
| class:LegacyService | 标记删除 | 经四维复核无引用 |
| route:energy_tree | 需 lazy import | PERF-01 |

---

## 附录

### A. 规则参考

- 通用 + 领域 + 死代码规则：`skills/nice-aos-code-review-skill/spec/review-rules.md`
- 后端服务规则：`skills/nice-aos-code-review-skill/spec/backend-review-rules.md`
- 死代码判定细则：`skills/nice-aos-deadcode-skill/SKILL.md` 第 5 节

### B. CLI 命令清单

```bash
# Step 1：装配
nice-aos query Project | jq '{summary, architecture, health}'
nice-aos action refreshRepo --params '{"repoPath":"."}'

# Step 2：通用维度
nice-aos query SourceFile --where "lineCount>500"
nice-aos query Route --where "isLazy=false"
nice-aos query Store
nice-aos export --format json | jq '._meta.cycles'

# Step 3：领域维度
nice-aos query Domain --pretty
nice-aos link importedBy --src "file:src/services/xxx.ts"

# Step 4：死代码
nice-aos query Project | jq '.health'
nice-aos export --format json | jq '._meta.orphanCandidates'
nice-aos query Method --where "deadCandidate=true" --pretty

# Step 5：后端服务（如适用）
nice-aos service audit all --snapshot <asdm-aos-snapshot.json>
nice-aos service export --format html --output reports/service-blueprint.html

# Step 7：闭环
nice-aos action markReviewed --params '{"objectId":"..."}'
nice-aos action addNote --params '{"objectId":"...","note":"..."}'
```

### C. 数据源清单

| 数据源 | 路径 / 格式 | 用途 |
|--------|------------|------|
| 本体快照 | `.nice-aos/data/snapshot.json` | 死代码 / 依赖图 / 循环依赖 |
| 服务快照 | `service-snapshot.json` | 后端服务五维审计 |
| 蓝图 HTML | `reports/blueprint-*.html` | 视觉评审 |
| ESLint JSON | `reports/scan/eslint.json` | 类型/性能/UX/安全/风格 |
| Sonar JSON | `reports/scan/sonar.json` | 综合 |
| Checkstyle XML | `reports/scan/checkstyle.xml` | 风格 |
| Semgrep JSON | `reports/scan/semgrep.json` | 安全 |
| Trivy JSON | `reports/scan/trivy.json` | 依赖漏洞 |

### D. 评审耗时参考

| 评审类型 | 数据源 | 典型耗时 |
|---------|--------|---------|
| 单文件 | analyzeFile | < 5 秒 |
| commit（< 50 文件变更） | 本体 + 扫描 JSON | 1~3 分钟 |
| 领域 | 本体 + 模块分析 | 3~5 分钟 |
| 综合（前端 1000+ 文件） | 本体 + 蓝图 + 多扫描 | 5~10 分钟 |
| 后端服务（500 类） | service audit all | 10~30 秒 |

---

*Report generated by Nice AOS Code Review Skill v1.0.0*
*Superset of: nice-aos-deadcode-skill (v0.x)*
*Inspired by: ASDM code-review v2.0*