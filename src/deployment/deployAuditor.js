// 部署架构审计器：五大审计场景
//   1. auditSecurity        安全审计：latest 镜像 / 明文敏感值 / 全网段端口暴露 / 无鉴权路由
//   2. auditResilience      高可用审计：健康检查 / 就绪探针 / 重启策略 / 副本数 / 资源限额
//   3. auditConfigConsistency 配置一致性：多环境变量漂移 / 环境引用未知服务
//   4. auditDependency      依赖审计：路由未解析 / 上游断链 / 循环依赖 / 中间件无消费方
//   5. auditHealth          综合健康评分（聚合上述维度）
// 每个审计返回 { key, label, score, level, findings: [{level, title, detail, location}], stats }

const LEVEL_WEIGHT = { error: 10, warn: 4, info: 0 };

function makeAudit(key, label, findings, stats) {
  // 评分：100 起步，按 error/warn 扣分，下限 0
  let penalty = 0;
  for (const f of findings) penalty += LEVEL_WEIGHT[f.level] || 0;
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const level = score >= 90 ? 'good' : score >= 70 ? 'fair' : score >= 50 ? 'warn' : 'poor';
  return { key, label, score, level, findings, stats: stats || {} };
}

function isBusinessService(svc) {
  return !svc.virtual;
}

// ---------- 1. 安全审计 ----------

export function auditSecurity(model) {
  const findings = [];
  const services = (model.services || []).filter(isBusinessService);
  let latestImageCount = 0;
  let exposedPortCount = 0;
  let secretValueCount = 0;

  for (const svc of services) {
    // latest / 无 tag 镜像
    if (svc.image && /(^|:)(latest)$/.test(svc.image.split('@')[0])) {
      latestImageCount++;
      findings.push({
        level: 'warn',
        title: `服务 ${svc.name} 使用 latest 镜像标签`,
        detail: `镜像 ${svc.image}：latest 标签导致部署不可复现，建议固定版本 tag`,
        location: svc.sources[0]?.file ?? null,
      });
    }
    // 端口绑定 0.0.0.0（host port 形如 "0.0.0.0:8080:80" 或纯数字暴露在宿主机）
    for (const p of svc.ports || []) {
      if (typeof p.host === 'string' && p.host !== '127.0.0.1') {
        exposedPortCount++;
        findings.push({
          level: 'info',
          title: `服务 ${svc.name} 端口绑定到 ${p.host}`,
          detail: `宿主机端口 ${p.host}:${p.host === '0.0.0.0' ? p.container : p.host} 对外暴露，确认是否需要限制为 127.0.0.1 或经网关转发`,
          location: svc.sources[0]?.file ?? null,
        });
      }
    }
    // 环境变量明文敏感值（builder 已脱敏展示，这里检测原始定义存在的敏感 key 数量）
    for (const [k, v] of Object.entries(svc.env || {})) {
      if (/password|passwd|secret|token|credential/i.test(k) && v && !String(v).startsWith('***')) {
        secretValueCount++;
        findings.push({
          level: 'error',
          title: `服务 ${svc.name} 环境变量 ${k} 含明文敏感值`,
          detail: '建议改用 Docker secrets / K8s Secret / 环境文件注入，避免提交到版本库',
          location: svc.sources[0]?.file ?? null,
        });
      }
    }
    // K8s Secret 直接挂 env（可接受，但标记统计）
  }

  // 环境文件中的明文敏感值
  for (const env of model.environments || []) {
    const secrets = (env.variables || []).filter((v) => v.isSecret);
    if (secrets.length > 0) {
      secretValueCount += secrets.length;
      findings.push({
        level: 'warn',
        title: `环境 ${env.name} 包含 ${secrets.length} 个敏感变量`,
        detail: `敏感键：${secrets.map((s) => s.key).slice(0, 8).join(', ')}${secrets.length > 8 ? ' …' : ''}（已脱敏展示）。建议纳入密钥管理`,
        location: env.file,
      });
    }
  }

  // 无鉴权的网关路由（auth_request 缺失 + 非 WebSocket 静态资源外的 API 路由）
  for (const route of model.routes || []) {
    if (route.resolvedService && !route.authRequest && /^\/(api|auth|admin|backend|service)/i.test(route.path || '')) {
      findings.push({
        level: 'info',
        title: `路由 ${route.path} 未配置 auth_request 鉴权`,
        detail: `网关 ${route.gateway} → ${route.resolvedService}：API 前缀路由建议在网关层统一鉴权（auth_request）或确认由后端鉴权`,
        location: route.source,
      });
    }
  }

  return makeAudit('security', '安全审计', findings, { latestImageCount, exposedPortCount, secretValueCount });
}

// ---------- 2. 高可用审计 ----------

