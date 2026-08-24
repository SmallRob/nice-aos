// 后端服务模型构建器测试：asdm-aos 快照 fixture → 模块/分层/技术栈/端点/表/热点/测试统计聚合
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServiceModel, buildServiceModelFromFile } from '../src/service/serviceBuilder.js';
import { deriveModuleRules } from '../src/service/serviceModel.js';

// ---- asdm-aos 快照 fixture（与真实 asdm-admin 结构对齐） ----
function buildFixtureSnapshot() {
  const pkg = (id, name, extra = {}) => ({ id, name, fullPath: name, visibility: 'public', classCount: 0, repoId: 'repo:test-app', dependsOnPackageIds: [], dependencyIds: [], ...extra });
  const cls = (id, name, packageId, extra = {}) => ({
    id, name, type: 'class', visibility: 'public', modifiers: ['public'], lineCount: 10,
    packageId, extendsClassIds: [], implementsInterfaceIds: [], description: '',
    isDataModel: false, dataModelType: null, tableName: '', entityName: '',
    ...extra,
  });
  const mtd = (id, name, classId, extra = {}) => ({
    id, name, returnType: 'void', visibility: 'public', modifiers: [], parameters: [], lineCount: 5,
    classId, callsMethodIds: [], description: '', isTest: false, testType: null, isTestSetup: false,
    endpointInfo: null, lambdaCount: 0, complexity: { cyclomaticComplexity: 1, branchCount: 0, loopCount: 0, maxNestingDepth: 0, exceptionHandlerCount: 0, earlyReturnCount: 0 },
    ...extra,
  });

  return {
    Repository: [{ id: 'repo:test-app', name: 'test-app', path: '/x/test-app', language: 'Java', commitHash: 'abc123', branch: 'main', fileCount: 20, analysisErrors: [] }],
    Package: [
      pkg('pkg:ai.asdm.admin.core.controller', 'ai.asdm.admin.core.controller'),
      pkg('pkg:ai.asdm.admin.core.service', 'ai.asdm.admin.core.service', { dependencyIds: ['dep:jpa', 'dep:redis'] }),
      pkg('pkg:ai.asdm.admin.core.repository', 'ai.asdm.admin.core.repository'),
      pkg('pkg:ai.asdm.admin.core.entity', 'ai.asdm.admin.core.entity'),
      pkg('pkg:ai.asdm.admin.core.dto', 'ai.asdm.admin.core.dto'),
      pkg('pkg:ai.asdm.admin.core.config', 'ai.asdm.admin.core.config'),
      pkg('pkg:ai.asdm.admin.core.util', 'ai.asdm.admin.core.util'),
      pkg('pkg:ai.asdm.admin.adapter.ads', 'ai.asdm.admin.adapter.ads', { dependsOnPackageIds: ['pkg:ai.asdm.admin.core.service', 'pkg:ai.asdm.admin.core.entity'] }),
      pkg('pkg:ai.asdm.portal', 'ai.asdm.portal'),
      pkg('pkg:com.example.unknown', 'com.example.unknown'),
    ],
    Class: [
      cls('cls:...UserController', 'UserController', 'pkg:ai.asdm.admin.core.controller', { modifiers: ['@RestController', 'public'] }),
      cls('cls:...UserService', 'UserService', 'pkg:ai.asdm.admin.core.service', { modifiers: ['@Service', 'public'] }),
      cls('cls:...UserRepository', 'UserRepository', 'pkg:ai.asdm.admin.core.repository', { modifiers: ['@Repository', 'public'] }),
      cls('cls:...User', 'User', 'pkg:ai.asdm.admin.core.entity', { modifiers: ['@Entity', 'public'], isDataModel: true, dataModelType: 'JPA Entity', tableName: 'users' }),
      cls('cls:...UserDTO', 'UserDTO', 'pkg:ai.asdm.admin.core.dto'),
      cls('cls:...AppConfig', 'AppConfig', 'pkg:ai.asdm.admin.core.config', { modifiers: ['@Configuration', 'public'] }),
      cls('cls:...Helper', 'Helper', 'pkg:ai.asdm.admin.core.util'),
      cls('cls:...Status', 'Status', 'pkg:com.example.unknown', { type: 'enum' }),
    ],
    Interface: [
      { id: 'intf:...UserQueryService', name: 'UserQueryService', visibility: 'public', modifiers: [], lineCount: 5, methodSignatures: ['findUser', 'listUsers'], packageId: 'pkg:ai.asdm.admin.core.service', extendsInterfaceIds: [], description: '' },
    ],
    Method: [
      mtd('mtd:...UserController.getUser', 'getUser', 'cls:...UserController', { endpointInfo: { httpMethod: 'GET', path: '/api/v1/users', framework: 'Spring' }, complexity: { cyclomaticComplexity: 3, maxNestingDepth: 1 } }),
      mtd('mtd:...UserController.createUser', 'createUser', 'cls:...UserController', { endpointInfo: { httpMethod: 'POST', path: '/api/v1/users', framework: 'Spring' }, callsMethodIds: ['mtd:...UserService.saveUser'], complexity: { cyclomaticComplexity: 4, maxNestingDepth: 2 } }),
      mtd('mtd:...UserController.updateUser', 'updateUser', 'cls:...UserController', { complexity: { cyclomaticComplexity: 5, maxNestingDepth: 3 } }),
      mtd('mtd:...UserService.findUser', 'findUser', 'cls:...UserService', { complexity: { cyclomaticComplexity: 15, maxNestingDepth: 6 } }),
      mtd('mtd:...UserService.listUsers', 'listUsers', 'cls:...UserService', { complexity: { cyclomaticComplexity: 6, maxNestingDepth: 2 } }),
      mtd('mtd:...UserService.saveUser', 'saveUser', 'cls:...UserService', { complexity: { cyclomaticComplexity: 3, maxNestingDepth: 1 } }),
      mtd('mtd:...UserRepository.findByName', 'findByName', 'cls:...UserRepository', { complexity: { cyclomaticComplexity: 2, maxNestingDepth: 1 } }),
      mtd('mtd:...Helper.parseComplex', 'parseComplex', 'cls:...Helper', { complexity: { cyclomaticComplexity: 20, maxNestingDepth: 8, branchCount: 12, loopCount: 4 } }),
      mtd('mtd:...Helper.parseTest', 'parseTest', 'cls:...Helper', { isTest: true, testType: 'UnitTest', complexity: { cyclomaticComplexity: 2 } }),
      mtd('mtd:...Helper.integrationSetup', 'integrationSetup', 'cls:...Helper', { isTest: true, testType: 'IntegrationTest', complexity: { cyclomaticComplexity: 2 } }),
    ],
    Dependency: [
      { id: 'dep:jpa', name: 'org.springframework.boot:spring-boot-starter-data-jpa', version: '3.2.0', scope: 'compile', source: 'maven' },
      { id: 'dep:web', name: 'org.springframework.boot:spring-boot-starter-web', version: '', scope: 'compile', source: 'maven' },
      { id: 'dep:redis', name: 'org.springframework.boot:spring-boot-starter-data-redis', version: '', scope: 'compile', source: 'maven' },
      { id: 'dep:es', name: 'org.springframework.boot:spring-boot-starter-data-elasticsearch', version: '', scope: 'compile', source: 'maven' },
      { id: 'dep:mysql', name: 'com.mysql:mysql-connector-j', version: '8.0.33', scope: 'runtime', source: 'maven' },
      { id: 'dep:minio', name: 'io.minio:minio', version: '8.5.0', scope: 'compile', source: 'maven' },
      { id: 'dep:jjwt', name: 'io.jsonwebtoken:jjwt-api', version: '0.12.3', scope: 'compile', source: 'maven' },
      { id: 'dep:springdoc', name: 'org.springdoc:springdoc-openapi-starter-webmvc-ui', version: '', scope: 'compile', source: 'maven' },
    ],
    Table: [
      { id: 'table:users', name: 'users', schema: null, comment: '用户表', engine: 'INNODB', charset: 'utf8mb4', primaryKey: 'id', columns: [{ name: 'id' }, { name: 'org_id' }], sourceFile: 'V1.sql', matchedEntityClass: 'User', fkDetails: [{ columnName: 'org_id', refTable: 'orgs', refColumn: 'id', fkName: 'fk_users_org' }] },
      { id: 'table:orders', name: 'orders', schema: null, comment: '', engine: 'INNODB', charset: 'utf8mb4', primaryKey: 'id', columns: [{ name: 'id' }, { name: 'user_id' }], sourceFile: 'V1.sql', matchedEntityClass: '', fkDetails: [{ columnName: 'user_id', refTable: 'users', refColumn: 'id', fkName: 'fk_orders_user' }] },
      { id: 'table:audit_logs', name: 'audit_logs', schema: null, comment: '', engine: 'INNODB', charset: 'utf8mb4', primaryKey: 'id', columns: [{ name: 'id' }], sourceFile: 'V1.sql', matchedEntityClass: '', fkDetails: [] },
    ],
    Mapper: [],
  };
}

