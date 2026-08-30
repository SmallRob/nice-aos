// 部署配置分析模型定义：对象类型 / 服务类型规则 / 分层规则 / 中间件识别

export const DEPLOY_MODEL_META = {
  version: '1.0',
  subsystem: 'deployment',
  description: '部署架构模型：从 Dockerfile / docker-compose / K8s manifest / nginx.conf / .env 解析出的服务、路由、依赖、中间件、环境与分层结构',
};

// 服务类型推断规则（按顺序匹配，先匹配先得；角色型词 init/fix 先于技术栈词）
// 词边界用 [^a-z0-9]，兼容 name 与 image 以 '|' 拼接后的边界
export const SERVICE_TYPE_RULES = [
  { key: 'gateway', label: '网关', patterns: [/(^|[^a-z0-9])nginx($|[^a-z0-9])/, /gateway/, /ingress/, /traefik/] },
  { key: 'frontend', label: '前端', patterns: [/(^|[^a-z0-9])web($|[^a-z0-9])/, /(^|[^a-z0-9])ui($|[^a-z0-9])/, /(^|[^a-z0-9])portal($|[^a-z0-9])/, /chatui/, /frontend/] },
  { key: 'adapter', label: '适配器', patterns: [/adapter/] },
  { key: 'job', label: '任务', patterns: [/flyway/, /migration/, /(^|[^a-z0-9])init($|[^a-z0-9])/, /init-/, /fixperms/, /bootstrap/] },
  { key: 'db', label: '数据库', patterns: [/mysql/, /mariadb/, /postgres/] },
  { key: 'cache', label: '缓存', patterns: [/redis/, /memcache/] },
  { key: 'storage', label: '对象存储', patterns: [/minio/, /(^|[^a-z0-9])oss($|[^a-z0-9])/, /(^|[^a-z0-9])s3($|[^a-z0-9])/] },
  { key: 'search', label: '搜索引擎', patterns: [/elasticsearch/, /(^|[^a-z0-9])es($|[^a-z0-9])/, /opensearch/] },
  { key: 'registry', label: '注册中心', patterns: [/nacos/, /consul/, /eureka/] },
  { key: 'observability', label: '可观测', patterns: [/prometheus/, /grafana/, /loki/, /promtail/, /alloy/, /telemetry/, /observability/, /jaeger/, /zipkin/] },
  { key: 'cicd', label: 'CI/CD', patterns: [/jenkins/, /sonar/] },
  { key: 'tool', label: '工具', patterns: [/portainer/, /pgadmin/, /(^|[^a-z0-9])docs($|[^a-z0-9])/, /adminer/, /phpmyadmin/] },
  { key: 'backend', label: '后端服务', patterns: [/service/, /server/, /api/, /backend/, /core/, /mcp/, /agentorbit/, /orchestration/, /manager/, /auth/, /module/, /scheduler/, /worker/] },
  { key: 'app', label: '应用', patterns: [/app/] },
];

export const SERVICE_TYPE_LABELS = Object.fromEntries(SERVICE_TYPE_RULES.map((r) => [r.key, r.label]));

export const SERVICE_TYPE_COLORS = {
  gateway: '#f472b6',
  frontend: '#38bdf8',
  backend: '#4ade80',
  adapter: '#a78bfa',
  app: '#2dd4bf',
  job: '#fbbf24',
  db: '#fb923c',
  cache: '#f87171',
  storage: '#22d3ee',
  search: '#e879f9',
  registry: '#c084fc',
  observability: '#facc15',
  cicd: '#60a5fa',
  tool: '#94a3b8',
};

// 分层规则：服务类型 → 架构分层
export const LAYER_RULES = [
  { key: 'edge', label: '接入层', serviceTypes: ['gateway'], arrow: '⬇️ HTTPS / 代理 ⬇️' },
  { key: 'frontend', label: '前端层', serviceTypes: ['frontend'], arrow: '⬇️ 静态资源 / API 调用 ⬇️' },
  { key: 'backend', label: '应用服务层', serviceTypes: ['backend', 'app'], arrow: '⬇️ 服务间调用 / JDBC / S3 ⬇️' },
  { key: 'adapter', label: '适配器层', serviceTypes: ['adapter'], arrow: '⬇️ 外部系统对接 ⬇️' },
  { key: 'job', label: '任务层', serviceTypes: ['job'], arrow: '⬇️ 初始化 / 迁移 ⬇️' },
  { key: 'data', label: '数据层', serviceTypes: ['db', 'cache', 'storage', 'search', 'registry'], arrow: '⬇️ 采集 / 指标 / 日志 ⬇️' },
  { key: 'observability', label: '可观测层', serviceTypes: ['observability'], arrow: '⬇️ 构建 / 发布 ⬇️' },
  { key: 'cicd', label: 'CI/CD 层', serviceTypes: ['cicd'], arrow: '' },
  { key: 'tool', label: '工具层', serviceTypes: ['tool'], arrow: '' },
];

