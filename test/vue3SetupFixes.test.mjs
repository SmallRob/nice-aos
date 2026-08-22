// Vue3 script setup / Pinia / unplugin / glob 场景修复回归测试（参考 snowy-admin-web 形态）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';
import { analyzeVueFile } from '../src/analyzers/vueAnalyzer.js';
import { analyzeFile } from '../src/analyzers/tsAnalyzer.js';

function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nice-aos-vue3-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('script setup：变量域收集与绑定来源分类（state/computed/store/handler/forward）', () => {
  const content = [
    '<template>',
    '  <UserCard :user="userStore.userInfo" :nickname="nickname" :list="menuList" :total="doubled" @save="handleSave" :size="600" />',
    '</template>',
    '<script setup name="Profile">',
    'const props = defineProps(["title"])',
    'const { nickname } = storeToRefs(useUserStore())',
    'const userStore = useUserStore()',
    'const menuList = ref([])',
    'const doubled = computed(() => menuList.value.length)',
    'function handleSave() {}',
    '</script>',
  ].join('\n');
  const facts = analyzeVueFile('src/views/profile.vue', content, '/proj');
  // setup name 属性优先于文件名
  assert.equal(facts.components[0].name, 'Profile');
  const props = facts.vuePropRenders[0].props;
  const byName = Object.fromEntries(props.map((p) => [p.name, p]));
  assert.equal(byName.user.source, 'store');
  assert.equal(byName.user.storeHook, 'useUserStore');
  assert.equal(byName.nickname.source, 'store');
  assert.equal(byName.nickname.storeHook, 'useUserStore');
  assert.equal(byName.list.source, 'state');
  assert.equal(byName.total.source, 'computed');
  assert.equal(byName['@save'].source, 'handler');
  assert.equal(byName.size.source, 'literal');
  // vueOptions 扩展：setup 键集进入类视图实体输入
  assert.ok(facts.vueOptions.dataKeys.includes('menuList'));
  assert.ok(facts.vueOptions.computedKeys.includes('doubled'));
  assert.ok(facts.vueOptions.methodKeys.includes('handleSave'));
  assert.ok(facts.vueOptions.storeKeys.some((k) => k.name === 'nickname' && k.module === 'useUserStore'));
});

test('script setup：snowy 形态 store hook（无 use 前缀 + storeToRefs 变量参数溯源）', () => {
  const content = [
    '<template>',
    '  <SideBar :unfold="moduleUnfoldOpen" :theme="store.themeColor" />',
    '</template>',
    '<script setup>',
    "import { globalStore } from '@/store'",
    "import { storeToRefs } from 'pinia'",
    'const store = globalStore()',
    'const { moduleUnfoldOpen, topHeaderThemeColorOpen } = storeToRefs(store)',
    '</script>',
  ].join('\n');
  const facts = analyzeVueFile('src/layout/moduleMenu.vue', content, '/proj');
  const props = facts.vuePropRenders[0].props;
  const byName = Object.fromEntries(props.map((p) => [p.name, p]));
  assert.equal(byName.unfold.source, 'store');
  assert.equal(byName.unfold.storeHook, 'globalStore');
  assert.equal(byName.theme.source, 'store');
  assert.equal(byName.theme.storeHook, 'globalStore');
  assert.ok(facts.vueOptions.storeKeys.some((k) => k.name === 'moduleUnfoldOpen' && k.module === 'globalStore'));
});

test('script setup：a- 前缀（Antdv）与 antd 标签不进传递链与组件标签集', () => {
  const content = [
    '<template>',
    '  <a-table :dataSource="rows" /><a-button @click="go" />',
    '  <BizCard :title="name" />',
    '</template>',
    '<script setup>',
    'const rows = ref([])',
    'const name = ref("x")',
    'function go() {}',
    '</script>',
  ].join('\n');
  const facts = analyzeVueFile('src/views/table.vue', content, '/proj');
  const tags = [...facts.jsxTags];
  assert.ok(!tags.includes('ATable'));
  assert.ok(!tags.includes('AButton'));
  assert.ok(tags.includes('BizCard'));
  const renders = facts.vuePropRenders.map((r) => r.tag);
  assert.deepEqual(renders, ['BizCard']);
});

test('vue-router 路由：顶层 const 懒加载包装的组件文件关联', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'vue3-app', dependencies: { vue: '^3.4.0', 'vue-router': '^4.3.0' } }),
    'src/router/clientRouter.js': [
      "const ClientLogin = () => import('@/views/auth/login.vue')",
      "const routes = [",
      "  { path: '/auth/login', component: ClientLogin, meta: { title: '登录' } },",
      "  { path: '/home', component: () => import('@/views/home.vue') }",
      "]",
      'export default routes',
    ].join('\n'),
    'src/views/auth/login.vue': '<template><div /></template>',
    'src/views/home.vue': '<template><div /></template>',
    'jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
  });
  const data = await buildOntologyData(dir);
  const byPath = new Map(data.Route.map((r) => [r.routePath, r]));
  assert.equal(byPath.get('/auth/login').componentFileId, 'file:src/views/auth/login.vue');
  assert.equal(byPath.get('/home').componentFileId, 'file:src/views/home.vue');
});

