# Code Review Rules — 通用 + 领域 + 死代码（nice-aos-code-review-skill）

> 本文件是 `nice-aos-code-review-skill/SKILL.md` 中引用规则矩阵的完整定义。
> 设计参考：ASDM `.asdm/toolsets/code-review/spec/review-rules.md` 与 `domain-review-rules.md`。
> 等级与判定基于 nice-aos CLI 结构化数据；标"外部依赖"规则需要扫描 JSON 配合。

## 1. Architecture（架构）

| ID | 规则 | 等级 | 数据源 | 判定逻辑 |
|----|------|------|--------|---------|
| ARCH-01 | 单文件体量限制 | P1 / P0 | `nice-aos query SourceFile --where "lineCount>500"` | 500~1000 行 P1；> 1000 行 P0 |
| ARCH-02 | 模块边界清晰 | P1 | `nice-aos query Module --all` | 模块 `summary` 与其子模块 `archLayer` 一致性 |
| ARCH-03 | 依赖方向正确 | P1 | `link importedBy` / `link imports` | UI 层（presentation）反向依赖 service → P1；Store 直接依赖 UI → P0 |
| ARCH-04 | 循环依赖检查 | **P0** | `export --format json | jq '._meta.cycles'` | 任意环 → P0 |
| ARCH-05 | Store 职责单一 | P2 | `nice-aos query Store` | 单 Store `actionKeys > 15` 或跨域 stateKeys → P2 |

## 2. Type Safety（类型安全）

| ID | 规则 | 等级 | 数据源 | 判定逻辑 |
|----|------|------|--------|---------|
| TYPE-01 | 禁止裸 any | P1 | 外部扫描 ESLint `@typescript-eslint/no-explicit-any` | 命中 ≥ 1 → P1 |
| TYPE-02 | 类型断言最小化 | P2 | 外部扫描 `@typescript-eslint/consistent-type-assertions` | 命中 > 5 → P2 |
| TYPE-03 | 泛型约束 | P2 | 外部扫描 `@typescript-eslint/no-explicit-any` + 静态读 | 无 `extends` 泛型参数 → P2 |
| TYPE-04 | Props 类型定义 | P1 | `nice-aos query Component --where "propsCount=0"` | 页面级 Component props 缺类型 → P1 |
| TYPE-05 | 枚举值类型安全 | P2 | 外部扫描 `no-string-literal-enum` | 命中 ≥ 3 → P2 |

## 3. Performance（性能）

| ID | 规则 | 等级 | 数据源 | 判定逻辑 |
|----|------|------|--------|---------|
| PERF-01 | 大组件懒加载 | P1 | `nice-aos query Route --where "isLazy=false"` + `kind=page` | 页面级 Route 未 lazy → P1 |
| PERF-02 | 避免内联对象/函数 | P2 | 外部扫描 `react/jsx-no-bind` | 命中 > 10 → P2 |
| PERF-03 | useMemo/useCallback 合理使用 | P2 | 外部扫描 `react-hooks/exhaustive-deps` | 命中 ≥ 5 → P2 |
| PERF-04 | 列表 key 稳定性 | P1 | 外部扫描 `react/no-array-index-key` | 命中 ≥ 1 → P1 |
| PERF-05 | 不必要的 state | P2 | 静态读 + ESLint `react/no-unused-state` | 派生值用 useState → P2 |
| PERF-06 | useEffect 依赖完整 | P1 | 外部扫描 `react-hooks/exhaustive-deps` | 命中 ≥ 1 → P1 |

## 4. UX（用户体验）

| ID | 规则 | 等级 | 数据源 | 判定逻辑 |
|----|------|------|--------|---------|
| UX-01 | 安全区处理 | **P0** | 静态读 + 自定义 ESLint `no-missing-safe-area` | fixed inset-0 缺 `safe-area-top` → P0 |
| UX-02 | 返回导航一致 | P1 | `nice-aos query Route --where "kind=page"` | backTarget 缺失 → P1 |
| UX-03 | 加载态处理 | P1 | 外部扫描 + 静态读 | 异步操作无 `isLoading` 状态 → P1 |
| UX-04 | 错误态处理 | P1 | 外部扫描 + 静态读 | fetch 无 try/catch → P1 |
| UX-05 | 动画性能 | P2 | 外部扫描 `react-native/no-inline-styles`（Flutter） | width/height 动画 → P2 |

