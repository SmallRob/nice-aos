// Vue props 传递链测试：Options API 解析 → 模板绑定分类 → builder PropEdge/vclass → viewer 类视图 renders 边
// fixture 模式取自 aise-ui（Vue 2.6 + Vue CLI + element-ui + vuex 3 + vue-router 3，纯 Options API）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOntologyData } from '../src/ontology/builder.js';
import { analyzeVueFile } from '../src/analyzers/vueAnalyzer.js';
import { createBlueprint } from '../src/ontology/blueprint.js';
import { buildViewerModel, renderViewerHtml } from '../src/ontology/viewer.js';

function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-vueprops-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// ---- analyzer 级：Options API 选项提取 ----
const OPTIONS_VUE = [
  '<template><div/></template>',
  '<script>',
  "import ChildComp from './ChildComp.vue'",
  'export default {',
  "  name: 'ParentView',",
  '  props: {',
  '    title: { type: String, required: true },',
  '    tags: Array,',
  '    extra: [String, Object],',
  '  },',
  '  components: { ChildComp },',
  '  data() {',
  "    return { count: 0, query: '' }",
  '  },',
  '  computed: {',
  "    ...mapState('app', ['sidebar']),",
  "    ...mapGetters({ roles: 'user/roles' }),",
  '    summary() { return this.count + 1 },',
  '  },',
  '  methods: {',
  '    doSubmit() {},',
  '    onSave() {},',
  '  },',
  '}',
  '</script>',
].join('\n');

test('vueAnalyzer：Options API 提取（props 定义/data/computed/methods/components/storeKeys）', () => {
  const facts = analyzeVueFile('src/views/Opt.vue', OPTIONS_VUE, process.cwd());
  assert.equal(facts.components[0].name, 'ParentView');
  assert.equal(facts.primaryComponentName, 'ParentView');
  assert.equal(facts.components[0].propsCount, 3);
  assert.deepEqual(facts.components[0].propsNames, ['title', 'tags', 'extra']);
  assert.equal(facts.components[0].stateCount, 2);

  const o = facts.vueOptions;
  assert.deepEqual(o.propsDefs, [
    { name: 'title', type: 'String' },
    { name: 'tags', type: 'Array' },
    { name: 'extra', type: '[String, Object]' },
  ]);
  assert.deepEqual(o.dataKeys, ['count', 'query']);
  assert.deepEqual(o.computedKeys, ['summary']);
  assert.deepEqual(o.methodKeys, ['doSubmit', 'onSave']);
  assert.deepEqual(o.storeKeys, [
    { name: 'sidebar', module: 'app' },
    { name: 'roles', module: null },
  ]);
  assert.deepEqual(facts.vueComponents, { ChildComp: 'ChildComp' });
});

// ---- analyzer 级：模板绑定分类（七类 source + v-model/.sync/静态/裸属性 + router-link 导航）----
const BINDINGS_VUE = [
  '<template>',
  '  <div>',
  '    <child-comp',
  '      :title="title"',
  '      :count="count"',
  '      :roles="roles"',
  '      :submit="doSubmit"',
  '      :summary="summary"',
  '      max="10"',
  '      clearable',
  '      v-model="query"',
  '      :name.sync="name"',
  '      v-bind="rest"',
  '      @save="onSave"',
  '    />',
  '    <el-table :data="items" />',
  '    <img :src="pic" />',
  '    <router-link to="/login">login</router-link>',
  '  </div>',
  '</template>',
  '<script>',
  'export default {',
  "  props: ['title', 'rest'],",
  "  data() { return { count: 0, query: '', name: '', items: [] } },",
  '  computed: {',
  "    ...mapState('app', ['roles']),",
  '    summary() {},',
  '  },',
  '  methods: { doSubmit() {}, onSave() {} },',
  '}',
  '</script>',
].join('\n');

