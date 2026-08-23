// 部署模型构建器：扫描部署目录 → 解析各类配置 → 归一化服务 → 推导依赖/路由/中间件/分层

import fs from 'node:fs';
import path from 'node:path';
import { analyzeDeployFile, classifyDeployFile } from './deployAnalyzer.js';
import { fileHash } from './deploySnapshot.js';
import {
  DEPLOY_MODEL_META, detectServiceType, detectLayer, detectMiddleware,
  extractImageVersion, extractRegistry, normalizeServiceName, isSecretKey, maskSecretValue,
  LAYER_RULES,
} from './deployModel.js';

const DEFAULT_EXCLUDE_DIRS = ['node_modules', '.git', 'bundled-plugins', 'data', 'dashboards', 'deploy-docs', 'target', 'dist', '.nice-aos'];

const DEPLOY_FILE_EXTS = new Set(['.yml', '.yaml', '.conf', '.json', '.sh', '.env', '.groovy', '.properties', '.toml', '.cfg', '.ini', '.config']);
const SKIP_FILES = new Set(['.DS_Store', '.gitignore', '.gitkeep', '.dockerignore']);

// 递归扫描部署配置文件
export function walkDeployFiles(dir, options = {}) {
  const results = [];
  const excludeDirs = options.excludeDirs || DEFAULT_EXCLUDE_DIRS;

  function walk(currentDir) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.some((d) => entry.name.toLowerCase() === d.toLowerCase())) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        if (isDeployFileName(entry.name)) {
          results.push({
            fileName: entry.name,
            filePath: fullPath,
            relativePath: path.relative(dir, fullPath).replace(/\\/g, '/'),
          });
        }
      }
    }
  }

  walk(dir);
  return results;
}

function isDeployFileName(base) {
  if (SKIP_FILES.has(base)) return false;
  const lower = base.toLowerCase();
  if (lower.startsWith('dockerfile')) return true;
  if (/jenkinsfile/.test(lower)) return true;
  if (lower.startsWith('.env')) return true;
  if (lower.endsWith('.env')) return true;
  if (lower.startsWith('env-') || lower.startsWith('env.')) return true;
  const ext = path.extname(lower);
  return DEPLOY_FILE_EXTS.has(ext);
}

// ---------- 服务归一化 ----------

function mergeService(serviceMap, name, partial, source) {
  const key = normalizeServiceName(name);
  let svc = serviceMap.get(key);
  if (!svc) {
    svc = {
      id: `service:${key}`,
      name: key,
      type: null,
      layer: null,
      image: null,
      registry: null,
      imageVersion: null,
      kind: null,
      namespace: null,
      replicas: null,
      ports: [],
      containerPorts: [],
      env: {},
      envRefs: [],
      configRefs: [],
      dependsOn: [],
      volumes: [],
      healthcheck: null,
      readinessProbe: null,
      livenessProbe: null,
      resources: null,
      restart: null,
      networks: [],
      extraHosts: [],
      containerNames: [],
      command: null,
      virtual: false,
      sources: [],
      serviceInfo: null,
      middleware: null,
    };
    serviceMap.set(key, svc);
  }
  // 主字段：首个非空定义生效，后续来源补充缺失字段
  const fill = (field, value) => {
    if (value === null || value === undefined) return;
    if (svc[field] === null || svc[field] === undefined || svc[field] === '') svc[field] = value;
  };
  fill('image', partial.image);
  fill('kind', partial.kind);
  fill('namespace', partial.namespace);
  fill('replicas', partial.replicas);
  fill('restart', partial.restart);
  fill('command', partial.command);
  fill('healthcheck', partial.healthcheck);
  fill('readinessProbe', partial.readinessProbe);
  fill('livenessProbe', partial.livenessProbe);
  fill('resources', partial.resources);
  fill('serviceInfo', partial.serviceInfo);
  // 数组字段：并集去重
  if (partial.image) {
    svc.registry = svc.registry || extractRegistry(partial.image);
    svc.imageVersion = svc.imageVersion || extractImageVersion(partial.image);
  }
  for (const p of partial.ports || []) {
    if (!svc.ports.some((x) => x.host === p.host && x.container === p.container)) svc.ports.push(p);
  }
  for (const p of partial.containerPorts || []) {
    if (!svc.containerPorts.includes(p)) svc.containerPorts.push(p);
  }
  for (const d of partial.dependsOn || []) {
    const n = normalizeServiceName(d);
    if (!svc.dependsOn.includes(n)) svc.dependsOn.push(n);
  }
  for (const v of partial.volumes || []) {
    if (!svc.volumes.includes(v)) svc.volumes.push(v);
  }
  for (const n of partial.networks || []) {
    if (!svc.networks.includes(n)) svc.networks.push(n);
  }
  for (const eh of partial.extraHosts || []) {
    if (!svc.extraHosts.includes(eh)) svc.extraHosts.push(eh);
  }
  for (const cn of partial.containerNames || []) {
    if (cn && !svc.containerNames.includes(cn)) svc.containerNames.push(cn);
  }
  for (const ref of partial.envRefs || []) {
    if (!svc.envRefs.some((r) => r.name === ref.name && r.ref === ref.ref)) svc.envRefs.push(ref);
  }
  for (const ref of partial.configRefs || []) {
    if (!svc.configRefs.some((r) => r.type === ref.type && r.ref === ref.ref)) svc.configRefs.push(ref);
  }
  // 环境变量：脱敏后合并（已有 key 不覆盖）
  for (const [k, v] of Object.entries(partial.env || {})) {
    if (!(k in svc.env)) {
      svc.env[k] = isSecretKey(k) ? maskSecretValue(v) : String(v);
    }
  }
  const src = { file: source.relativePath || source.fileName, type: source.type };
  if (!svc.sources.some((s) => s.file === src.file)) svc.sources.push(src);
  return svc;
}

