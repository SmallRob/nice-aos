---
name: nice-aos-fullscan
description: |
  一站式全栈代码扫描：把 React/TypeScript/Vue/油猴/Go/Rust/Dart/Python 等主代码 + MySQL 迁移脚本（.sql）
  + 部署配置（Dockerfile / docker-compose / K8s / nginx / .env / shell） + 配置/视图/样式文件
  （.css/.html/.sql/.yml/.yaml/.conf/.toml/.ini/.env）统一扫描为结构化本体快照，
  供 agent 跨毫秒级查询与蓝图展示。
  nice-aos v0.29.0+ 一次性把代码本体（`action refreshRepo`）+ 数据库迁移（`db scan`）+ 部署配置（`deploy scan`）
  + 配置/视图文件行数与顶层 key 提取全部纳入主分析。
  适用：用户说"全栈扫描 / 一次性分析代码和部署 / 扫整个项目库 / 包含 SQL 和部署 / 多类型项目扫描 /
  完整代码蓝图 + 数据库蓝图 + 部署蓝图 / 跨类型代码行数统计"，
  或在大规模 monorepo（含前端 + 后端 + SQL + K8s/Compose）里需要统一视图时。
  不做：单类型深挖（用专用 nice-aos-* skill）/ 油猴审计 / 死代码清理 / 代码生成 / 重构。
---

# Nice AOS Full-Scan Skill — 一站式全栈代码扫描

> 统一调度 nice-aos 的三大子命令（refreshRepo / db scan / deploy scan），并把项目里的配置/视图文件
> （.css / .html / .sql / .yml / .yaml / .conf / .toml / .ini / .env）也纳入主本体快照。
> 适用于多类型混合项目（前端 + 后端 + SQL + 部署 + 配置）。
> **核心价值**：把"逐类型单独跑 + 手动对齐"降级为"一次命令出全套快照 + 三套蓝图"，
> 涵盖代码本体、数据库 schema、部署架构三个维度的全景视图。
> **分工**：本 Skill 承载一站式调度与汇总；单类型深挖见 `nice-aos` / `nice-aos-database` / `nice-aos-deployment` 三个 skill。

## 适用场景

| 项目类型 | 用此 skill？ | 推荐命令组合 |
|---------|:---:|---|
| 纯前端 / 纯后端（单一类型） | ✗ | 用 `nice-aos` skill 即可 |
| 前端 + 后端（monorepo，单语言） | ✗ | `nice-aos` skill，`roots=["src","server"]` 一次扫 |
| **前端 + SQL + 部署（典型中台）** | ✓ | refreshRepo + db scan + deploy scan |
| **多 monorepo + SQL + K8s** | ✓ | 三套命令分别跑各自的 dir |
| 含 .css / .html / .env / *.conf 的前端项目 | ✓ | refreshRepo（v0.29.0+ 默认会扫顶层 .env / index.html / *.conf / nginx.conf） |
| **多项目 / 18 个仓库的全量盘点** | ✓ | 见末尾"批量扫描"模板 |
| **多项目全景架构图（类似 asdm-aos 服务蓝图）** | ✓ | 批量扫 + `_architecture.py` 聚合（见末尾"全景架构"模板） |

| 用户意图 | 典型表述 | 命令组合 |
|---------|---------|---------|
| **一站式全栈扫描** | "扫整个项目" / "代码 + SQL + 部署一起看" | 三套命令按顺序跑（见下方"标准工作流"） |
| **行数汇总（多类型）** | "项目一共多少行代码" / "TS + SQL + YAML 各多少行" | `refreshRepo` 后从 `SourceFile.ext` 聚合 |
| **数据库模型 + 部署 + 代码全要** | "出 3 套蓝图" | refreshRepo + db export html + deploy export html |
| **批量扫多个仓库** | "扫这 18 个项目" | 循环 `_scan.sh` 模板，对每个项目跑三套命令到不同 snapshot 目录 |
| **跨类型依赖追踪** | "哪个 service 引用了哪个 SQL 表" | refreshRepo（含 SQL 顶层对象名）+ db（schema 详情）+ 手动 cross-ref |

## 触发场景