test('vueAnalyzer：模板绑定提取与七类来源分类', () => {
  const facts = analyzeVueFile('src/views/Bind.vue', BINDINGS_VUE, process.cwd());
  const renders = facts.vuePropRenders;
  assert.equal(renders.length, 1, '仅 child-comp 一个组件标签（el-/原生/router-link 均排除）');
  const pass = renders[0];
  assert.equal(pass.tag, 'ChildComp');
  const byName = new Map(pass.props.map((p) => [p.name, p]));
  assert.equal(byName.get('title').source, 'forward'); // 父组件 props 转发
  assert.equal(byName.get('count').source, 'state'); // data 键
  assert.equal(byName.get('roles').source, 'store'); // mapState 键
  assert.equal(byName.get('roles').storeHook, 'app'); // 模块名
  assert.equal(byName.get('submit').source, 'handler'); // methods 键
  assert.equal(byName.get('summary').source, 'computed'); // computed 键
  assert.equal(byName.get('max').source, 'literal'); // 静态属性
  assert.equal(byName.get('max').valueText, '10');
  assert.equal(byName.get('clearable').source, 'literal'); // 裸属性 = true
  assert.equal(byName.get('clearable').valueText, 'true');
  assert.equal(byName.get('v-model').source, 'state'); // 双向绑定按 data 来源分类
  assert.equal(byName.get('name').source, 'state'); // .sync 修饰符剥离后按名分类
  assert.equal(byName.get('...rest').source, 'spread'); // v-bind 整体透传
  assert.equal(byName.get('@save').source, 'handler'); // 事件回调
  assert.equal(byName.get('@save').valueText, 'onSave');
  // router-link 静态 to → 导航目标
  assert.deepEqual(facts.overlayOpens.map((o) => o.target), ['/login']);
});

// ---- builder 级：Vue2 全链路 fixture（别名/路由/store/全局注册/局部注册）----
const USER_VUE = [
  '<template>',
  '  <div class="app-container">',
  '    <user-avatar :src="avatar" :size="48" @error="handleErr" />',
  '    <pagination :total="total" :page.sync="page" @pagination="getList" />',
  '    <router-link to="/login" class="link">退出</router-link>',
  '  </div>',
  '</template>',
  '<script>',
  "import userAvatar from '@/components/userAvatar'",
  "import { mapState } from 'vuex'",
  '',
  'export default {',
  "  name: 'User',",
  '  components: { userAvatar },',
  '  data() {',
  '    return { page: 1, list: [] }',
  '  },',
  '  computed: {',
  "    ...mapState('user', ['name']),",
  '    total() { return this.list.length },',
  "    avatar() { return 'static/a.png' },",
  '  },',
  '  methods: {',
  '    handleErr() {},',
  '    getList() {},',
  '  },',
  '}',
  '</script>',
].join('\n');

const USER_AVATAR_VUE = [
  '<template>',
  '  <img :src="src" :width="size" />',
  '</template>',
  '<script>',
  'export default {',
  "  name: 'UserAvatar',",
  '  props: {',
  '    src: { type: String, default: \'\' },',
  '    size: { type: Number, default: 40 },',
  '  },',
  '  computed: {',
  "    boxSize() { return this.size + 'px' },",
  '  },',
  '  methods: {',
  '    load() {},',
  '  },',
  '}',
  '</script>',
].join('\n');

const PAGINATION_VUE = [
  '<template>',
  '  <div class="pagination">',
  '    <el-pagination :total="total" :current-page.sync="page" @size-change="onSize" />',
  '  </div>',
  '</template>',
  '<script>',
  'export default {',
  "  name: 'Pagination',",
  "  props: ['total', 'page', 'limit'],",
  '  data() { return { pager: null } },',
  '  methods: { onSize() {}, goto() {} },',
  '}',
  '</script>',
].join('\n');

const STORE_USER_JS = [
  'const user = {',
  "  state: { token: '', name: '', avatar: '' },",
  '  mutations: {',
  '    SET_TOKEN: (state, token) => { state.token = token },',
  '  },',
  '  actions: {',
  '    Login({ commit }, userInfo) {',
  "      commit('SET_TOKEN', 'x')",
  '    },',
  '  },',
  '}',
  'export default user',
].join('\n');