// ---------- Nginx 网关归属 ----------

const NGINX_ENV_WORDS = /[-_.](prod|sit|sit02|dt|dev|test|stage|staging|uat|allinone)$/i;

function findGatewayForNginxFile(fileName, services) {
  const candidates = services.filter((s) => s.type === 'gateway' && !s.virtual);
  if (candidates.length === 0) return null;
  // 文件特征词：nginx.conf → ''；artifacts-nginx.conf → 'artifacts'
  let key = fileName.replace(/\.conf$/i, '').replace(/nginx/gi, '').replace(/[-_.]+/g, '-').replace(/^-|-$/g, '');
  key = key.replace(NGINX_ENV_WORDS, '');
  if (key) {
    const matched = candidates.filter((s) => s.name.includes(key));
    if (matched.length > 0) return matched[0];
  }
  // 多个候选时取名字最短的（最通用）
  return [...candidates].sort((a, b) => a.name.length - b.name.length)[0];
}

// ---------- 环境变量中的服务引用 ----------

const URL_RE = /(?:https?|jdbc:[a-z]+|redis|rediss|amqp|mongodb(?:\+srv)?|postgres(?:ql)?|mysql|ftp):\/\/([a-zA-Z0-9._-]+?)(?::(\d+))?/g;

function extractEnvServiceRefs(env, nameToService) {
  const refs = [];
  for (const [key, value] of Object.entries(env || {})) {
    const s = String(value ?? '');
    if (!s.includes('://')) continue;
    for (const m of s.matchAll(URL_RE)) {
      const host = m[1];
      const port = m[2] ? parseInt(m[2], 10) : null;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost' || host === '127.0.0.1') continue;
      const resolved = nameToService.get(normalizeServiceName(host));
      if (resolved) {
        refs.push({ key, serviceName: resolved, port });
      }
    }
  }
  return refs;
}

function extractEnvName(fileName) {
  const base = path.basename(fileName);
  if (base.startsWith('.env')) {
    const rest = base.slice(4).replace(/^[._-]+/, '');
    return rest.replace(/\.env$/i, '') || 'default';
  }
  return base.replace(/\.env$/i, '') || 'default';
}

// ---------- 主构建流程 ----------