## 5. Security（安全）

| ID | 规则 | 等级 | 数据源 | 判定逻辑 |
|----|------|------|--------|---------|
| SEC-01 | API Key 不暴露 | **P0** | 外部扫描 `no-secrets` / `gitleaks` | 命中 ≥ 1 → P0 |
| SEC-02 | 用户输入消毒 | P1 | 外部扫描 `dompurify` / `eslint-plugin-security` | innerHTML 未消毒 → P1 |
| SEC-03 | 敏感数据存储 | P1 | 静态读 `localStorage` 调用 | 含 token / password → P1 |
| SEC-04 | GM API 越权 | P1 | `nice-aos query GmApiUsage --where "declared=false"` | 命中 ≥ 1 → P1（深审计委派 nice-aos-userscript skill） |

## 6. Style（代码风格）

| ID | 规则 | 等级 | 数据源 | 判定逻辑 |
|----|------|------|--------|---------|
| STYLE-01 | Tailwind 动态类安全 | P1 | 自定义 ESLint `no-dynamic-tailwind` | `${var}/20` 命中 → P1 |
| STYLE-02 | React.memo 规范 | P2 | 静态读 + ESLint `react/display-name` | 纯展示组件缺 memo → P2 |
| STYLE-03 | 命名规范 | P2 | ESLint `camelcase` / `react/jsx-pascal-case` | 命中 ≥ 3 → P2 |
| STYLE-04 | import 排序 | P3 | ESLint `import/order` | 命中 > 10 → P3 |
| STYLE-05 | 魔法数字 | P2 | 自定义 ESLint `no-magic-numbers` | 业务函数中未提取 → P2 |

---

## 7. Domain Boundary（领域边界）

| ID | 规则 | 等级 | 数据源 | 判定逻辑 |
|----|------|------|--------|---------|
| DOMAIN-01 | UI 层不直接访问其他领域服务 | P1 | `nice-aos link importedBy` 路径分析 | Component 跨域 import service → P1 |
| DOMAIN-02 | 领域间通信通过抽象接口 | P1 | `nice-aos query Interface --where "domain=X"` | 直接 import 具体实现而非接口 → P1 |
| DOMAIN-03 | 共享组件提取到公共目录 | P2 | `nice-aos query Component --where "usedDomains>=3"` | 跨 3 个领域使用但路径在领域内 → P2 |
| DOMAIN-04 | 领域内服务不暴露内部实现 | P2 | 静态读 `export` 语句 | service 直接 export 内部类 → P2 |
| DOMAIN-05 | 跨领域数据访问通过 API | P1 | 静态读 `localStorage.getItem('domain_xxx')` | UI 直接读别领域 storage → P1 |

## 8. Code Reuse（代码复用）

| ID | 规则 | 等级 | 数据源 | 判定逻辑 |
|----|------|------|--------|---------|
| REUSE-01 | 相似代码提取为工具函数 | P2 | 外部扫描 jscpd / cpd 报告 | 重复 ≥ 3 处且行数 > 5 → P2 |
| REUSE-02 | 相似组件提取为公共组件 | P2 | `link renderedBy` + 静态读 JSX | 3 处 JSX 结构高度相似 → P2 |
| REUSE-03 | 相似逻辑提取为 Hook | P2 | `nice-aos query Hook --all` + 静态读 | 3 处相似 useState/useEffect 模式 → P2 |
| REUSE-04 | 相似样式提取为工具类 | P3 | 外部扫描 stylelint | 重复 className ≥ 3 处 → P3 |
| REUSE-05 | 相似类型提取为公共类型 | P2 | `nice-aos query Interface --where "name~X"` | 同形 type ≥ 3 处 → P2 |

## 9. Coupling（耦合度）

