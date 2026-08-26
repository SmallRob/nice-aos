// 全景架构扫描器：从"多项目 snapshot 目录" + "Java 解析（pom.xml / application.yml / @注解）" +
// "布局声明（LAYOUT_FILE）" + "可选人类架构知识（HumanKnowledgeFile）"聚合产出概览快照。
//
// 设计原则：
// 1. 复用 single-project snapshot 已有产物，不重复扫描代码本体
// 2. 借鉴 asdm/_blueprints/_architecture.py 的 Java 解析思路（pom.xml + application.yml + ripgrep @RestController / @Service）
// 3. 5 层架构（client / gateway / application / integration / tool）从外部 LAYOUT_FILE 声明，避免硬编码
// 4. 人类架构知识（设计意图 / 资源需求）从可选 HUMAN_KNOWLEDGE_FILE 加载，可与 cict-asdm 辅助文档联动

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadProjectSnapshot } from './overviewSnapshot.js';
import yaml from 'yaml';

// ============================================================================
// 1. 单项目画像（从已有 snapshot.json 抽取）
// ============================================================================
function summarizeProject(snapshot) {
  const project = (snapshot.Project || [{}])[0] || {};
  const fileCount = project.fileCount || 0;
  let totalLines = 0;
  let testLines = 0;
  let entryFiles = 0;
  const byExt = {};
  for (const f of snapshot.SourceFile || []) {
    const ext = f.ext || '?';
    const n = f.lineCount || 0;
    totalLines += n;
    byExt[ext] = byExt[ext] || { files: 0, lines: 0 };
    byExt[ext].files += 1;
    byExt[ext].lines += n;
    if (f.isTest) testLines += n;
    if (f.isEntry) entryFiles += 1;
  }
  // 顶层依赖（按 importCount 排序，前 5）
  const deps = (snapshot.Dependency || [])
    .filter((d) => d.source === 'npm' || d.source === 'pub')
    .sort((a, b) => (b.importCount || 0) - (a.importCount || 0))
    .slice(0, 5)
    .map((d) => `${d.name}${d.version ? '@' + d.version : ''}`);
  return {
    packageName: project.name || null,
    framework: project.framework || 'unknown',
    frameworkVariants: project.frameworkVariants || [],
    fileCount,
    totalLines,
    testLines,
    entryFiles,
    durationMs: project.durationMs || null,
    byExt,
    techStack: deps,
  };
}

// ============================================================================
// 2. Java 子服务发现（pom.xml + application.yml + ripgrep 注解统计）
//    借鉴 asdm/_blueprints/_architecture.py 实现
// ============================================================================
function discoverJavaServices(projectRootDir) {
  const services = [];
  if (!fs.existsSync(projectRootDir)) return services;
  // 约定：asdm-admin/asdm-admin-services/<sub>/pom.xml
  const candidates = ['asdm-admin-services', 'services', 'modules'];
  let servicesDir = null;
  for (const c of candidates) {
    const d = path.join(projectRootDir, c);
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
      servicesDir = d;
      break;
    }
  }
  if (!servicesDir) {
    // 退而求其次：找包含 pom.xml 的子目录
    const subdirs = fs.readdirSync(projectRootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(projectRootDir, e.name));
    for (const sd of subdirs) {
      if (fs.existsSync(path.join(sd, 'pom.xml'))) {
        servicesDir = projectRootDir;
        break;
      }
    }
  }
  if (!servicesDir) return services;

  // 收集所有含 pom.xml 的子服务目录
  const entries = fs.readdirSync(servicesDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sd = path.join(servicesDir, e.name);
    const pomPath = path.join(sd, 'pom.xml');
    if (!fs.existsSync(pomPath)) continue;
    const pom = readPomXml(pomPath);
    if (!pom.artifactId) continue;
    const { port, appName, description } = readApplicationYaml(sd);
    services.push({
      name: e.name,
      displayName: e.name.replace(/^.*?-services-/, ''),
      artifactId: pom.artifactId,
      port,
      appName,
      description,
      path: path.relative(projectRootDir, sd),
      dependencies: pom.dependencies || [],
    });
  }
  return services.sort((a, b) => (a.port || 99999) - (b.port || 99999));
}

