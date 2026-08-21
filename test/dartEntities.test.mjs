// Dart/Flutter 实体测试：dartAnalyzer 事实提取（Widget/Store/GoRoute/调用链）、
// Flutter 框架识别（pubspec.yaml + lib/）、实体入快照（Component/Store/Route/Method 调用链）、
// 蓝图视图模型（dart 语言分布 + 方法调用链展示）与 Markdown 导出
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeDartFile, isDartCandidate } from '../src/analyzers/dartAnalyzer.js';
import { scanProject } from '../src/analyzers/projectScanner.js';
import { buildOntologyData } from '../src/ontology/builder.js';
import { buildViewerModel } from '../src/ontology/viewer.js';
import { exportToMarkdown } from '../src/ontology/exporter.js';

// ---- 单元级：dartAnalyzer 事实提取 ----

test('dartAnalyzer：StatelessWidget 类 → Component（isWidget/widgetBase/primary）', () => {
  const content = [
    "import 'package:flutter/material.dart';",
    '',
    '/// 首页',
    'class HomePage extends StatelessWidget {',
    '  const HomePage({super.key});',
    '',
    '  @override',
    '  Widget build(BuildContext context) {',
    '    return const Scaffold(body: Text("home"));',
    '  }',
    '}',
  ].join('\n');
  const facts = analyzeDartFile('lib/pages/home_page.dart', content);
  assert.equal(facts.isDart, true);
  assert.equal(facts.classes.length, 1);
  const cls = facts.classes[0];
  assert.equal(cls.name, 'HomePage');
  assert.equal(cls.language, 'dart');
  assert.equal(cls.isWidget, true);
  assert.equal(cls.widgetBase, 'StatelessWidget');
  assert.equal(cls.kind, 'class');
  // @override 注解不得吞掉 build 方法（回归：注解行破坏行首分类）
  assert.deepEqual(cls.methods.map((m) => m.name), ['build']);
  assert.equal(cls.methods[0].isOverride, true);
  // Widget → Component + dartdoc 描述
  assert.equal(facts.components.length, 1);
  assert.equal(facts.components[0].name, 'HomePage');
  assert.equal(facts.components[0].kind, 'page');
  assert.equal(facts.components[0].description, '首页');
  assert.equal(facts.primaryComponentName, 'HomePage');
});

test('dartAnalyzer：abstract class → Interface；class implements → implementsNames', () => {
  const content = [
    'abstract class GameRepository {',
    '  List<String> fetchAll();',
    '}',
    '',
    'class SteamGameRepository implements GameRepository {',
    '  @override',
    '  List<String> fetchAll() {',
    '    return _load();',
    '  }',
    '',
    '  List<String> _load() => const [];',
    '}',
  ].join('\n');
  const facts = analyzeDartFile('lib/models/game_repository.dart', content);
  const iface = facts.interfaces.find((i) => i.name === 'GameRepository');
  assert.ok(iface, 'abstract class 应映射为 Interface');
  assert.equal(iface.language, 'dart');
  assert.deepEqual(iface.methods.map((m) => m.name), ['fetchAll']);
  const impl = facts.classes.find((c) => c.name === 'SteamGameRepository');
  assert.deepEqual(impl.implementsNames, ['GameRepository']);
  assert.deepEqual(impl.methods.map((m) => m.name), ['fetchAll', '_load']);
});

test('dartAnalyzer：ChangeNotifier 子类 → Store（stateKeys/actionKeys）', () => {
  const content = [
    "import 'package:flutter/foundation.dart';",
    '',
    'class SettingsStore extends ChangeNotifier {',
    "  String _theme = 'light';",
    '  bool _enabled = false;',
    '',
    '  String get theme => _theme;',
    '',
    '  void toggle() {',
    '    _enabled = !_enabled;',
    '    notifyListeners();',
    '  }',
    '}',
  ].join('\n');
  const facts = analyzeDartFile('lib/stores/settings_store.dart', content);
  const cls = facts.classes[0];
  assert.equal(cls.isStore, true);
  assert.equal(facts.stores.length, 1);
  const store = facts.stores[0];
  assert.equal(store.name, 'SettingsStore');
  assert.deepEqual(store.stateKeys, ['_theme', '_enabled']);
  assert.deepEqual(store.actionKeys, ['toggle']);
});

