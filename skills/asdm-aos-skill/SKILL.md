---
registry_id: asdm-aos
name: ASDM Ontology Skill
description: AOS 是面向企业级超大型代码项目的语义层。它将 Java 仓库的全量源码、编译产物、数据库 DDL 与 MyBatis Mapper XML
  预先分析为结构化本体快照，把"代码文件"转化为 AI agent 可直接查询的"关系图谱"——包含包、类、接口、方法、依赖、数据库表、MyBatis Mapper
  和 10 种链接关系。大幅提升 AI coding agent 在超大型工程项目上的语义理解效率和准确度。
version: 0.0.12
guid: f28af00a-9f21-4a46-8204-f2eb363a868c
entryPoint: SKILL.md
configType: skill
---

# AOS Ontology Skill

> AOS（**A**SDM **O**ntology **S**ervice）是 [ASDM](https://asdm.ai)（AI-First System Development Methodology）的代码本体分析组件。
>
> **企业私有化部署场景下，大模型能力受限（上下文窗口小、token/s 低），直接扫描大型代码库会导致响应极慢且分析质量严重下降。AOS 通过预构建语义层，将"逐文件扫描 + LLM 推理"降级为"毫秒级查询"，在企业级超大型代码项目中保障 AI agent 的响应速度和分析准确度。**

## 版本亮点（0.0.12）

**打通"代码 ↔ 数据库"：AI agent 现在可以一条指令追踪从 Controller 方法到数据库表列的完整全栈链路（此前链路在 Mapper 层断裂，数据库完全不可见）。**（核心特性由 0.0.11 引入，0.0.12 为 npm 文档同步修复版，功能一致）

- 数据库 DDL 解析：`.sql` 文件中的表/列/主键/外键/中文注释解析为 `Table` 对象
- 外键关系图谱：`fkReferences` 链接 + `fkDetails` 明细，支撑"删表影响分析"等跨表场景
- MyBatis Mapper XML 解析：namespace / resultMap / 动态 SQL 表名引用 / 嵌套映射
- Mapper 对象与双链接：`mapperMapsTable` / `mapperMapsEntity` 关联数据访问层与表、POJO
- MyBatis POJO 识别：无 `@Entity` 注解的 POJO 也被标记为数据模型（`MyBatis POJO`）
- JPA 注解参数提取：`@Table(name)` / `@Column(name)` 建立 JPA 实体 ↔ 表/列映射
- DDL ↔ 代码融合：审计字段补全 + 类型冲突（以 DDL 为准）与 FK 冲突（以 JPA 为准）记录
- 零影响：无 DDL / MyBatis 的项目，构建结果与 0.0.10 完全一致

## 概述

本 Skill 让 AI coding agent 通过 `aos` CLI 查询代码仓库的结构化本体（包/类/方法/依赖/调用关系 + 数据库表/MyBatis Mapper 映射），无需全量扫描源码。

**自闭环设计**：将本 Skill 目录（`asdm-aos-skill/`）放入任意 Java 代码库的 `.codebuddy/skills/` 目录下，agent 即可自动识别并使用。快照文件存储在 Skill 目录内的 `data/` 子目录中，不污染代码库。CLI 未安装时 agent 自动完成安装，用户无需手动操作。

> 0.0.11 的数据库能力（见顶部版本亮点）无需额外配置：`refreshRepo` 自动检测 `.sql` 与 Mapper XML 并纳入分析，无 DDL 项目零影响。

> **了解更多**：如需了解 AOS CLI 的详细能力（完整命令列表、参数说明、技术限制等），请访问 npm 包首页：<https://www.npmjs.com/package/@leansoftx/asdm-aos>

## 触发场景

> **Agent 应在以下场景主动加载本 Skill**（而非等用户明确说"用 AOS"）：

| 用户意图 | 典型表述 | 触发本 Skill |
|---------|---------|-------------|
| **了解项目结构** | "这个项目有哪些模块？" / "包结构是什么样的？" / "有多少个类？" | ✅ `query Package --all` + `query Class --all` |
| **查找类/方法定义** | "UserService 在哪里定义？" / "getUser 方法在哪个类？" | ✅ `query Class --where "name=UserService"` |
| **分析继承关系** | "BaseController 被谁继承了？" / "这个 DTO 继承了哪个 model？" | ✅ `link extends` / `link implements` |
| **正向调用链** | "OrderController.create 调用了哪些方法？" / "这个方法的调用链是什么？" | ✅ `link calls` |
| **反向调用链（变更影响）** | "谁调用了这个方法？" / "修改 getUser 会影响哪些代码？" / "变更影响分析" | ✅ `link calledBy` |
| **接口与实现** | "UserService 接口有哪些实现类？" / "DAO 接口定义了哪些方法？" | ✅ `link implements` + `link contains` |
| **包间依赖** | "controller 包依赖了哪些包？" / "模块间依赖关系" | ✅ `link dependsOn` |
| **外部依赖** | "这个方法调用了哪些 Spring 框架的方法？" / "用到了哪些外部库？" | ✅ `link calls`（ext: 虚拟对象）+ `link usesDependency` |
| **构建/刷新本体** | "构建本地" / "分析当前项目" / "刷新快照" / "代码有变动，重新分析" | ✅ `action refreshRepo` |
| **代码 Review 辅助** | "帮我 review 这个类的结构" / "标记这个类已审查" | ✅ `action markReviewed` + `action addNote` |
| **复杂度分析** | "哪些方法复杂度高？" / "这个方法的圈复杂度是多少？" / "找出高风险代码" | ✅ `query Method --where "complexity"` |
| **测试方法识别** | "项目有哪些测试方法？" / "测试覆盖率怎样？" / "哪些是单元测试？" | ✅ `query Method --where "isTest=true"` |
| **API 端点检测** | "项目有哪些 API 端点？" / "这个接口暴露了哪些 HTTP 方法？" / "Spring/JAX-RS 端点" | ✅ `query Method --where "endpointInfo"` |
| **数据模型识别** | "项目有哪些数据模型？" / "JPA Entity 有哪些？" / "哪些类是 Lombok 数据类？" | ✅ `query Class --where "isDataModel=true"` |
| **Javadoc 查询** | "这个方法的文档是什么？" / "这个类的说明是什么？" | ✅ `query Method --where "name=xxx"` 查看 `description` |
| **Lambda 分析** | "哪些方法用了 Lambda？" / "Stream 操作链在哪些方法中？" | ✅ `query Method --where "lambdaCount>0"` |
| **数据库表结构查询** | "数据库有哪些表？" / "这张表有哪些列、什么类型？" / "表注释和列注释是什么？" | ✅ `query Table --all` / `query Table --where "name=xxx"`（0.0.11 新增） |
| **外键关系分析** | "这张表引用了哪些表？" / "删除这张表会影响哪些表？" / "表间关系图" | ✅ `link fkReferences --src table:xxx` + `fkDetails`（0.0.11 新增） |
| **实体↔表映射** | "这个实体类对应哪张表？" / "Loan 映射的表名？" / "审计字段在数据库叫什么？" | ✅ `query Class --where "name=Loan"` 查看 `tableName`（0.0.11 新增） |
| **MyBatis POJO 识别** | "OmsCartItem 是数据模型吗？" / "MyBatis 的 POJO 类有哪些？" | ✅ `query Class --where "dataModelType=MyBatis POJO" --all`（0.0.11 新增） |
| **Mapper 数据访问分析** | "这个 Mapper 操作哪张表？" / "表的数据访问层覆盖了多少？" / "哪些表没有 Mapper？" | ✅ `link mapperMapsTable` / `mapperMapsEntity`（0.0.11 新增） |
| **列名↔属性名映射** | "product_sku_id 列对应哪个 Java 属性？" / "resultMap 在哪个 XML？" | ✅ `query Mapper --where "mappedTable=xxx"`（sourceFile + resultMapId 定位）（0.0.11 新增） |
| **全栈链路追踪** | "从 Controller 到数据库表的完整链路？" / "这个功能最终操作哪张表？" | ✅ `link calls` + `mapperMapsTable` 组合（0.0.11 新增） |
| **数据库 schema 变更影响** | "给这张表加列需要改哪些代码？" / "schema 变更影响面" | ✅ `query Table` + 反查 Mapper/POJO（0.0.11 新增） |
| **技术栈判定** | "这个项目是 JPA 还是 MyBatis？" / "持久化技术栈证据" | ✅ `query Class --where "dataModelType=..."` + `query Mapper --all`（0.0.11 新增） |

**不触发的场景**（用其他工具）：

| 用户意图 | 应使用 |
|---------|--------|
| 写/改/生成代码 | AI agent 自身能力 |
| 编译/构建/运行 | Maven/Gradle CLI |
| 单元测试 | Maven/Gradle + JUnit |
| 静态代码检查 | SonarQube / Checkstyle / SpotBugs |
| 非 Java 项目 | 语言专用工具 |

## 前置条件

- **Node.js 18+**
- **AOS CLI `@leansoftx/asdm-aos` >= 0.0.12**（0.0.12 增强：数据库 DDL 解析（Table 对象/fkReferences 链接）、MyBatis Mapper XML 解析（Mapper 对象/mapperMapsTable/mapperMapsEntity 链接）、MyBatis POJO 识别、DDL ↔ 代码融合、JPA @Table(name)/@Column(name) 参数提取）
- **目标代码库**为 Java 项目（Maven 或 Gradle）

> AOS CLI 无需用户手动安装。Agent 会在首次使用时自动检测并安装（见下方「CLI 自动安装」）。
>
> **版本要求说明**：本 Skill 文档描述的 `Table`/`Mapper` 对象类型、`fkReferences`/`mapperMapsTable`/`mapperMapsEntity` 链接类型、`Class.tableName`（@Table 提取）、`dataModelType="MyBatis POJO"`、`import-ddl` 命令需要 AOS CLI >= 0.0.12。0.0.10 的能力（`calledBy`、`complexity`/`isTest`/`endpointInfo` 等）需要 >= 0.0.10。如果安装的 CLI 版本低于要求，上述功能不可用。

## 安装方式

将本 Skill 目录复制到目标 Java 代码库中：

```bash
cd /path/to/your-java-repo
mkdir -p .codebuddy/skills
cp -r /path/to/asdm-aos-skill .codebuddy/skills/
```

安装后 CodeBuddy 等 AI agent 会自动识别 `.codebuddy/skills/asdm-aos-skill/SKILL.md` 并加载。

## CLI 自动安装

**Agent 在执行任何 `aos` 命令前，必须先检查 CLI 是否可用且版本满足要求。** 以下检查脚本会在 CLI 未安装或版本过低时自动执行全局安装：

```bash
# 检查 aos CLI 是否已安装且版本 >= 0.0.12
REQUIRED_VERSION="0.0.12"
if ! command -v aos > /dev/null 2>&1; then
  echo "AOS CLI 未安装，正在自动安装..."
  npm install -g @leansoftx/asdm-aos@$REQUIRED_VERSION
  echo "AOS CLI 安装完成。"
else
  # 检查版本是否满足要求
  INSTALLED_VERSION=$(aos --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ -z "$INSTALLED_VERSION" ] || [ "$(printf '%s\n' "$REQUIRED_VERSION" "$INSTALLED_VERSION" | sort -V | head -1)" != "$REQUIRED_VERSION" ]; then
    echo "AOS CLI 版本过低（当前: $INSTALLED_VERSION，需要: >= $REQUIRED_VERSION），正在升级..."
    npm install -g @leansoftx/asdm-aos@$REQUIRED_VERSION
    echo "AOS CLI 升级完成。"
  fi
fi

# 验证安装
aos --version
```

**Agent 行为规范**：
1. 每次会话首次执行 `aos` 命令前，先运行上述检查脚本
2. 如果 `npm install -g` 失败（如权限不足），提示用户手动执行：`sudo npm install -g @leansoftx/asdm-aos@0.0.12`
3. 安装/升级成功后继续执行后续命令
4. 同一会话内无需重复检查（CLI 已安装且版本满足即可）

**权限不足时的降级方案**：

如果全局安装失败（EACCES 权限错误），agent 可改用 `npx` 临时执行：

```bash
# 降级方案：用 npx 临时运行（无需全局安装，自动使用最新版）
npx @leansoftx/asdm-aos@0.0.12 --version
npx @leansoftx/asdm-aos@0.0.12 query Repository --all
```

> 使用 `npx` 时，需将本文档中所有 `aos` 替换为 `npx @leansoftx/asdm-aos@0.0.12`。首次执行会下载包，后续从缓存运行。

## 核心概念：快照目录

所有 CLI 命令通过 `--snapshot-dir` 指定快照目录。本 Skill 约定快照存放在 Skill 目录的 `data/` 子目录：

```bash
# Skill 目录的绝对路径
SKILL_DIR="<代码库根目录>/.codebuddy/skills/asdm-aos-skill"

# 所有命令都通过 --snapshot-dir 指定快照位置
aos --snapshot-dir "$SKILL_DIR/data" query Repository --all
```

> **简化写法**：agent 执行命令时，需将 `$SKILL_DIR` 替换为 Skill 目录的实际绝对路径。也可设置环境变量 `export AOS_SNAPSHOT_DIR="$SKILL_DIR/data"` 后省略 `--snapshot-dir`。

## 首次使用：构建本地本体

**当用户说「构建本地」或类似表述时**，agent 应执行以下步骤：

```bash
# 0. 确保 CLI 已安装（见「CLI 自动安装」章节）
if ! command -v aos > /dev/null 2>&1; then
  npm install -g @leansoftx/asdm-aos
fi

# 1. 确定代码库根目录（通常是当前工作目录或 git 仓库根目录）
REPO_ROOT=$(pwd)

# 2. 确定 Skill 目录
SKILL_DIR="$REPO_ROOT/.codebuddy/skills/asdm-aos-skill"

# 3. 确保快照目录存在
mkdir -p "$SKILL_DIR/data"

# 4. 构建本体快照（分析当前代码库，写入 Skill 目录的 data/ 下）
# 0.0.10: repoPath 支持目录路径、文件路径、或不传（自动检测）
# 0.0.11: 自动检测仓库内 .sql 文件（DDL）与 MyBatis Mapper XML，无需额外参数
aos --snapshot-dir "$SKILL_DIR/data" action refreshRepo --params '{"repoPath":"."}'
```

**预期输出**（JSON）：
```json
{
  "ok": true,
  "message": "已成功导入 my-project（123 个 Java 文件）",
  "stats": {
    "fileCount": 145,
    "packageCount": 15,
    "classCount": 60,
    "interfaceCount": 8,
    "methodCount": 320,
    "dependencyCount": 25,
    "tableCount": 76,
    "mapperCount": 76
  }
}
```

> **0.0.11 说明**：`refreshRepo` 自动检测 DDL（`.sql`）与 Mapper XML（无需参数）。构建时若检测到会输出 `[4.5/6] DDL 分析` 与 `[4.6/6] MyBatis Mapper 分析` 进度。无 DDL/MyBatis 的项目自动跳过，零影响。

构建完成后，`$SKILL_DIR/data/snapshot.json` 文件即为后续所有查询的数据源。

## 检查是否已构建

**在执行任何查询前，agent 应先检查快照是否存在**：

```bash
SKILL_DIR="<代码库根目录>/.codebuddy/skills/asdm-aos-skill"
if [ ! -f "$SKILL_DIR/data/snapshot.json" ]; then
  echo "⚠️ 尚未构建本地本体。请对我说「构建本地」以生成本体快照。"
  exit 1
fi
```

或直接尝试查询，CLI 会输出友好错误提示：
```
错误：未找到本体快照。
  快照目录: /path/to/.codebuddy/skills/asdm-aos-skill/data
  请先执行构建：aos action refreshRepo
  或指定快照目录：aos --snapshot-dir <path> query Repository --all
  或设置环境变量：export AOS_SNAPSHOT_DIR=<path>
```

**当看到此错误时，agent 应主动提示用户**：「尚未构建本地本体，请对我说「构建本地」以生成本体快照。」

## 本体模型

### 对象类型

| 类型 | 说明 | 典型属性 | ID 前缀 |
|------|------|---------|---------|
| Repository | 代码仓库 | name, path, language, commitHash, branch, fileCount, **analysisErrors** | `repo:` |
| Package | Java 包 | name, fullPath, visibility, classCount | `pkg:` |
| Class | 类/枚举 | name, type(class/enum), visibility, modifiers, lineCount, **description**, **isDataModel**, **dataModelType**, **tableName** | `cls:` |
| Interface | 接口 | name, visibility, modifiers, methodSignatures, extendsInterfaceIds, lineCount, **description** | `intf:` |
| Method | 方法 | name, returnType, visibility, parameters, lineCount, **complexity**, **description**, **isTest**, **testType**, **isTestSetup**, **endpointInfo**, **lambdaCount** | `mtd:` |
| Dependency | 外部依赖 | name, version, scope(compile/test/runtime), source(maven/gradle) | `dep:` |
| **Table** | 数据库表 | name, schema, comment, engine, charset, primaryKey, columns(嵌套 ColumnInfo[]), sourceFile, matchedEntityClass, **fkDetails** | `table:` |
| **Mapper** | MyBatis Mapper 接口 | name, namespace, mappedTable, mappedEntityClass, resultMapId, sourceFile | `mapper:` |

> **0.0.10 新增属性**（加粗显示）：
> - **Repository.analysisErrors**：分析错误记录（文件路径 + 错误信息 + 时间戳）
> - **Class.description**：类的 Javadoc 注释
> - **Class.isDataModel / dataModelType**：数据模型标识（JPA Entity / MongoDB Document / Record / Lombok Data / Immutable / **MyBatis POJO**）
> - **Interface.description**：接口的 Javadoc 注释
> - **Method.complexity**：复杂度指标（圈复杂度 / 分支数 / 循环数 / 最大嵌套深度 / 异常处理数 / 提前返回数 / 逻辑运算符数）
> - **Method.description**：方法的 Javadoc 注释
> - **Method.isTest / testType / isTestSetup**：测试方法标识（@Test / @ParameterizedTest / @BeforeEach 等）
> - **Method.endpointInfo**：API 端点信息（HTTP 方法 / 路径 / 框架 Spring|JAX-RS）
> - **Method.lambdaCount**：Lambda 表达式数量

> **0.0.11 新增**（Table/Mapper 对象类型与属性）：
> - **Table**：DDL 解析的数据库表（974 个实测：mall 76 / RuoYi 32 / Fineract 748 / eladmin 37 / RuoYi-Vue-Plus 78 / qa-healthcare 3）
>   - `primaryKey`：主键列（逗号分隔字符串，复合主键如 "menu_id,role_id"）
>   - `columns`：列定义数组（name / sqlType / isNullable / isPrimaryKey / isUnique / isForeignKey / isAutoIncrement / defaultValue / comment）
>   - `comment`：表注释（RuoYi 中文注释提取率 >90%）
>   - `fkDetails`：外键明细（columnName / refTable / refColumn / name 约束名）
>   - `matchedEntityClass`：融合匹配的实体类名（JPA @Table 或 MyBatis resultMap；无匹配为 ""，即"孤儿表"）
> - **Mapper**：MyBatis Mapper XML 接口（98 个实测：mall 76 / RuoYi 21）
>   - `namespace`：XML namespace（即 Mapper ID）
>   - `mappedTable` / `mappedEntityClass`：关联表与 POJO
>   - `resultMapId`：主 resultMap（如 BaseResultMap）
>   - `sourceFile`：XML 文件路径（定位 resultMap 列映射）
> - **Class.tableName**：JPA `@Table(name=...)` 参数提取（Fineract 251/255 实测；MyBatis POJO 此属性为空，走 Mapper.mappedTable）
> - **Class.dataModelType = "MyBatis POJO"**：无 @Entity 注解的 POJO 经 resultMap.type 反查识别（mall 76 / RuoYi 21 实测）

### 链接

| 链接 | 语义 | 方向 |
|------|------|------|
| contains | 层次包含 | Repository→Package→Class/Interface→Method |
| dependsOn | 包间依赖 | Package→Package（import 关系） |
| calls | 方法调用 | Method→Method（含 `ext:` 外部库虚拟对象） |
| calledBy | 被调用（反向） | Method→Method（谁调用了指定方法） |
| extends | 继承 | Class→Class / Interface→Interface |
| implements | 类实现接口 | Class→Interface |
| usesDependency | 使用依赖 | Package→Dependency |
| **fkReferences** | 外键引用 | Table→Table（DDL FOREIGN KEY；删除表的影响分析） |
| **mapperMapsTable** | Mapper 映射表 | Mapper→Table（MyBatis 数据访问层关联） |
| **mapperMapsEntity** | Mapper 映射实体 | Mapper→Class（resultMap.type 的 POJO） |

### 动作

| 动作 | 用途 | 守卫 |
|------|------|------|
| refreshRepo | 重新分析仓库（生成新快照） | 路径必须存在且为目录 |
| markReviewed | 标记类已 review（持久化） | classId 必须存在 |
| addNote | 给对象加注释（持久化） | objectId 必须存在；note 非空 |

## CLI 命令参考

> 以下命令中的 `$SKILL_DIR` 需替换为 Skill 目录的实际绝对路径。也可设置 `export AOS_SNAPSHOT_DIR="$SKILL_DIR/data"` 后省略 `--snapshot-dir`。
>
> **前置**：执行以下命令前，确保 CLI 已安装（见「CLI 自动安装」）。

### query — 查询对象

```bash
# 查询所有包
aos --snapshot-dir "$SKILL_DIR/data" query Package --all

# 按条件过滤
aos --snapshot-dir "$SKILL_DIR/data" query Class --where "visibility=public"

# 人类可读格式
aos --snapshot-dir "$SKILL_DIR/data" query Method --where "name=getUser" --pretty

# 0.0.11：数据库表查询
aos --snapshot-dir "$SKILL_DIR/data" query Table --all                          # 全部表（含列/主键/注释）
aos --snapshot-dir "$SKILL_DIR/data" query Table --where "name=oms_cart_item"   # 单表结构（columns 嵌套数组）

# 0.0.11：Mapper 查询
aos --snapshot-dir "$SKILL_DIR/data" query Mapper --all                         # 全部 Mapper
aos --snapshot-dir "$SKILL_DIR/data" query Mapper --where "name=OmsCartItemMapper"
aos --snapshot-dir "$SKILL_DIR/data" query Mapper --where "mappedTable=oms_order"  # 反查表的数据访问层

# 0.0.11：MyBatis POJO / JPA 实体查询
aos --snapshot-dir "$SKILL_DIR/data" query Class --where "dataModelType=MyBatis POJO" --all
aos --snapshot-dir "$SKILL_DIR/data" query Class --where "dataModelType=JPA Entity" --all
aos --snapshot-dir "$SKILL_DIR/data" query Class --where "name=Loan"            # tableName 属性（@Table 提取）
```

### link — 遍历链接关系

```bash
# 仓库 → 包
aos --snapshot-dir "$SKILL_DIR/data" link contains --src repo:my-project

# 包 → 类
aos --snapshot-dir "$SKILL_DIR/data" link contains --src pkg:com.example.controller

# 方法调用链
aos --snapshot-dir "$SKILL_DIR/data" link calls --src mtd:com.example.UserService.login

# 反向调用链（谁调用了指定方法）
aos --snapshot-dir "$SKILL_DIR/data" link calledBy --src mtd:com.example.UserService.login

# 类继承
aos --snapshot-dir "$SKILL_DIR/data" link extends --src cls:com.example.UserService

# 接口继承
aos --snapshot-dir "$SKILL_DIR/data" link extends --src intf:com.example.UserRepository

# 接口实现
aos --snapshot-dir "$SKILL_DIR/data" link implements --src cls:com.example.UserRepository

# 包使用的依赖
aos --snapshot-dir "$SKILL_DIR/data" link usesDependency --src pkg:com.example

# 0.0.11：数据库表外键引用（Table → Table）
aos --snapshot-dir "$SKILL_DIR/data" link fkReferences --src table:m_loan

# 0.0.11：Mapper → 表 / Mapper → POJO
aos --snapshot-dir "$SKILL_DIR/data" link mapperMapsTable --src mapper:com.macro.mall.mapper.OmsCartItemMapper
aos --snapshot-dir "$SKILL_DIR/data" link mapperMapsEntity --src mapper:com.macro.mall.mapper.OmsCartItemMapper
```

> **对象 ID 格式**：`table:<表名>`（如 `table:oms_cart_item`）、`mapper:<XML namespace>`（如 `mapper:com.macro.mall.mapper.OmsCartItemMapper`）、`cls:<全限定类名>`、`mtd:<全限定名>.<方法名>(:<参数类型>)`。

### action — 执行受控动作

```bash
# 重新分析仓库（repoPath 缺省时自动检测项目根目录）
# 0.0.10 新增：支持传入文件路径，自动向上查找 pom.xml/build.gradle 确定项目根目录
aos --snapshot-dir "$SKILL_DIR/data" action refreshRepo --params '{"repoPath":"/path/to/java/repo"}'

# 也可以传入文件路径（自动检测项目根目录）
aos --snapshot-dir "$SKILL_DIR/data" action refreshRepo --params '{"repoPath":"src/main/java/com/example/UserService.java"}'

# 不传 repoPath 时，从当前工作目录自动检测
aos --snapshot-dir "$SKILL_DIR/data" action refreshRepo --params '{}'

# 0.0.11：单独导入 DDL（只解析 SQL，不扫描 Java 代码；输出表/FK/索引/错误统计）
aos import-ddl --sql-dir ./sql --dialect mysql

# 标记类已审查（自动持久化）
aos --snapshot-dir "$SKILL_DIR/data" action markReviewed --params '{"classId":"cls:com.example.UserService"}'

# 添加注释（自动持久化）
aos --snapshot-dir "$SKILL_DIR/data" action addNote --params '{"objectId":"cls:com.example.UserService","note":"核心服务类"}'
```

### export — 导出本体快照

```bash
# 导出 Markdown（小型仓库可用，大型仓库会超限）
aos --snapshot-dir "$SKILL_DIR/data" export --format markdown --output "$SKILL_DIR/data/export.md"

# 导出 JSON
aos --snapshot-dir "$SKILL_DIR/data" export --format json --output "$SKILL_DIR/data/snapshot-copy.json"

# 管道给 jq 聚合分析
aos --snapshot-dir "$SKILL_DIR/data" export --format json | jq '[.Class[]] | length'
```

## 使用建议

### 通用工作流

1. **确保 CLI 安装**：检查 `aos` 可用，未安装则自动安装
2. **检查快照**：确认 `$SKILL_DIR/data/snapshot.json` 存在，不存在则提示「构建本地」
3. **概览仓库**：`aos query Repository --all` + `aos query Package --all`
4. **逐层下钻**：`link contains` 从 Repository → Package → Class → Method
5. **分析关系**：用 `link calls/calledBy/extends/implements/dependsOn/usesDependency`
6. **分析数据库**（如有 DDL）：`query Table` 表结构 → `link fkReferences` 外键 → `query Mapper` 数据访问层 → `link mapperMapsTable/mapperMapsEntity` ORM 映射
7. **回写结论**：`action markReviewed` + `action addNote`（跨会话保留）

### 大型仓库策略（> 500 文件）

1. **避免全量 export**：输出可能超过 50MB，超出 LLM 上下文限制
2. **用 query 缩小范围**：先 `query Package --all` 了解模块，再 `query Class --where "packageId=pkg:..."` 定位
3. **用 link 逐层下钻**：只获取当前关注层级的数据
4. **用 --where 过滤**：默认仅返回前 50 条

### 变更影响分析（S2 场景）

修改某个方法后，用 `calledBy` 反向追踪所有上游调用者：

```bash
# 查看谁调用了该方法
aos --snapshot-dir "$SKILL_DIR/data" link calledBy --src mtd:com.example.UserService.login

# 再递归查看上游的上游
aos --snapshot-dir "$SKILL_DIR/data" link calledBy --src mtd:com.example.AuthController.authenticate
```

`calls` 链接返回的结果中，`isExternal: true` 的对象表示外部库方法调用（如 Spring/Hutool），`externalClassName` 字段为外部库全限定类名。

### 代码复杂度分析（0.0.10 新增）

识别高复杂度方法，优先进行 code review 和重构：

```bash
# 查询所有方法并按圈复杂度排序（需配合 jq）
aos --snapshot-dir "$SKILL_DIR/data" query Method --all | jq '[.[] | select(.complexity != null) | {name, cc: .complexity.cyclomaticComplexity, depth: .complexity.maxNestingDepth}] | sort_by(-.cc) | .[0:20]'

# 查看特定方法的复杂度详情
aos --snapshot-dir "$SKILL_DIR/data" query Method --where "name=processOrder" --pretty
# 返回结果中 complexity 字段包含：cyclomaticComplexity, branchCount, loopCount, maxNestingDepth, exceptionHandlerCount, earlyReturnCount, logicalOperatorCount
```

### 测试方法识别（0.0.10 新增）

识别项目中的测试方法和测试生命周期方法：

```bash
# 查询所有 @Test 方法
aos --snapshot-dir "$SKILL_DIR/data" query Method --all | jq '[.[] | select(.isTest == true)]'

# 查询测试 setup 方法（@BeforeEach/@AfterEach 等）
aos --snapshot-dir "$SKILL_DIR/data" query Method --all | jq '[.[] | select(.isTestSetup == true)]'

# 按测试类型分类（UnitTest / IntegrationTest）
aos --snapshot-dir "$SKILL_DIR/data" query Method --all | jq '[.[] | select(.isTest == true) | .testType] | group_by(.) | map({type: .[0], count: length})'
```

### API 端点检测（0.0.10 新增）

识别项目中的所有 API 端点（Spring MVC + JAX-RS）：

```bash
# 查询所有 API 端点方法
aos --snapshot-dir "$SKILL_DIR/data" query Method --all | jq '[.[] | select(.endpointInfo != null) | {name, method: .endpointInfo.httpMethod, path: .endpointInfo.path, framework: .endpointInfo.framework}]'

# 按 HTTP 方法分类
aos --snapshot-dir "$SKILL_DIR/data" query Method --all | jq '[.[] | select(.endpointInfo != null) | .endpointInfo.httpMethod] | group_by(.) | map({method: .[0], count: length})'

# 仅查看 JAX-RS 端点
aos --snapshot-dir "$SKILL_DIR/data" query Method --all | jq '[.[] | select(.endpointInfo.framework == "JAX-RS")]'
```

### 数据模型识别（0.0.10 新增）

识别项目中的数据模型类（JPA Entity / Record / Lombok 等）：

```bash
# 查询所有数据模型类
aos --snapshot-dir "$SKILL_DIR/data" query Class --all | jq '[.[] | select(.isDataModel == true) | {name, type: .dataModelType}]'

# 按数据模型类型分类
aos --snapshot-dir "$SKILL_DIR/data" query Class --all | jq '[.[] | select(.isDataModel == true) | .dataModelType] | group_by(.) | map({type: .[0], count: length})'

# 仅查看 JPA Entity
aos --snapshot-dir "$SKILL_DIR/data" query Class --all | jq '[.[] | select(.dataModelType == "JPA Entity")]'
```

### 数据库表结构查询（0.0.11 新增）

查询数据库表、列、主键、注释与复合主键：

```bash
# 全部表（数量与清单）
aos --snapshot-dir "$SKILL_DIR/data" query Table --all | jq '[.[].name] | length'
aos --snapshot-dir "$SKILL_DIR/data" query Table --all | jq '[.[].name] | sort'

# 单表结构（列/类型/注释/主键）
aos --snapshot-dir "$SKILL_DIR/data" query Table --where "name=oms_cart_item" --pretty

# 列级明细（jq 展开 columns）
aos --snapshot-dir "$SKILL_DIR/data" query Table --where "name=oms_cart_item" | jq '.[0].columns | map({name, sqlType, comment, isPrimaryKey, isNullable})'

# 复合主键表（primaryKey 为逗号分隔字符串，如 "menu_id,role_id"）
aos --snapshot-dir "$SKILL_DIR/data" query Table --all | jq '[.[] | select((.primaryKey | split(",") | length) > 1) | {name, primaryKey}]'

# 孤儿表（无任何实体映射的表，如纯查找表/调度框架表）
aos --snapshot-dir "$SKILL_DIR/data" query Table --all | jq '[.[] | select(.matchedEntityClass == "") | .name]'
```

### 外键关系与跨表影响分析（0.0.11 新增）

追踪表间外键引用，分析删表/改表的影响面：

```bash
# 正向：这张表引用了哪些表
aos --snapshot-dir "$SKILL_DIR/data" link fkReferences --src table:m_loan --pretty

# 外键明细（列名/引用表/引用列/约束名）
aos --snapshot-dir "$SKILL_DIR/data" query Table --where "name=m_loan" | jq '.[0].fkDetails'

# 反向：谁引用了这张表（删表影响分析；全量表按 fkDetails.refTable 过滤）
aos --snapshot-dir "$SKILL_DIR/data" query Table --all | jq '[.[] | select(.fkDetails[]?.refTable == "m_client") | {name, refs: [.fkDetails[] | select(.refTable == "m_client") | .columnName]}]'
```

### 实体 ↔ 表映射与列补全（0.0.11 新增）

JPA 实体与数据库表的映射查询（含审计字段补全）：

```bash
# 实体映射的表名（@Table(name=...) 提取）
aos --snapshot-dir "$SKILL_DIR/data" query Class --where "name=Loan" | jq '.[0].tableName'   # → "m_loan"

# 有 @Table 注解的全部实体
aos --snapshot-dir "$SKILL_DIR/data" query Class --all | jq '[.[] | select(.tableName != null) | {name, tableName}]'

# 审计字段对照（Java 基类字段 vs DDL 补全列）
aos --snapshot-dir "$SKILL_DIR/data" query Class --where "name=AbstractAuditable" --pretty
aos --snapshot-dir "$SKILL_DIR/data" query Table --where "name=m_loan" | jq '.[0].columns | map(select(.name | test("created|modified")) | .name)'
```

### MyBatis POJO / Mapper 数据访问层分析（0.0.11 新增）

MyBatis 项目的数据模型与数据访问层查询：

```bash
# MyBatis POJO（无 @Entity 注解但被 resultMap 引用的类）
aos --snapshot-dir "$SKILL_DIR/data" query Class --where "dataModelType=MyBatis POJO" --all | jq '[.[].name] | length'

# Mapper 全景（namespace/关联表/POJO/resultMap/XML 路径）
aos --snapshot-dir "$SKILL_DIR/data" query Mapper --all | jq '[.[] | {name, mappedTable, mappedEntityClass, resultMapId}]'

# 反查：某张表的数据访问层（表 → Mapper → POJO）
aos --snapshot-dir "$SKILL_DIR/data" query Mapper --where "mappedTable=oms_order" --pretty

# Mapper → 表 / Mapper → POJO 链接遍历
aos --snapshot-dir "$SKILL_DIR/data" link mapperMapsTable --src mapper:com.macro.mall.mapper.OmsCartItemMapper --pretty
aos --snapshot-dir "$SKILL_DIR/data" link mapperMapsEntity --src mapper:com.macro.mall.mapper.OmsCartItemMapper --pretty

# 数据访问层覆盖率（有映射的表 / 全部表）
aos --snapshot-dir "$SKILL_DIR/data" query Mapper --all | jq '[.[] | select(.mappedTable != "")] | length'
aos --snapshot-dir "$SKILL_DIR/data" query Table --all | jq 'length'
```

### 全栈链路追踪（0.0.11 新增）

从 HTTP 入口贯穿到数据库表（Controller → Service → Mapper → Table）：

```bash
# ① 定位 Controller 方法（Method ID 含参数签名）
aos --snapshot-dir "$SKILL_DIR/data" query Method --where "name=add" --all | jq '[.[] | select(.id | test("OmsCartItemController")) | .id]'

# ② Controller → Service 调用
aos --snapshot-dir "$SKILL_DIR/data" link calls --src "mtd:com.macro.mall.portal.controller.OmsCartItemController.add(:OmsCartItem)" --pretty

# ③ Service 接口 → 实现类
aos --snapshot-dir "$SKILL_DIR/data" query Interface --where "name=OmsCartItemService" --pretty
aos --snapshot-dir "$SKILL_DIR/data" query Class --where "name=OmsCartItemServiceImpl" --pretty

# ④ 实现类 → Mapper（实现类方法的 calls 含 Mapper 方法）
aos --snapshot-dir "$SKILL_DIR/data" link calls --src "mtd:com.macro.mall.portal.service.impl.OmsCartItemServiceImpl.add(:OmsCartItem)" --pretty

# ⑤ Mapper → 表
aos --snapshot-dir "$SKILL_DIR/data" link mapperMapsTable --src mapper:com.macro.mall.mapper.OmsCartItemMapper --pretty

# ⑥ 表结构（关键列）
aos --snapshot-dir "$SKILL_DIR/data" query Table --where "name=oms_cart_item" --pretty
```

### 数据库 schema 变更影响分析（0.0.11 新增）

DDL 变更前的影响面评估（S2 场景的数据库延伸）：

```bash
# 1. 当前列与约束
aos --snapshot-dir "$SKILL_DIR/data" query Table --where "name=oms_order" --pretty

# 2. 变更影响代码面（表 → Mapper → POJO）
aos --snapshot-dir "$SKILL_DIR/data" query Mapper --where "mappedTable=oms_order" --pretty   # sourceFile 定位 XML
aos --snapshot-dir "$SKILL_DIR/data" query Mapper --where "mappedTable=oms_order" | jq '.[0] | {mappedEntityClass, resultMapId, sourceFile}'

# 3. 关联实体类（需同步修改的 Java 类）
aos --snapshot-dir "$SKILL_DIR/data" query Class --where "name=OmsOrder" --pretty
```

### Javadoc / 方法说明查询（0.0.10 新增）

获取方法和类的文档注释：

```bash
# 查看方法的 Javadoc
aos --snapshot-dir "$SKILL_DIR/data" query Method --where "name=getUser" --pretty
# 返回结果中的 description 字段包含 Javadoc 内容

# 查看类的 Javadoc
aos --snapshot-dir "$SKILL_DIR/data" query Class --where "name=UserService" --pretty
# 返回结果中的 description 字段包含类级 Javadoc

# 查询所有有 Javadoc 的方法
aos --snapshot-dir "$SKILL_DIR/data" query Method --all | jq '[.[] | select(.description != "") | {name, description}]'
```

### Agent 行为规范

| 用户意图 | Agent 行为 |
|---------|-----------|
| 任意 `aos` 命令（首次） | 检查 CLI 是否安装，未安装则自动 `npm install -g @leansoftx/asdm-aos@0.0.12` |
| 「构建本地」/「分析当前项目」 | 确保 CLI 安装 → 执行 `aos action refreshRepo` 生成快照到 `$SKILL_DIR/data/`（自动含 DDL 与 MyBatis 分析；支持传入文件路径，自动检测项目根目录） |
| 查询/遍历类请求 | 确保 CLI 安装 → 检查快照是否存在 → 不存在则提示「请先说构建本地」 |
| 数据库表结构/外键/表间关系问题 | `query Table`（含 columns/fkDetails）→ `link fkReferences`；无 Table 对象时提示「项目无 .sql 文件或快照为旧版，请重新构建本地」 |
| 实体↔表/Mapper/列名映射问题 | `query Class --where "name=X"` 查 tableName（JPA）→ `query Mapper --where "mappedTable=Y"`（MyBatis）→ `link mapperMapsTable/mapperMapsEntity` |
| 代码变更后 | 提醒用户重新「构建本地」以刷新快照 |
| 数据库 schema 变更后 | 提醒用户重新「构建本地」（DDL 从 .sql 重新解析） |
| 跨会话恢复 | 确保 CLI 安装 → 检查快照存在 → `query` 恢复上下文 → 继续工作 |
| CLI 全局安装失败 | 提示用户手动执行 `sudo npm install -g @leansoftx/asdm-aos@0.0.12`，或降级用 `npx @leansoftx/asdm-aos@0.0.12` |

## 输出格式

- **默认 JSON**：stdout 输出 JSON 数组，便于 agent 解析
- **`--pretty`**：人类可读表格，调试用
- **`--output`**：export 写入文件，不污染 stdout
- **退出码**：`0` 成功，`1` 失败

## 技术限制

- 每次调用全量加载 JSON 快照（建议仓库 < 1,000 .java 文件；含 DDL 后快照增大约 2-7%）
- 无并发写保护（多 Agent 同时写 action 会覆盖）
- `--where` 为全表扫描（O(n)），无索引
- CLI 直接读 snapshot.json，不依赖后端进程在线
- `.class only` 方法（仅有字节码、无源码）的 `complexity`/`description`/`isTest`/`endpointInfo`/`lambdaCount` 等属性为 `null` 或默认值
- 增量解析（`IncrementalParser`）已实现，但当前 `refreshRepo` 仍为全量解析模式，增量模式将在 Part04 启用
- **DDL 仅支持 MySQL 方言**（CREATE TABLE / ALTER TABLE / CREATE INDEX；存储过程 DELIMITER 块自动跳过）；Oracle/PostgreSQL/SQLServer 方言文件会解析报错（已知边界）
- **MyBatis 仅解析 XML 映射文件**（resultMap / 动态 SQL 表名引用 / 嵌套 association-collection）；MyBatis-Plus 注解 SQL（@TableName/@TableId）不在 XML 中，暂不覆盖
- **Liquibase changelog XML**（变更日志型 DDL）不在快照解析范围（后续版本预留）
- 融合冲突记录（类型冲突/FK 冲突）为构建期诊断数据，不在快照对象中；类型冲突以 DDL 为准，FK 冲突以 JPA @ManyToOne 为准

---

## 发版记录

| 版本 | 日期 | 说明 |
|---|---|---|
| **0.0.12** | 2026-08-19 | 文档修复：npm 展示 README 与 CLI 文档同步（build:cli 自动同步根 README）；功能与 0.0.11 一致 |
| **0.0.11** | 2026-08-19 | 打通"代码 ↔ 数据库"：DDL 解析（Table 对象/fkReferences 外键链接）、MyBatis Mapper XML 解析（Mapper 对象/双链接）、MyBatis POJO 识别、JPA `@Table` 参数提取、DDL ↔ 代码融合与审计字段补全；分析器目录重构（shared/java/sql 分层）；全栈链路（Controller → 数据库表）首次贯穿 |
| **0.0.10** | 2026-08-13 | 代码特征深度分析（tree-sitter）：复杂度分析、Javadoc 提取、测试方法识别（@Test/@ParameterizedTest）、API 端点检测（Spring/JAX-RS）、数据模型识别（JPA Entity/Record/Lombok）、Lambda 提取、项目根目录自动检测；测试体系建立（107 测试） |
| **0.0.8** | 2026-08-12 | 链接完整性增强：`calledBy` 反向调用链（变更影响分析）、`ext:` 外部库虚拟对象（外部依赖调用可见性）、`contains` 包含 Interface；Skill 触发场景与 Agent 行为规范完善 |
| **0.0.4** | 2026-08-12 | npm 正式发布：CLI 结构化日志与结果统计、`findClassFiles` 收集 test-classes、Lambda 调用合并、方法重载 ID 区分、内部类方法归属修正——调用链覆盖率 4.32% → 79.87% 系列修复 |
| **0.0.3** | 2026-08-10 | npm 发布准备：README 完善（项目目标/价值/架构/使用方式）、CLI 日志输出优化 |
| **0.0.1** | 2026-08-07 | 初始 MVP：Java 源码 + 字节码分析，包/类/接口/方法/依赖 6 种对象与 contains/dependsOn/calls/extends/implements/usesDependency 链接，本体快照与 query/link CLI |

---

## 了解更多

- **ASDM 官网**：<https://asdm.ai> — AI-First System Development Methodology，面向 AI 时代的系统开发方法论
- **AOS CLI npm 包**：<https://www.npmjs.com/package/@leansoftx/asdm-aos> — AOS CLI 的完整命令列表、参数说明和技术限制

---

© 2026 [ASDM](https://asdm.ai). All rights reserved.