test('模块推导：动态派生模块（core/adapter/portal/com），无硬编码', () => {
  const snapshot = buildFixtureSnapshot();
  const rules = deriveModuleRules(snapshot.Package.map((p) => p.name));
  const keys = rules.map((r) => r.key);
  assert.ok(keys.includes('core'), `应推导出 core，实际 ${keys}`);
  assert.ok(keys.includes('adapter'));
  assert.ok(keys.includes('portal'));
  assert.ok(keys.includes('com'), '未落入基础包的包应分叉推导');
  const core = rules.find((r) => r.key === 'core');
  assert.deepEqual(core.prefixes, ['ai.asdm.admin.core']);
});

test('单模块仓库坍缩：全部分层关键词 → 基础包末段为唯一模块', () => {
  const rules = deriveModuleRules([
    'com.example.app.controller', 'com.example.app.service',
    'com.example.app.repository', 'com.example.app.entity',
  ]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].key, 'app');
  assert.deepEqual(rules[0].prefixes, ['com.example.app']);
});

test('构建聚合：stats 统计（类/枚举/接口/方法/端点/测试/表/分析错误）', () => {
  const model = buildServiceModel(buildFixtureSnapshot());
  const s = model.stats;
  assert.equal(s.fileCount, 20);
  assert.equal(s.packageCount, 10);
  assert.equal(s.classCount, 7, 'Status 为枚举，不计入 classCount');
  assert.equal(s.enumCount, 1);
  assert.equal(s.interfaceCount, 1);
  assert.equal(s.methodCount, 10);
  assert.equal(s.endpointCount, 2);
  assert.equal(s.testMethodCount, 2);
  assert.equal(s.tableCount, 3);
  assert.equal(s.analysisErrorCount, 0);
  assert.equal(s.moduleCount, 4);
  assert.ok(Number.isFinite(s.avgCyclomatic), 'avgCyclomatic 应为数值');
});

