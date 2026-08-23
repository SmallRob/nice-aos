// 部署配置文件解析器：Dockerfile / docker-compose / K8s manifest / nginx.conf / .env / shell
// 纯函数：输入 (filePath, content)，输出结构化解析结果

import path from 'node:path';
import YAML from 'yaml';
import { isSecretKey, maskSecretValue } from './deployModel.js';

// ---------- Dockerfile ----------

export function parseDockerfile(filePath, content) {
  const lines = content.split('\n');
  const result = {
    baseImages: [],
    exposedPorts: [],
    healthcheck: null,
    env: {},
    copyTargets: [],
    labels: {},
  };
  let healthLines = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // HEALTHCHECK 可能跨行（\ 续行）
    if (/^HEALTHCHECK/i.test(line)) {
      healthLines = [line];
      continue;
    }
    if (healthLines.length > 0 && line.endsWith('\\')) {
      healthLines.push(line);
      continue;
    }
    if (healthLines.length > 0) {
      healthLines.push(line);
      result.healthcheck = healthLines.join(' ').replace(/\\\s*/g, ' ').trim();
      healthLines = [];
      continue;
    }
    const from = line.match(/^FROM\s+(\S+)/i);
    if (from) {
      result.baseImages.push(from[1]);
      continue;
    }
    const expose = line.match(/^EXPOSE\s+(.+)$/i);
    if (expose) {
      for (const p of expose[1].split(/\s+/)) {
        const port = parseInt(p, 10);
        if (!Number.isNaN(port)) result.exposedPorts.push(port);
      }
      continue;
    }
    const env = line.match(/^ENV\s+(\S+?)[=\s](.*)$/i);
    if (env) {
      result.env[env[1]] = env[2].replace(/^["']|["']$/g, '');
      continue;
    }
    const copy = line.match(/^COPY\s+(.+)$/i);
    if (copy) {
      result.copyTargets.push(copy[1].trim());
      continue;
    }
    const label = line.match(/^LABEL\s+(\S+?)=(.*)$/i);
    if (label) {
      result.labels[label[1]] = label[2].replace(/^["']|["']$/g, '');
    }
  }
  return result;
}

// ---------- Docker Compose ----------

function parseComposePort(p) {
  if (typeof p === 'string' || typeof p === 'number') {
    const s = String(p);
    // "8080:80" / "127.0.0.1:8080:80" / "80"
    const parts = s.split(':');
    if (parts.length >= 2) {
      const container = parseInt(parts[parts.length - 1], 10);
      const host = parseInt(parts[parts.length - 2], 10);
      return { host: Number.isNaN(host) ? parts[parts.length - 2] : host, container };
    }
    const port = parseInt(s, 10);
    return Number.isNaN(port) ? null : { host: port, container: port };
  }
  if (p && typeof p === 'object') {
    return { host: p.published ?? p.target, container: p.target };
  }
  return null;
}

function parseComposeEnv(env) {
  const map = {};
  if (Array.isArray(env)) {
    for (const item of env) {
      const idx = item.indexOf('=');
      if (idx > 0) map[item.slice(0, idx)] = item.slice(idx + 1);
      else if (item) map[item] = '';
    }
  } else if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      if (v !== null && typeof v === 'object') continue; // 复杂结构跳过
      map[k] = String(v);
    }
  }
  return map;
}

function parseComposeHealthcheck(hc) {
  if (!hc || typeof hc !== 'object') return null;
  const test = Array.isArray(hc.test) ? hc.test.join(' ') : hc.test;
  return {
    test: test ? String(test) : null,
    interval: hc.interval ?? null,
    timeout: hc.timeout ?? null,
    retries: hc.retries ?? null,
    startPeriod: hc.start_period ?? null,
  };
}

// extra_hosts 两种形态：数组 ["host:ip", ...] 或对象 { host: ip }；统一为 ["host:ip", ...]
function parseComposeExtraHosts(eh) {
  if (!eh) return [];
  const list = Array.isArray(eh) ? eh.map(String) : Object.entries(eh).map(([host, ip]) => `${host}:${ip}`);
  return list.filter(Boolean);
}

export function parseDockerCompose(filePath, content) {
  const result = { services: [], networks: [], version: null, parseError: null };
  let doc;
  try {
    doc = YAML.parse(content, { logLevel: "silent" });
  } catch (e) {
    result.parseError = e.message;
    return result;
  }
  if (!doc || typeof doc !== 'object') return result;
  result.version = doc.version ?? null;
  result.networks = Object.keys(doc.networks || {});
  const services = doc.services || {};
  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;
    const ports = [];
    for (const p of svc.ports || []) {
      const parsed = parseComposePort(p);
      if (parsed) ports.push(parsed);
    }
    let build = null;
    if (typeof svc.build === 'string') build = { context: svc.build };
    else if (svc.build && typeof svc.build === 'object') build = { context: svc.build.context ?? null, dockerfile: svc.build.dockerfile ?? null };
    result.services.push({
      name,
      image: svc.image ?? null,
      containerName: svc.container_name ?? null,
      build,
      ports,
      expose: (svc.expose || []).map(String),
      dependsOn: Array.isArray(svc.depends_on)
        ? svc.depends_on.map(String)
        : Object.keys(svc.depends_on || {}),
      environment: parseComposeEnv(svc.environment),
      envFile: (svc.env_file ? (Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file]) : []).map(String),
      volumes: (svc.volumes || []).map(String),
      healthcheck: parseComposeHealthcheck(svc.healthcheck),
      restart: svc.restart ?? null,
      extraHosts: parseComposeExtraHosts(svc.extra_hosts),
      networks: Array.isArray(svc.networks) ? svc.networks.map(String) : Object.keys(svc.networks || {}),
      command: Array.isArray(svc.command) ? svc.command.join(' ') : (svc.command ?? null),
      replicas: svc.deploy?.replicas ?? null,
    });
  }
  return result;
}

