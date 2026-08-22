// Flutter 原生路由测试：Map<String, WidgetBuilder> routes 表提取 + Navigator.pushNamed 导航边
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';
import { analyzeDartFile } from '../src/analyzers/dartAnalyzer.js';

function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-dart-native-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('dartAnalyzer：原生 routes Map 提取（箭头与块体 builder）', () => {
  const routerDart = [
    "import 'package:flutter/material.dart';",
    "import '../screen/home/home_page.dart';",
    "import '../screen/settings/settings_page.dart';",
    '',
    'final Map<String, WidgetBuilder> routes = {',
    "  '/': (context) => const HomePage(),",
    "  '/settings': (context) {",
    "    final args = ModalRoute.of(context)!.settings.arguments as dynamic;",
    '    return const SettingsPage();',
    '  },',
    '};',
  ].join('\n');
  const facts = analyzeDartFile('lib/config/router.dart', routerDart);
  const native = facts.dartRoutes.filter((r) => r.native);
  assert.equal(native.length, 2);
  const byPath = new Map(native.map((r) => [r.path, r]));
  assert.equal(byPath.get('/').builderWidget, 'HomePage');
  assert.equal(byPath.get('/settings').builderWidget, 'SettingsPage'); // 块体取 return 构造
});

test('dartAnalyzer：pushNamed 系列导航调用（of(context) 与静态两种形式）', () => {
  const homeDart = [
    "import 'package:flutter/material.dart';",
    '',
    'class HomePage extends StatelessWidget {',
    '  const HomePage({super.key});',
    '  @override',
    '  Widget build(BuildContext context) {',
    "    return TextButton(onPressed: () => Navigator.of(context).pushNamed('/settings'), child: const Text('a'));",
    '  }',
    '}',
  ].join('\n');
  const facts = analyzeDartFile('lib/screen/home/home_page.dart', homeDart);
  assert.ok(facts.overlayOpens.some((o) => o.target === '/settings'));

  const staticDart = [
    'void goHome(BuildContext context) {',
    "  Navigator.pushNamed(context, '/');",
    '}',
  ].join('\n');
  const staticFacts = analyzeDartFile('lib/util/nav.dart', staticDart);
  assert.ok(staticFacts.overlayOpens.some((o) => o.target === '/'));
});

test('flutter 原生路由：buildOntologyData 生成 Route 与 pushNamed 导航边', async () => {
  const dir = makeProject({
    'pubspec.yaml': [
      'name: keylol_demo',
      'environment:',
      "  sdk: '>=3.0.1 <4.0.0'",
      'dependencies:',
      '  flutter:',
      '    sdk: flutter',
    ].join('\n'),
    'lib/config/router.dart': [
      "import 'package:flutter/material.dart';",
      "import '../screen/home/home_page.dart';",
      "import '../screen/settings/settings_page.dart';",
      '',
      'final Map<String, WidgetBuilder> routes = {',
      "  '/': (context) => const HomePage(),",
      "  '/settings': (context) => const SettingsPage(),",
      '};',
    ].join('\n'),
    'lib/screen/home/home_page.dart': [
      "import 'package:flutter/material.dart';",
      '',
      'class HomePage extends StatelessWidget {',
      '  const HomePage({super.key});',
      '  @override',
      '  Widget build(BuildContext context) {',
      '    return TextButton(',
      "      onPressed: () => Navigator.of(context).pushNamed('/settings'),",
      "      child: const Text('settings'),",
      '    );',
      '  }',
      '}',
    ].join('\n'),
    'lib/screen/settings/settings_page.dart': [
      "import 'package:flutter/material.dart';",
      '',
      'class SettingsPage extends StatelessWidget {',
      '  const SettingsPage({super.key});',
      '  @override',
      '  Widget build(BuildContext context) => const Scaffold();',
      '}',
    ].join('\n'),
  });
  const data = await buildOntologyData(dir);
  const routes = data.Route;
  assert.equal(routes.length, 2);

  const home = routes.find((r) => r.routePath === '/');
  const settings = routes.find((r) => r.routePath === '/settings');
  assert.ok(home && settings);
  assert.equal(home.routeType, 'flutter');
  assert.equal(home.componentFileId, 'file:lib/screen/home/home_page.dart');
  assert.equal(settings.componentFileId, 'file:lib/screen/settings/settings_page.dart');

  // pushNamed 导航边：/ → /settings
  assert.deepEqual(home.navigatesToIds, [settings.id]);

  fs.rmSync(dir, { recursive: true, force: true });
});