test('模块聚合：core 含 7 类 + 接口，责任描述含分层占比', () => {
  const model = buildServiceModel(buildFixtureSnapshot());
  const core = model.modules.find((m) => m.key === 'core');
  assert.ok(core, 'core 模块应存在');
  assert.equal(core.classCount, 7);
  assert.equal(core.interfaceCount, 1);
  assert.equal(core.endpointCount, 2);
  assert.equal(core.packageCount, 7);
  assert.ok(core.responsibility.includes('API 接口'), `responsibility 应含 API 接口，实际 ${core.responsibility}`);
});

test('分层聚合：注解/类名/包名关键词判定分层', () => {
  const model = buildServiceModel(buildFixtureSnapshot());
  const byKey = Object.fromEntries(model.layers.map((l) => [l.key, l]));
  assert.equal(byKey.controller.classCount, 1);
  assert.equal(byKey.service.classCount, 1);
  assert.equal(byKey.repository.classCount, 1);
  assert.equal(byKey.entity.classCount, 1);
  assert.equal(byKey.dto.classCount, 1);
  assert.equal(byKey.config.classCount, 1);
  assert.equal(byKey.util.classCount, 1);
  assert.equal(byKey.other.classCount, 1, 'Status（无分层信号）应归 other');
});

test('技术栈检测：spring-boot-starter-data-jpa 优先归类 JPA，具体 starter 不被 spring-boot 泛型吞掉', () => {
  const model = buildServiceModel(buildFixtureSnapshot());
  const ts = Object.fromEntries(model.techStack.map((t) => [t.key, t]));
  assert.ok(ts.jpa, 'JPA 应被检测');
  assert.equal(ts.jpa.label, 'JPA (Hibernate)');
  assert.ok(ts.redis, 'Redis 应被检测');
  assert.ok(ts.elasticsearch, 'Elasticsearch 应被检测');
  assert.ok(ts.mysql, 'MySQL 驱动应被检测');
  assert.ok(ts.minio, 'MinIO 应被检测');
  assert.ok(ts.jjwt, 'JJWT 应被检测');
  assert.ok(ts.springdoc, 'SpringDoc 应被检测');
  assert.ok(ts['spring-boot'], 'spring-boot-starter-web 应归 Spring Boot 泛型');
  // jpa 依赖应归 jpa 而非 spring-boot
  const jpaDep = model.dependencies.find((d) => d.name.includes('data-jpa'));
  assert.equal(jpaDep.category, 'jpa');
  const webDep = model.dependencies.find((d) => d.name.includes('starter-web'));
  assert.equal(webDep.category, 'spring-boot');
});