test('dartAnalyzer：Riverpod Provider 变量 → Store（providerType/notifierClass）', () => {
  const content = [
    "import 'package:flutter_riverpod/flutter_riverpod.dart';",
    '',
    'class SettingsState {',
    "  SettingsState({this.theme = 'light'});",
    '  final String theme;',
    '}',
    '',
    'class SettingsNotifier extends Notifier<SettingsState> {',
    '  @override',
    '  SettingsState build() => SettingsState();',
    '',
    '  void setTheme(String t) => state = SettingsState(theme: t);',
    '}',
    '',
    'final settingsProvider = NotifierProvider<SettingsNotifier, SettingsState>.new(SettingsNotifier.new);',
  ].join('\n');
  const facts = analyzeDartFile('lib/stores/settings_provider.dart', content);
  const providerStore = facts.stores.find((s) => s.name === 'settingsProvider');
  assert.ok(providerStore, 'Riverpod Provider 变量应映射为 Store');
  assert.equal(providerStore.providerType, 'NotifierProvider');
  assert.equal(providerStore.notifierClass, 'SettingsNotifier');
  // Notifier 子类本身也是 Store（baseClass 以 Notifier 开头）
  const notifierCls = facts.classes.find((c) => c.name === 'SettingsNotifier');
  assert.equal(notifierCls.isStore, true);
  assert.equal(facts.stores.some((s) => s.name === 'SettingsNotifier'), true);
});

test('dartAnalyzer：GoRoute 提取 + 路由常量回填 + context.push 导航', () => {
  const content = [
    "import 'package:go_router/go_router.dart';",
    "import 'pages/home_page.dart';",
    "import 'pages/more_page.dart';",
    '',
    'class AppRoutes {',
    "  static const home = '/home';",
    "  static const more = '/more';",
    '}',
    '',
    'void goMore(BuildContext context) {',
    '  context.push(AppRoutes.more);', // 常量引用参数（非字符串字面量）
    '}',
    '',
    'final router = GoRouter(',
    '  routes: [',
    '    GoRoute(path: AppRoutes.home, builder: (context, state) => const HomePage()),',
    "    GoRoute(path: AppRoutes.more, name: 'more', builder: (context, state) => const MorePage())",
    '  ],',
    ');',
  ].join('\n');
  const facts = analyzeDartFile('lib/main.dart', content);
  assert.equal(facts.dartRoutes.length, 2);
  // AppRoutes.home 常量引用回填为 '/home'
  const home = facts.dartRoutes.find((r) => r.path === '/home');
  assert.ok(home);
  assert.equal(home.builderWidget, 'HomePage');
  const more = facts.dartRoutes.find((r) => r.path === '/more');
  assert.equal(more.name, 'more');
  assert.equal(more.builderWidget, 'MorePage');
  // context.push(AppRoutes.more) 常量引用 → overlayOpens（builder 侧用全仓库常量表回填）
  assert.equal(facts.overlayOpens.length, 1);
  assert.equal(facts.overlayOpens[0].target, 'AppRoutes.more');
});

test('dartAnalyzer：import 解析（package:/相对路径/别名）与调用链分类', () => {
  const content = [
    "import 'package:flutter/material.dart';",
    "import '../widgets/game_card.dart' show GameCard;",
    "import '../models/game_source.dart' as src;",
    '',
    'class HomePage extends StatelessWidget {',
    '  @override',
    '  Widget build(BuildContext context) {',
    "    return GameCard(title: src.GameSource.title, onTap: () => context.push('/more'));",
    '  }',
    '}',
    '',
    'List<String> topLevelHelper() {',
    '  return HomePage.helper();',
    '}',
  ].join('\n');
  const facts = analyzeDartFile('lib/pages/home_page.dart', content);
  assert.equal(facts.importMap.get('GameCard'), '../widgets/game_card.dart');
  assert.equal(facts.importMap.get('src'), '../models/game_source.dart');
  assert.equal(facts.imports.length, 3);
  // build 内调用：GameCard → widget；context.push('/more') → nav
  const buildEdge = facts.callEdges.find((e) => e.from === 'HomePage.build');
  assert.ok(buildEdge);
  assert.ok(buildEdge.to.some((c) => c.kind === 'widget' && c.to === 'GameCard'));
  assert.ok(buildEdge.to.some((c) => c.kind === 'nav' && c.navPath === '/more'));
  // 导航调用 → overlayOpens
  assert.equal(facts.overlayOpens.length, 1);
  assert.equal(facts.overlayOpens[0].target, '/more');
  // 顶层函数 → moduleFunctions + callEdges（from 不含类前缀）
  assert.deepEqual(facts.moduleFunctions.map((f) => f.name), ['topLevelHelper']);
  assert.ok(facts.callEdges.some((e) => e.from === 'topLevelHelper'));
});

