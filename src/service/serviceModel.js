// 后端服务蓝图模型定义：对象类型 / 模块规则 / 分层规则 / 技术栈规则 / 复杂度阈值
// 输入：asdm-aos 本体快照（snapshot.json，Java 后端）
// 输出：ServiceModel —— 后端服务蓝图（模块/分层/API/数据层/依赖/质量/健康度）

export const SERVICE_MODEL_META = {
  version: '1.0',
  subsystem: 'service',
  description: '后端服务模型：从 asdm-aos Java 后端本体快照解析出的模块、分层、API 端点、数据层、依赖技术栈、代码质量与健康度结构',
};

// ---------- 模块规则 ----------
// 模块不硬编码：从待转换的 asdm-aos 快照包结构动态推导（deriveModuleRules），
// 推导结果可写入模块配置文件（service-modules.json），后续构建从配置文件加载；
// 亦可用 --module-prefix 直接指定规则。避免切换后端项目时模块无法匹配。

// 从包名列表动态推导模块规则：
// 1) 找"项目基础包"= 覆盖大多数包的**最深**公共前缀（默认阈值 80%，命名空间通常是压倒性多数，模块是相对少数）
// 2) 每个包取基础包之后的首段为模块 key；未落入基础包的包（如 ai.asdm.portal.*）取与基础包分叉处的首段
// 3) 每个模块收集其全部实际前缀，生成 { key, label, prefixes } 规则
// 4) 若推导出的模块全部是分层关键词（controller/service/repository…），视为单模块仓库，坍缩为基础包末段
const LAYER_WORDS = new Set([
  'controller', 'service', 'repository', 'repo', 'mapper', 'entity', 'model',
  'dto', 'vo', 'config', 'adapter', 'client', 'job', 'scheduler',
  'util', 'common', 'domain', 'exception', 'interceptor', 'aspect', 'handler', 'support',
]);