test('端点聚合：endpointByMethod + 领域前缀提取', () => {
  const model = buildServiceModel(buildFixtureSnapshot());
  assert.deepEqual(model.stats.endpointByMethod, { GET: 1, POST: 1 });
  const get = model.endpoints.find((e) => e.httpMethod === 'GET');
  assert.equal(get.path, '/api/v1/users');
  assert.equal(get.domainPrefix, 'users', '应跳过 /api/v1 取领域段');
  assert.equal(get.className, 'UserController');
});

test('表聚合：实体映射表 / FK 表 / 孤儿表（无实体且无 FK）', () => {
  const model = buildServiceModel(buildFixtureSnapshot());
  assert.equal(model.tables.length, 3);
  assert.equal(model.tables.filter((t) => t.isOrphan).length, 1);
  const audit = model.tables.find((t) => t.name === 'audit_logs');
  assert.equal(audit.isOrphan, true);
  assert.equal(audit.orphanReason, 'no_entity_no_fk');
  assert.equal(model.foreignKeys.length, 2);
  assert.ok(model.fkChains.some((c) => c.startTable === 'orders'), 'orders → users 应构成 FK 链');
});

test('复杂度热点：按圈复杂度降序，TOP 含 cc=20 与 cc=15', () => {
  const model = buildServiceModel(buildFixtureSnapshot());
  assert.equal(model.complexityHotspots.length, 2);
  assert.equal(model.complexityHotspots[0].cyclomaticComplexity, 20);
  assert.equal(model.complexityHotspots[0].location, 'Helper#parseComplex');
  assert.equal(model.complexityHotspots[1].cyclomaticComplexity, 15);
});

test('测试统计：单元/集成测试计数 + 按类聚合', () => {
  const model = buildServiceModel(buildFixtureSnapshot());
  assert.equal(model.testStats.total, 2);
  assert.equal(model.testStats.unitTest, 1);
  assert.equal(model.testStats.integrationTest, 1);
  const helper = model.testStats.byClass.find((c) => c.className === 'Helper');
  assert.equal(helper.unitTest, 1);
  assert.equal(helper.integrationTest, 1);
});