| 用户意图 | 典型表述 | 命令组合 |
|---------|---------|---------|
| **一站式全栈扫描** | "扫整个项目" / "代码 + SQL + 部署一起看" | 三套命令按顺序跑（见下方"标准工作流"） |
| **行数汇总（多类型）** | "项目一共多少行代码" / "TS + SQL + YAML 各多少行" | `refreshRepo` 后从 `SourceFile.ext` 聚合 |
| **数据库模型 + 部署 + 代码全要** | "出 3 套蓝图" | refreshRepo + db export html + deploy export html |
| **批量扫多个仓库** | "扫这 18 个项目" | 循环 `_scan.sh` 模板，对每个项目跑三套命令到不同 snapshot 目录 |
| **跨类型依赖追踪** | "哪个 service 引用了哪个 SQL 表" | refreshRepo（含 SQL 顶层对象名）+ db（schema 详情）+ 手动 cross-ref |
| **全景架构蓝图** | "画一张覆盖 18 项目的架构图" / "类似 asdm-aos 服务蓝图" | 批量扫 + `_architecture.py` 聚合（6 指标卡 + 分层架构图） |
| **架构层归属** | "哪些项目是前端、哪些是后端、哪些是工具" | `_architecture.py` 按 layer 分桶渲染 |
| **跨项目依赖矩阵** | "asdm-portal 依赖哪些 asdm-* 包" | `_architecture.py` 从 package.json `dependencies` 抽取 |
| **Java 业务规模** | "12 个 Spring Boot 一共多少 API 控制器和业务服务" | `_architecture.py` 跑 ripgrep 统计 @RestController / @Service 注解文件 |

## 全景架构蓝图（v0.29.0+）

`nice-aos` 当前聚焦单项目本体。多项目 / 仓库群的"全景架构"需在 skill 调用方做二次聚合。`asdm/_blueprints/_architecture.py` 是一个可复用模板：

```bash
# 1) 先批量扫每个项目到独立 snapshot 目录
for proj in asdm-portal asdm-admin asdm-mcp-server ...; do
  nice-aos --snapshot-dir "_blueprints/$proj" action refreshRepo \
    --params "{\"repoPath\":\"./asdm/$proj\"}"
done

# 2) 跑全景架构聚合（自动读所有 snapshot + Java pom.xml/application.yml + 跨项目 deps）
python3 asdm/_blueprints/_architecture.py
#  → 输出 _summary/architecture-blueprint.html + architecture-stats.json
```

`_architecture.py` 输出包含：

- **6 个架构指标卡**：服务总数 / 后端微服务 / 架构分层 / 外部集成 / API 控制器 / 业务服务
- **分层架构图**（5 层）：客户端层 → 网关层（nginx）→ 应用服务层（Java Spring Boot，按端口排列）→ 集成层（MCP / adapter）→ 工具/运行时层
- **技术栈 legend**：React / Vue / Spring Boot / Node.js / Go / Shell
- **跨项目 npm 依赖矩阵**：asdm-* 互相依赖关系（from package.json `dependencies`）
- **Java 业务规模**：从 ripgrep `rg -c '@RestController' / '@Service'` 统计

数据源：
- `snapshot.json`（每个项目）：framework / variants / dependencies
- `pom.xml` + `application.yml`（Java 服务）：artifactId / server.port / Spring 名
- `package.json`（前端 / Node）：scripts / dependencies / 跨项目引用
- `.java` 源文件（ripgrep）：`@RestController` / `@Service` / `@Component` 注解统计

## 标准工作流

### 单项目一站式扫描

```bash
PROJECT=/path/to/project
SNAP_BASE=$PROJECT/.nice-aos/data
mkdir -p "$SNAP_BASE"

# 1. 代码本体 + 配置/视图文件（v0.29.0+ 默认含 .css/.html/.sql/.yml/.yaml/.conf/.toml/.ini/.env）
nice-aos --snapshot-dir "$SNAP_BASE" \
  action refreshRepo --params "{\"repoPath\":\"$PROJECT\"}"

# 2. 数据库迁移脚本（如果项目含 .sql）
if find "$PROJECT" -name "*.sql" -not -path "*/node_modules/*" -not -path "*/.git/*" | grep -q .; then
  nice-aos --snapshot-dir "$SNAP_BASE" \
    db scan --dir "$PROJECT" \
    --output "$SNAP_BASE/db-snapshot.json"
fi

# 3. 部署配置（如果项目含 Dockerfile / docker-compose* / k8s / nginx.conf 等）
if [ -d "$PROJECT/deploy" ] || [ -f "$PROJECT/Dockerfile" ] || [ -f "$PROJECT/docker-compose.yml" ]; then
  DEPLOY_DIR="${DEPLOY_DIR:-$PROJECT/deploy}"
  [ -f "$PROJECT/Dockerfile" ] && [ ! -d "$PROJECT/deploy" ] && DEPLOY_DIR="$PROJECT"
  nice-aos --snapshot-dir "$SNAP_BASE" \
    deploy scan --dir "$DEPLOY_DIR" \
    --output "$SNAP_BASE/deploy-snapshot.json"
fi

# 4. 导出三套 HTML 蓝图
nice-aos --snapshot-dir "$SNAP_BASE" export --format html --output "$SNAP_BASE/blueprint.html"
nice-aos --snapshot-dir "$SNAP_BASE" db export --format html --output "$SNAP_BASE/db-blueprint.html"
nice-aos --snapshot-dir "$SNAP_BASE" deploy export --format html --output "$SNAP_BASE/deploy-blueprint.html"
```