export function auditResilience(model) {
  const findings = [];
  const services = (model.services || []).filter(isBusinessService);
  // 只审计业务服务（后端/前端/适配器/应用），中间件与 job 类放宽
  const CORE_TYPES = new Set(['backend', 'frontend', 'adapter', 'app', 'gateway']);
  let missingHealthcheck = 0;
  let missingProbes = 0;
  let singleReplica = 0;
  let missingLimits = 0;
  let noRestart = 0;

  for (const svc of services) {
    const isCore = CORE_TYPES.has(svc.type);
    const hasHc = Boolean(svc.healthcheck || svc.readinessProbe || svc.livenessProbe);
    if (isCore && !hasHc) {
      missingHealthcheck++;
      findings.push({
        level: 'warn',
        title: `服务 ${svc.name} 缺少健康检查`,
        detail: '无 healthcheck / readinessProbe / livenessProbe，故障实例无法自动摘除与重启',
        location: svc.sources[0]?.file ?? null,
      });
    }
    if (svc.kind === 'Deployment' && !svc.readinessProbe) {
      missingProbes++;
      findings.push({
        level: 'warn',
        title: `服务 ${svc.name}（Deployment）缺少就绪探针`,
        detail: '滚动更新时未就绪实例会接收流量，建议配置 readinessProbe',
        location: svc.sources[0]?.file ?? null,
      });
    }
    if (isCore && svc.replicas !== null && svc.replicas <= 1 && svc.kind !== 'Job' && svc.kind !== 'CronJob') {
      singleReplica++;
      findings.push({
        level: 'info',
        title: `服务 ${svc.name} 单副本部署`,
        detail: `replicas=${svc.replicas}：单点故障风险，生产环境建议 ≥2`,
        location: svc.sources[0]?.file ?? null,
      });
    }
    if (svc.kind === 'Deployment' && svc.resources && !svc.resources.limits) {
      missingLimits++;
      findings.push({
        level: 'warn',
        title: `服务 ${svc.name} 未配置资源限额（limits）`,
        detail: '无 limits 时容器可能耗尽节点资源，建议设置 CPU/内存上限',
        location: svc.sources[0]?.file ?? null,
      });
    }
    if (svc.kind === 'container' && !svc.restart && isCore) {
      noRestart++;
      findings.push({
        level: 'info',
        title: `服务 ${svc.name} 未声明 restart 策略`,
        detail: 'docker-compose 默认 no：进程退出后不会自动拉起，建议 unless-stopped / always',
        location: svc.sources[0]?.file ?? null,
      });
    }
  }

  return makeAudit('resilience', '高可用审计', findings, {
    missingHealthcheck, missingProbes, singleReplica, missingLimits, noRestart,
  });
}

// ---------- 3. 配置一致性审计 ----------

export function auditConfigConsistency(model) {
  const findings = [];
  const environments = model.environments || [];
  const knownNames = new Set((model.services || []).map((s) => s.name));

  // 多环境变量漂移：同名变量集合在环境间不一致
  if (environments.length >= 2) {
    const keySets = environments.map((e) => ({
      name: e.name,
      keys: new Set((e.variables || []).map((v) => v.key)),
    }));
    const union = new Set(keySets.flatMap((k) => [...k.keys]));
    const drift = [];
    for (const key of union) {
      const missing = keySets.filter((k) => !k.keys.has(key)).map((k) => k.name);
      if (missing.length > 0 && missing.length < keySets.length) {
        drift.push({ key, missing });
      }
    }
    if (drift.length > 0) {
      findings.push({
        level: 'warn',
        title: `${drift.length} 个环境变量存在跨环境漂移`,
        detail: drift.slice(0, 10).map((d) => `  ${d.key}：缺失于 ${d.missing.join('/')}`).join('\n') + (drift.length > 10 ? `\n  … 共 ${drift.length} 项` : ''),
        location: '多环境 .env 文件',
      });
    }
  }

  // 环境文件引用未知服务
  for (const env of environments) {
    for (const ref of env.serviceRefs || []) {
      if (!knownNames.has(ref.serviceName)) {
        findings.push({
          level: 'info',
          title: `环境 ${env.name} 变量 ${ref.key} 引用未识别服务 ${ref.serviceName}`,
          detail: '该主机名未在部署文件中定义，可能是外部地址或命名不一致',
          location: env.file,
        });
      }
    }
  }

  // 服务 env 引用未知服务
  for (const svc of (model.services || [])) {
    if (svc.virtual) continue;
    for (const ref of svc.envServiceRefs || []) {
      if (!knownNames.has(ref.serviceName)) {
        findings.push({
          level: 'warn',
          title: `服务 ${svc.name} 变量 ${ref.key} 引用未识别服务 ${ref.serviceName}`,
          detail: 'URL 主机名与服务名无法对齐：可能拼写不一致或服务未部署，运行时将连接失败',
          location: svc.sources[0]?.file ?? null,
        });
      }
    }
  }

  return makeAudit('configConsistency', '配置一致性审计', findings, {
    environmentCount: environments.length,
  });
}