function readPomXml(pomPath) {
  try {
    const text = fs.readFileSync(pomPath, 'utf-8');
    const art = text.match(/<artifactId>([^<]+)<\/artifactId>/);
    const deps = [];
    for (const m of text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) {
      deps.push(m[1]);
    }
    const desc = text.match(/<description>([^<]+)<\/description>/);
    return {
      artifactId: art ? art[1] : null,
      description: desc ? desc[1] : null,
      dependencies: deps,
    };
  } catch {
    return {};
  }
}

function readApplicationYaml(svcDir) {
  for (const fname of ['application.yml', 'application.yaml', 'application.properties']) {
    const p = path.join(svcDir, 'src', 'main', 'resources', fname);
    if (!fs.existsSync(p)) continue;
    try {
      const text = fs.readFileSync(p, 'utf-8');
      let port = null;
      let appName = null;
      let description = null;
      if (fname.endsWith('.properties')) {
        const pm = text.match(/server\.port\s*=\s*(\d+)/);
        if (pm) port = parseInt(pm[1], 10);
        const nm = text.match(/spring\.application\.name\s*=\s*(\S+)/);
        if (nm) appName = nm[1];
      } else {
        const doc = yaml.parse(text) || {};
        const rawPort = doc?.server?.port;
        port = typeof rawPort === 'number' ? rawPort : null;
        appName = doc?.spring?.application?.name || null;
        description = doc?.spring?.application?.description || null;
      }
      // ${SERVER_PORT:8887} 形式（占位符带默认值）—— port 解析后再尝试
      if (!port) {
        const m = text.match(/\$\{[^}]*:(\d+)\}/);
        if (m) port = parseInt(m[1], 10);
      }
      // application-dev.yml 等 profile 文件可能有更具体的端口（开发端口）
      for (const prof of ['application-dev.yml', 'application-dev.yaml', 'application-prod.yml', 'application-prod.yaml']) {
        const pp = path.join(svcDir, 'src', 'main', 'resources', prof);
        if (!fs.existsSync(pp)) continue;
        try {
          const ptext = fs.readFileSync(pp, 'utf-8');
          const pm = ptext.match(/^\s*port:\s*(\d+)/m);
          if (pm) { port = parseInt(pm[1], 10); break; }
        } catch { /* ignore */ }
      }
      return { port, appName, description };
    } catch {
      // 继续
    }
  }
  return { port: null, appName: null, description: null };
}

// Java 注解统计：@RestController / @Service / @Component
// 借鉴 asdm/_blueprints/_architecture.py 的 rg_count 思路
// macOS Node 18+ spawnSync/execFileSync 在 find+grep 大文件集上有 ETIMEDOUT bug，用 async spawn 替代
function runSubprocess(cmd, args, { timeoutMs = 60000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let errBuf = '';
    let killed = false;
    const child = spawn(cmd, args);
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (out.length < maxBuffer) out += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (errBuf.length < maxBuffer) errBuf += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: '', stderr: errBuf, error: e, killed });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !killed, stdout: out, stderr: errBuf, code, killed });
    });
  });
}

// 纯 JS 计算 Java 文件/行数（避免 subprocess 开销）
function countJavaFilesAndLines(projectRootDir) {
  if (!fs.existsSync(projectRootDir)) return { files: 0, lines: 0 };
  let files = 0;
  let lines = 0;
  const SKIP = new Set(['node_modules', 'target', 'build', 'dist', '.git']);
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith('.java')) {
        files += 1;
        try {
          const buf = fs.readFileSync(path.join(dir, e.name));
          // 二进制快速跳过
          if (buf.length > 0 && buf[0] === 0) continue;
          for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lines += 1;
          if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) lines += 1;
        } catch { /* ignore */ }
      }
    }
  };
  walk(projectRootDir);
  return { files, lines };
}