export function buildDeployModel(deployDir, options = {}) {
  const startTime = Date.now();
  const files = walkDeployFiles(deployDir, options);
  const serviceMap = new Map();
  const routes = [];
  const upstreams = [];
  const dependencies = [];
  const environments = [];
  const deployFiles = [];
  const fileManifest = [];
  const k8sResourceCounts = {};
  const nginxParseResults = [];
  let parseErrors = 0;

  // Pass 1：解析所有文件，登记 DeployFile + 收集服务/环境/nginx 结果
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file.filePath, 'utf-8');
    } catch {
      continue;
    }
    const hash = fileHash(file.filePath);
    const type = classifyDeployFile(file.filePath, content);
    const analyzed = analyzeDeployFile(file.filePath, content);
    if (analyzed.parsed?.parseError) parseErrors++;

    fileManifest.push({ fileName: file.fileName, relativePath: file.relativePath, type, hash });

    // DeployFile 登记
    const deployFile = {
      id: `file:${file.relativePath}`,
      fileName: file.fileName,
      relativePath: file.relativePath,
      type,
      fileSize: analyzed.fileSize,
    };
    if (type === 'compose') {
      deployFile.serviceCount = analyzed.parsed.services.length;
      deployFile.networkCount = analyzed.parsed.networks.length;
    } else if (type === 'k8s') {
      const kinds = {};
      for (const doc of analyzed.parsed.documents) {
        kinds[doc.kind] = (kinds[doc.kind] || 0) + 1;
        k8sResourceCounts[doc.kind] = (k8sResourceCounts[doc.kind] || 0) + 1;
      }
      deployFile.kinds = kinds;
    } else if (type === 'nginx') {
      deployFile.upstreamCount = analyzed.parsed.upstreams.length;
      deployFile.routeCount = analyzed.parsed.routes.length;
    } else if (type === 'dockerfile') {
      deployFile.baseImage = analyzed.parsed.baseImages[0] ?? null;
      deployFile.exposedPorts = analyzed.parsed.exposedPorts;
    } else if (type === 'env') {
      deployFile.variableCount = analyzed.parsed.variables.length;
    } else if (type === 'shell') {
      deployFile.commandCount = analyzed.parsed.commands.length;
    }
    deployFiles.push(deployFile);

    // 服务收集
    if (type === 'compose') {
      for (const svc of analyzed.parsed.services) {
        mergeService(serviceMap, svc.name, {
          image: svc.image,
          kind: 'container',
          ports: svc.ports,
          containerPorts: svc.expose.map((p) => parseInt(p, 10)).filter((n) => !Number.isNaN(n)),
          env: svc.environment,
          dependsOn: svc.dependsOn,
          volumes: svc.volumes,
          healthcheck: svc.healthcheck,
          restart: svc.restart,
          networks: svc.networks,
          extraHosts: svc.extraHosts,
          containerNames: svc.containerName ? [svc.containerName] : [],
          command: svc.command,
          replicas: svc.replicas,
        }, { ...file, type });
      }
    } else if (type === 'k8s') {
      for (const doc of analyzed.parsed.documents) {
        if (!doc.containers) continue;
        for (const container of doc.containers) {
          mergeService(serviceMap, container.name || doc.name, {
            image: container.image,
            kind: doc.kind,
            namespace: doc.namespace,
            replicas: doc.replicas,
            containerPorts: container.ports.map((p) => p.container),
            env: container.env,
            envRefs: container.envRefs,
            configRefs: container.envFrom,
            volumes: container.volumeMounts,
            readinessProbe: container.readinessProbe,
            livenessProbe: container.livenessProbe,
            resources: container.resources,
          }, { ...file, type });
        }
      }
    } else if (type === 'env') {
      environments.push({
        id: `env:${extractEnvName(file.fileName)}`,
        name: extractEnvName(file.fileName),
        file: file.relativePath,
        variables: analyzed.parsed.variables,
        serviceRefs: [],
      });
    } else if (type === 'nginx') {
      nginxParseResults.push({ file, parsed: analyzed.parsed });
    }
  }

  // Pass 2：类型/分层/中间件推断 + Dockerfile 构建信息回填
  const services = [...serviceMap.values()];
  for (const svc of services) {
    svc.type = detectServiceType(svc.name, svc.image);
    svc.layer = detectLayer(svc.type);
    svc.middleware = detectMiddleware(svc.name, svc.image);
  }

  for (const df of deployFiles) {
    if (df.type !== 'dockerfile') continue;
    // Dockerfile.admin-nginx → 特征名 admin-nginx → 匹配服务名包含该特征
    const feature = df.fileName.replace(/^Dockerfile\.?/i, '').replace(/\.(agent|arm|test)$/i, '');
    if (!feature) continue;
    const target = services.find((s) => s.name.includes(normalizeServiceName(feature)));
    if (target) {
      target.buildFrom = { file: df.relativePath, baseImage: df.baseImage, exposedPorts: df.exposedPorts };
      df.boundService = target.name;
    }
  }

  // Pass 3：nginx 网关归属 + 路由/上游/依赖推导
  // 名称解析表：服务名 + compose container_name（容器网络 DNS 主机名）→ 服务名
  const nameToService = new Map();
  for (const s of services) {
    nameToService.set(s.name, s.name);
    for (const cn of s.containerNames || []) {
      const n = normalizeServiceName(cn);
      if (n && !nameToService.has(n)) nameToService.set(n, s.name);
    }
  }
  for (const { file, parsed } of nginxParseResults) {
    let gateway = findGatewayForNginxFile(file.fileName, services);
    if (!gateway) {
      const virtualName = normalizeServiceName(file.fileName.replace(/\.conf$/i, ''));
      gateway = mergeService(serviceMap, virtualName, {
        kind: 'nginx-conf',
      }, { ...file, type: 'nginx' });
      gateway.virtual = true;
      gateway.type = detectServiceType(gateway.name, null);
      gateway.layer = detectLayer(gateway.type);
      services.push(gateway);
      nameToService.set(gateway.name, gateway.name);
    } else {
      mergeService(serviceMap, gateway.name, { kind: gateway.kind || 'nginx' }, { ...file, type: 'nginx' });
    }

    // extra_hosts 声明的主机名 = 网关通过静态映射指向的集群外服务
    const extraHostNames = new Set();
    for (const svc of serviceMap.values()) {
      for (const eh of svc.extraHosts || []) {
        const host = String(eh).split(':')[0].trim();
        if (host) extraHostNames.add(normalizeServiceName(host));
      }
    }

    for (const up of parsed.upstreams) {
      const resolved = up.servers.map((s) => ({
        host: s.host,
        port: s.port,
        resolvedService: nameToService.get(normalizeServiceName(s.host)) ?? null,
      }));
      upstreams.push({
        id: `upstream:${gateway.name}.${up.name}`,
        name: up.name,
        gateway: gateway.name,
        servers: resolved,
        source: file.relativePath,
      });
      for (const server of resolved) {
        if (server.resolvedService && server.resolvedService !== gateway.name) {
          addDependency(dependencies, gateway.name, server.resolvedService, 'route', file.relativePath);
        }
      }
    }

    for (const route of parsed.routes) {
      let resolvedService = null;
      let resolvedPort = null;
      let externalHost = null;
      if (route.targetUpstream) {
        const up = upstreams.find((u) => u.name === route.targetUpstream && u.gateway === gateway.name)
          || upstreams.find((u) => u.name === route.targetUpstream);
        if (up) {
          const target = up.servers.find((s) => s.resolvedService);
          resolvedService = target?.resolvedService ?? null;
          resolvedPort = target?.port ?? null;
        }
      } else if (route.directService) {
        const n = normalizeServiceName(route.directService);
        const resolved = nameToService.get(n);
        if (resolved) {
          resolvedService = resolved;
          resolvedPort = route.directPort;
        } else if (route.directService.includes('.') || extraHostNames.has(n)) {
          externalHost = route.directService;
        }
      }
      routes.push({
        id: `route:${gateway.name}:${route.matchType}:${route.path}`,
        gateway: gateway.name,
        path: route.path,
        matchType: route.matchType,
        proxyPass: route.proxyPass,
        targetUpstream: route.targetUpstream,
        resolvedService,
        resolvedPort,
        externalHost,
        authRequest: route.authRequest,
        clientMaxBodySize: route.clientMaxBodySize,
        websocket: route.websocket,
        source: file.relativePath,
      });
    }
  }

  // 路由去重（多环境 nginx 文件会产生重复路由）
  const routeMap = new Map();
  for (const r of routes) {
    const key = `${r.gateway}|${r.matchType}|${r.path}|${r.resolvedService}`;
    const existing = routeMap.get(key);
    if (existing) {
      if (!existing.source.includes(r.source)) existing.source = `${existing.source}, ${r.source}`;
    } else {
      routeMap.set(key, r);
    }
  }
  const dedupedRoutes = [...routeMap.values()];

  // Pass 4：服务环境变量引用 → 依赖边
  for (const svc of services) {
    if (svc.virtual) continue;
    const envRefs = extractEnvServiceRefs(svc.env, nameToService);
    svc.envServiceRefs = envRefs;
    for (const ref of envRefs) {
      if (ref.serviceName !== svc.name) {
        addDependency(dependencies, svc.name, ref.serviceName, 'env_ref', ref.key);
      }
    }
    // compose depends_on → 依赖边
    for (const dep of svc.dependsOn) {
      const n = normalizeServiceName(dep);
      if (n !== svc.name) addDependency(dependencies, svc.name, n, 'depends_on', null);
    }
  }

  // Pass 5：环境 serviceRefs（引用已知服务的 URL）
  for (const env of environments) {
    const refs = [];
    for (const v of env.variables) {
      if (v.isSecret || !String(v.value).includes('://')) continue;
      for (const m of String(v.value).matchAll(URL_RE)) {
        const host = m[1];
        const port = m[2] ? parseInt(m[2], 10) : null;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost') continue;
        const resolved = nameToService.get(normalizeServiceName(host));
        if (resolved) refs.push({ key: v.key, serviceName: resolved, port });
      }
    }
    env.serviceRefs = refs;
  }

  // Pass 6：中间件消费方反查（job/init 类服务不计入中间件本体）
  const middlewareList = [];
  for (const svc of services) {
    if (!svc.middleware || svc.type === 'job') continue;
    const consumers = [...new Set(dependencies
      .filter((d) => d.to === svc.name)
      .map((d) => d.from))];
    middlewareList.push({
      id: `mw:${svc.name}`,
      name: svc.name,
      kind: svc.middleware.kind,
      label: svc.middleware.label,
      version: svc.middleware.version,
      image: svc.image,
      ports: svc.containerPorts.length > 0 ? svc.containerPorts : svc.ports.map((p) => p.container),
      consumers,
      source: svc.sources[0]?.file ?? null,
    });
  }

  // Pass 7：分层归类
  const layers = LAYER_RULES
    .map((rule) => ({
      id: `layer:${rule.key}`,
      key: rule.key,
      label: rule.label,
      arrow: rule.arrow,
      serviceNames: services.filter((s) => s.layer === rule.key).map((s) => s.name),
    }))
    .filter((l) => l.serviceNames.length > 0);

  const durationMs = Date.now() - startTime;
  const model = {
    services: services.sort((a, b) => a.layer.localeCompare(b.layer) || a.name.localeCompare(b.name)),
    routes: dedupedRoutes,
    upstreams,
    dependencies,
    middleware: middlewareList,
    environments,
    files: deployFiles,
    layers,
    k8sResourceCounts,
    _meta: {
      ...DEPLOY_MODEL_META,
      scannedAt: new Date().toISOString(),
      sourceDir: path.resolve(deployDir),
      fileCount: files.length,
      serviceCount: services.length,
      routeCount: dedupedRoutes.length,
      upstreamCount: upstreams.length,
      dependencyCount: dependencies.length,
      middlewareCount: middlewareList.length,
      environmentCount: environments.length,
      layerCount: layers.length,
      parseErrors,
      durationMs,
      incremental: false,
      fileManifest,
    },
  };
  return model;
}