const STORE_INDEX_JS = [
  "import Vue from 'vue'",
  "import Vuex from 'vuex'",
  'Vue.use(Vuex)',
  'export default new Vuex.Store({',
  '  modules: {},',
  '})',
].join('\n');

const ROUTER_INDEX_JS = [
  "import Vue from 'vue'",
  "import Router from 'vue-router'",
  '',
  'Vue.use(Router)',
  '',
  'const routes = [',
  "  { path: '/user', component: () => import('@/views/user/index'), name: 'User' },",
  "  { path: '/login', component: () => import('@/views/login'), name: 'Login', hidden: true },",
  ']',
  '',
  'export default new Router({ routes })',
].join('\n');

const MAIN_JS = [
  "import Vue from 'vue'",
  "import Pagination from '@/components/Pagination'",
  '',
  "Vue.component('Pagination', Pagination)",
].join('\n');

const LOGIN_VUE = [
  '<template>',
  '  <div class="login">login</div>',
  '</template>',
  '<script>',
  'export default {',
  "  name: 'Login',",
  '}',
  '</script>',
].join('\n');

function buildVue2Project() {
  return makeProject({
    'package.json': JSON.stringify({
      name: 'vue2-fixture',
      dependencies: { vue: '^2.6.12', vuex: '^3.6.0', 'vue-router': '^3.4.9', 'element-ui': '^2.15.13' },
    }),
    'vue.config.js': [
      'const path = require(\'path\')',
      'module.exports = {',
      '  configureWebpack: {',
      '    resolve: {',
      '      alias: {',
      "        '@': path.resolve(__dirname, 'src'),",
      '      },',
      '    },',
      '  },',
      '}',
    ].join('\n'),
    'src/main.js': MAIN_JS,
    'src/router/index.js': ROUTER_INDEX_JS,
    'src/store/index.js': STORE_INDEX_JS,
    'src/store/modules/user.js': STORE_USER_JS,
    'src/views/user/index.vue': USER_VUE,
    'src/views/login.vue': LOGIN_VUE,
    'src/components/userAvatar.vue': USER_AVATAR_VUE,
    'src/components/Pagination/index.vue': PAGINATION_VUE,
  });
}