test('自定义模块规则：--module-prefix 覆盖动态推导', () => {
  const snapshot = buildFixtureSnapshot();
  const model = buildServiceModel(snapshot, {
    modulePrefixes: [{ key: 'core', label: '核心', prefixes: ['ai.asdm.admin.core'] }, { key: 'rest', label: '其余', prefixes: ['ai.asdm', 'com.example'] }],
  });
  assert.equal(model._meta.modulePrefixSource, 'cli');
  assert.ok(model.modules.find((m) => m.key === 'core'));
  assert.ok(model.modules.find((m) => m.key === 'rest'));
  const status = model.classes.find((c) => c.name === 'Status');
  assert.equal(status.moduleKey, 'rest', 'com.example.unknown 应归 rest');
});

test('图谱数据：模块依赖边（包 dependsOnPackageIds 聚合）与分层调用流（跨层方法调用）', () => {
  const model = buildServiceModel(buildFixtureSnapshot());
  const g = model.moduleGraph;
  assert.ok(g, 'moduleGraph 应存在');

  // 模块图谱：adapter.ads 包依赖 core.service / core.entity → 边 adapter→core（权重 2）
  const moduleNodes = new Set(g.moduleView.nodes.map((n) => n.key));
  assert.ok(moduleNodes.has('core') && moduleNodes.has('adapter'), '模块图谱节点应含 core/adapter');
  const mEdge = g.moduleView.edges.find((e) => e.source === 'module:adapter' && e.target === 'module:core');
  assert.ok(mEdge, '应有 adapter→core 模块依赖边');
  assert.equal(mEdge.weight, 2);

  // 分层调用流：createUser（controller 层）调用 saveUser（service 层）→ 边 controller→service
  const lEdge = g.layerView.edges.find((e) => e.source === 'layer:controller' && e.target === 'layer:service');
  assert.ok(lEdge, '应有 controller→service 分层调用边');
  assert.ok(lEdge.weight >= 1);
  const layerNodes = new Set(g.layerView.nodes.map((n) => n.key));
  assert.ok(layerNodes.has('controller') && layerNodes.has('service'));
  // 自环（同层调用）应被排除
  assert.ok(!g.layerView.edges.some((e) => e.source === e.target), '图谱不应有自环边');

  // 模块×技术栈：core.service 包使用 dep:jpa / dep:redis → 边 core→jpa / core→redis
  assert.ok(g.techView, 'techView 应存在');
  const tEdge = g.techView.edges.find((e) => e.source === 'module:core' && e.target === 'tech:jpa');
  assert.ok(tEdge, '应有 core→JPA 技术边');
  assert.ok(g.techView.nodes.some((n) => n.id === 'tech:jpa'), '技术栈节点应含 jpa');
  assert.ok(g.techView.nodes.some((n) => n.id === 'module:core'), '技术栈节点应含 core');
});