// ---------- 4. 依赖审计 ----------

export function auditDependency(model) {
  const findings = [];
  const knownNames = new Set((model.services || []).map((s) => s.name));

  // 路由未解析到服务
  let unresolvedRoutes = 0;
  for (const route of model.routes || []) {
    if (!route.resolvedService && !route.externalHost) {
      unresolvedRoutes++;
      findings.push({
        level: 'warn',
        title: `路由 ${route.path} 无法解析目标服务`,
        detail: `proxy_pass ${route.proxyPass} → 上游 ${route.targetUpstream || '未知'}：目标未在部署清单中定义`,
        location: route.source,
      });
    }
  }

  // 上游服务器断链
  for (const up of model.upstreams || []) {
    const unresolved = (up.servers || []).filter((s) => !s.resolvedService);
    if (unresolved.length > 0) {
      findings.push({
        level: 'warn',
        title: `上游 ${up.name} 存在未识别后端`,
        detail: `网关 ${up.gateway} 的 server ${unresolved.map((s) => `${s.host}:${s.port}`).join(', ')} 未匹配到部署服务`,
        location: up.source,
      });
    }
  }

  // 循环依赖检测（depends_on + env_ref + route 边）
  const adj = new Map();
  for (const dep of model.dependencies || []) {
    if (!adj.has(dep.from)) adj.set(dep.from, []);
    adj.get(dep.from).push(dep.to);
  }
  const visiting = new Set();
  const done = new Set();
  const cycles = [];
  function dfs(node, stack) {
    if (done.has(node)) return;
    if (visiting.has(node)) {
      const idx = stack.indexOf(node);
      if (idx >= 0) cycles.push([...stack.slice(idx), node]);
      return;
    }
    visiting.add(node);
    for (const next of adj.get(node) || []) dfs(next, [...stack, node]);
    visiting.delete(node);
    done.add(node);
  }
  for (const node of adj.keys()) dfs(node, []);
  for (const cycle of [...new Set(cycles.map((c) => c.join('→')))].slice(0, 5)) {
    findings.push({
      level: 'error',
      title: '存在循环依赖',
      detail: `${cycle}：循环依赖可能导致启动死锁或级联故障`,
      location: null,
    });
  }

  // 无消费方的中间件
  for (const mw of model.middleware || []) {
    if (!mw.consumers || mw.consumers.length === 0) {
      findings.push({
        level: 'info',
        title: `中间件 ${mw.label}（${mw.name}）无消费方`,
        detail: '未发现服务通过依赖边或环境变量引用它：可能未被使用或引用方式未被识别',
        location: mw.source,
      });
    }
  }

  // depends_on 指向未定义服务
  for (const svc of (model.services || [])) {
    if (svc.virtual) continue;
    for (const dep of svc.dependsOn || []) {
      if (!knownNames.has(dep)) {
        findings.push({
          level: 'error',
          title: `服务 ${svc.name} depends_on 未定义服务 ${dep}`,
          detail: 'compose 编排中引用了不存在的服务名',
          location: svc.sources[0]?.file ?? null,
        });
      }
    }
  }

  return makeAudit('dependency', '依赖审计', findings, {
    unresolvedRoutes,
    cycleCount: new Set(cycles.map((c) => c.join('→'))).size,
  });
}

// ---------- 5. 综合健康评分 ----------

const DIMENSION_WEIGHTS = {
  security: 0.3,
  resilience: 0.3,
  configConsistency: 0.2,
  dependency: 0.2,
};

export function auditHealth(model) {
  const audits = {
    security: auditSecurity(model),
    resilience: auditResilience(model),
    configConsistency: auditConfigConsistency(model),
    dependency: auditDependency(model),
  };

  let score = 0;
  const dimensions = [];
  for (const [key, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    score += audits[key].score * weight;
    dimensions.push({ key, label: audits[key].label, score: audits[key].score, level: audits[key].level, weight });
  }
  score = Math.round(score);
  const level = score >= 90 ? 'good' : score >= 70 ? 'fair' : score >= 50 ? 'warn' : 'poor';
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'E';

  // Top 问题（error 优先）
  const allFindings = Object.values(audits).flatMap((a) => a.findings.map((f) => ({ ...f, audit: a.label })));
  const ranked = allFindings.sort((a, b) => {
    const order = { error: 0, warn: 1, info: 2 };
    return order[a.level] - order[b.level];
  });

  return {
    key: 'health',
    label: '综合健康评分',
    score,
    level,
    grade,
    dimensions,
    errorCount: allFindings.filter((f) => f.level === 'error').length,
    warnCount: allFindings.filter((f) => f.level === 'warn').length,
    infoCount: allFindings.filter((f) => f.level === 'info').length,
    topFindings: ranked.slice(0, 12),
    audits,
  };
}