test('builder：@别名解析（vue.config.js）与 Vuex store 检测', async () => {
  const dir = buildVue2Project();
  try {
    const data = await buildOntologyData(dir);
    // 别名：@/ 导入全部解析为 internal，user/index.vue 无 unresolved
    const userFile = data.SourceFile.find((f) => f.path === 'src/views/user/index.vue');
    assert.ok(userFile, 'User 视图文件应被扫描');
    assert.deepEqual(userFile.unresolvedImports, [], '@/ 导入应经 vue.config.js 别名解析');
    assert.ok(userFile.importIds.includes('file:src/components/userAvatar.vue'));

    // Vuex：user 模块产出 store；index.js 仅接线不产出
    assert.equal(data.Store.length, 1);
    const store = data.Store[0];
    assert.equal(store.name, 'user');
    assert.equal(store.providerType, 'vuex');
    assert.deepEqual(store.stateKeys, ['token', 'name', 'avatar']);
    assert.deepEqual(store.actionKeys, ['SET_TOKEN', 'Login']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('builder：Vue PropEdge 聚合（局部注册 + 全局注册 + renderCount + 出入度）', async () => {
  const dir = buildVue2Project();
  try {
    const data = await buildOntologyData(dir);
    const edges = data.PropEdge;
    assert.equal(edges.length, 2);

    // camelCase 默认导入 + kebab 模板标签 + shorthand 注册 → UserAvatar
    const avatarEdge = edges.find((e) => e.id === 'prop:User→UserAvatar');
    assert.ok(avatarEdge, 'User→UserAvatar 边应产出（camelCase 默认导入解析）');
    assert.equal(avatarEdge.fromComponentId, 'comp:User');
    assert.equal(avatarEdge.toComponentId, 'comp:UserAvatar');
    assert.equal(avatarEdge.renderCount, 1);
    const avatarProps = new Map(avatarEdge.props.map((p) => [p.name, p]));
    assert.equal(avatarProps.get('src').source, 'computed');
    assert.equal(avatarProps.get('size').source, 'literal');
    assert.equal(avatarProps.get('@error').source, 'handler');

    // 全局注册（main.js Vue.component）→ Pagination
    const pageEdge = edges.find((e) => e.id === 'prop:User→Pagination');
    assert.ok(pageEdge, 'User→Pagination 边应产出（全局注册兜底）');
    const pageProps = new Map(pageEdge.props.map((p) => [p.name, p]));
    assert.equal(pageProps.get('total').source, 'computed');
    assert.equal(pageProps.get('page').source, 'state'); // .sync 剥离
    assert.equal(pageProps.get('@pagination').source, 'handler');

    // 出入度
    const user = data.Component.find((c) => c.name === 'User');
    const avatar = data.Component.find((c) => c.name === 'UserAvatar');
    const pagination = data.Component.find((c) => c.name === 'Pagination');
    assert.equal(user.propOutCount, 2);
    assert.equal(avatar.propInCount, 1);
    assert.equal(pagination.propInCount, 1);

    // renders 关系同步产出
    assert.deepEqual(user.rendersIds.sort(), ['comp:Pagination', 'comp:UserAvatar']);

    // blueprint passesProps 链接
    const bp = createBlueprint(data);
    assert.deepEqual(bp.link('passesProps', 'comp:User').map((o) => o.id).sort(), ['comp:Pagination', 'comp:UserAvatar']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('builder：vclass 类实体（props 字段/computed+methods 方法/renders 组合边）', async () => {
  const dir = buildVue2Project();
  try {
    const data = await buildOntologyData(dir);
    const vclasses = data.Class.filter((c) => c.id.startsWith('vclass:'));
    assert.equal(vclasses.length, 4, '4 个 .vue 文件各产出 1 个 vclass（User/UserAvatar/Pagination/Login）');

    const vcUser = vclasses.find((c) => c.name === 'User');
    const vcAvatar = vclasses.find((c) => c.name === 'UserAvatar');
    const vcPage = vclasses.find((c) => c.name === 'Pagination');
    assert.ok(vcUser && vcAvatar && vcPage);
    assert.equal(vcUser.kind, 'component');
    assert.equal(vcUser.language, 'vue');
    assert.equal(vcUser.exported, true);
    assert.deepEqual(vcUser.fields, []);
    assert.equal(vcUser.methodIds.length, 4, 'computed 2 + methods 2');

    assert.deepEqual(vcAvatar.fields, [
      { name: 'src', type: 'String' },
      { name: 'size', type: 'Number' },
    ]);
    assert.equal(vcAvatar.methodIds.length, 2, 'computed 1 + methods 1');
    // props 数组形式 → type null
    assert.deepEqual(vcPage.fields, [
      { name: 'total', type: null },
      { name: 'page', type: null },
      { name: 'limit', type: null },
    ]);

    // vmethod 实体归属
    const methodById = new Map(data.Method.map((m) => [m.id, m]));
    const boxSize = methodById.get(vcAvatar.methodIds.find((id) => methodById.get(id)?.name === 'boxSize'));
    assert.equal(boxSize.ownerKind, 'class');
    assert.equal(boxSize.ownerName, 'UserAvatar');
    assert.equal(boxSize.language, undefined); // Method 无 language 字段，路径归属即可

    // renders 组合边（vclass → vclass）
    assert.deepEqual(vcUser.rendersIds.sort(), ['vclass:Pagination', 'vclass:UserAvatar']);
    assert.deepEqual(vcAvatar.rendersIds, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('builder：router-link 静态 to → 路由导航边', async () => {
  const dir = buildVue2Project();
  try {
    const data = await buildOntologyData(dir);
    const vueRoutes = data.Route.filter((r) => r.routeType === 'vue');
    assert.equal(vueRoutes.length, 2, '显式声明路由 2 条（文件路由推导不重复）');
    const userRoute = vueRoutes.find((r) => r.routePath === '/user');
    assert.ok(userRoute);
    assert.equal(userRoute.componentId, 'comp:User');
    assert.deepEqual(userRoute.navigatesToIds, ['route:/login'], 'router-link 静态 to 产出导航边');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('viewer：propFlow 消费 Vue PropEdge + 类视图 renders 边渲染', async () => {
  const dir = buildVue2Project();
  try {
    const dataMap = await buildOntologyData(dir);
    const model = buildViewerModel(dataMap);

    // 组件数据流
    const pf = model.propFlow;
    assert.ok(pf, '有 Vue PropEdge 时 propFlow 应存在');
    assert.equal(pf.edgeCount, 2);
    assert.equal(pf.nodeCount, 3);
    assert.equal(pf.edges.find((e) => e.toName === 'UserAvatar').propCount, 3);
    assert.equal(pf.topOut[0].name, 'User');

    // 实体类图：renders 边 + 组件类型
    const ent = model.entities;
    assert.ok(ent);
    assert.equal(ent.rendersCount, 2);
    const componentKind = ent.byKind.find((k) => k.key === 'component');
    assert.equal(componentKind.count, 4);
    const rndEdges = ent.graph.edges.filter((e) => e.kind === 'renders');
    assert.ok(rndEdges.length > 0, '类图应含 renders 边');
    const rndNode = ent.graph.nodes.find((n) => n.kind === 'component');
    assert.ok(rndNode, '类图节点应含 «组件» 实体');

    // HTML 渲染：Tab 存在 + renders marker/样式 + 图例
    const html = renderViewerHtml(model);
    assert.ok(html.includes('data-tab="props"'));
    assert.ok(html.includes('id="view-props"'));
    assert.ok(html.includes('arr-rnd'), 'SVG defs 应含 renders 箭头 marker');
    assert.ok(html.includes('svg .ge.rnd'), 'CSS 应含 renders 边样式');
    assert.ok(html.includes('renders（组件组合，实线箭头）'), '图例应含 renders 说明');

    // mock DOM 执行内嵌脚本，验证实体面板实际渲染输出（chips 的 renders 计数为运行时拼接）
    const dataJson = html.match(/<script id="viewer-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
    const script = html.match(/<script>\n([\s\S]*?)<\/script>\s*<\/body>/)[1];
    const elements = new Map();
    const makeEl = (id) => {
      if (!elements.has(id)) {
        elements.set(id, {
          innerHTML: '', textContent: id === 'viewer-data' ? dataJson : '',
          dataset: {}, style: {}, value: '', addEventListener() {},
          classList: { add() {}, remove() {} }, querySelectorAll: () => [],
          querySelector: () => makeEl('generic'),
        });
      }
      return elements.get(id);
    };
    const prevDocument = globalThis.document;
    globalThis.document = {
      getElementById: makeEl, querySelectorAll: () => [], querySelector: () => makeEl('generic'),
    };
    try {
      new Function(script)();
    } finally {
      globalThis.document = prevDocument;
    }
    const entOut = makeEl('view-entities').innerHTML;
    assert.ok(entOut.includes('renders 2'), '实体面板 chips 应含 renders 计数');
    assert.ok(entOut.includes('组件组合，实线箭头'), '实体面板图例应含 renders 说明');
    assert.ok(entOut.includes('«component»') || entOut.includes('«组件»'), '类图应渲染 «组件» 构造型');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('回归：Vue 文件无组件绑定时 propFlow 为 null（Tab 隐藏）', async () => {
  const dir = makeProject({
    'package.json': JSON.stringify({ name: 'vue-plain', dependencies: { vue: '^2.6.12' } }),
    'src/App.vue': [
      '<template>',
      '  <div>plain</div>',
      '</template>',
      '<script>',
      'export default { name: \'App\' }',
      '</script>',
    ].join('\n'),
  });
  try {
    const dataMap = await buildOntologyData(dir);
    const model = buildViewerModel(dataMap);
    assert.equal(model.propFlow, null);
    // vclass 仍产出（类视图不依赖 PropEdge）
    assert.ok(model.entities.byKind.find((k) => k.key === 'component'));
    assert.equal(model.entities.rendersCount, 0);
    const html = renderViewerHtml(model);
    assert.ok(html.includes("if (!M.propFlow) hideTab('props');"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