test('分层修复：domain 包类归实体层（MyBatis POJO），Mapper/Repository 接口归对应分层', () => {
  const snapshot = {
    Repository: [{ id: 'repo:t', name: 't', path: '/x', language: 'Java', commitHash: '', branch: '', fileCount: 5, analysisErrors: [] }],
    Package: [
      { id: 'p1', name: 'com.leaniss.system.domain', fullPath: 'com/leaniss/system/domain', visibility: 'public', classCount: 0, repoId: 'repo:t', dependsOnPackageIds: [], dependencyIds: [] },
      { id: 'p2', name: 'com.leaniss.system.mapper', fullPath: 'com/leaniss/system/mapper', visibility: 'public', classCount: 0, repoId: 'repo:t', dependsOnPackageIds: [], dependencyIds: [] },
    ],
    Class: [
      { id: 'c1', name: 'SysUser', type: 'class', visibility: 'public', modifiers: ['public'], lineCount: 5, packageId: 'p1', extendsClassIds: [], implementsInterfaceIds: [], description: '', isDataModel: true, dataModelType: 'MyBatis POJO', tableName: 'sys_user', entityName: '' },
    ],
    Interface: [
      { id: 'i1', name: 'SysUserMapper', visibility: 'public', modifiers: [], lineCount: 3, methodSignatures: ['selectList'], packageId: 'p2', extendsInterfaceIds: [], description: '' },
    ],
    Method: [], Dependency: [], Table: [], Mapper: [],
  };
  const model = buildServiceModel(snapshot);
  const byKey = Object.fromEntries(model.layers.map((l) => [l.key, l]));
  assert.equal(byKey.entity.classCount, 1, 'domain 包中的 MyBatis POJO 应归实体层');
  assert.equal(byKey.mapper.interfaceCount, 1, 'SysUserMapper 接口应归 Mapper 层');
  // domain 包类不应再落入 util
  assert.ok(!byKey.util || byKey.util.classCount === 0, 'domain 包类不应归 util 层');
});

test('_meta：repositoryName / modulePrefixSource / durationMs', () => {
  const model = buildServiceModel(buildFixtureSnapshot());
  assert.equal(model._meta.repositoryName, 'test-app');
  assert.equal(model._meta.modulePrefixSource, 'derived');
  assert.ok(Number.isFinite(model._meta.durationMs));
  assert.equal(model._meta.version, '1.0');
  assert.equal(model._meta.subsystem, 'service');
});

test('仓库级 classCount 与 stats.classCount 同口径（不含枚举）', () => {
  const model = buildServiceModel(buildFixtureSnapshot());
  assert.equal(model.repositories[0].classCount, model.stats.classCount);
  assert.equal(model.repositories[0].classCount, 7, 'Status 枚举不计入仓库类数');
});

test('模块配置跨仓库防串用：repositoryName 不符时忽略配置并重新推导', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-svc-'));
  try {
    const snapshotFile = path.join(dir, 'snapshot.json');
    fs.writeFileSync(snapshotFile, JSON.stringify(buildFixtureSnapshot()));
    const configFile = path.join(dir, 'service-modules.json');
    fs.writeFileSync(configFile, JSON.stringify({
      version: '1.0',
      repositoryName: 'other-repo',
      rules: [{ key: 'wrong', label: '旧项目规则', prefixes: ['com.wrong.prefix'] }],
    }));
    const model = buildServiceModelFromFile(snapshotFile, { moduleConfigPath: configFile });
    assert.equal(model._meta.modulePrefixSource, 'derived', '旧仓库配置应被忽略');
    assert.ok(model._meta.moduleConfigWarning, '应携带跨仓库警告');
    assert.ok(model.modules.some((m) => m.key === 'core'), '应回到动态推导的 core');
    // 落盘的配置应被推导结果覆盖，并改写为当前仓库名
    const persisted = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    assert.equal(persisted.repositoryName, 'test-app');
    assert.ok(persisted.rules.some((r) => r.key === 'core'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('模块配置同仓库正常加载且无警告', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-svc-'));
  try {
    const snapshotFile = path.join(dir, 'snapshot.json');
    fs.writeFileSync(snapshotFile, JSON.stringify(buildFixtureSnapshot()));
    const configFile = path.join(dir, 'service-modules.json');
    fs.writeFileSync(configFile, JSON.stringify({
      version: '1.0',
      repositoryName: 'test-app',
      rules: [{ key: 'custom', label: '自定义', prefixes: ['ai.asdm.admin.core'] }],
    }));
    const model = buildServiceModelFromFile(snapshotFile, { moduleConfigPath: configFile });
    assert.equal(model._meta.modulePrefixSource, 'config');
    assert.ok(!model._meta.moduleConfigWarning);
    assert.ok(model.modules.some((m) => m.key === 'custom'), '同仓库配置应生效');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