test('isDartCandidate：.dart 后缀判定', () => {
  assert.equal(isDartCandidate('lib/main.dart'), true);
  assert.equal(isDartCandidate('lib/main.ts'), false);
});

// ---- 端到端：Flutter 项目 fixture（pubspec.yaml + lib/）----

const MAIN_DART = [
  "import 'package:flutter/material.dart';",
  "import 'package:go_router/go_router.dart';",
  "import 'pages/home_page.dart';",
  "import 'pages/more_page.dart';",
  '',
  'class AppRoutes {',
  "  static const home = '/home';",
  "  static const more = '/more';",
  '}',
  '',
  'final router = GoRouter(',
  '  routes: [',
  '    GoRoute(path: AppRoutes.home, builder: (context, state) => const HomePage()),',
  '    GoRoute(path: AppRoutes.more, builder: (context, state) => const MorePage()),',
  '  ],',
  ');',
].join('\n');

const HOME_PAGE_DART = [
  "import 'package:flutter/material.dart';",
  "import 'package:go_router/go_router.dart';",
  "import '../widgets/game_card.dart';",
  '',
  'class HomePage extends StatelessWidget {',
  '  const HomePage({super.key});',
  '',
  '  @override',
  '  Widget build(BuildContext context) {',
  '    return Scaffold(',
  '      body: Column(',
  '        children: [',
  "          GameCard(title: 'Portal 2'),",
  "          TextButton(onPressed: () => context.push('/more'), child: const Text('go')),",
  '        ],',
  '      ),',
  '    );',
  '  }',
  '}',
].join('\n');

const MORE_PAGE_DART = [
  "import 'package:flutter/material.dart';",
  "import 'package:go_router/go_router.dart';",
  "import '../main.dart' show AppRoutes;",
  '',
  'class MorePage extends StatefulWidget {',
  '  const MorePage({super.key});',
  '',
  '  @override',
  '  State<MorePage> createState() => _MorePageState();',
  '}',
  '',
  'class _MorePageState extends State<MorePage> {',
  '  @override',
  '  Widget build(BuildContext context) {',
  '    return Scaffold(body: TextButton(',
  '      onPressed: () => context.push(AppRoutes.home),', // 常量引用（跨文件回填）
  "      child: const Text('back'),",
  '    ));',
  '  }',
  '}',
].join('\n');

const GAME_CARD_DART = [
  "import 'package:flutter/material.dart';",
  '',
  'class GameCard extends StatelessWidget {',
  '  const GameCard({super.key, required this.title});',
  '  final String title;',
  '',
  '  @override',
  '  Widget build(BuildContext context) {',
  '    return Card(child: Text(title));',
  '  }',
  '}',
].join('\n');

const GAME_REPOSITORY_DART = [
  "import 'game_source.dart';",
  '',
  'abstract class GameRepository {',
  '  List<String> fetchAll();',
  '}',
  '',
  'class SteamGameRepository implements GameRepository {',
  '  final GameSource _source = GameSource();',
  '',
  '  @override',
  '  List<String> fetchAll() {',
  '    return _load();',
  '  }',
  '',
  '  List<String> _load() {',
  '    return _source.read();',
  '  }',
  '}',
].join('\n');

const GAME_SOURCE_DART = [
  'class GameSource {',
  "  static String get title => 'steam';",
  "  List<String> read() => const ['Portal 2'];",
  '}',
].join('\n');