// ---------- K8s Manifest ----------

const K8S_WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet']);
const K8S_OBJECT_KINDS = new Set([...K8S_WORKLOAD_KINDS, 'Service', 'ConfigMap', 'Secret', 'PersistentVolumeClaim', 'Ingress', 'Namespace', 'Kustomization']);

function parseK8sEnv(envList) {
  const map = {};
  const refs = [];
  for (const e of envList || []) {
    if (!e || !e.name) continue;
    if (e.value !== undefined && e.value !== null) {
      map[e.name] = String(e.value);
    } else if (e.valueFrom?.configMapKeyRef) {
      refs.push({ name: e.name, type: 'configMap', ref: e.valueFrom.configMapKeyRef.name, key: e.valueFrom.configMapKeyRef.key });
    } else if (e.valueFrom?.secretKeyRef) {
      refs.push({ name: e.name, type: 'secret', ref: e.valueFrom.secretKeyRef.name, key: e.valueFrom.secretKeyRef.key });
    }
  }
  return { map, refs };
}

function parseProbe(probe) {
  if (!probe || typeof probe !== 'object') return null;
  const p = { type: null, path: null, port: null, command: null };
  if (probe.httpGet) {
    p.type = 'httpGet';
    p.path = probe.httpGet.path ?? null;
    p.port = probe.httpGet.port ?? null;
  } else if (probe.exec) {
    p.type = 'exec';
    p.command = Array.isArray(probe.exec.command) ? probe.exec.command.join(' ') : probe.exec.command;
  } else if (probe.tcpSocket) {
    p.type = 'tcpSocket';
    p.port = probe.tcpSocket.port ?? null;
  }
  p.initialDelaySeconds = probe.initialDelaySeconds ?? null;
  p.periodSeconds = probe.periodSeconds ?? null;
  return p;
}