const SERVICE_TYPE_TO_LAYER = {};
for (const rule of LAYER_RULES) {
  for (const st of rule.serviceTypes) SERVICE_TYPE_TO_LAYER[st] = rule.key;
}

// 中间件识别规则（从 image / name 识别基础设施组件）
export const MIDDLEWARE_KINDS = [
  { kind: 'mysql', label: 'MySQL', patterns: [/mysql/, /mariadb/], defaultPort: 3306 },
  { kind: 'postgres', label: 'PostgreSQL', patterns: [/postgres/], defaultPort: 5432 },
  { kind: 'redis', label: 'Redis', patterns: [/redis/], defaultPort: 6379 },
  { kind: 'minio', label: 'MinIO', patterns: [/minio/], defaultPort: 9000 },
  { kind: 'elasticsearch', label: 'Elasticsearch', patterns: [/elasticsearch/], defaultPort: 9200 },
  { kind: 'nacos', label: 'Nacos', patterns: [/nacos/], defaultPort: 8848 },
  { kind: 'mongodb', label: 'MongoDB', patterns: [/mongo/], defaultPort: 27017 },
  { kind: 'rabbitmq', label: 'RabbitMQ', patterns: [/rabbitmq/], defaultPort: 5672 },
  { kind: 'kafka', label: 'Kafka', patterns: [/kafka/], defaultPort: 9092 },
];

// 推断服务类型：名称 + 镜像联合匹配（'|' 分隔避免拼接破坏词边界）
export function detectServiceType(name, image) {
  const target = `${name || ''}|${image || ''}`.toLowerCase();
  for (const rule of SERVICE_TYPE_RULES) {
    for (const p of rule.patterns) {
      if (p.test(target)) return rule.key;
    }
  }
  return 'app';
}

// 服务类型 → 分层 key
export function detectLayer(serviceType) {
  return SERVICE_TYPE_TO_LAYER[serviceType] || 'backend';
}

// 中间件识别：返回 { kind, label, version } 或 null
export function detectMiddleware(name, image) {
  const target = `${image || ''}|${name || ''}`.toLowerCase();
  for (const mw of MIDDLEWARE_KINDS) {
    for (const p of mw.patterns) {
      if (p.test(target)) {
        const version = extractImageVersion(image);
        return { kind: mw.kind, label: mw.label, version, defaultPort: mw.defaultPort };
      }
    }
  }
  return null;
}

// 解引用 ${VAR:-default} 形式：取默认值；${VAR} 无默认 → null
export function derefImageRef(image) {
  if (!image) return null;
  const m = String(image).match(/^\$\{[^:}]+(?::-([^}]*))?\}$/);
  if (m) return m[1] !== undefined ? m[1] : null;
  return image;
}

// 从镜像名提取版本 tag：registry/repo:tag → tag；tag 为 ${VAR:-default} 时取默认值
export function extractImageVersion(image) {
  const deref = derefImageRef(image);
  if (!deref) return null;
  // 去掉 digest 部分；tag = 最后一个 '/' 之后的第一个 ':' 之后的内容（避免取到 ${VAR:-x} 内部冒号）
  const namePart = deref.split('@')[0];
  const lastSlash = namePart.lastIndexOf('/');
  const colonIdx = namePart.indexOf(':', lastSlash + 1);
  if (colonIdx > 0) {
    return derefImageRef(namePart.slice(colonIdx + 1));
  }
  return null;
}

// 从镜像名提取 registry（第一段含 . 或 : 或 localhost）
export function extractRegistry(image) {
  const deref = derefImageRef(image);
  if (!deref) return null;
  const first = deref.split('/')[0];
  if (deref.includes('/') && (/^\d+\.\d+\.\d+\.\d+$/.test(first) || first.includes('.') || first.includes(':') || first === 'localhost')) {
    return first;
  }
  return null;
}

// 服务名归一化：小写、下划线转连字符（docker 服务名与 k8s 资源名风格统一）
export function normalizeServiceName(name) {
  return String(name || '').trim().toLowerCase().replace(/_/g, '-');
}

// 敏感变量判断
export function isSecretKey(key) {
  return /password|passwd|secret|token|credential|private[-_]?key|access[-_]?key/i.test(key || '');
}

// 值脱敏：保留长度提示
export function maskSecretValue(value) {
  const s = String(value ?? '');
  if (!s) return s;
  return `***(${s.length}位)`;
}
