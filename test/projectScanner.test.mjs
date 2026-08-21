import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanProject } from '../src/analyzers/projectScanner.js';

// 框架识别与宿主项目定位测试：tmpdir 不在 home 下，天然隔离祖先 package.json 干扰
function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aos-scan-'));
}

test('扫描 src 子目录：向上定位宿主项目，识别 React + Capacitor（Vite）', () => {
  const root = tmpProject();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'nice-today-2.0',
      version: '2.36.0',
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0', '@capacitor/core': '^6.0.0' },
      devDependencies: { vite: '^5.0.0' },
    }));
    fs.writeFileSync(path.join(root, 'capacitor.config.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { paths: { '@/*': ['./src/*'] } },
    }));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'App.tsx'), 'export default function App() { return null; }\n');

    const scan = scanProject(path.join(root, 'src'));
    assert.equal(scan.framework, 'react');
    assert.deepEqual(scan.frameworkVariants, ['capacitor', 'vite']);
    assert.equal(scan.frameworkLabel, 'React 单页应用 + Capacitor 跨端（Vite 构建）');
    assert.equal(scan.name, 'nice-today-2.0', '项目名回退到宿主 package.json');
    assert.equal(scan.version, '2.36.0');
    assert.equal(scan.hostRoot, root, '宿主根为父目录');
    assert.ok(scan.hostConfigs.includes('capacitor.config.ts'));
    assert.ok(scan.hostConfigs.includes('vite.config.ts'));
    // 宿主依赖进入清单（react 不再被误判为未声明依赖）
    assert.ok(scan.dependencies.react);
    assert.ok(scan.dependencies['@capacitor/core']);
    // 宿主 tsconfig 别名重定基：宿主根的 "./src/*" → 扫描根的 "./*"
    assert.deepEqual(scan.tsconfigPaths, { '@/*': './*' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Expo 项目识别（deps.expo 优先于 react）', () => {
  const root = tmpProject();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'expo-app',
      dependencies: { expo: '~51.0.0', react: '18.2.0', 'react-native': '0.74.0' },
    }));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const x = 1;\n');
    const scan = scanProject(path.join(root, 'src'));
    assert.equal(scan.framework, 'expo');
    assert.equal(scan.frameworkLabel, 'React Native（Expo）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('React Native / Next / Nuxt 元框架识别', () => {
  const cases = [
    [{ 'react-native': '0.74.0', react: '18.0.0' }, 'react-native', 'React Native 应用'],
    [{ next: '14.0.0', react: '18.0.0' }, 'next', 'Next.js 应用'],
    [{ nuxt: '3.0.0', vue: '3.4.0' }, 'nuxt', 'Nuxt 应用'],
  ];
  for (const [deps, framework, label] of cases) {
    const root = tmpProject();
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 't', dependencies: deps }));
      const scan = scanProject(root);
      assert.equal(scan.framework, framework, JSON.stringify(deps));
      assert.equal(scan.frameworkLabel, label);
      assert.equal(scan.hostRoot, null, '扫描根自身有 package.json，无外部宿主');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('无任何 package.json：代码信号兜底（.vue → vue / .tsx → react）', () => {
  const vueRoot = tmpProject();
  try {
    fs.mkdirSync(path.join(vueRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(vueRoot, 'src', 'Comp.vue'), '<template><div/></template>\n');
    assert.equal(scanProject(vueRoot).framework, 'vue');
  } finally {
    fs.rmSync(vueRoot, { recursive: true, force: true });
  }
  const reactRoot = tmpProject();
  try {
    fs.mkdirSync(path.join(reactRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(reactRoot, 'src', 'App.tsx'), 'export default function App() { return null; }\n');
    assert.equal(scanProject(reactRoot).framework, 'react');
  } finally {
    fs.rmSync(reactRoot, { recursive: true, force: true });
  }
});

test('Expo 旁证：无框架依赖但 app.json 含 expo 键', () => {
  const root = tmpProject();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'no-deps' }));
    fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify({ expo: { name: 'App', slug: 'app' } }));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const x = 1;\n');
    const scan = scanProject(path.join(root, 'src'));
    assert.equal(scan.framework, 'expo');
    assert.ok(scan.hostConfigs.includes('app.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Electron 桌面端变体识别', () => {
  const root = tmpProject();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'desktop',
      dependencies: { react: '18.0.0' },
      devDependencies: { electron: '^30.0.0' },
    }));
    const scan = scanProject(root);
    assert.equal(scan.framework, 'react');
    assert.ok(scan.frameworkVariants.includes('electron'));
    assert.equal(scan.frameworkLabel, 'React 单页应用 + Electron 桌面端');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// solution 风格 tsconfig：根文件仅含 references，paths 在引用的子配置中（如 tsconfig.app.json）
test('solution 风格 tsconfig：合并 references 子配置的 paths 别名', () => {
  const root = tmpProject();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'mono-app',
      dependencies: { vue: '^3.4.0' },
    }));
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
      files: [],
      references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
    }));
    fs.writeFileSync(path.join(root, 'tsconfig.app.json'), JSON.stringify({
      compilerOptions: { paths: { '@/*': ['./src/*'], '#/*': ['./src/types/*'] } },
    }));
    fs.writeFileSync(path.join(root, 'tsconfig.node.json'), JSON.stringify({
      compilerOptions: { paths: { '@node/*': ['./scripts/*'] } },
    }));
    fs.mkdirSync(path.join(root, 'src', 'types'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'App.vue'), '<template><div/></template>\n');

    const scan = scanProject(path.join(root, 'src'));
    // 宿主 tsconfig 无自身 paths，从 references 合并；重定基到扫描根
    // @node/* 指向扫描根外的 scripts/，保留宿主根相对形态
    assert.deepEqual(scan.tsconfigPaths, { '@/*': './*', '#/*': './types/*', '@node/*': 'scripts/*' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