function addDependency(dependencies, from, to, type, source) {
  const key = `${from}|${to}|${type}`;
  const existing = dependencies.find((d) => d.key === key);
  if (existing) {
    if (source && !existing.sources.includes(source)) existing.sources.push(source);
    return;
  }
  dependencies.push({
    id: `dep:${type}:${from}->${to}`,
    key,
    from,
    to,
    type,
    sources: source ? [source] : [],
  });
}

// 增量构建：部署配置为声明式最终态，任何文件变化即全量重建
export function buildDeployModelIncremental(deployDir, existingModel, options = {}) {
  const startTime = Date.now();
  const files = walkDeployFiles(deployDir, options);
  const existingManifest = existingModel?._meta?.fileManifest || [];
  const existingHashes = new Map(existingManifest.map((f) => [f.relativePath, f.hash]));

  const currentFiles = new Set();
  const changedFiles = [];
  for (const file of files) {
    currentFiles.add(file.relativePath);
    let hash;
    try {
      hash = fileHash(file.filePath);
    } catch {
      continue;
    }
    if (existingHashes.get(file.relativePath) !== hash) {
      changedFiles.push(file.relativePath);
    }
  }
  const removedFiles = [...existingHashes.keys()].filter((f) => !currentFiles.has(f));

  if (changedFiles.length === 0 && removedFiles.length === 0) {
    // 无变化：直接复用已有模型
    existingModel._meta.incremental = true;
    existingModel._meta.durationMs = Date.now() - startTime;
    existingModel._meta.changedFiles = [];
    return existingModel;
  }

  // 有变化：全量重建，报告变化文件
  const model = buildDeployModel(deployDir, options);
  model._meta.incremental = true;
  model._meta.changedFiles = changedFiles;
  model._meta.removedFiles = removedFiles;
  model._meta.durationMs = Date.now() - startTime;
  return model;
}