const SETTINGS_STORE_DART = [
  "import 'package:flutter/foundation.dart';",
  "import 'package:flutter_riverpod/flutter_riverpod.dart';",
  '',
  'class SettingsState {',
  "  SettingsState({this.theme = 'light'});",
  '  final String theme;',
  '}',
  '',
  'class SettingsNotifier extends Notifier<SettingsState> {',
  '  @override',
  '  SettingsState build() => SettingsState();',
  '',
  '  void setTheme(String t) => state = SettingsState(theme: t);',
  '}',
  '',
  'final settingsProvider = NotifierProvider<SettingsNotifier, SettingsState>.new(SettingsNotifier.new);',
  '',
  'class SettingsStore extends ChangeNotifier {',
  "  String _theme = 'light';",
  '  bool _enabled = false;',
  '',
  '  void toggle() {',
  '    _enabled = !_enabled;',
  '    notifyListeners();',
  '  }',
  '}',
].join('\n');

async function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-dart-'));
  fs.mkdirSync(path.join(dir, 'lib/pages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib/widgets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib/models'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib/stores'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pubspec.yaml'), [
    'name: dart_demo',
    'environment:',
    "  sdk: '>=3.0.0 <4.0.0'",
    'dependencies:',
    '  flutter:',
    '    sdk: flutter',
    '  flutter_riverpod: ^2.4.0',
    '  go_router: ^13.0.0',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'lib/main.dart'), MAIN_DART);
  fs.writeFileSync(path.join(dir, 'lib/pages/home_page.dart'), HOME_PAGE_DART);
  fs.writeFileSync(path.join(dir, 'lib/pages/more_page.dart'), MORE_PAGE_DART);
  fs.writeFileSync(path.join(dir, 'lib/widgets/game_card.dart'), GAME_CARD_DART);
  fs.writeFileSync(path.join(dir, 'lib/models/game_repository.dart'), GAME_REPOSITORY_DART);
  fs.writeFileSync(path.join(dir, 'lib/models/game_source.dart'), GAME_SOURCE_DART);
  fs.writeFileSync(path.join(dir, 'lib/stores/settings_store.dart'), SETTINGS_STORE_DART);
  const dataMap = await buildOntologyData(dir);
  return { dir, dataMap };
}

test('扫描：pubspec.yaml + lib/ → Flutter 框架识别（.dart 纳入扫描）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-scan-dart-'));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pubspec.yaml'), ['name: demo', 'dependencies:', '  flutter:', '    sdk: flutter'].join('\n'));
  fs.writeFileSync(path.join(dir, 'lib/main.dart'), 'void main() {}\n');
  const scan = scanProject(dir);
  assert.ok(scan.files.includes('lib/main.dart'));
  assert.equal(scan.dartFileCount, 1);
  assert.equal(scan.flutterDetected, true);
  assert.equal(scan.framework, 'flutter');
  assert.ok(scan.frameworkLabel.includes('Flutter'));

  // 纯 Dart 项目（pubspec 无 flutter sdk 依赖）→ framework = dart
  const dartDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-scan-pure-dart-'));
  fs.mkdirSync(path.join(dartDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dartDir, 'pubspec.yaml'), 'name: pure_dart\ndependencies:\n  http: ^1.0.0\n');
  fs.writeFileSync(path.join(dartDir, 'lib/main.dart'), 'void main() {}\n');
  const dartScan = scanProject(dartDir);
  assert.equal(dartScan.flutterDetected, true);
  assert.equal(dartScan.framework, 'dart');
});

test('端到端：Flutter 实体入快照（Class/Component/Store/Route + 语言标注）', async () => {
  const { dataMap } = await buildFixture();
  // 项目画像
  const proj = dataMap.Project[0];
  assert.equal(proj.dartFileCount, 7);
  assert.equal(proj.flutterDetected, true);
  assert.equal(proj.framework, 'flutter');
  // Widget Class 透传 isWidget/widgetBase
  const homeCls = dataMap.Class.find((c) => c.name === 'HomePage');
  assert.ok(homeCls);
  assert.equal(homeCls.language, 'dart');
  assert.equal(homeCls.isWidget, true);
  assert.equal(homeCls.widgetBase, 'StatelessWidget');
  // abstract class → Interface；implements 解析
  const repo = dataMap.Interface.find((i) => i.name === 'GameRepository');
  assert.ok(repo);
  const steamRepo = dataMap.Class.find((c) => c.name === 'SteamGameRepository');
  assert.ok(steamRepo.implementsIds.includes(repo.id));
  // ChangeNotifier → Store
  const settingsStore = dataMap.Store.find((s) => s.name === 'SettingsStore');
  assert.ok(settingsStore);
  assert.deepEqual(settingsStore.stateKeys, ['_theme', '_enabled']);
  // Riverpod Provider 变量 → Store（providerType/notifierClass）
  const providerStore = dataMap.Store.find((s) => s.name === 'settingsProvider');
  assert.ok(providerStore);
  assert.equal(providerStore.providerType, 'NotifierProvider');
  assert.equal(providerStore.notifierClass, 'SettingsNotifier');
  // GoRoute → Route 实体（routeType: flutter + 组件关联）
  const homeRoute = dataMap.Route.find((r) => r.routePath === '/home');
  assert.ok(homeRoute);
  assert.equal(homeRoute.routeType, 'flutter');
  assert.equal(homeRoute.componentFileId, 'file:lib/pages/home_page.dart');
  // pubspec 依赖 → Dependency（pub 包）
  const riverpod = dataMap.Dependency.find((d) => d.name === 'flutter_riverpod');
  assert.ok(riverpod);
});