export function deriveModuleRules(packageNames, opts = {}) {
  const threshold = opts.threshold ?? 0.8;
  const segments = (packageNames || [])
    .map((p) => String(p || '').trim().split('.').filter(Boolean))
    .filter((s) => s.length > 0);
  if (segments.length === 0) return [];

  const total = segments.length;
  const maxDepth = Math.max(...segments.map((s) => s.length));

  // 找基础包深度：最深的一个前缀覆盖 >= threshold 比例的包；
  // 附加"分层守门员"：若该深度的前缀大多是分层关键词（controller/service/entity…），
  // 说明已下钻到分层层而非模块层，停止下钻（避免单模块仓库把 controller/service 当模块）
  let baseDepth = 0;
  let basePrefix = [];
  for (let d = 1; d <= maxDepth; d++) {
    const counts = new Map();
    for (const seg of segments) {
      if (seg.length < d) continue;
      const p = seg.slice(0, d).join('.');
      counts.set(p, (counts.get(p) || 0) + 1);
    }
    if (counts.size === 0) break;
    let top = null;
    let topCount = -1;
    for (const [p, c] of counts) {
      if (c > topCount) { top = p; topCount = c; }
    }
    if (topCount / total < threshold) break;
    if (counts.size > 1) {
      const layerish = [...counts.keys()].filter((p) => LAYER_WORDS.has(p.split('.').pop())).length;
      if (layerish / counts.size > 0.5) break; // 该深度为分层层，不再下钻
    }
    baseDepth = d;
    basePrefix = top.split('.');
  }
  if (baseDepth === 0) {
    // 连第一段都不满足阈值（包前缀过于分散）：退化为取最常见的第一段
    const counts = new Map();
    for (const seg of segments) counts.set(seg[0], (counts.get(seg[0]) || 0) + 1);
    let top = null;
    let topCount = -1;
    for (const [p, c] of counts) {
      if (c > topCount) { top = p; topCount = c; }
    }
    baseDepth = 1;
    basePrefix = [top];
  }

  // 为每个包分配模块 key 并收集实际前缀
  const modulePrefixes = new Map(); // key -> Set<prefix>
  for (const seg of segments) {
    const pkgName = seg.join('.');
    let l = 0;
    while (l < basePrefix.length && l < seg.length && seg[l] === basePrefix[l]) l++;
    let key;
    let prefix;
    if (l >= baseDepth) {
      // 包位于基础包之下（或等于基础包）
      if (seg.length > baseDepth) {
        key = seg[baseDepth];
        prefix = seg.slice(0, baseDepth + 1).join('.');
      } else {
        // 包恰好等于基础包本身
        key = basePrefix[basePrefix.length - 1];
        prefix = pkgName;
      }
    } else if (seg.length > l) {
      // 分叉包：取分叉处首段（如 ai.asdm.portal.* → portal）
      key = seg[l];
      prefix = seg.slice(0, l + 1).join('.');
    } else {
      key = seg[seg.length - 1];
      prefix = pkgName;
    }
    if (!key) key = 'other';
    if (!modulePrefixes.has(key)) modulePrefixes.set(key, new Set());
    modulePrefixes.get(key).add(prefix);
  }

  // 单模块仓库坍缩：所有模块都是分层关键词 → 以基础包末段为唯一模块
  const keys = [...modulePrefixes.keys()];
  if (keys.length > 1 && keys.every((k) => LAYER_WORDS.has(k))) {
    return [{ key: basePrefix[basePrefix.length - 1], label: basePrefix[basePrefix.length - 1], prefixes: [basePrefix.join('.')] }];
  }

  // 模块排序：按包数降序，other 恒置尾
  const rules = keys.map((key) => ({
    key,
    label: key,
    prefixes: [...modulePrefixes.get(key)].sort((a, b) => a.length - b.length || a.localeCompare(b)),
  }));
  const countByKey = new Map();
  for (const seg of segments) {
    const mod = assignModuleKey(seg, basePrefix, baseDepth);
    countByKey.set(mod, (countByKey.get(mod) || 0) + 1);
  }
  rules.sort((a, b) => {
    if (a.key === 'other') return 1;
    if (b.key === 'other') return -1;
    return (countByKey.get(b.key) || 0) - (countByKey.get(a.key) || 0);
  });
  return rules;
}

// 单个包 → 模块 key（与 deriveModuleRules 内部一致；供排序统计复用）
function assignModuleKey(seg, basePrefix, baseDepth) {
  let l = 0;
  while (l < basePrefix.length && l < seg.length && seg[l] === basePrefix[l]) l++;
  if (l >= baseDepth) {
    if (seg.length > baseDepth) return seg[baseDepth];
    return basePrefix[basePrefix.length - 1];
  }
  if (seg.length > l) return seg[l];
  return seg[seg.length - 1] || 'other';
}

// 编译模块前缀为正则：^prefix(\.|$)
export function compileModuleRules(rules) {
  return (rules || []).map((r) => ({
    key: r.key,
    label: r.label,
    regex: new RegExp('^' + r.prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('$|^') + '(\\.|$)'),
    matchedPrefix: r.prefixes[r.prefixes.length - 1],
  }));
}

// 检测包所属模块：按编译后的规则顺序匹配，兜底 other
export function detectModule(packagePath, compiledRules) {
  for (const rule of compiledRules || []) {
    if (rule.regex.test(packagePath)) {
      return { key: rule.key, label: rule.label, prefix: rule.matchedPrefix };
    }
  }
  return { key: 'other', label: '其他', prefix: '' };
}