async function countJavaAnnotationsAsync(projectRootDir) {
  if (!fs.existsSync(projectRootDir)) return { controllers: 0, services: 0 };
  const result = { controllers: 0, services: 0 };
  const tryCount = async (pattern) => {
    // 优先 ripgrep
    let r = await runSubprocess('rg', ['-l', '--no-heading', '--type', 'java', pattern, projectRootDir], { timeoutMs: 30000 });
    if (r.ok) {
      return r.stdout.split('\n').filter((l) => l.trim()).length;
    }
    // fallback: find + grep -lE
    r = await runSubprocess('find', [
      projectRootDir, '-name', '*.java',
      '-not', '-path', '*/target/*',
      '-not', '-path', '*/node_modules/*',
      '-not', '-path', '*/build/*',
      '-exec', 'grep', '-lE', pattern, '{}', '+',
    ], { timeoutMs: 60000 });
    if (r.ok) {
      return r.stdout.split('\n').filter((l) => l.trim()).length;
    }
    return 0;
  };
  result.controllers = await tryCount('@RestController');
  result.services = await tryCount('@(Service|Component)\\b');
  return result;
}

// ============================================================================
// 3. 跨项目 npm 依赖矩阵
// ============================================================================
function buildCrossMatrix(projectsLayout) {
  const matrix = {};
  for (const p of projectsLayout) {
    const pkgPath = path.join(p.rootDir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = new Set();
      for (const scope of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const dep of Object.keys(pkg[scope] || {})) {
          if (dep.startsWith('asdm-') || /asdm/i.test(pkg.name || '')) {
            deps.add(dep);
          }
        }
      }
      if (deps.size > 0) matrix[p.name] = [...deps].sort();
    } catch {
      // 忽略
    }
  }
  return matrix;
}

// ============================================================================
// 4. Docker Compose 服务关系（depends_on + ports）
// ============================================================================
function extractComposeRelations(projectsLayout) {
  const relations = [];
  for (const p of projectsLayout) {
    for (const entry of fs.readdirSync(p.rootDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!(entry.name === 'docker-compose.yml' || entry.name.startsWith('docker-compose-'))) continue;
      if (!(entry.name.endsWith('.yml') || entry.name.endsWith('.yaml'))) continue;
      const composePath = path.join(p.rootDir, entry.name);
      try {
        const doc = yaml.parse(fs.readFileSync(composePath, 'utf-8')) || {};
        const services = doc.services || {};
        for (const [svcName, svcDef] of Object.entries(services)) {
          for (const port of svcDef.ports || []) {
            let parsedPort = null;
            if (typeof port === 'string') {
              const m = port.match(/^(\d+):/);
              if (m) parsedPort = parseInt(m[1], 10);
            } else if (port && typeof port === 'object' && port.published) {
              parsedPort = parseInt(String(port.published), 10);
            }
            if (parsedPort) {
              relations.push({
                project: p.name,
                compose: path.relative(p.rootDir, composePath),
                service: svcName,
                port: parsedPort,
                kind: 'compose-port',
              });
            }
          }
          const deps = svcDef.depends_on;
          if (Array.isArray(deps)) {
            for (const d of deps) {
              relations.push({ project: p.name, service: svcName, dependsOn: d, kind: 'compose-dep' });
            }
          } else if (deps && typeof deps === 'object') {
            for (const d of Object.keys(deps)) {
              relations.push({ project: p.name, service: svcName, dependsOn: d, kind: 'compose-dep' });
            }
          }
        }
      } catch {
        // 忽略解析失败
      }
    }
  }
  return relations;
}

// ============================================================================
// 5. nginx.conf 代理关系
// ============================================================================
function extractNginxRelations(projectsLayout) {
  const relations = [];
  for (const p of projectsLayout) {
    let found = false;
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (full.includes('node_modules') || full.includes('.git') || full.includes('target')) continue;
          walk(full);
        } else if (e.isFile() && e.name === 'nginx.conf') {
          try {
            const text = fs.readFileSync(full, 'utf-8');
            for (const m of text.matchAll(/proxy_pass\s+https?:\/\/([^/;]+)\/?([^;]*);/g)) {
              relations.push({
                project: p.name,
                config: path.relative(p.rootDir, full),
                target: m[1],
                path: m[2] ? '/' + m[2].trim() : '/',
                kind: 'proxy-pass',
              });
            }
            for (const m of text.matchAll(/listen\s+(\d+)/g)) {
              relations.push({
                project: p.name,
                config: path.relative(p.rootDir, full),
                listen: parseInt(m[1], 10),
                kind: 'nginx-listen',
              });
            }
            found = true;
          } catch {
            // 忽略
          }
        }
      }
    };
    walk(p.rootDir);
    if (found) void 0; // 静默
  }
  return relations;
}