export function parseK8sManifest(filePath, content) {
  const result = { documents: [], parseError: null };
  let docs;
  try {
    docs = YAML.parseAllDocuments(content, { logLevel: "silent" }).map((d) => d.toJS({ mapAsMap: false }));
  } catch (e) {
    result.parseError = e.message;
    return result;
  }
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object' || !doc.kind) continue;
    const kind = String(doc.kind);
    const meta = doc.metadata || {};
    const entry = {
      kind,
      name: meta.name ?? null,
      namespace: meta.namespace ?? null,
      labels: meta.labels || {},
      known: K8S_OBJECT_KINDS.has(kind),
    };
    if (K8S_WORKLOAD_KINDS.has(kind)) {
      const spec = doc.spec || {};
      entry.replicas = spec.replicas ?? (kind === 'CronJob' ? null : 1);
      const podSpec = kind === 'CronJob' ? spec.jobTemplate?.spec?.template?.spec : spec.template?.spec;
      entry.containers = (podSpec?.containers || []).map((c) => {
        const env = parseK8sEnv(c.env);
        return {
          name: c.name,
          image: c.image ?? null,
          ports: (c.ports || []).map((p) => ({ container: p.containerPort, name: p.name ?? null, protocol: p.protocol ?? 'TCP' })),
          env: env.map,
          envRefs: env.refs,
          envFrom: (c.envFrom || []).map((ef) => ({
            type: ef.configMapRef ? 'configMap' : 'secret',
            ref: ef.configMapRef?.name ?? ef.secretRef?.name ?? null,
          })),
          resources: c.resources ? {
            requests: c.resources.requests || null,
            limits: c.resources.limits || null,
          } : null,
          readinessProbe: parseProbe(c.readinessProbe),
          livenessProbe: parseProbe(c.livenessProbe),
          volumeMounts: (c.volumeMounts || []).map((v) => v.mountPath),
          args: Array.isArray(c.args) ? c.args.map(String) : [],
        };
      });
      entry.strategy = spec.strategy?.type ?? null;
      entry.imagePullSecrets = (spec.template?.spec?.imagePullSecrets || podSpec?.imagePullSecrets || []).map((s) => s.name);
    } else if (kind === 'Service') {
      const spec = doc.spec || {};
      entry.serviceType = spec.type ?? 'ClusterIP';
      entry.ports = (spec.ports || []).map((p) => ({ port: p.port, targetPort: p.targetPort ?? p.port, name: p.name ?? null }));
      entry.selector = spec.selector || {};
    } else if (kind === 'ConfigMap' || kind === 'Secret') {
      entry.dataKeys = Object.keys(doc.data || doc.stringData || {});
      entry.dataSize = Object.values(doc.data || {}).reduce((sum, v) => sum + String(v ?? '').length, 0);
    } else if (kind === 'PersistentVolumeClaim') {
      entry.storage = doc.spec?.resources?.requests?.storage ?? null;
      entry.accessModes = doc.spec?.accessModes || [];
    } else if (kind === 'Ingress') {
      const rules = doc.spec?.rules || [];
      entry.hosts = rules.map((r) => r.host).filter(Boolean);
      entry.paths = rules.flatMap((r) => (r.http?.paths || []).map((p) => ({
        host: r.host ?? null,
        path: p.path,
        serviceName: p.backend?.service?.name ?? p.backend?.serviceName ?? null,
        servicePort: p.backend?.service?.port?.number ?? p.backend?.servicePort ?? null,
      })));
    } else if (kind === 'Kustomization') {
      entry.resources = (doc.resources || []).map(String);
      entry.images = (doc.images || []).map((i) => ({ name: i.name, newTag: i.newTag ?? null }));
    }
    result.documents.push(entry);
  }
  return result;
}

// ---------- Nginx Conf ----------

// 花括号计数切块：提取顶层指令块
function extractBlocks(content, keyword) {
  const blocks = [];
  const re = new RegExp(`(^|\\n)\\s*(${keyword})\\b`, 'g');
  let m;
  while ((m = re.exec(content)) !== null) {
    const start = m.index + m[1].length;
    let depth = 0;
    let braceStart = -1;
    for (let i = start; i < content.length; i++) {
      if (content[i] === '{') {
        if (depth === 0) braceStart = i;
        depth++;
      } else if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          blocks.push({
            header: content.slice(start, braceStart).trim(),
            body: content.slice(braceStart + 1, i),
          });
          re.lastIndex = i + 1;
          break;
        }
      }
    }
  }
  return blocks;
}