// 从 CLI --module-prefix JSON 字符串解析自定义模块规则
// 形状: {"core":{"label":"核心","prefixes":["ai.asdm.admin.core"]}}
export function parseModulePrefixJson(jsonStr) {
  if (!jsonStr) return null;
  let raw;
  try {
    raw = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`--module-prefix 不是合法 JSON: ${err.message}`);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('--module-prefix 应为 JSON 对象: {"key":{"label":"...","prefixes":["pkg.prefix"]}}');
  }
  const rules = [];
  for (const [key, def] of Object.entries(raw)) {
    if (!def || typeof def !== 'object' || !Array.isArray(def.prefixes) || def.prefixes.length === 0) {
      throw new Error(`--module-prefix 中 "${key}" 需含非空 prefixes 数组`);
    }
    rules.push({ key, label: def.label || key, prefixes: def.prefixes });
  }
  return rules;
}

// ---------- 分层规则 ----------
// 检测优先级见 detectLayer（分层展示顺序由 viewer 侧维护）
const ANNOTATION_TO_LAYER = [
  ['@RestController', 'controller'],
  ['@Controller', 'controller'],
  ['@Service', 'service'],
  ['@Repository', 'repository'],
  ['@Mapper', 'mapper'],
  ['@Entity', 'entity'],
  ['@Configuration', 'config'],
];

const NAME_SUFFIX_TO_LAYER = [
  [/Controller$/, 'controller'],
  [/Service$/, 'service'],
  [/Repository$/, 'repository'],
  [/Mapper$/, 'mapper'],
  [/Entity$/, 'entity'],
  [/(DTO|VO|Request|Response|Param|Query)$/, 'dto'],
  [/(Config|Properties)$/, 'config'],
  [/(Adapter|Client)$/, 'adapter'],
  [/(Job|Scheduler|Task|Cron)$/, 'job'],
  [/(Util|Utils|Helper)$/, 'util'],
];

const PACKAGE_KEYWORD_TO_LAYER = [
  ['controller', 'controller'],
  ['service', 'service'],
  ['repository', 'repository'],
  ['repo', 'repository'],
  ['mapper', 'mapper'],
  ['entity', 'entity'],
  ['model', 'entity'],
  ['domain', 'entity'], // DDD/MyBatis 项目的 POJO 通常位于 domain 包
  ['dto', 'dto'],
  ['vo', 'dto'],
  ['config', 'config'],
  ['adapter', 'adapter'],
  ['client', 'adapter'],
  ['job', 'job'],
  ['scheduler', 'job'],
  ['exception', 'util'],
  ['interceptor', 'util'],
  ['util', 'util'],
  ['common', 'util'],
];

// 检测类的分层：注解 → 类名后缀 → 包名关键词，首个命中即返回；兜底 other
export function detectLayer(cls, packagePath = '') {
  const modifiers = cls.modifiers || [];
  for (const [ann, key] of ANNOTATION_TO_LAYER) {
    if (modifiers.some((m) => m === ann || m.startsWith(ann + '('))) return key;
  }
  const name = cls.name || '';
  for (const [re, key] of NAME_SUFFIX_TO_LAYER) {
    if (re.test(name)) return key;
  }
  const segments = String(packagePath).split('.');
  for (const [kw, key] of PACKAGE_KEYWORD_TO_LAYER) {
    if (segments.includes(kw)) return key;
  }
  return 'other';
}

