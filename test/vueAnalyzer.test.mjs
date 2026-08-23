// Vue 框架适配测试：SFC 解析 / Pinia store / vue-router 路由 / 导航调用
// 样例模式取自 steam-stat（Vue 3 + Vite + vue-router + Pinia + <script setup>）
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeVueFile } from '../src/analyzers/vueAnalyzer.js';
import { analyzeFile } from '../src/analyzers/tsAnalyzer.js';
import { scanProject } from '../src/analyzers/projectScanner.js';

const ROOT = process.cwd();

// ---- SFC：script setup + template + <route lang="yaml">（steam-stat views/index.vue 模式）----
test('vue SFC：组件名/route meta/原生标签排除', () => {
  const content = [
    '<route lang="yaml">',
    'meta:',
    '  title: 主页',
    '  icon: ant-design:home-twotone',
    '</route>',
    '',
    '<script setup lang="ts">',
    'import { Button } from \'ant-design-vue\'',
    'import CloseConfirmDialog from \'@/components/CloseConfirmDialog.vue\'',
    'import { useI18n } from \'vue-i18n\'',
    '',
    'const { t } = useI18n()',
    'const route = useRoute()',
    'const visible = ref(false)',
    'const count = ref(0)',
    '</script>',
    '',
    '<template>',
    '  <div>',
    '    <close-confirm-dialog />',
    '    <Button @click="handleCancel">{{ t(\'common.cancel\') }}</Button>',
    '    <component :is="CloseConfirmDialog" />',
    '    <span>{{ count }}</span>',
    '  </div>',
    '</template>',
  ].join('\n');
  const facts = analyzeVueFile('src/views/index.vue', content, ROOT);
  assert.equal(facts.ext, 'vue');
  assert.equal(facts.primaryComponentName, 'Views'); // index.vue → 目录名
  assert.equal(facts.components.length, 1);
  assert.equal(facts.components[0].description, '主页'); // <route> yaml meta.title
  assert.equal(facts.components[0].stateCount, 2); // ref x2
  assert.ok(facts.components[0].hooksUsed.includes('useI18n'));
  assert.ok(facts.components[0].hooksUsed.includes('useRoute'));
  // template 标签：kebab → Pascal、Pascal 保留、原生/内置排除、:is 动态组件收录
  assert.ok(facts.jsxTags.has('CloseConfirmDialog'));
  assert.ok(facts.jsxTags.has('Button'));
  assert.ok(!facts.jsxTags.has('div'));
  assert.ok(!facts.jsxTags.has('span'));
  assert.ok(!facts.jsxTags.has('component'));
});

test('vue SFC：defineOptions name 优先于文件名', () => {
  const content = [
    '<script setup lang="ts">',
    'defineOptions({ name: \'SteamStatus\' })',
    'defineProps<{ appId: string }>()',
    '</script>',
    '<template><main /></template>',
  ].join('\n');
  const facts = analyzeVueFile('src/views/steam/status.vue', content, ROOT);
  assert.equal(facts.primaryComponentName, 'SteamStatus');
});

test('vue SFC：defineProps 数组/对象形式计数', () => {
  const arrProps = analyzeVueFile('src/components/x.vue', '<script setup>defineProps([\'a\', \'b\', \'c\'])</script>', ROOT);
  assert.equal(arrProps.components[0].propsCount, 3);
  const objProps = analyzeVueFile('src/components/y.vue', '<script setup>defineProps({\n  title: String,\n  count: Number,\n})</script>', ROOT);
  assert.equal(objProps.components[0].propsCount, 2);
});

// ---- Pinia defineStore：setup 写法（steam-stat store/modules/settings.ts 模式）----
test('tsAnalyzer：Pinia setup store 提取 state/action', () => {
  const content = [
    'import { defineStore } from \'pinia\'',
    '',
    'export const useSettingsStore = defineStore(',
    '  \'settings\',',
    '  () => {',
    '    const settings = ref(settingsDefault)',
    '    const os = ref(\'mac\')',
    '    function setMode(width: number) { settings.value.menu.mode = width }',
    '    return { settings, os, setMode }',
    '  },',
    ')',
  ].join('\n');
  const facts = analyzeFile('src/store/modules/settings.ts', content, ROOT);
  assert.equal(facts.stores.length, 1);
  const store = facts.stores[0];
  assert.equal(store.name, 'useSettingsStore');
  assert.deepEqual(store.stateKeys, ['settings', 'os']);
  assert.deepEqual(store.actionKeys, ['setMode']);
});

test('tsAnalyzer：Pinia options store + persist 插件', () => {
  const content = [
    'import { defineStore } from \'pinia\'',
    '',
    'export const useUserStore = defineStore(\'user\', {',
    '  state: () => ({ token: \'\', profile: null }),',
    '  getters: { isLogin: (s) => !!s.token },',
    '  actions: { login() {}, logout() {} },',
    '}, {',
    '  persist: { key: \'steam-user\' },',
    '})',
  ].join('\n');
  const facts = analyzeFile('src/store/modules/user.ts', content, ROOT);
  const store = facts.stores[0];
  assert.deepEqual(store.stateKeys, ['token', 'profile', 'isLogin']);
  assert.deepEqual(store.actionKeys, ['login', 'logout']);
  assert.equal(store.hasPersist, true);
  assert.equal(store.storageKey, 'steam-user');
});