// ============================================================================
// 6. 加载外部 layout 声明（5 层架构 + 角色 hint）
// ============================================================================
function loadLayoutFile(layoutFilePath) {
  if (!layoutFilePath || !fs.existsSync(layoutFilePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(layoutFilePath, 'utf-8'));
  } catch {
    return null;
  }
}

// ============================================================================
// 7. 加载人类架构知识（设计意图 / 资源需求）
//    来源示例：cict-asdm/架构设计/ASDM架构.md + cict-asdm/资源规划/*.md
// ============================================================================
function loadHumanKnowledge(knowledgeFilePath) {
  if (!knowledgeFilePath || !fs.existsSync(knowledgeFilePath)) {
    return { intent: [], resources: [], sources: [] };
  }
  try {
    const doc = JSON.parse(fs.readFileSync(knowledgeFilePath, 'utf-8'));
    return {
      intent: doc.intent || [],
      resources: doc.resources || [],
      sources: doc.sources || [],
    };
  } catch {
    return { intent: [], resources: [], sources: [] };
  }
}

// ============================================================================
// 8. 主扫描函数
// ============================================================================
/**
 * 扫描多项目目录 + 布局声明 + 人类知识，生成全景架构概览模型
 * @param {Object} opts
 * @param {string} opts.projectsRoot  顶层项目根目录（含多个项目子目录）
 * @param {string} [opts.layoutFile]  布局声明 JSON（5 层架构 + 角色 hint）
 * @param {string} [opts.humanKnowledgeFile]  人类架构知识 JSON（设计意图 / 资源需求）
 * @param {string} [opts.niceAosVersion]  nice-aos 版本号
 * @returns {Object} 全景架构模型
 */