test('端到端：GoRouter 导航边 + 方法调用链（callIds/calledByIds/compCallIds）', async () => {
  const { dataMap } = await buildFixture();
  // HomePage.build 内 context.push('/more') → route:/home → route:/more
  const homeRoute = dataMap.Route.find((r) => r.routePath === '/home');
  const moreRoute = dataMap.Route.find((r) => r.routePath === '/more');
  assert.deepEqual(homeRoute.navigatesToIds, [moreRoute.id]);
  // MorePage.build 内 context.push(AppRoutes.home) 常量引用（跨文件常量表回填）→ route:/more → route:/home
  assert.deepEqual(moreRoute.navigatesToIds, [homeRoute.id]);
  // HomePage.build 构造 GameCard → compCallIds（Widget 渲染链）
  const build = dataMap.Method.find((m) => m.id === 'method:lib/pages/home_page.dart#HomePage#build');
  assert.ok(build, 'HomePage.build 方法实体应存在');
  const gameCardId = dataMap.Component.find((c) => c.name === 'GameCard').id;
  assert.ok(build.compCallIds.includes(gameCardId), 'build 的 compCallIds 应含 GameCard');
  // SteamGameRepository.fetchAll → _load：本类方法调用链（双向）
  const fetchAll = dataMap.Method.find((m) => m.id === 'method:lib/models/game_repository.dart#SteamGameRepository#fetchAll');
  const load = dataMap.Method.find((m) => m.id === 'method:lib/models/game_repository.dart#SteamGameRepository#_load');
  assert.deepEqual(fetchAll.callIds, [load.id]);
  assert.deepEqual(load.calledByIds, [fetchAll.id]);
});

test('端到端：蓝图视图模型（dart 语言分布 + 方法调用链展示）', async () => {
  const { dataMap } = await buildFixture();
  const model = buildViewerModel(dataMap);
  const E = model.entities;
  assert.ok(E, 'entities 视图模型应存在');
  // 语言分布：dart 实体并存
  const langs = Object.fromEntries(E.byLanguage.map((l) => [l.key, l.count]));
  assert.ok((langs.dart ?? 0) >= 5, `dart 实体数应 >= 5，实际 ${langs.dart}`);
  // 图节点：HomePage 携带方法调用链（calls 含 GameCard）
  const homeNode = E.graph.nodes.find((n) => n.name === 'HomePage');
  assert.ok(homeNode);
  assert.equal(homeNode.language, 'dart');
  const buildMethod = homeNode.methods.find((m) => m.name === 'build');
  assert.ok(buildMethod);
  assert.ok(buildMethod.calls.includes('GameCard'), '详情面板方法调用链应展示 → GameCard');
});

test('端到端：Markdown 导出含 Dart 统计与方法调用链段', async () => {
  const { dataMap } = await buildFixture();
  const md = exportToMarkdown(dataMap);
  assert.ok(md.includes('Dart 文件（Flutter）'), '概览表应含 Dart 文件数行');
  assert.ok(md.includes('Flutter GoRoute'), '路由地图标题应含 Flutter GoRoute');
  assert.ok(md.includes('Riverpod'), 'Store 一览标题应含 Riverpod');
  assert.ok(md.includes('方法调用链 Top 30'), '应导出方法调用链段');
  assert.ok(md.includes('HomePage'), '方法调用链段应含 HomePage.build');
  assert.ok(md.includes('GameCard'), '方法调用链段应含 Widget 渲染目标');
});