### 批量扫描（多项目）

参考 `_scan.sh` 模板：对每个项目目录调用上面的"单项目"流程，输出到独立 snapshot 目录，最后用 Python 聚合所有 `snapshot.json` 生成总览。

```bash
# /Users/healer2027/workprojetcs/asdm/_blueprints/_scan.sh 是真实可用的 18 项目批量驱动
# /Users/healer2027/workprojetcs/asdm/_blueprints/_aggregate.py 是聚合统计脚本
```

## v0.29.0+ 主代码本体的扩展文件类型

`action refreshRepo` 默认会把以下文件加入 `SourceFile` 列表（行数 + 顶层语义提取）：

| 类型 | 提取内容 | 适用项目 |
|---|---|---|
| `.css` | @import / @keyframes / CSS 变量 / 顶层选择器 | 前端项目 |
| `.html` | `<title>` / `<script src>` / `<link href>` / `<meta>` / `id` 锚点 | Vite/HTML 应用 |
| `.sql` | CREATE TABLE/VIEW/INDEX/FUNCTION/PROCEDURE/TRIGGER/DROP 对象名 | 含迁移脚本的项目 |
| `.yml` / `.yaml` | 顶层 key / docker-compose service 名 / k8s apiVersion+kind | 部署 / CI / 配置 |
| `.conf` | `[section]` / nginx 风格 `section { }` / key 名 | nginx / 系统配置 |
| `.toml` | `[section]` / key 名 | Cargo.toml / pyproject.toml |
| `.ini` | `[section]` / key 名 | 老式配置 |
| `.env` / `.env.*` | KEY 名（不取 value，敏感信息保护） | 环境配置 |

默认 `roots` 行为变更：当项目有 `src/` 时，会**同时**扫 `src/` 和 `.`（项目根），让顶层 `.env*` / `index.html` / `*.conf` / `nginx.conf` 等不被遗漏。文件去重由 `projectScanner` 内部处理。

## 输出

每个项目产出一个 snapshot 目录：

```
<project>/.nice-aos/data/
  snapshot.json              ← 代码本体（含 8 种配置/视图文件类型）
  db-snapshot.json           ← 数据库模型
  deploy-snapshot.json       ← 部署架构
  blueprint.html             ← 代码本体蓝图
  blueprint.md
  db-blueprint.html          ← 数据库蓝图
  deploy-blueprint.html      ← 部署蓝图
```

批量扫描时（如 asdm 18 项目），建议每个项目独立 snapshot 目录，最后用 Python 聚合：

```python
# 伪代码
import json
from pathlib import Path
total = {'files': 0, 'lines': 0, 'by_ext': {}}
for proj_dir in Path('/path/to/asdm/_blueprints').iterdir():
    snap = proj_dir / 'snapshot.json'
    if not snap.exists(): continue
    data = json.loads(snap.read_text())
    for f in data.get('SourceFile', []):
        ext = f.get('ext', '?')
        total['by_ext'].setdefault(ext, {'files':0,'lines':0})
        total['by_ext'][ext]['files'] += 1
        total['by_ext'][ext]['lines'] += f.get('lineCount', 0)
        total['files'] += 1
        total['lines'] += f.get('lineCount', 0)
```

## 前置条件

- nice-aos v0.29.0+（命令行 `nice-aos --version`）
- Node.js 18+
- v0.29.0 之前：主代码本体不包含 .css/.html/.sql/.yml/.yaml/.conf/.toml/.ini/.env —— 需要先升级
  ```bash
  nice-aos update         # 全局装时自动 npm install -g nice-aos@latest
  # 或仓库源码升级：cd /path/to/nice-aos && git pull && npm install -g --force .
  ```

## 与单类型 skill 的边界

| Skill | 范围 | 何时用 |
|---|---|---|
| `nice-aos` | 单项目代码本体 | 单类型深挖 / 跨文件变更影响 / 重构分析 |
| `nice-aos-database` | 单项目 MySQL 迁移脚本 | 数据库 schema 演进 / 表关系 / Flyway 审计 |
| `nice-aos-deployment` | 单项目部署配置 | 部署拓扑 / 服务依赖 / 安全审计 |
| **`nice-aos-fullscan`** | **多项目 / 多类型一站式** | 跨类型总览 / 多仓库盘点 / 一键三套蓝图 |

需要分析 SQL 与代码的引用关系（如"哪个 service 用了 user_account 表"）时，先用此 skill 拿到 schema + service 列表，再 `cross-ref` agent 自己做。