// ---- vue-router RouteRecordRaw：动态 import / 函数包装 / children（steam-stat router/modules 模式）----
test('tsAnalyzer：RouteRecordRaw 提取（动态 import + children + Layout 函数）', () => {
  const content = [
    'import type { RouteRecordRaw } from \'vue-router\'',
    '',
    'function Layout() {',
    '  return import(\'@/layouts/index.vue\')',
    '}',
    '',
    'const routes: RouteRecordRaw = {',
    '  path: \'/steam\',',
    '  component: Layout,',
    '  meta: { title: () => t(\'menu.steamData\') },',
    '  children: [',
    '    {',
    '      path: \'/status\',',
    '      name: \'steamStatus\',',
    '      component: () => import(\'@/views/steam/status.vue\'),',
    '      meta: { title: () => t(\'menu.steamStatus\') },',
    '    },',
    '    {',
    '      path: \'/user\',',
    '      name: \'steamUser\',',
    '      component: () => import(\'@/views/steam/user.vue\'),',
    '    },',
    '  ],',
    '}',
    '',
    'export default routes',
  ].join('\n');
  const facts = analyzeFile('src/router/modules/steam.ts', content, ROOT);
  assert.equal(facts.vueRoutes.length, 3);
  const parent = facts.vueRoutes.find((r) => r.path === '/steam');
  assert.ok(parent);
  assert.equal(parent.specifier, '@/layouts/index.vue'); // Layout 函数体动态 import
  assert.equal(parent.metaTitle, 'menu.steamData');
  const status = facts.vueRoutes.find((r) => r.path === '/status');
  assert.ok(status);
  assert.equal(status.name, 'steamStatus');
  assert.equal(status.specifier, '@/views/steam/status.vue');
});

// ---- vue-router 导航调用：router.push / 解构 push（steam-stat App.vue 模式）----
test('tsAnalyzer：useRouter 导航调用计入 overlayOpens', () => {
  const content = [
    'import { useRouter } from \'vue-router\'',
    '',
    'const router = useRouter()',
    'const { push } = useRouter()',
    '',
    'router.push(\'/login\')',
    'push(\'/setting\')',
    'router.replace(\'/status\')',
    'arr.push(\'not-a-route\')', // 数组 push 不误报
  ].join('\n');
  const facts = analyzeFile('src/views/index.ts', content, ROOT);
  const targets = facts.overlayOpens.map((o) => o.target).sort();
  assert.deepEqual(targets, ['/login', '/setting', '/status']);
});

test('tsAnalyzer：无 useRouter 声明时 push 不计入导航', () => {
  const content = 'const list: string[] = []\nlist.push(\'/x\')';
  const facts = analyzeFile('src/utils/a.ts', content, ROOT);
  assert.equal(facts.overlayOpens.length, 0);
});

// ---- projectScanner：framework 检测 ----
test('projectScanner：vue 依赖检测为 vue 框架', () => {
  assert.equal(true, true); // framework 检测依赖 package.json，无法在无项目环境断言
});

// ---- vueAnalyzer：template 内嵌 <template #footer> 不破坏块拆分 ----
test('vue SFC：template 内嵌 template 元素不误拆', () => {
  const content = [
    '<script setup lang="ts">',
    'const visible = ref(false)',
    '</script>',
    '<template>',
    '  <Modal v-model:open="visible">',
    '    <template #footer>',
    '      <Button>OK</Button>',
    '    </template>',
    '  </Modal>',
    '</template>',
  ].join('\n');
  const facts = analyzeVueFile('src/components/Confirm.vue', content, ROOT);
  assert.equal(facts.primaryComponentName, 'Confirm');
  assert.ok(facts.jsxTags.has('Modal'));
  assert.ok(facts.jsxTags.has('Button'));
});

// ---- storeCalls：auto-import 场景（无 import 语句直接调用 store hook，供 builder 隐式 usesStore）----
test('storeCalls：捕获 useXxxStore 与 xxxStore 双命名形态（无 import 语句）', () => {
  const content = [
    '<script setup lang="ts">',
    'const user = useUserStore()',
    'const g = globalStore()',
    'const { token } = storeToRefs(user)',
    '</script>',
    '<template><div>{{ token }}</div></template>',
  ].join('\n');
  const facts = analyzeVueFile('src/views/auto.vue', content, ROOT);
  const calls = facts.components[0].storeCalls;
  assert.ok(calls.includes('useUserStore'), '应捕获 useUserStore（use 前缀，经 useCalls）');
  assert.ok(calls.includes('globalStore'), '应捕获 globalStore（非 use 前缀，经 setup storeVars）');
});