// ---------- 技术栈规则 ----------
// 依赖名（如 org.springframework.boot:spring-boot-starter-web）→ 技术栈分类。
// 顺序即优先级：具体规则（webflux/jjwt/redis…）在前，泛型（spring-boot）在后。
export const TECH_STACK_RULES = [
  { key: 'webflux', label: 'WebFlux / WebClient', regex: /spring-boot-starter-webflux/ },
  { key: 'jpa', label: 'JPA (Hibernate)', regex: /spring-boot-starter-data-jpa|spring-data-jpa|hibernate|jakarta\.persistence/ },
  { key: 'mybatis', label: 'MyBatis', regex: /mybatis/ },
  { key: 'jdbc', label: 'JDBC', regex: /spring-boot-starter-jdbc|spring-jdbc/ },
  { key: 'flyway', label: 'Flyway', regex: /flyway/ },
  { key: 'spring-security', label: 'Spring Security', regex: /spring-boot-starter-security|spring-security/ },
  { key: 'jjwt', label: 'JJWT (JWT)', regex: /jjwt|java-jwt|nimbus-jose-jwt|oauth2-jose/ },
  { key: 'shedlock', label: 'ShedLock', regex: /shedlock/ },
  { key: 'quartz', label: 'Quartz', regex: /quartz/ },
  { key: 'springdoc', label: 'SpringDoc (OpenAPI)', regex: /springdoc|springfox|swagger/ },
  { key: 'redis', label: 'Redis', regex: /spring-boot-starter-data-redis|redisson|jedis|lettuce/ },
  { key: 'kafka', label: 'Kafka', regex: /spring-kafka|kafka-clients/ },
  { key: 'rabbitmq', label: 'RabbitMQ', regex: /spring-boot-starter-amqp|amqp-client|rabbitmq/ },
  { key: 'elasticsearch', label: 'Elasticsearch', regex: /spring-boot-starter-data-elasticsearch|elasticsearch/ },
  { key: 's3', label: 'AWS S3', regex: /aws-java-sdk-s3|software\.amazon\.awssdk.*s3|spring-cloud-aws/ },
  { key: 'obs', label: '华为云 OBS', regex: /esdk-obs|huaweicloud.*obs/ },
  { key: 'minio', label: 'MinIO', regex: /minio/ },
  { key: 'okhttp', label: 'OkHttp', regex: /okhttp/ },
  { key: 'httpclient', label: 'Apache HttpClient', regex: /httpclient|httpcore/ },
  { key: 'feign', label: 'OpenFeign', regex: /openfeign|spring-cloud-starter-openfeign/ },
  { key: 'mysql', label: 'MySQL 驱动', regex: /mysql-connector/ },
  { key: 'postgresql', label: 'PostgreSQL 驱动', regex: /postgresql/ },
  { key: 'mongodb', label: 'MongoDB', regex: /spring-boot-starter-data-mongodb|mongodb-driver/ },
  { key: 'validation', label: 'Bean Validation', regex: /spring-boot-starter-validation|jakarta\.validation|hibernate-validator/ },
  { key: 'micrometer', label: 'Micrometer', regex: /micrometer/ },
  { key: 'prometheus', label: 'Prometheus', regex: /prometheus/ },
  { key: 'logstash', label: 'Logstash', regex: /logstash/ },
  { key: 'zipkin', label: 'Zipkin / Sleuth', regex: /zipkin|spring-cloud-sleuth/ },
  { key: 'lombok', label: 'Lombok', regex: /lombok/ },
  { key: 'mapstruct', label: 'MapStruct', regex: /mapstruct/ },
  { key: 'test', label: '测试框架', regex: /junit|mockito|assertj|spring-boot-starter-test/ },
  { key: 'spring-boot', label: 'Spring Boot', regex: /(^|:)spring-boot(-starter)?(-web|-actuator|-aop|-autoconfigure|-devtools|-logging)?($|\.)/ },
];

// 依赖名 → 技术栈分类；无匹配兜底 other
export function detectTechCategory(depName) {
  const name = String(depName || '');
  for (const rule of TECH_STACK_RULES) {
    if (rule.regex.test(name)) return { key: rule.key, label: rule.label };
  }
  return { key: 'other', label: '其他' };
}

// 圈复杂度热点阈值（报告中将 cc>50 列为高复杂度，此处用 15 作为一般热点阈值）
export const COMPLEXITY_HOTSPOT_CC = 15;

// API 路径领域前缀提取：跳过空段与 api/v1/v2/v3/rest，取首个有语义的路径段
export function extractDomainPrefix(path) {
  const segments = String(path || '').split('/').filter(Boolean);
  for (const seg of segments) {
    if (!/^(api|v1|v2|v3|rest)$/i.test(seg)) return seg;
  }
  return path || '';
}