function stripNginxComments(content) {
  return content.replace(/(^|\s)#.*$/gm, '$1');
}

export function parseNginxConf(filePath, content) {
  const result = { upstreams: [], servers: [], routes: [], staticLocations: [], parseError: null };
  const clean = stripNginxComments(content);

  // upstream 块
  for (const block of extractBlocks(clean, 'upstream')) {
    const name = block.header.replace(/^upstream\s+/, '').trim();
    const servers = [];
    for (const sm of block.body.matchAll(/server\s+([^;]+);/g)) {
      const target = sm[1].trim().split(/\s+/)[0];
      const [host, port] = target.split(':');
      servers.push({ host, port: port ? parseInt(port, 10) : 80 });
    }
    result.upstreams.push({ name, servers });
  }

  // location 块（递归于 server，但扁平提取即可）
  for (const block of extractBlocks(clean, 'location')) {
    const header = block.header.replace(/^location\s+/, '').trim();
    let matchType = 'prefix';
    let path = header;
    const mt = header.match(/^([=~^]*~\*?|[=^])\s*(.*)$/);
    if (mt && mt[2]) {
      matchType = mt[1] === '=' ? 'exact' : mt[1].startsWith('^') ? 'prefix-nostack' : 'regex';
      path = mt[2];
    }
    const body = block.body;
    const proxyPass = (body.match(/proxy_pass\s+([^;]+);/) || [])[1]?.trim() ?? null;
    if (!proxyPass) {
      if (/root\s|alias\s|try_files\s/.test(body)) {
        result.staticLocations.push({ path, matchType, body: body.trim().slice(0, 200) });
      }
      continue;
    }
    // 解析 proxy_pass 目标
    let targetUpstream = null;
    let directService = null;
    let directPort = null;
    const schemeMatch = proxyPass.match(/^(https?):\/\/([^/]+)/);
    if (schemeMatch) {
      const target = schemeMatch[2];
      if (result.upstreams.some((u) => u.name === target)) {
        targetUpstream = target;
      } else {
        const [host, port] = target.split(':');
        directService = host;
        directPort = port ? parseInt(port, 10) : 80;
      }
    } else {
      targetUpstream = proxyPass.replace(/\/.*$/, '');
    }
    result.routes.push({
      path,
      matchType,
      proxyPass,
      targetUpstream,
      directService,
      directPort,
      authRequest: (body.match(/auth_request\s+([^;]+);/) || [])[1]?.trim() ?? null,
      clientMaxBodySize: (body.match(/client_max_body_size\s+([^;]+);/) || [])[1]?.trim() ?? null,
      websocket: /proxy_set_header\s+Upgrade/.test(body),
    });
  }

  // server 块（监听与 SSL）
  for (const block of extractBlocks(clean, 'server')) {
    const listen = [...block.header.matchAll(/listen\s+([^;]+);/g)].map((m) => m[1].trim());
    if (listen.length === 0) continue; // upstream 内的 server 已处理
    const serverName = (block.header.match(/server_name\s+([^;]+);/) || [])[1]?.trim() ?? null;
    const sslCert = (block.header.match(/ssl_certificate\s+([^;]+);/) || [])[1]?.trim() ?? null;
    const sslKey = (block.header.match(/ssl_certificate_key\s+([^;]+);/) || [])[1]?.trim() ?? null;
    const sslProtocols = (block.header.match(/ssl_protocols\s+([^;]+);/) || [])[1]?.trim() ?? null;
    const redirect = /return\s+301/.test(block.body) || /return\s+302/.test(block.body);
    result.servers.push({ listen, serverName, ssl: { cert: sslCert, key: sslKey, protocols: sslProtocols }, redirect });
  }
  return result;
}

// ---------- Env File ----------

export function parseEnvFile(filePath, content) {
  const result = { variables: [], serviceRefs: [] };
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const secret = isSecretKey(key);
    result.variables.push({
      key,
      value: secret ? maskSecretValue(value) : value,
      isSecret: secret,
    });
    // URL 型服务引用：http://host:port 或 https://host
    for (const um of value.matchAll(/https?:\/\/([a-zA-Z0-9._-]+?)(?::(\d+))?[/?\s"']/g)) {
      const host = um[1];
      const port = um[2] ? parseInt(um[2], 10) : null;
      // 排除常见外部域名与 localhost
      if (host === 'localhost' || host.includes('.com') || host.includes('.cn') || host.includes('.ai') || /^\d+\.\d+/.test(host)) continue;
      result.serviceRefs.push({ key, serviceName: host, port });
    }
  }
  return result;
}

// ---------- Shell Script（轻量登记） ----------

export function parseShellScript(filePath, content) {
  const commands = [];
  for (const m of content.matchAll(/(docker\s+(compose|run|build|pull)[^\n&|;]*|kubectl\s+[^\n&|;]*|flyway\s+[^\n&|;]*|helm\s+[^\n&|;]*)/g)) {
    const cmd = m[1].trim();
    if (cmd.length > 160) continue;
    commands.push(cmd);
  }
  return { commands: [...new Set(commands)].slice(0, 50) };
}

// ---------- 文件分类 ----------

const DOCKERFILE_RE = /^dockerfile/i;
const COMPOSE_RE = /^(docker-)?compose|^compose/i;
const CI_FILE_RE = /(jenkinsfile|azure-pipeline|\.github[\\/])/i;
const NGINX_CONF_RE = /nginx|\.conf$/i;

// 按文件名 + 内容特征分类部署文件
export function classifyDeployFile(filePath, content) {
  const base = path.basename(filePath);
  const lower = base.toLowerCase();
  const relHint = filePath.replace(/\\/g, '/');

  if (DOCKERFILE_RE.test(lower)) return 'dockerfile';
  if (COMPOSE_RE.test(lower) && /\.(yml|yaml)$/.test(lower)) return 'compose';

  if (CI_FILE_RE.test(relHint) || /\.github\//.test(relHint)) {
    if (/\.(yml|yaml)$/.test(lower)) return 'ci';
  }
  if (/jenkinsfile/i.test(base)) return 'ci';

  if (NGINX_CONF_RE.test(lower) && /\.conf$/.test(lower)) {
    return /upstream|location|proxy_pass|server\s*\{/i.test(content) ? 'nginx' : 'config';
  }
  if (/\.conf$/.test(lower)) {
    return /upstream|location|proxy_pass/i.test(content) ? 'nginx' : 'config';
  }
  if (/^\.env/.test(lower) || /\.env$/.test(lower) || /^env[-.]/i.test(lower)) return 'env';

  if (/\.(yml|yaml)$/.test(lower)) {
    if (/^\s*(apiVersion|kind):/m.test(content)) return 'k8s';
    if (/^services:/m.test(content) && /image:|build:/m.test(content)) return 'compose';
    return 'config';
  }
  if (/\.sh$/.test(lower)) return 'shell';
  if (/\.(json|md|txt|properties|toml|groovy|jpi|tgz)$/i.test(lower)) return 'config';
  if (/^(crontab|redis)\.conf$/i.test(lower)) return 'config';
  return 'config';
}

// 解析单个部署文件（按分类分发）
export function analyzeDeployFile(filePath, content) {
  const type = classifyDeployFile(filePath, content);
  const fileName = path.basename(filePath);
  const fileSize = Buffer.byteLength(content, 'utf-8');
  const base = { filePath, fileName, type, fileSize };

  switch (type) {
    case 'dockerfile':
      return { ...base, parsed: parseDockerfile(filePath, content) };
    case 'compose':
      return { ...base, parsed: parseDockerCompose(filePath, content) };
    case 'k8s':
      return { ...base, parsed: parseK8sManifest(filePath, content) };
    case 'nginx':
      return { ...base, parsed: parseNginxConf(filePath, content) };
    case 'env':
      return { ...base, parsed: parseEnvFile(filePath, content) };
    case 'shell':
      return { ...base, parsed: parseShellScript(filePath, content) };
    default:
      return base;
  }
}
