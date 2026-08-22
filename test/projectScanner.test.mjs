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

// HTML 入口探测：Vite 多页应用 <script src="/src/xxx/main.tsx">，嵌套入口文件名启发式覆盖不到
test('HTML 入口探测：script src 根绝对路径引用的源文件记为入口', () => {
  const root = tmpProject();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'mpa-app',
      dependencies: { react: '18.0.0' },
    }));
    fs.writeFileSync(path.join(root, 'admin.html'), [
      '<!DOCTYPE html><html><body>',
      '<script type="module" src="/src/managed-agent/main.tsx"></script>',
      '</body></html>',
    ].join('\n'));
    fs.mkdirSync(path.join(root, 'src', 'managed-agent'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'managed-agent', 'main.tsx'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'managed-agent', 'unused.tsx'), 'export const y = 2;\n');

    const scan = scanProject(root);
    assert.deepEqual(scan.htmlEntryFiles, ['src/managed-agent/main.tsx']);
    // 相对路径引用与不存在文件不进入入口清单
    assert.ok(!scan.htmlEntryFiles.includes('src/managed-agent/unused.tsx'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 根目录识别优化：兄弟项目 / 上级 go.mod / 依赖并入防护 ----

// 融合仓库骨架：repo（git 根）+ web/（npm 子项目）+ server/（go 子项目）
function buildFusionRepo() {
  const repo = tmpProject();
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); // 仓库根标记（兄弟项目发现依据）
  fs.mkdirSync(path.join(repo, 'web/src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'server/api/v1'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'server/service'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'web/package.json'), JSON.stringify({
    name: 'gva-web',
    dependencies: { vue: '^3.2.0', pinia: '^2.0.0' },
  }));
  fs.writeFileSync(path.join(repo, 'web/src/main.js'), "import { createApp } from 'vue';\n");
  fs.writeFileSync(path.join(repo, 'server/go.mod'), 'module smartide-server\n\ngo 1.18\n\nrequire github.com/gin-gonic/gin v1.9.1\n');
  fs.writeFileSync(path.join(repo, 'server/api/v1/router.go'), 'package v1\n\nfunc Register() {}\n');
  fs.writeFileSync(path.join(repo, 'server/service/user.go'), 'package service\n\ntype UserService struct{}\n\nfunc (u *UserService) RegisterUser() {}\n');
  return repo;
}

test('根识别：定位子项目目录（web/）时发现兄弟项目（server/），依赖不并入', () => {
  const repo = buildFusionRepo();
  try {
    const scan = scanProject(path.join(repo, 'web'));
    assert.equal(scan.framework, 'vue');
    assert.deepEqual(scan.siblingProjects.map((s) => `${s.path}:${s.kind}`).sort(), ['server:go']);
    // 兄弟项目只报告不并入：gin 依赖不在 web 自身清单中
    assert.equal(scan.dependencies['github.com/gin-gonic/gin'], undefined);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('根识别：定位代码子目录（web/src）时同样发现兄弟项目', () => {
  const repo = buildFusionRepo();
  try {
    const scan = scanProject(path.join(repo, 'web', 'src'));
    assert.ok(scan.siblingProjects.some((s) => s.path === 'server' && s.kind === 'go'));
    // 宿主依赖（vue）来自 web/package.json（向上定位）
    assert.ok(scan.dependencies.vue);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('根识别：定位仓库根时不报告兄弟（子项目由 subProjects 报告），无 git 根的普通目录不吸附邻居', () => {
  const repo = buildFusionRepo();
  try {
    const atRoot = scanProject(repo);
    assert.deepEqual(atRoot.siblingProjects, []);
    assert.deepEqual(atRoot.subProjects.map((s) => s.path).sort(), ['server', 'web']);
    // 融合仓库根（git 根 + 子项目 ≤4）：web 依赖并入画像（framework 判定信号）
    assert.ok(atRoot.dependencies.vue);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
  // 普通目录（无 .git / 无根清单）下 5 个子项目：只报告，依赖不并入（代码集合目录防误吸附）
  const plain = tmpProject();
  try {
    for (let i = 0; i < 5; i += 1) {
      fs.mkdirSync(path.join(plain, `app${i}`, 'src'), { recursive: true });
      fs.writeFileSync(path.join(plain, `app${i}`, 'package.json'), JSON.stringify({
        name: `app${i}`,
        dependencies: { [`lib-${i}`]: '1.0.0' },
      }));
      fs.writeFileSync(path.join(plain, `app${i}`, 'src', 'main.js'), 'export const x = 1;\n');
    }
    const scan = scanProject(plain);
    assert.equal(scan.subProjects.length, 5);
    assert.equal(scan.dependencies['lib-0'], undefined, '代码集合目录不并入子项目依赖');
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('根识别：定位 Go module 子目录（server/api）时向上发现 go.mod（dir 含 ../）', () => {
  const repo = buildFusionRepo();
  try {
    const scan = scanProject(path.join(repo, 'server', 'api'));
    assert.equal(scan.framework, 'go', JSON.stringify(scan.framework));
    assert.equal(scan.goModule.name, 'smartide-server');
    assert.equal(scan.goModule.dir, '..', 'module 基准目录相对扫描根表达');
    assert.ok(scan.dependencies['github.com/gin-gonic/gin']);
    // 兄弟项目发现：server/api 的同级无清单，但仓库根下 web 被识别
    assert.ok(scan.siblingProjects.some((s) => s.path === 'web' && s.kind === 'npm'));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