| ID | 规则 | 等级 | 数据源 | 判定逻辑 |
|----|------|------|--------|---------|
| COUPLE-01 | 领域间依赖通过接口 | P1 | 静态读 import 路径 + 接口查询 | 直接 import 类 → P1 |
| COUPLE-02 | 避免循环依赖 | **P0** | `nice-aos export --format json | jq '._meta.cycles'` | 任意环 → P0（与 ARCH-04 等价） |
| COUPLE-03 | 依赖方向单一 | P1 | `nice-aos query Module --where "archLayer=presentation"` 反向依赖 service | presentation → service → store（理想）违反 → P1 |
| COUPLE-04 | 使用依赖注入 | P2 | 静态读 `new XXXService()` | UI 中直接 new → P2 |
| COUPLE-05 | 领域事件解耦 | P2 | `nice-aos link imports` + 静态读 eventBus.emit | 跨域直接调用 → P2 |

## 10. Cohesion（内聚度）

| ID | 规则 | 等级 | 数据源 | 判定逻辑 |
|----|------|------|--------|---------|
| COHESION-01 | 领域职责单一 | P1 | `nice-aos query Module --where "name=X"` 看 summary | summary 含 ≥ 3 个不相关关键词 → P1 |
| COHESION-02 | 领域内组件相关 | P2 | `link belongsTo --src dom:X` | 域内 Component routeDomain 不一致 → P2 |
| COHESION-03 | 领域服务职责明确 | P2 | `nice-aos query Service --where "exportsCount>20"` | 单 service > 20 export → P2 |
| COHESION-04 | 领域状态独立 | P1 | `nice-aos query Store` | Store stateKeys 跨域 → P1 |
| COHESION-05 | 领域事件命名规范 | P3 | 静态读 eventBus.emit/on | 事件名未按 `domain:event` → P3 |

---

## 11. Deadcode（死代码，继承 nice-aos-deadcode-skill 全部规则）

| ID | 规则 | 等级 | 数据源 | 判定逻辑 |
|----|------|------|--------|---------|
| DEAD-FILE-01 | 孤儿文件 | P2 | `_meta.orphanCandidates` | 命中且经人工复核确认 → P2 |
| DEAD-EXPORT-01 | 未使用导出 | P2 | `_meta.deadExportCandidates` | 同上 |
| DEAD-TYPE-01 | 死接口/死类 | P2 | `Interface/Class.deadCandidate=true` | 同上 |
| DEAD-FN-01 | 死方法 | P2 | `Method.deadCandidate=true` 且 `ownerKind=class` | 复核非实现类方法后 → P2 |
| DEAD-FN-02 | 死模块函数 | **不评审**（由导出级覆盖） | — | 模块函数不判函数级死代码 |
| DEAD-FN-03 | 油猴死 ScriptFunction | P2 | `ScriptFunction.deadCandidate=true` | 复核非 unsafeWindow 暴露 → P2 |
| DEAD-FN-04 | 接口方法 | **永不判死**（契约声明） | — | `ownerKind=interface` 永不 deadCandidate |

**完整死代码判定豁免与边界**：参考 `nice-aos-deadcode-skill/SKILL.md` 第 5 节"判定规则细则"。

---

## 12. 项目特定规则（Nice Today 2.0 兼容规则集）

| ID | 规则 | 等级 | 数据源 | 判定逻辑 |
|----|------|------|--------|---------|
| PROJ-01 | AI 服务统一架构 | P1 | 静态读 `createAICache` + `jsonParser` | AI 模块未使用 → P1 |
| PROJ-02 | localStorage key 规范 | P2 | 静态读 localStorage key | 不符合 `nice_today_*_v1` → P2 |
| PROJ-03 | Overlay 路由注册 | **P0** | `nice-aos query Route` | 新增 overlay 未在 overlayStack 注册 → P0 |
| PROJ-04 | Store 事件机制 | P2 | 静态读 `eventBus.emit('nice_today_*_refresh')` | 数据变更未发事件 → P2 |
| PROJ-05 | 组件 lazy import | P1 | `nice-aos query Route --where "isLazy=false"` | 全屏 overlay 未 lazy → P1 |

> 各项目可按需扩展 PROJ-06+（如 nice-aos 的 `nice-aos-skill/data/` 目录约定、asdm 项目的 `core/adapter/portal` 模块规则）。