test('Pinia setup store：providerType=pinia 且 state/action 键提取', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'pinia-app', dependencies: { vue: '^3.4.0', pinia: '^2.1.0' } }),
    'src/store/user.js': [
      "import { defineStore } from 'pinia'",
      "export const useUserStore = defineStore('useUserStore', () => {",
      '  const userInfo = ref({})',
      '  const loadUser = async () => {}',
      '  return { userInfo, loadUser }',
      '})',
    ].join('\n'),
    'src/main.js': "import { createApp } from 'vue'",
  });
  const data = await buildOntologyData(dir);
  const store = data.Store.find((s) => s.name === 'useUserStore');
  assert.ok(store, 'Pinia store 应被提取');
  assert.equal(store.providerType, 'pinia');
  assert.ok(store.stateKeys.includes('userInfo'));
  assert.ok(store.actionKeys.includes('loadUser'));
});

test('zustand store：providerType=zustand', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'react-app', dependencies: { react: '^18.0.0', zustand: '^4.5.0' } }),
    'src/store/useCount.js': [
      "import { create } from 'zustand'",
      'export const useCount = create((set) => ({',
      '  count: 0,',
      '  inc: () => set((s) => ({ count: s.count + 1 })),',
      '}))',
    ].join('\n'),
  });
  const data = await buildOntologyData(dir);
  const store = data.Store.find((s) => s.name === 'useCount');
  assert.ok(store);
  assert.equal(store.providerType, 'zustand');
});

test('defineAsyncComponent：renders 关系与 Props 传递链', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'vue3-async', dependencies: { vue: '^3.4.0' } }),
    'src/views/wrap.vue': [
      '<template><PhoneForm :phone="phone" /></template>',
      '<script setup>',
      "const PhoneForm = defineAsyncComponent(() => import('./phoneForm.vue'))",
      "const phone = ref('')",
      '</script>',
    ].join('\n'),
    'src/views/phoneForm.vue': [
      '<template><input /></template>',
      '<script setup>',
      "defineProps(['phone'])",
      '</script>',
    ].join('\n'),
  });
  const data = await buildOntologyData(dir);
  const wrap = data.Component.find((c) => c.name === 'Wrap');
  const phone = data.Component.find((c) => c.name === 'PhoneForm');
  assert.ok(wrap && phone);
  assert.ok(wrap.rendersIds.includes(phone.id), 'defineAsyncComponent 包装组件应建立 renders 关系');
  const edge = data.PropEdge.find((e) => e.fromComponentId === wrap.id && e.toComponentId === phone.id);
  assert.ok(edge, '应建立 Props 传递边');
  assert.equal(edge.props[0].name, 'phone');
  assert.equal(edge.props[0].source, 'state');
});

test('import.meta.glob + unplugin-vue-components：动态注册文件豁免孤儿候选', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({
      name: 'vite-glob-app',
      dependencies: { vue: '^3.4.0' },
      devDependencies: { 'unplugin-vue-components': '^0.27.0' },
    }),
    'vite.config.mjs': [
      "import { resolve } from 'path'",
      "import Components from 'unplugin-vue-components/vite'",
      "export const r = (...args) => resolve(__dirname, '.', ...args)",
      'export default {',
      '  plugins: [',
      "    Components({ dirs: [r('src/components')] })",
      '  ]',
      '}',
    ].join('\n'),
    'src/store/menu.js': [
      "const modules = import.meta.glob([",
      "  '/src/views/**/**.vue',",
      "  '!/src/views/auth/login/**.vue'",
      '])',
      'export default modules',
    ].join('\n'),
    'src/config/iconSelect.js': [
      "const icons = import.meta.glob('../assets/icons/uiw/*.vue')",
      'export default icons',
    ].join('\n'),
    // glob 豁免：views 动态路由（含排除段）+ assets 图标
    'src/views/sys/user/index.vue': '<template><div /></template>',
    'src/views/auth/login/login.vue': '<template><div /></template>',
    'src/assets/icons/uiw/GiteeIcon.vue': '<template><i /></template>',
    // unplugin-vue-components 自动注册目录
    'src/components/XnPanel/index.vue': '<template><div /></template>',
    // 真孤儿：无人引用且不被任何机制覆盖
    'src/utils/deadCode.js': 'export const dead = 1',
  });
  const data = await buildOntologyData(dir);
  const orphans = data._meta.orphanCandidates;
  // glob 命中：views + uiw 图标豁免；排除段的 login 仍会被 views glob 排除 → 但有 fileBased 路由兜底，也不应孤儿
  assert.ok(!orphans.includes('src/views/sys/user/index.vue'), 'glob 注册的 views 文件不应为孤儿');
  assert.ok(!orphans.includes('src/assets/icons/uiw/GiteeIcon.vue'), '相对路径 glob 的图标文件不应为孤儿');
  assert.ok(!orphans.includes('src/components/XnPanel/index.vue'), 'unplugin 自动注册目录的组件不应为孤儿');
  assert.ok(orphans.includes('src/utils/deadCode.js'), '真实死代码应保留在孤儿候选');
});

test('import.meta.glob 模式采集（facts 级）', () => {
  const facts = analyzeFile('src/store/menu.js', [
    "const modules = import.meta.glob(['/src/views/**/**.vue', '!/src/views/auth/**.vue'])",
    'export default modules',
  ].join('\n'), '/proj');
  assert.equal(facts.globPatterns.length, 1);
  assert.deepEqual(facts.globPatterns[0].patterns, ['/src/views/**/**.vue', '!/src/views/auth/**.vue']);
});