export async function scanOverview({ projectsRoot, layoutFile, humanKnowledgeFile, niceAosVersion = '0.31.0' }) {
  const projectsLayout = loadLayoutFile(layoutFile)?.projects || [];
  // projectsLayout 为空时，自动以 projectsRoot 下子目录为项目
  if (projectsLayout.length === 0) {
    for (const e of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      projectsLayout.push({
        name: e.name,
        displayName: e.name,
        layerHint: 'auto',
        roleHint: 'unknown',
        rootDir: path.join(projectsRoot, e.name),
      });
    }
  } else {
    // 给每个 layout 项目补 rootDir：sourceRoot（项目源代码根）优先，回退到 projectsRoot + name
    for (const p of projectsLayout) {
      p.rootDir = p.sourceRoot || p.rootDir || path.join(projectsRoot, p.name);
      p.snapshotPath = path.join(projectsRoot, p.name, 'snapshot.json');
      p.displayName = p.displayName || p.name;
      p.layerHint = p.layerHint || 'auto';
      p.roleHint = p.roleHint || 'unknown';
    }
  }

  // 自动发现模式下（无 layout）：snapshot 目录 = projectsRoot/<name>，源代码根 = 同
  if (projectsLayout.length > 0 && !projectsLayout[0].snapshotPath) {
    for (const p of projectsLayout) {
      p.snapshotPath = p.snapshotPath || path.join(projectsRoot, p.name, 'snapshot.json');
    }
  }

  // 1) 收集每个项目的 code-ontology 画像
  const projects = [];
  let grandLines = 0;
  let grandFiles = 0;
  const langTotals = {};
  for (const p of projectsLayout) {
    const snapPath = p.snapshotPath;
    const snap = loadProjectSnapshot(snapPath);
    if (!snap) {
      projects.push({
        name: p.name,
        displayName: p.displayName,
        layerHint: p.layerHint,
        roleHint: p.roleHint,
        note: p.note || '',
        framework: 'unknown',
        frameworkVariants: [],
        fileCount: 0,
        totalLines: 0,
        testLines: 0,
        entryFiles: 0,
        byExt: {},
        techStack: [],
        javaServices: [],
        snapshotPath: snapPath,
        snapshotExists: false,
      });
      continue;
    }
    const summary = summarizeProject(snap);
    grandLines += summary.totalLines;
    grandFiles += summary.fileCount;
    for (const [ext, info] of Object.entries(summary.byExt)) {
      langTotals[ext] = langTotals[ext] || { files: 0, lines: 0 };
      langTotals[ext].files += info.files;
      langTotals[ext].lines += info.lines;
    }
    // Java 子服务发现
    const javaServices = discoverJavaServices(p.rootDir);
    const javaAnnotationCounts = javaServices.length > 0 ? await countJavaAnnotationsAsync(p.rootDir) : null;
    const javaFileStats = javaServices.length > 0 ? countJavaFilesAndLines(p.rootDir) : { files: 0, lines: 0 };
    projects.push({
      name: p.name,
      displayName: p.displayName,
      layerHint: p.layerHint,
      roleHint: p.roleHint,
      note: p.note || '',
      ...summary,
      javaServices,
      javaAnnotationCounts,
      javaFileStats,
      snapshotPath: snapPath,
      snapshotExists: true,
    });
  }

  // 2) 跨项目依赖矩阵
  const crossMatrix = buildCrossMatrix(projectsLayout);

  // 3) 部署关系（compose + nginx）
  const composeRelations = extractComposeRelations(projectsLayout);
  const nginxRelations = extractNginxRelations(projectsLayout);

  // 4) 端口汇总
  const portAllocations = [];
  for (const p of projects) {
    for (const svc of p.javaServices || []) {
      if (svc.port) {
        portAllocations.push({
          service: svc.name,
          port: svc.port,
          appName: svc.appName,
          parent: p.name,
          kind: 'Spring Boot',
        });
      }
    }
  }
  for (const r of nginxRelations) {
    if (r.listen) {
      portAllocations.push({
        service: `nginx (${r.project})`,
        port: r.listen,
        kind: 'Nginx',
        config: r.config,
      });
    }
  }
  portAllocations.sort((a, b) => (a.port || 0) - (b.port || 0));

  // 5) 人类架构知识
  const humanKnowledge = loadHumanKnowledge(humanKnowledgeFile);

  // 6) 5 层架构分桶
  const layers = { client: [], gateway: [], application: [], integration: [], tool: [], repo: [] };
  for (const p of projects) {
    const layer = p.layerHint in layers ? p.layerHint : 'repo';
    layers[layer].push(p);
  }
  // application 层：把 Java 子服务展开为独立项
  const applicationServices = [];
  for (const p of projects) {
    for (const svc of p.javaServices || []) {
      applicationServices.push({ ...svc, parent: p.name });
    }
  }
  applicationServices.sort((a, b) => (a.port || 99999) - (b.port || 99999));

  // 7) 汇总指标
  let javaTotalFiles = 0;
  let javaTotalLines = 0;
  for (const p of projects) {
    if (p.javaFileStats) {
      javaTotalFiles += p.javaFileStats.files;
      javaTotalLines += p.javaFileStats.lines;
    }
  }
  const totals = {
    projects: projects.length,
    withSource: projects.filter((p) => p.totalLines > 0).length,
    grandTotalLines: grandLines + javaTotalLines,
    grandTotalFiles: grandFiles + javaTotalFiles,
    grandTotalSourceLines: grandLines,
    grandTotalSourceFiles: grandFiles,
    javaFiles: javaTotalFiles,
    javaLines: javaTotalLines,
    javaServices: applicationServices.length,
    layers: Object.keys(layers).filter((k) => layers[k].length > 0 || applicationServices.length > 0).length,
    crossProjectDeps: Object.values(crossMatrix).reduce((sum, deps) => sum + deps.length, 0),
  };
  // controllers / services
  let totalControllers = 0;
  let totalBizServices = 0;
  for (const p of projects) {
    if (p.javaAnnotationCounts) {
      totalControllers += p.javaAnnotationCounts.controllers;
      totalBizServices += p.javaAnnotationCounts.services;
    }
  }
  totals.apiControllers = totalControllers;
  totals.businessServices = totalBizServices;

  return {
    _meta: {
      generatedAt: new Date().toISOString(),
      scannerVersion: niceAosVersion,
      projectsRoot,
      layoutFile: layoutFile || null,
      humanKnowledgeFile: humanKnowledgeFile || null,
      projectCount: projects.length,
    },
    projects,
    layers,
    applicationServices,
    languages: langTotals,
    architecture: {
      crossMatrix,
      composeRelations: composeRelations.slice(0, 50),
      nginxRelations: nginxRelations.slice(0, 50),
      portAllocations,
    },
    humanKnowledge,
    totals,
  };
}
