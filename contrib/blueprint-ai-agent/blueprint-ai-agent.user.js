// ==UserScript==
// @name         AOS 蓝图 AI 代码分析助手
// @name:zh-CN   AOS 蓝图 AI 代码分析助手
// @name:en      AOS Blueprint AI Code Analysis Assistant
// @namespace    https://github.com/nice-aos
// @version      1.1.0
// @description  nice-aos 蓝图页 AI 对话侧边栏。在 blueprint.html 右下角插入浮窗按钮，展开即可对项目代码本体（模块/组件/Hook/Store/Service/路由/接口/死代码/依赖/功能域等）进行自然语言问答分析。同时支持数据库蓝图页（dataoverview：表/列/外键/索引/迁移/领域/模式特征）、部署蓝图页（deployoverview：服务/镜像/网关路由/依赖/中间件/环境/分层/审计）与 Java 后端服务蓝图页（service-blueprint：模块/分层/API 面/数据层/技术栈/代码质量/健康审计/模块图谱），自动检测页面类型并切换对应分析模式。双数据源：优先读取页面内嵌 viewer-data / db-viewer-data / deploy-viewer-data / service-viewer-data，可配置本地快照地址。支持多模型供应商(DeepSeek/GLM/Qwen/Kimi/Doubao/OpenAI/自定义)、新建会话、会话历史、导出 JSON/Markdown。参考 steam-ai-agent 的 ToolRegistry + ReAct 工具循环架构。
// @description:en nice-aos blueprint AI chat sidebar. Floating button in blueprint.html. Natural language Q&A over code ontology (modules/components/hooks/stores/services/routes/interfaces/deadcode/deps/domains). Also supports database blueprint pages (dataoverview) with auto-detection and database-specific tools (tables/columns/fks/indexes/migrations/domains/patterns), deploy blueprint pages (deployoverview) and Java backend service blueprint pages (service-blueprint: modules/layers/API/database/techstack/quality/health/module graph). Dual data source. Multi-provider, sessions, history, export.
// @icon         data:image/svg+xml,%3Csvg%20viewBox='0%200%2024%2024'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3E%3Crect%20width='24'%20height='24'%20rx='6'%20fill='%236366f1'/%3E%3Cpath%20d='M7%205.5h10a1.5%201.5%200%200%201%201.5%201.5v7a1.5%201.5%200%200%201-1.5%201.5h-4.5l-4%203.2V15.5H7a1.5%201.5%200%200%201-1.5-1.5V7A1.5%201.5%200%200%201%207%205.5z'%20fill='white'/%3E%3Cpath%20d='M12%207.5l1%202.8a2%202%200%200%200%201.1%201.1L17%2012.5l-2.9%201.1a2%202%200%200%200-1.1%201.1L12%2017.5l-1-2.8a2%202%200%200%200-1.1-1.1L7%2012.5l2.9-1.1a2%202%200%200%200%201.1-1.1L12%207.5z'%20fill='%236366f1'/%3E%3C/svg%3E
// @author       nice-aos
// @match        file:///*
// @match        http://*/*
// @match        https://*/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_info
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      open.bigmodel.cn
// @connect      dashscope.aliyuncs.com
// @connect      api.moonshot.cn
// @connect      ark.cn-beijing.volces.com
// @connect      api.openai.com
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // 页面类型检测：服务蓝图页 (service-viewer-data) / 部署蓝图页 (deploy-viewer-data) / 数据库蓝图页 (db-viewer-data) / 代码蓝图页 (viewer-data / #viewer)
    function detectPageType() {
        if (document.getElementById('service-viewer-data')) return 'service';
        if (document.getElementById('deploy-viewer-data')) return 'deploy';
        if (document.getElementById('db-viewer-data')) return 'database';
        if (document.getElementById('viewer-data') || document.querySelector('#viewer')) return 'code';
        return null;
    }
    const PAGE_TYPE = detectPageType();
    if (!PAGE_TYPE) return;

    // ============================================================
    //  配置与常量
    // ============================================================
    const CONFIG = {
        AI_DEFAULT_URL: 'https://api.deepseek.com/v1/chat/completions',
        AI_DEFAULT_MODEL: 'deepseek-chat',
        PANEL_WIDTH: 580,
        MAX_ITERATIONS: 5,
        TOOL_TIMEOUT: 25000,
        AI_TIMEOUT: 120000,
        CACHE_TTL: 30 * 60 * 1000,
        TOAST_DURATION: 3000,
        SK: { SETTINGS: 'ba_ai_settings', CHATS: 'ba_ai_chats', ACTIVE: 'ba_ai_active_chat', VER: 'ba_ai_ver', CACHE: 'ba_ai_cache', SNAP: 'ba_ai_snap' },
    };

    const MODEL_PROVIDERS = {
        deepseek: {
            name: 'DeepSeek', apiUrl: 'https://api.deepseek.com/v1/chat/completions',
            models: [{ value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }, { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }],
            defaultModel: 'deepseek-v4-pro', apiKeyUrl: 'https://platform.deepseek.com/api_keys',
        },
        glm: {
            name: '智谱GLM', apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
            models: [{ value: 'glm-4-flash', label: 'GLM-4-Flash (免费)' }, { value: 'glm-5', label: 'GLM-5' }],
            defaultModel: 'glm-4-flash', apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
        },
        qwen: {
            name: '通义千问', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
            models: [{ value: 'qwen-plus', label: 'Qwen Plus' }, { value: 'qwen-max', label: 'Qwen Max' }],
            defaultModel: 'qwen-plus', apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
        },
        moonshot: {
            name: 'Kimi', apiUrl: 'https://api.moonshot.cn/v1/chat/completions',
            models: [{ value: 'kimi-k3', label: 'Kimi K3' }],
            defaultModel: 'kimi-k3', apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
        },
        doubao: {
            name: '豆包', apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
            models: [{ value: 'doubao-seed-1-6-pro-250528', label: 'Doubao Seed 1.6 Pro' }, { value: 'doubao-pro-32k', label: 'Doubao Pro 32K' }],
            defaultModel: 'doubao-seed-1-6-pro-250528', apiKeyUrl: 'https://console.volcengine.com/ark',
        },
        openai: {
            name: 'OpenAI', apiUrl: 'https://api.openai.com/v1/chat/completions',
            models: [{ value: 'gpt-4o-mini', label: 'GPT-4o Mini' }, { value: 'gpt-4o', label: 'GPT-4o' }],
            defaultModel: 'gpt-4o-mini', apiKeyUrl: 'https://platform.openai.com/api-keys',
        },
        custom: {
            name: '自定义', apiUrl: '', models: [{ value: '', label: '自定义模型 ID' }], defaultModel: '',
            apiKeyUrl: '', keyHint: '输入兼容 OpenAI 格式的 API 地址与模型 ID',
        },
    };

    // ============================================================
    //  小工具
    // ============================================================
    const $d = (sel, scope = document) => scope.querySelector(sel);
    const $all = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));
    const el = (tag, cls = '', html = '') => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (html) n.innerHTML = html;
        return n;
    };
    const parseStored = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
    const deepClone = (o) => JSON.parse(JSON.stringify(o));
    const uid = () => 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const trunc = (s, n = 120) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

    let toastTimer;
    function toast(msg, type = 'info') {
        let t = $d('.ba-toast');
        if (!t) { t = el('div', 'ba-toast'); document.body.appendChild(t); }
        t.textContent = msg;
        t.className = 'ba-toast ba-toast-' + type + ' ba-toast-show';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove('ba-toast-show'), CONFIG.TOAST_DURATION);
    }
    function getIcon(name, size = 16) {
        const I = SVG_ICONS[name] || SVG_ICONS.robot;
        return `<svg class="ba-ic" style="width:${size}px;height:${size}px" viewBox="0 0 24 24" fill="none">${I}</svg>`;
    }
    function downloadFile(content, filename, mime = 'text/plain') {
        const blob = new Blob([content], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    // ============================================================
    //  存储封装（GM_* → 降级 localStorage）
    // ============================================================
    const Store = {
        get(k, fb = null) {
            try { return typeof GM_getValue === 'function' ? GM_getValue(k, fb) : localStorage.getItem(k) ?? fb; }
            catch { return localStorage.getItem(k) ?? fb; }
        },
        set(k, v) {
            try { typeof GM_setValue === 'function' ? GM_setValue(k, v) : localStorage.setItem(k, v); }
            catch { localStorage.setItem(k, v); }
        },
        del(k) {
            try { typeof GM_deleteValue === 'function' ? GM_deleteValue(k) : localStorage.removeItem(k); }
            catch { localStorage.removeItem(k); }
        },
    };
    function readSettings() {
        const s = parseStored(Store.get(CONFIG.SK.SETTINGS, null), {});
        if (!s.provider) s.provider = 'deepseek';
        if (!s.apiUrl) s.apiUrl = MODEL_PROVIDERS[s.provider]?.apiUrl || '';
        if (!s.model) s.model = MODEL_PROVIDERS[s.provider]?.defaultModel || '';
        // 初始化模型预设：如果为空，自动将当前配置保存为第一个预设
        if (!Array.isArray(s.modelPresets) || s.modelPresets.length === 0) {
            const prov = MODEL_PROVIDERS[s.provider];
            s.modelPresets = [{
                id: uid(),
                name: prov?.name ? prov.name + ' · ' + (s.model || '默认') : '默认配置',
                provider: s.provider,
                model: s.model,
                apiUrl: s.apiUrl || prov?.apiUrl || '',
            }];
        }
        return s;
    }
    let settingsCache = null;
    const getSettings = () => settingsCache || (settingsCache = readSettings());
    const saveSettings = (patch) => { settingsCache = { ...getSettings(), ...patch }; Store.set(CONFIG.SK.SETTINGS, JSON.stringify(settingsCache)); };

    // ============================================================
    //  SVG 图标（精简子集）
    // ============================================================
    const SVG_ICONS = {
        robot: `<path d="M9 4h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2l-3 3v-3H9a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 9h6M9 12h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
        chat: `<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>`,
        send: `<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
        stop: `<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/>`,
        plus: `<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
        close: `<path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
        download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
        trash: `<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
        gear: `<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" stroke-width="1.8"/>`,
        history: `<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
        search: `<circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/><line x1="21" y1="21" x2="16.65" y2="16.65" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
        lightbulb: `<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2v.3h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
        book: `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>`,
        key: `<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.778-7.778zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
        copy: `<rect x="9" y="9" width="12" height="12" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.8"/>`,
        check: `<path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
        database: `<ellipse cx="12" cy="5" rx="8" ry="3" stroke="currentColor" stroke-width="1.6"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" stroke="currentColor" stroke-width="1.6"/>`,
        chart: `<path d="M3 3v18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="7" y="10" width="3" height="8" fill="currentColor" rx="1"/><rect x="12" y="6" width="3" height="12" fill="currentColor" rx="1"/><rect x="17" y="13" width="3" height="5" fill="currentColor" rx="1"/>`,
        sitemap: `<rect x="9" y="3" width="6" height="4" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="17" width="6" height="4" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="15" y="17" width="6" height="4" rx="1" stroke="currentColor" stroke-width="1.6"/><path d="M12 7v4M9 13l-3 3M15 13l3 3M9 11h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
        code: `<path d="M16 18l6-6-6-6M8 6l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
        edit: `<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
        file: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 2v6h6" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>`,
        server: `<rect x="3" y="3" width="18" height="7" rx="2" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="14" width="18" height="7" rx="2" stroke="currentColor" stroke-width="1.6"/><circle cx="7" cy="6.5" r="1" fill="currentColor"/><circle cx="7" cy="17.5" r="1" fill="currentColor"/><path d="M12 6.5h5M12 17.5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
    };

    // ============================================================
    //  工具显示配置（友好名称 + 图标映射）
    // ============================================================
    const TOOL_DISPLAY = {
        // 代码分析工具
        getStats:          { label: '项目概览',     icon: 'chart' },
        queryObjects:      { label: '对象查询',     icon: 'search' },
        queryModules:      { label: '模块查询',     icon: 'sitemap' },
        queryComponents:   { label: '组件查询',     icon: 'code' },
        queryHooks:        { label: 'Hook查询',     icon: 'code' },
        queryStores:       { label: 'Store查询',    icon: 'database' },
        queryServices:     { label: 'Service查询',  icon: 'sitemap' },
        queryRoutes:       { label: '路由查询',     icon: 'sitemap' },
        queryDeadCode:     { label: '死代码检测',   icon: 'trash' },
        queryDependencies: { label: '依赖分析',     icon: 'sitemap' },
        queryDomains:      { label: '领域分析',     icon: 'sitemap' },
        getNodeDetails:    { label: '节点详情',     icon: 'file' },
        listLinks:         { label: '关联查询',     icon: 'sitemap' },
        getDomainDetail:   { label: '领域详情',     icon: 'sitemap' },
        analyzeFile:       { label: '文件分析',     icon: 'file' },
        getArchLayers:     { label: '架构分层',     icon: 'sitemap' },
        findDeadCode:      { label: '死代码检测',   icon: 'trash' },
        getProjectContext: { label: '项目上下文',   icon: 'book' },
        // 数据库工具
        getDbStats:           { label: '数据库概览',   icon: 'chart' },
        queryTables:          { label: '表查询',       icon: 'database' },
        getTableDetails:      { label: '表详情',       icon: 'database' },
        queryForeignKeys:     { label: '外键查询',     icon: 'sitemap' },
        queryIndexes:         { label: '索引查询',     icon: 'search' },
        queryMigrations:      { label: '迁移分析',     icon: 'history' },
        queryDbDomains:       { label: '领域分析',     icon: 'sitemap' },
        queryPatterns:        { label: '模式特征',     icon: 'lightbulb' },
        getDbPatterns:        { label: '模式特征',     icon: 'lightbulb' },
        getDbHealth:          { label: '健康度评估',   icon: 'chart' },
        getDbIndexAnalysis:   { label: '索引优化',     icon: 'search' },
        getDbDomainCoupling:  { label: '领域耦合',     icon: 'sitemap' },
        getDbEvolution:       { label: '演进趋势',     icon: 'history' },
        getDbNamingAudit:     { label: '命名规范',     icon: 'edit' },
        getDbImpact:          { label: '迁移影响',     icon: 'history' },
        getDbFkChain:         { label: '外键链路',     icon: 'sitemap' },
        // 部署分析工具
        getDeployStats:        { label: '部署概览',     icon: 'chart' },
        queryDeployServices:   { label: '服务查询',     icon: 'sitemap' },
        getServiceDeployDetails: { label: '服务详情',   icon: 'file' },
        queryDeployRoutes:     { label: '路由查询',     icon: 'sitemap' },
        queryDeployUpstreams:  { label: '上游查询',     icon: 'sitemap' },
        queryDeployDeps:       { label: '依赖查询',     icon: 'sitemap' },
        queryMiddleware:       { label: '中间件查询',   icon: 'database' },
        queryDeployEnvs:       { label: '环境查询',     icon: 'file' },
        queryDeployFiles:      { label: '文件查询',     icon: 'file' },
        queryDeployLayers:     { label: '分层查询',     icon: 'sitemap' },
        getDeployHealth:       { label: '健康度评估',   icon: 'chart' },
        getDeployAudit:        { label: '审计明细',     icon: 'lightbulb' },
        // 后端服务蓝图工具
        getServiceStats:       { label: '服务概览',     icon: 'chart' },
        queryServiceModules:   { label: '模块查询',     icon: 'sitemap' },
        queryServiceLayers:    { label: '分层查询',     icon: 'sitemap' },
        queryServiceEndpoints: { label: '端点查询',     icon: 'server' },
        queryServiceTables:    { label: '表查询',       icon: 'database' },
        queryServiceDeps:      { label: '依赖/技术栈',  icon: 'sitemap' },
        getServiceQuality:     { label: '代码质量',     icon: 'chart' },
        getServiceHealth:      { label: '健康度评估',   icon: 'chart' },
        getServiceAudit:       { label: '审计明细',     icon: 'lightbulb' },
        queryServiceGraph:     { label: '图谱查询',     icon: 'sitemap' },
    };

    function getToolDisplay(name) {
        const key = String(name || '');
        return TOOL_DISPLAY[key] || { label: key || '工具', icon: 'code' };
    }

    function formatToolArgs(args) {
        if (!args || typeof args !== 'object') return '';
        const entries = Object.entries(args);
        if (!entries.length) return '';
        return entries
            .slice(0, 2)
            .map(([k, v]) => {
                const val = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
                return `${k}: ${val.length > 24 ? val.slice(0, 24) + '…' : val}`;
            })
            .join(' · ');
    }

    // ============================================================
    //  数据源：双模式归一化
    //   - 模式A：页面内嵌 #viewer-data（blueprint.html，零依赖离线）
    //   - 模式B：本地 snapshot.json（设置里配置 http/file URL，GM_xmlhttpRequest 拉取）
    // ============================================================
    const DATA_TYPES = ['project', 'domain', 'module', 'sourcefile', 'component', 'hook', 'store', 'service', 'interface', 'class', 'method', 'route', 'userscript', 'scriptfunction', 'dependency', 'gmusage', 'injectionpoint', 'networkendpoint'];
    const TYPE_LABELS = { project: '工程', domain: '功能域', module: '模块', sourcefile: '源文件', component: '组件', hook: 'Hook', store: 'Store', service: 'Service', interface: '接口', class: '类', method: '方法', route: '路由', userscript: '油猴脚本', scriptfunction: '脚本函数', dependency: '依赖', gmusage: 'GM调用', injectionpoint: '注入点', networkendpoint: '网络端点' };

    // 数据库对象类型标签
    const DB_DATA_TYPES = ['tables', 'foreignKeys', 'indexes', 'migrations', 'domains', 'views', 'triggers', 'procedures'];
    const DB_TYPE_LABELS = { tables: '表', foreignKeys: '外键', indexes: '索引', migrations: '迁移', domains: '领域', views: '视图', triggers: '触发器', procedures: '存储过程' };

    const DataSource = {
        ctx: null, // { byId, byType, project, meta, sourceLabel }
        status: 'unloaded', // unloaded | loading | ready | error
        error: '',

        _typeArrays(raw) {
            if (!raw || typeof raw !== 'object') return null;
            const out = {};
            for (const grouped of [raw, raw.dataMap, raw.model]) {
                if (!grouped || typeof grouped !== 'object') continue;
                for (const k of Object.keys(grouped)) {
                    const lk = k.toLowerCase();
                    if (DATA_TYPES.includes(lk) && Array.isArray(grouped[k])) {
                        (out[lk] || (out[lk] = [])).push(...grouped[k]);
                    }
                }
            }
            return out;
        },

        _buildIndex(raw) {
            const byId = new Map();
            const byType = {};
            const arrays = this._typeArrays(raw);
            if (!arrays) return null;
            for (const type of DATA_TYPES) {
                const arr = arrays[type] || [];
                byType[type] = arr;
                for (const o of arr) {
                    o._t = type;
                    const id = o.id || o.path || o.name;
                    if (id && !byId.has(id)) byId.set(id, o);
                }
            }
            const meta = (Array.isArray(raw._meta) ? null : raw._meta) || (raw.dataMap?._meta) || {};
            const project = raw.Project?.[0] || raw.dataMap?.project?.[0] || arrays.project?.[0] || this._buildFakeProject(raw, arrays);
            return { byId, byType, project, meta, raw };
        },

        _buildFakeProject(raw, arrays) {
            const all = Object.values(arrays).flat();
            return {
                id: 'proj:unknown', name: '未命名项目', path: '', version: '', framework: '',
                fileCount: (arrays.sourcefile || []).length, commitHash: '', branch: '',
            };
        },

        readInjected() {
            if (PAGE_TYPE === 'service') {
                const el = document.getElementById('service-viewer-data');
                if (!el) return null;
                try {
                    const parsed = JSON.parse(el.textContent);
                    const idx = this._buildServiceIndex(parsed);
                    if (idx) { idx.sourceLabel = '页面内嵌数据 (service-viewer-data)'; return idx; }
                } catch (e) { console.warn('[BA-Agent] service-viewer-data 解析失败', e); }
                return null;
            }
            if (PAGE_TYPE === 'deploy') {
                const el = document.getElementById('deploy-viewer-data');
                if (!el) return null;
                try {
                    const parsed = JSON.parse(el.textContent);
                    const idx = this._buildDeployIndex(parsed);
                    if (idx) { idx.sourceLabel = '页面内嵌数据 (deploy-viewer-data)'; return idx; }
                } catch (e) { console.warn('[BA-Agent] deploy-viewer-data 解析失败', e); }
                return null;
            }
            if (PAGE_TYPE === 'database') {
                const el = document.getElementById('db-viewer-data');
                if (!el) return null;
                try {
                    const parsed = JSON.parse(el.textContent);
                    const idx = this._buildDbIndex(parsed);
                    if (idx) { idx.sourceLabel = '页面内嵌数据 (db-viewer-data)'; return idx; }
                } catch (e) { console.warn('[BA-Agent] db-viewer-data 解析失败', e); }
                return null;
            }
            const el = document.getElementById('viewer-data');
            if (!el) return null;
            try {
                const parsed = JSON.parse(el.textContent);
                const body = parsed && typeof parsed === 'object' && ('dataMap' in parsed) ? parsed : { dataMap: parsed };
                const idx = this._buildIndex(body);
                if (idx) { idx.sourceLabel = '页面内嵌数据 (viewer-data)'; return idx; }
            } catch (e) { console.warn('[BA-Agent] viewer-data 解析失败', e); }
            return null;
        },

        _buildDeployIndex(raw) {
            if (!raw || typeof raw !== 'object') return null;
            const byType = {
                services: raw.services || [],
                routes: raw.routes || [],
                upstreams: raw.upstreams || [],
                dependencies: raw.dependencies || raw.depGraph?.edges || [],
                middleware: raw.middleware || [],
                environments: raw.environments || [],
                files: raw.files || [],
                layers: raw.topologyLayers || raw.layers || [],
            };
            const byName = new Map();
            for (const s of byType.services) { if (s.name && !byName.has(s.name)) byName.set(s.name, s); }
            const meta = raw.meta || raw._meta || {};
            return { byId: byName, byType, byName, meta, raw };
        },

        _buildServiceIndex(raw) {
            if (!raw || typeof raw !== 'object') return null;
            const byType = {
                modules: raw.modules || [],
                layers: raw.layers || [],
                endpoints: raw.endpoints || [],
                tables: raw.tables || [],
                orphanTables: raw.orphanTables || [],
                fkChains: raw.fkChains || [],
                dependencies: raw.dependencies || [],
                techStack: raw.techStack || [],
                complexityHotspots: raw.complexityHotspots || [],
                testStats: raw.testStats ? [raw.testStats] : [],
                repositories: raw.repositories || [],
                moduleGraph: raw.moduleGraph ? [raw.moduleGraph] : [],
            };
            const byName = new Map();
            for (const m of byType.modules) { if (m.key && !byName.has(m.key)) byName.set(m.key, m); }
            for (const t of byType.tables) { if (t.name && !byName.has(t.name)) byName.set(t.name, t); }
            const meta = raw.meta || raw._meta || {};
            return { byId: byName, byType, byName, meta, raw };
        },

        _buildDbIndex(raw) {
            if (!raw || typeof raw !== 'object') return null;
            const byName = new Map();
            const byType = {};
            for (const type of DB_DATA_TYPES) {
                const arr = raw[type] || [];
                byType[type] = arr;
                if (type === 'tables') {
                    for (const t of arr) { if (t.name && !byName.has(t.name)) byName.set(t.name, t); }
                }
            }
            const meta = raw.meta || raw._meta || {};
            return { byId: byName, byType, byName, meta, raw };
        },

        fetchSnapshot(url) {
            return new Promise((resolve, reject) => {
                if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('无 GM_xmlhttpRequest')); return; }
                GM_xmlhttpRequest({
                    method: 'GET', url, timeout: 15000,
                    onload: (r) => {
                        try { resolve(JSON.parse(r.responseText)); }
                        catch { reject(new Error('快照 JSON 解析失败')); }
                    },
                    onerror: (e) => reject(new Error(e.error || '快照拉取失败')),
                    ontimeout: () => reject(new Error('快照拉取超时')),
                });
            });
        },

        async load() {
            this.status = 'loading';
            this.error = '';
            try {
                const s = getSettings();
                // 模式A：页面内嵌优先（零依赖、即时可用）
                const injected = this.readInjected();
                if (injected) { this.ctx = injected; this.status = 'ready'; return injected; }
                // 模式B：配置的本地快照地址（按页面类型选择索引构建器）
                if (s.snapshotUrl) {
                    toast('拉取本地快照…');
                    const raw = await this.fetchSnapshot(s.snapshotUrl);
                    const idx = PAGE_TYPE === 'deploy' ? this._buildDeployIndex(raw)
                        : PAGE_TYPE === 'database' ? this._buildDbIndex(raw)
                        : PAGE_TYPE === 'service' ? this._buildServiceIndex(raw)
                        : this._buildIndex(raw && typeof raw === 'object' && ('dataMap' in raw) ? raw : { dataMap: raw });
                    if (!idx) throw new Error('快照结构无法识别');
                    idx.sourceLabel = `本地快照 ${s.snapshotUrl}`;
                    this.ctx = idx; this.status = 'ready'; return idx;
                }
                this.status = 'error';
                this.error = PAGE_TYPE === 'database'
                    ? '未找到可用数据：页面未内嵌 db-viewer-data，且未配置本地快照地址。请在设置中填写 db-snapshot.json 地址。'
                    : PAGE_TYPE === 'deploy'
                        ? '未找到可用数据：页面未内嵌 deploy-viewer-data。请使用最新版 nice-aos deploy export --format html 重新生成部署蓝图。'
                        : PAGE_TYPE === 'service'
                            ? '未找到可用数据：页面未内嵌 service-viewer-data。请使用最新版 nice-aos service export --format html 重新生成服务蓝图。'
                            : '未找到可用数据：页面未内嵌 viewer-data，且未配置本地 snapshot.json。请在设置中填写快照地址。';
                return null;
            } catch (e) {
                this.status = 'error'; this.error = String(e.message || e);
                return null;
            }
        },
    };

    // ============================================================
    //  代码分析工具（ToolRegistry + ReAct 文本协议）
    //   参考 steam-ai-agent 的 ToolRegistry 弱协议设计，规避多模型 function-calling 差异
    // ============================================================
    const ToolRegistry = {
        _tools: new Map(),
        register(t) { this._tools.set(t.name, t); },
        get(name) { return this._tools.get(name); },
        getAll() { return Array.from(this._tools.values()); },
        toolsDescription() {
            return this.getAll().map((t) => `【${t.name}】${t.description}\n  参数: ${JSON.stringify(t.parameters.properties ?? {})}`).join('\n\n');
        },
        async execute(name, args, ctx) {
            const t = this.get(name);
            if (!t) return { success: false, error: `工具 "${name}" 不存在` };
            try {
                return await Promise.race([
                    Promise.resolve(t.execute(args, ctx)),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('工具执行超时')), CONFIG.TOOL_TIMEOUT)),
                ]);
            } catch (e) { return { success: false, error: `工具执行错误: ${e.message}` }; }
        },
    };

    // ---- 归一化的便捷查询辅助 ----
    const matchObj = (o, kw) => {
        kw = String(kw ?? '').trim().toLowerCase();
        if (!kw) return true;
        return [o.name, o.id, o.path, o.filePath].filter(Boolean).some((f) => String(f).toLowerCase().includes(kw));
    };
    const allFields = (o) => {
        const out = {};
        for (const k of Object.keys(o)) {
            if (k.startsWith('_')) continue;
            const v = o[k];
            if (v === undefined || v === null || v === '') continue;
            if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 8) continue;
            out[k] = v;
        }
        return out;
    };
    const compactInfo = (o, max = 12) => {
        const r = { id: o.id, name: o.name, path: o.filePath || o.path, type: TYPE_LABELS[o._t] || o._t };
        if (o.fileId) r.fileId = o.fileId;
        return r;
    };
    const needsData = () => {
        if (DataSource.status !== 'ready' || !DataSource.ctx) return '数据尚未加载，请先在设置中刷新数据源';
        return null;
    };

    function registerAnalysisTools() {
        ToolRegistry.register({
            name: 'getStats',
            description: '获取项目本体统计总览：工程信息、各类型对象数量、循环依赖、孤儿/死代码候选数量。适合回答"项目有多大/结构如何"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = needsData(); if (err) return { success: false, error: err };
                const { byType, project, meta } = DataSource.ctx;
                const counts = {};
                for (const t of DATA_TYPES) counts[TYPE_LABELS[t]] = (byType[t] || []).length;
                const out = {
                    project: project.name,
                    framework: project.framework,
                    frameworkVariants: project.frameworkVariants,
                    branch: project.branch,
                    commit: project.commitHash ? String(project.commitHash).slice(0, 7) : null,
                    fileCount: project.fileCount ?? (byType.sourcefile || []).length,
                    counts,
                    cycles: (meta.cycles || []).map((c) => String(c).replace(/,/g, ' ⇄ ')),
                    orphanCandidates: meta.orphanCandidates || [],
                    deadExportCandidates: meta.deadExportCandidates || [],
                    source: DataSource.ctx.sourceLabel,
                };
                return { success: true, data: out, summary: `共 ${byType.sourcefile?.length || 0} 个源文件，${byType.component?.length || 0} 组件，${byType.interface?.length || 0} 接口` };
            },
        });

        ToolRegistry.register({
            name: 'queryObjects',
            description: '按类型查询本体对象（type 取 project/domain/module/sourcefile/component/hook/store/service/interface/class/method/route/dependency；keyword 可选，按名称/文件路径模糊匹配）。适合"列出某类型对象/有哪些组件/Hook"',
            parameters: { type: 'object', properties: { type: { type: 'string', description: '对象类型，小写单词，如 component/hook/store/service/interface/sourcefile' }, keyword: { type: 'string', description: '可选过滤关键词' }, limit: { type: 'number', description: '返回条数上限，默认20' } }, required: ['type'] },
            execute(args) {
                const err = needsData(); if (err) return { success: false, error: err };
                const type = String(args.type || '').toLowerCase();
                if (!DATA_TYPES.includes(type)) return { success: false, error: `未知类型 "${type}"，可选: ${DATA_TYPES.join(', ')}` };
                const limit = Math.min(Number(args.limit) || 20, 50);
                const arr = DataSource.ctx.byType[type] || [];
                const hit = arr.filter((o) => matchObj(o, args.keyword)).slice(0, limit).map((o) => compactInfo(o));
                if (!hit.length) return { success: false, error: `未找到类型 ${type}${args.keyword ? `(关键词 ${args.keyword})` : ''} 的对象` };
                return { success: true, data: hit, summary: `${TYPE_LABELS[type]} ${hit.length} 条(共 ${arr.length})` };
            },
        });

        ToolRegistry.register({
            name: 'getNodeDetails',
            description: '获取单个本体对象的完整详情（类型 + 名称或 id）。用于深入某个组件/Hook/Service/接口/类的方法与关系字段',
            parameters: { type: 'object', properties: { query: { type: 'string', description: '对象类型+名称 或 直接 id，如 "service:ExportService" 或文件路径' } }, required: ['query'] },
            execute(args) {
                const err = needsData(); if (err) return { success: false, error: err };
                const q = String(args.query || '').trim();
                if (!q) return { success: false, error: '缺少 query 参数' };
                const { byId, byType } = DataSource.ctx;
                let o = byId.get(q);
                if (!o) {
                    const [pt, ...rest] = q.split(':');
                    if (rest.length) {
                        const type = pt.toLowerCase();
                        if (DATA_TYPES.includes(type)) o = (byType[type] || []).find((x) => x.name === rest.join(':') || x.filePath === rest.join(':'));
                    }
                    if (!o) o = (byType.sourcefile || []).find((x) => x.path === q || x.filePath === q);
                }
                if (!o) return { success: false, error: `未找到对象 "${q}"（可先 queryObjects 查询）` };
                return { success: true, data: allFields(o), summary: `${TYPE_LABELS[o._t]} ${o.name}` };
            },
        });

        ToolRegistry.register({
            name: 'listLinks',
            description: '列出某个对象的全部关系字段（importIds/rendersIds/hooksUsed/extendsIds/implementsIds/domainIds 等），用于回答"X 依赖谁 / 谁使用 / 引用关系"',
            parameters: { type: 'object', properties: { query: { type: 'string', description: '对象类型:名称 或 id' }, keyword: { type: 'string', description: '可选：仅显示包含该关键词的关系字段' } }, required: ['query'] },
            execute(args) {
                const err = needsData(); if (err) return { success: false, error: err };
                const q = String(args.query || '').trim();
                const first = getNodeByQuery(q);
                if (!first) return { success: false, error: `未找到对象 "${q}"` };
                const links = {};
                for (const [k, v] of Object.entries(first)) {
                    if (!/Ids$|ases$|ers$|Count|candidates/i.test(k)) continue;
                    if (Array.isArray(v) && v.length) links[k] = v.slice(0, 20);
                    else if (v && typeof v !== 'object') links[k] = v;
                }
                if (args.keyword) {
                    const kw = String(args.keyword).toLowerCase();
                    for (const k of Object.keys(links)) if (!k.toLowerCase().includes(kw)) delete links[k];
                }
                if (!Object.keys(links).length) return { success: true, data: { note: '该对象无明显关系字段' }, summary: `${first.name} 无关系字段` };
                // 补充所在文件维度的导入关系与反向引用者，便于 Service/Store 等无直接关系字段的对象也能分析引用
                const { byType } = DataSource.ctx;
                const fileObj = first.fileId ? byId.get(first.fileId) : (first.filePath ? (byType.sourcefile || []).find((x) => x.path === first.filePath || x.filePath === first.filePath) : null);
                if (fileObj && Array.isArray(fileObj.importIds) && fileObj.importIds.length) links['file_imports'] = fileObj.importIds.slice(0, 20);
                const fileKey = first.fileId || fileObj?.id;
                if (fileKey) {
                    const importers = (byType.sourcefile || []).filter((x) => Array.isArray(x.importIds) && x.importIds.includes(fileKey)).map((x) => x.path || x.name);
                    if (importers.length) links['imported_by_files'] = importers.slice(0, 20);
                }
                if (Object.keys(links).length) return { success: true, data: links, summary: `${first.name} ${Object.keys(links).length} 类关系` };
                return { success: true, data: { note: '该对象无明显关系字段' }, summary: `${first.name} 无关系字段` };
            },
        });

        ToolRegistry.register({
            name: 'getDomainDetail',
            description: '分析指定功能域（domain）：列出所属的模块/文件/组件数量、域内清单。适合"xx功能域包含什么"',
            parameters: { type: 'object', properties: { keyword: { type: 'string', description: '功能域关键词（名称或 id）' } }, required: ['keyword'] },
            execute(args) {
                const err = needsData(); if (err) return { success: false, error: err };
                const domains = DataSource.ctx.byType.domain || [];
                const d = domains.find((x) => matchObj(x, args.keyword));
                if (!d) return { success: false, error: `未找到功能域 "${args.keyword}"，可用: ${domains.map((x) => x.name).join(', ') || '无'}` };
                const rel = {};
                for (const k of ['moduleIds', 'fileIds', 'componentIds', 'storeIds', 'hookIds', 'serviceIds', 'routeIds']) {
                    if (Array.isArray(d[k]) && d[k].length) rel[k] = d[k].slice(0, 30);
                }
                return { success: true, data: { id: d.id, name: d.name, sources: d.sources, ...rel }, summary: `功能域 ${d.name}：${d.componentCount ?? rel.componentIds?.length ?? 0} 组件` };
            },
        });

        ToolRegistry.register({
            name: 'analyzeFile',
            description: '分析单个源文件：导出符号、导入依赖、行数、所属模块/架构层。适合"这个文件是干什么的"',
            parameters: { type: 'object', properties: { file: { type: 'string', description: '文件路径或文件关键词' } }, required: ['file'] },
            execute(args) {
                const err = needsData(); if (err) return { success: false, error: err };
                const files = DataSource.ctx.byType.sourcefile || [];
                const f = files.find((x) => matchObj(x, args.file));
                if (!f) return { success: false, error: `未找到文件 "${args.file}"` };
                return { success: true, data: allFields(f), summary: `${f.name} ${f.lineCount ?? ''}行 ${f.isTest ? '(测试)' : ''}` };
            },
        });

        ToolRegistry.register({
            name: 'getArchLayers',
            description: '按架构分层（entry/presentation/state/service/integration/shared/test 等）统计文件与模块分布。适合"架构分层情况"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = needsData(); if (err) return { success: false, error: err };
                const layers = {};
                for (const f of DataSource.ctx.byType.sourcefile || []) {
                    const l = f.archLayer || f.layer || 'mixed';
                    layers[l] = (layers[l] || 0) + 1;
                }
                return { success: true, data: layers, summary: `${Object.keys(layers).length} 个架构层` };
            },
        });

        ToolRegistry.register({
            name: 'findDeadCode',
            description: '列出血代码候选（孤儿文件 / 未使用导出 / 未使用接口/方法）。适合"哪些代码是死的/可清理"',
            parameters: { type: 'object', properties: { kind: { type: 'string', description: '可选: file/export/interface/method/orphan，默认全部' } }, required: [] },
            execute(args) {
                const err = needsData(); if (err) return { success: false, error: err };
                const { byType, meta } = DataSource.ctx;
                const kind = String(args.kind || '').toLowerCase();
                const out = {};
                if (!kind || kind === 'orphan' || kind === 'file') out.orphanFiles = meta.orphanCandidates || [];
                if (!kind || kind === 'export') out.deadExports = (meta.deadExportCandidates || []).slice(0, 40);
                if (!kind || kind === 'interface') out.deadInterfaces = (byType.interface || []).filter((x) => x.deadCandidate).slice(0, 40).map((x) => ({ name: x.name, reason: x.deadReason, file: x.filePath }));
                if (!kind || kind === 'method') out.deadMethods = (byType.method || []).filter((x) => x.deadCandidate).slice(0, 40).map((x) => ({ name: x.name, file: x.filePath }));
                if (!Object.keys(out).length) return { success: false, error: `未知 kind "${kind}"` };
                return { success: true, data: out, summary: `死代码候选: ${(meta.orphanCandidates || []).length} 孤儿文件` };
            },
        });

        ToolRegistry.register({
            name: 'getProjectContext',
            description: '返回当前页面正在查看的蓝图上下文（如正在查看哪个视图/功能域），帮助结合界面回答',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const s = currentViewContext();
                return { success: true, data: s, summary: s ? '已获取页面上下文' : '无特殊上下文' };
            },
        });
    }

    function getNodeByQuery(q) {
        if (!DataSource.ctx) return null;
        const { byId, byType } = DataSource.ctx;
        if (byId.has(q)) return byId.get(q);
        const [pt, ...rest] = q.split(':');
        if (rest.length && DATA_TYPES.includes(pt.toLowerCase())) {
            const name = rest.join(':');
            return (byType[pt.toLowerCase()] || []).find((x) => x.name === name);
        }
        return (byType.sourcefile || []).find((x) => x.path === q);
    }

    // ============================================================
    // ============================================================
    //  数据库分析工具（仅在 PAGE_TYPE === 'database' 时注册）
    // ============================================================
    function registerDatabaseTools() {
        const dbNeedsData = () => {
            if (DataSource.status !== 'ready' || !DataSource.ctx) return '数据尚未加载';
            return null;
        };
        const dbMatch = (o, kw) => {
            kw = String(kw ?? '').trim().toLowerCase();
            if (!kw) return true;
            return [o.name, o.table, o.fromTable, o.toTable, o.version, o.domain].filter(Boolean).some((f) => String(f).toLowerCase().includes(kw));
        };

        ToolRegistry.register({
            name: 'getDbStats',
            description: '获取数据库整体统计：表数量、外键数量、索引数量、迁移文件数、领域数量、模式特征统计。适合回答"数据库有多大规模/结构如何"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const { byType, meta } = DataSource.ctx;
                const counts = {};
                for (const t of DB_DATA_TYPES) counts[DB_TYPE_LABELS[t]] = (byType[t] || []).length;
                const tables = byType.tables || [];
                const patternStats = {};
                for (const t of tables) {
                    for (const p of (t.patterns || [])) patternStats[p] = (patternStats[p] || 0) + 1;
                }
                const out = {
                    counts,
                    patterns: patternStats,
                    idempotentDdlCount: meta.idempotentDdlCount || 0,
                    source: DataSource.ctx.sourceLabel,
                };
                return { success: true, data: out, summary: `${counts['表']} 张表，${counts['外键']} 个外键，${counts['索引']} 个索引，${counts['迁移']} 个迁移文件` };
            },
        });

        ToolRegistry.register({
            name: 'queryTables',
            description: '查询数据库表列表，可按表名关键词或领域过滤。适合"数据库有哪些表/某领域的表"',
            parameters: { type: 'object', properties: { keyword: { type: 'string', description: '表名关键词（模糊匹配）' }, domain: { type: 'string', description: '领域名（如 auth/proj/ws/agent 等）' }, limit: { type: 'number', description: '返回条数上限，默认30' } }, required: [] },
            execute(args) {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const tables = DataSource.ctx.byType.tables || [];
                let hit = tables;
                if (args.domain) hit = hit.filter((t) => t.domain === args.domain);
                if (args.keyword) hit = hit.filter((t) => dbMatch(t, args.keyword));
                const limit = Math.min(Number(args.limit) || 30, 80);
                const result = hit.slice(0, limit).map((t) => ({
                    name: t.name, domain: t.domain, columnCount: (t.columns || []).length,
                    hasFk: (t.foreignKeys || []).length > 0, patterns: t.patterns || [],
                    migrationVersion: t.migrationVersion,
                }));
                if (!result.length) return { success: false, error: `未找到匹配的表${args.domain ? `(领域 ${args.domain})` : ''}` };
                return { success: true, data: result, summary: `${result.length} 张表（共 ${tables.length}）` };
            },
        });

        ToolRegistry.register({
            name: 'getTableDetails',
            description: '获取单张表的完整详情：列定义、主键、外键、索引、模式特征、所属领域。适合"某表的结构是什么"',
            parameters: { type: 'object', properties: { tableName: { type: 'string', description: '表名' } }, required: ['tableName'] },
            execute(args) {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const tableName = String(args.tableName || '').trim();
                if (!tableName) return { success: false, error: '缺少 tableName 参数' };
                const tables = DataSource.ctx.byType.tables || [];
                const t = tables.find((x) => x.name === tableName) || tables.find((x) => x.name.toLowerCase() === tableName.toLowerCase());
                if (!t) return { success: false, error: `未找到表 "${tableName}"` };
                const out = {
                    name: t.name, domain: t.domain, comment: t.comment,
                    columns: (t.columns || []).map((c) => ({ name: c.name, type: c.type, nullable: c.nullable, defaultValue: c.defaultValue, comment: c.comment })),
                    primaryKey: t.primaryKey || [],
                    foreignKeys: (t.foreignKeys || []).map((fk) => ({ name: fk.name, columns: fk.columns, refTable: fk.refTable, refColumns: fk.refColumns, onDelete: fk.onDelete, onUpdate: fk.onUpdate })),
                    indexes: (t.indexes || []).map((idx) => ({ name: idx.name, columns: idx.columns, unique: idx.unique })),
                    patterns: t.patterns || [],
                    migrationVersion: t.migrationVersion,
                    engine: t.engine, charset: t.charset,
                };
                return { success: true, data: out, summary: `表 ${t.name}：${(t.columns || []).length} 列，${(t.foreignKeys || []).length} 外键` };
            },
        });

        ToolRegistry.register({
            name: 'queryForeignKeys',
            description: '查询外键关系，可按源表/目标表过滤。适合"哪些表有外键/某表引用了谁"',
            parameters: { type: 'object', properties: { fromTable: { type: 'string', description: '源表名关键词' }, toTable: { type: 'string', description: '目标表名关键词' }, limit: { type: 'number', description: '返回条数上限，默认50' } }, required: [] },
            execute(args) {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const fks = DataSource.ctx.byType.foreignKeys || [];
                let hit = fks;
                if (args.fromTable) hit = hit.filter((fk) => String(fk.fromTable || '').toLowerCase().includes(String(args.fromTable).toLowerCase()));
                if (args.toTable) hit = hit.filter((fk) => String(fk.toTable || '').toLowerCase().includes(String(args.toTable).toLowerCase()));
                const limit = Math.min(Number(args.limit) || 50, 100);
                const result = hit.slice(0, limit).map((fk) => ({
                    name: fk.name, fromTable: fk.fromTable, fromColumns: fk.fromColumns || fk.columns,
                    toTable: fk.toTable, toColumns: fk.toColumns || fk.refColumns,
                    onDelete: fk.onDelete, onUpdate: fk.onUpdate,
                }));
                if (!result.length) return { success: false, error: '未找到匹配的外键关系' };
                return { success: true, data: result, summary: `${result.length} 个外键关系` };
            },
        });

        ToolRegistry.register({
            name: 'queryMigrations',
            description: '查询迁移历史，可按版本号过滤。适合"迁移历史/某版本有哪些变更"',
            parameters: { type: 'object', properties: { version: { type: 'string', description: '版本号关键词（如 V2.1）' }, limit: { type: 'number', description: '返回条数上限，默认30' } }, required: [] },
            execute(args) {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const migs = DataSource.ctx.byType.migrations || [];
                let hit = migs;
                if (args.version) hit = hit.filter((m) => dbMatch(m, args.version));
                const limit = Math.min(Number(args.limit) || 30, 80);
                const result = hit.slice(0, limit).map((m) => ({
                    version: m.version, description: m.description, fileName: m.fileName,
                    tablesCreated: m.tablesCreated, tablesAltered: m.tablesAltered,
                    indexesCreated: m.indexesCreated, fksCreated: m.fksCreated,
                }));
                if (!result.length) return { success: false, error: '未找到匹配的迁移记录' };
                return { success: true, data: result, summary: `${result.length} 个迁移（共 ${migs.length}）` };
            },
        });

        ToolRegistry.register({
            name: 'queryDomains',
            description: '查询数据库领域分组及其表清单。适合"数据库有哪些领域/某领域包含哪些表"',
            parameters: { type: 'object', properties: { keyword: { type: 'string', description: '领域名关键词' } }, required: [] },
            execute(args) {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const domains = DataSource.ctx.byType.domains || [];
                let hit = domains;
                if (args.keyword) hit = hit.filter((d) => dbMatch(d, args.keyword));
                if (!hit.length) return { success: false, error: `未找到领域${args.keyword ? ` "${args.keyword}"` : ''}` };
                const result = hit.map((d) => ({
                    name: d.name, tableCount: (d.tables || []).length,
                    tables: (d.tables || []).slice(0, 30),
                }));
                return { success: true, data: result, summary: `${result.length} 个领域` };
            },
        });

        ToolRegistry.register({
            name: 'getDbPatterns',
            description: '查询表的模式特征（软删除/审计字段/多租户/自引用/UUID主键）。适合"哪些表有软删除/多租户表有哪些"',
            parameters: { type: 'object', properties: { pattern: { type: 'string', description: '模式名（soft_delete/audit_columns/multi_tenant/self_reference/uuid_primary）' } }, required: ['pattern'] },
            execute(args) {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const pattern = String(args.pattern || '').trim().toLowerCase();
                const tables = DataSource.ctx.byType.tables || [];
                const matched = tables.filter((t) => (t.patterns || []).includes(pattern));
                if (!matched.length) return { success: false, error: `没有表使用模式 "${pattern}"` };
                return { success: true, data: matched.map((t) => ({ name: t.name, domain: t.domain })), summary: `${matched.length} 张表使用模式 ${pattern}` };
            },
        });

        // ---- 审计/概览类工具（数据概览图智能体）----
        ToolRegistry.register({
            name: 'getDbHealth',
            description: '获取数据库 Schema 健康度总评：综合评分、等级（A/B/C/D）、四个维度得分（完整性/一致性/索引质量/模式健康）、Top 问题列表、优化建议。适合"数据库健康状况如何/有什么质量问题"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const audits = DataSource.ctx.raw?.audits;
                if (!audits?.health) return { success: false, error: '未找到健康度审计数据，请确保使用最新版 aos db scan 生成快照' };
                const h = audits.health;
                return {
                    success: true,
                    data: {
                        score: h.score, grade: h.grade, totalIssues: h.totalIssues,
                        dimensions: Object.fromEntries(Object.entries(h.dimensions).map(([k, d]) => [k, { score: d.score, issueCount: (d.issues || []).length }])),
                        topIssues: (h.topIssues || []).slice(0, 10).map((i) => ({ severity: i.severity, message: i.message })),
                        recommendations: h.recommendations || [],
                    },
                    summary: `健康度 ${h.score} 分（等级 ${h.grade}），共 ${h.totalIssues} 个问题`,
                };
            },
        });

        ToolRegistry.register({
            name: 'getDbIndexAnalysis',
            description: '获取索引优化分析：索引总数、表均索引数、外键索引覆盖率、未建索引外键列表、冗余索引、宽索引、主键类型分布、优化建议。适合"索引设计是否合理/有哪些索引优化点"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const audits = DataSource.ctx.raw?.audits;
                if (!audits?.indexes) return { success: false, error: '未找到索引分析数据' };
                const idx = audits.indexes;
                return {
                    success: true,
                    data: {
                        totalIndexCount: idx.totalIndexCount,
                        perTableAvg: idx.perTableAvg,
                        unindexedFkCount: idx.unindexedFkCount,
                        fkIndexCoverageRate: Math.round((1 - (idx.unindexedFkRatio || 0)) * 100) + '%',
                        redundantIndexCount: idx.redundantIndexCount,
                        wideIndexCount: idx.wideIndexCount,
                        pkTypeDistribution: idx.pkTypeDistribution,
                        unindexedFks: (idx.unindexedFks || []).slice(0, 15),
                        redundantIndexes: (idx.redundantIndexes || []).slice(0, 10),
                        recommendations: idx.recommendations || [],
                    },
                    summary: `索引 ${idx.totalIndexCount} 个，表均 ${idx.perTableAvg} 个，FK 索引覆盖率 ${Math.round((1 - (idx.unindexedFkRatio || 0)) * 100)}%`,
                };
            },
        });

        ToolRegistry.register({
            name: 'getDbDomainCoupling',
            description: '获取领域依赖耦合分析：领域依赖矩阵、耦合度排名（出度/入度/总耦合度）、核心领域、循环依赖、桑基图数据。适合"领域之间依赖关系如何/哪些领域耦合度高"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const audits = DataSource.ctx.raw?.audits;
                if (!audits?.domains) return { success: false, error: '未找到领域依赖数据' };
                const d = audits.domains;
                return {
                    success: true,
                    data: {
                        couplingRanking: (d.coupling || []).slice(0, 15).map((c) => ({
                            key: c.key, label: c.label, tableCount: c.tableCount,
                            outDegree: c.outDegree, inDegree: c.inDegree, totalDegree: c.totalDegree,
                        })),
                        coreDomains: d.coreDomains || [],
                        circularDeps: d.circularDeps || [],
                    },
                    summary: `${(d.coupling || []).length} 个领域，核心领域 ${(d.coreDomains || []).length} 个，循环依赖 ${(d.circularDeps || []).length} 对`,
                };
            },
        });

        ToolRegistry.register({
            name: 'getDbEvolution',
            description: '获取模型演进分析：表数增长曲线、操作类型分布（按版本）、重大里程碑、领域首版出现时间、演进趋势。适合"数据库是如何演进的/哪个版本变化最大"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const audits = DataSource.ctx.raw?.audits;
                if (!audits?.evolution) return { success: false, error: '未找到演进分析数据' };
                const evo = audits.evolution;
                return {
                    success: true,
                    data: {
                        totalVersions: evo.totalVersions,
                        finalTableCount: evo.finalTableCount,
                        milestones: (evo.milestones || []).slice(0, 10),
                        trends: evo.trends || {},
                        domainFirstVersions: evo.domainFirstVersions || {},
                        sampleTimeline: (evo.timeline || []).slice(-10).map((t) => ({
                            version: t.version, description: t.description,
                            cumulativeTables: t.cumulativeTables, operationCount: t.operationCount,
                        })),
                    },
                    summary: `${evo.totalVersions} 个版本演进，最终 ${evo.finalTableCount} 张表`,
                };
            },
        });

        ToolRegistry.register({
            name: 'getDbNamingAudit',
            description: '获取命名规范审计结果：表名/主键/外键列/时间戳/软删除/索引命名问题统计及优化建议。适合"命名规范如何/有哪些命名不统一的问题"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const audits = DataSource.ctx.raw?.audits;
                if (!audits?.naming) return { success: false, error: '未找到命名审计数据' };
                const n = audits.naming;
                return {
                    success: true,
                    data: {
                        stats: n.stats,
                        topIssues: (n.issues || []).slice(0, 15).map((i) => ({ severity: i.severity, type: i.type, message: i.message })),
                        recommendations: n.recommendations || [],
                    },
                    summary: `命名问题 ${n.stats?.total || 0} 个（高${n.stats?.high || 0}/中${n.stats?.medium || 0}/低${n.stats?.low || 0}）`,
                };
            },
        });

        ToolRegistry.register({
            name: 'getDbImpact',
            description: '获取指定迁移版本的影响分析：受影响表（新增/修改/删除）、级联影响（外键引用被修改表的其他表）、风险等级（high/medium/low）、操作类型汇总。适合"某个版本影响哪些表/有什么风险/Vx.x 有什么变化"',
            parameters: { type: 'object', properties: { version: { type: 'string', description: '迁移版本号，如 V2.1.0 或 V2__add_user_table 中的 V2' } }, required: ['version'] },
            execute(args) {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const version = String(args.version || '').trim();
                if (!version) return { success: false, error: '缺少 version 参数' };
                const migrations = DataSource.ctx.byType.migrations || [];
                const fks = DataSource.ctx.byType.foreignKeys || [];
                const tables = DataSource.ctx.byType.tables || [];
                // 模糊匹配版本（支持 V2.1 / V2.1.0 / 完整版本号）
                const matched = migrations.filter((m) => {
                    const v = m.version || '';
                    return v === version || v.startsWith(version + '.') || v.startsWith(version + '__') || v.startsWith(version + '_');
                });
                if (!matched.length) {
                    // 再尝试宽松匹配
                    const loose = migrations.filter((m) => (m.version || '').includes(version));
                    if (!loose.length) return { success: false, error: `未找到版本 "${version}" 的迁移` };
                    matched.push(...loose.slice(0, 5));
                }
                // 汇总受影响的表
                const affectedTables = new Set();
                const createdTables = [];
                const alteredTables = [];
                const droppedTables = [];
                let totalOps = 0;
                let highRiskOps = 0;
                for (const mig of matched) {
                    const summary = mig.operationSummary || {};
                    totalOps += (summary.createTable || 0) + (summary.alterTable || 0) + (summary.dropTable || 0) + (summary.createIndex || 0);
                    highRiskOps += (summary.dropTable || 0) + Math.floor((summary.alterTable || 0) * 0.3);
                    const tbls = mig.tablesAffected || mig.involvedTables || [];
                    for (const t of tbls) affectedTables.add(typeof t === 'string' ? t : t.name);
                }
                // 按操作类型分类
                for (const t of affectedTables) {
                    const tbl = tables.find((x) => x.name === t);
                    if (tbl) {
                        if (tbl.migrationVersion && matched.some((m) => m.version === tbl.migrationVersion)) {
                            createdTables.push(t);
                        } else {
                            alteredTables.push(t);
                        }
                    }
                }
                // 级联影响：外键引用了被修改表的其他表
                const cascadeImpact = [];
                for (const fk of fks) {
                    if (affectedTables.has(fk.toTable) && !affectedTables.has(fk.fromTable)) {
                        cascadeImpact.push({ table: fk.fromTable, dependsOn: fk.toTable, fkName: fk.name });
                    }
                }
                // 风险等级
                const riskLevel = highRiskOps > 0 ? 'high' : totalOps > 5 ? 'medium' : 'low';
                const riskColor = riskLevel === 'high' ? '#e74c3c' : riskLevel === 'medium' ? '#f39c12' : '#27ae60';
                return {
                    success: true,
                    data: {
                        version,
                        matchedMigrations: matched.length,
                        migrationList: matched.map((m) => ({ version: m.version, description: m.description, fileName: m.fileName })),
                        affectedTableCount: affectedTables.size,
                        createdTables: createdTables.slice(0, 20),
                        alteredTables: alteredTables.slice(0, 20),
                        cascadeImpactCount: cascadeImpact.length,
                        cascadeImpactTop: cascadeImpact.slice(0, 15),
                        riskLevel,
                        totalOperations: totalOps,
                    },
                    summary: `版本 ${version} 涉及 ${matched.length} 个迁移，影响 ${affectedTables.size} 张表，级联影响 ${cascadeImpact.length} 张表，风险等级：${riskLevel}`,
                };
            },
        });

        ToolRegistry.register({
            name: 'getDbFkChain',
            description: '获取指定表的外键链路分析：下游影响链（哪些表引用了它）、上游依赖链（它引用了哪些表）、级联删除路径、循环引用、扇入/扇出。适合"某张表的上下游依赖关系/删除某表会影响哪些表"',
            parameters: { type: 'object', properties: { tableName: { type: 'string', description: '表名' } }, required: ['tableName'] },
            execute(args) {
                const err = dbNeedsData(); if (err) return { success: false, error: err };
                const tableName = String(args.tableName || '').trim();
                if (!tableName) return { success: false, error: '缺少 tableName 参数' };
                // 简单 BFS 实现（避免依赖 dbAuditor 模块）
                const tables = DataSource.ctx.byType.tables || [];
                const fks = DataSource.ctx.byType.foreignKeys || [];
                const tableNames = new Set(tables.map((t) => t.name));
                if (!tableNames.has(tableName)) return { success: false, error: `未找到表 "${tableName}"` };
                const incoming = new Map();
                const outgoing = new Map();
                for (const fk of fks) {
                    if (!outgoing.has(fk.fromTable)) outgoing.set(fk.fromTable, []);
                    outgoing.get(fk.fromTable).push(fk);
                    if (!incoming.has(fk.toTable)) incoming.set(fk.toTable, []);
                    incoming.get(fk.toTable).push(fk);
                }
                function bfs(start, adjMap, neighborKey) {
                    const visited = []; const depthMap = new Map([[start, 0]]); const queue = [start];
                    while (queue.length) {
                        const cur = queue.shift(); const depth = depthMap.get(cur) || 0;
                        const edges = adjMap.get(cur) || [];
                        for (const e of edges) {
                            const next = e[neighborKey];
                            if (next === start || depthMap.has(next)) continue;
                            depthMap.set(next, depth + 1);
                            visited.push({ table: next, depth: depth + 1, fkName: e.name });
                            queue.push(next);
                        }
                    }
                    return visited;
                }
                const downstream = bfs(tableName, incoming, 'fromTable');
                const upstream = bfs(tableName, outgoing, 'toTable');
                const fanIn = (incoming.get(tableName) || []).length;
                const fanOut = (outgoing.get(tableName) || []).length;
                return {
                    success: true,
                    data: {
                        tableName, fanIn, fanOut,
                        downstreamCount: downstream.length,
                        downstreamTop: downstream.slice(0, 10),
                        upstreamCount: upstream.length,
                        upstreamTop: upstream.slice(0, 10),
                    },
                    summary: `${tableName}: 下游 ${downstream.length} 张表依赖，上游依赖 ${upstream.length} 张表，扇入 ${fanIn}，扇出 ${fanOut}`,
                };
            },
        });
    }

    // ============================================================
    // ============================================================
    //  部署分析工具（仅在 PAGE_TYPE === 'deploy' 时注册）
    // ============================================================
    function registerDeployTools() {
        const dpNeedsData = () => {
            if (DataSource.status !== 'ready' || !DataSource.ctx) return '数据尚未加载';
            return null;
        };
        const dpMatch = (o, kw) => {
            kw = String(kw ?? '').trim().toLowerCase();
            if (!kw) return true;
            return [o.name, o.gateway, o.from, o.to, o.path, o.image, o.label, o.kind].filter(Boolean).some((f) => String(f).toLowerCase().includes(kw));
        };

        ToolRegistry.register({
            name: 'getDeployStats',
            description: '获取部署架构整体统计：服务数、路由数、上游数、依赖数、中间件数、环境数、分层数、文件数、服务类型分布。适合回答"部署架构有多大/整体如何"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = dpNeedsData(); if (err) return { success: false, error: err };
                const { byType, meta, raw } = DataSource.ctx;
                const services = byType.services || [];
                const typeDist = {};
                for (const s of services) typeDist[s.typeLabel || s.type] = (typeDist[s.typeLabel || s.type] || 0) + 1;
                return {
                    success: true,
                    data: {
                        sourceDir: meta.sourceDir,
                        services: services.length,
                        routes: (byType.routes || []).length,
                        upstreams: (byType.upstreams || []).length,
                        dependencies: (byType.dependencies || []).length,
                        middleware: (byType.middleware || []).length,
                        environments: (byType.environments || []).length,
                        layers: (byType.layers || []).length,
                        files: (byType.files || []).length,
                        typeDistribution: typeDist,
                        parseErrors: meta.parseErrors || 0,
                        healthScore: raw?.audits?.health?.score,
                    },
                    summary: `${services.length} 个服务，${(byType.routes || []).length} 条路由，${(byType.middleware || []).length} 个中间件，${(byType.layers || []).length} 个分层`,
                };
            },
        });

        ToolRegistry.register({
            name: 'queryDeployServices',
            description: '查询部署服务列表，可按名称关键词、类型（gateway/frontend/backend/adapter/job/db/cache/storage/search/registry/observability/cicd/tool/app）、分层过滤。适合"有哪些服务/某类型服务"',
            parameters: { type: 'object', properties: { keyword: { type: 'string', description: '服务名/镜像关键词（模糊匹配）' }, type: { type: 'string', description: '服务类型（如 backend/adapter/gateway）' }, layer: { type: 'string', description: '分层（edge/frontend/backend/data 等）' }, limit: { type: 'number', description: '返回条数上限，默认30' } }, required: [] },
            execute(args) {
                const err = dpNeedsData(); if (err) return { success: false, error: err };
                const services = DataSource.ctx.byType.services || [];
                let hit = services;
                if (args.type) hit = hit.filter((s) => s.type === args.type);
                if (args.layer) hit = hit.filter((s) => s.layer === args.layer);
                if (args.keyword) hit = hit.filter((s) => dpMatch(s, args.keyword));
                const limit = Math.min(Number(args.limit) || 30, 80);
                const result = hit.slice(0, limit).map((s) => ({
                    name: s.name, type: s.typeLabel || s.type, layer: s.layerLabel || s.layer,
                    image: s.image, version: s.imageVersion, replicas: s.replicas,
                    ports: (s.containerPorts || []).join(',') || (s.ports || []).map((p) => p.container).join(','),
                    hasHealthcheck: s.hasHealthcheck, envCount: s.envCount,
                }));
                if (!result.length) return { success: false, error: `未找到匹配的服务${args.type ? `(类型 ${args.type})` : ''}` };
                return { success: true, data: result, summary: `${result.length} 个服务（共 ${services.length}）` };
            },
        });

        ToolRegistry.register({
            name: 'getServiceDeployDetails',
            description: '获取单个服务的部署详情：镜像/版本/registry、端口、探针、副本数、重启策略、资源限额、依赖、环境变量（敏感值已脱敏）、定义文件。适合"某服务怎么部署的"',
            parameters: { type: 'object', properties: { serviceName: { type: 'string', description: '服务名' } }, required: ['serviceName'] },
            execute(args) {
                const err = dpNeedsData(); if (err) return { success: false, error: err };
                const serviceName = String(args.serviceName || '').trim();
                if (!serviceName) return { success: false, error: '缺少 serviceName 参数' };
                const services = DataSource.ctx.byType.services || [];
                const s = services.find((x) => x.name === serviceName) || services.find((x) => x.name.toLowerCase() === serviceName.toLowerCase());
                if (!s) return { success: false, error: `未找到服务 "${serviceName}"` };
                const out = {
                    name: s.name, type: s.typeLabel || s.type, layer: s.layerLabel || s.layer,
                    image: s.image, registry: s.registry, version: s.imageVersion,
                    kind: s.kind, namespace: s.namespace, replicas: s.replicas,
                    ports: s.containerPorts, hostPorts: (s.ports || []).map((p) => p.host + ':' + p.container),
                    restart: s.restart, hasHealthcheck: s.hasHealthcheck,
                    readinessProbe: s.readinessProbe, livenessProbe: s.livenessProbe,
                    resources: s.resources, dependsOn: s.dependsOn,
                    envVariables: s.env, envCount: s.envCount,
                    configRefs: s.configRefs, buildFrom: s.buildFrom,
                    definedIn: (s.sources || []).map((x) => x.file),
                };
                return { success: true, data: out, summary: `服务 ${s.name}（${s.typeLabel || s.type}，镜像 ${s.image || '未知'}）` };
            },
        });

        ToolRegistry.register({
            name: 'queryDeployRoutes',
            description: '查询网关路由（nginx location → proxy_pass），可按网关/路径/目标服务过滤。适合"nginx 路由怎么配的/某路径转发到哪"',
            parameters: { type: 'object', properties: { gateway: { type: 'string', description: '网关名关键词' }, path: { type: 'string', description: '路径关键词（如 /api）' }, target: { type: 'string', description: '目标服务名关键词' }, limit: { type: 'number', description: '返回条数上限，默认50' } }, required: [] },
            execute(args) {
                const err = dpNeedsData(); if (err) return { success: false, error: err };
                const routes = DataSource.ctx.byType.routes || [];
                let hit = routes;
                if (args.gateway) hit = hit.filter((r) => String(r.gateway || '').toLowerCase().includes(String(args.gateway).toLowerCase()));
                if (args.path) hit = hit.filter((r) => String(r.path || '').toLowerCase().includes(String(args.path).toLowerCase()));
                if (args.target) hit = hit.filter((r) => String(r.resolvedService || r.externalHost || '').toLowerCase().includes(String(args.target).toLowerCase()));
                const limit = Math.min(Number(args.limit) || 50, 100);
                const result = hit.slice(0, limit).map((r) => ({
                    gateway: r.gateway, path: r.path, matchType: r.matchType, proxyPass: r.proxyPass,
                    targetService: r.resolvedService, externalHost: r.externalHost,
                    auth: r.authRequest ? true : false, websocket: r.websocket,
                }));
                if (!result.length) return { success: false, error: '未找到匹配的路由' };
                return { success: true, data: result, summary: `${result.length} 条路由（共 ${routes.length}）` };
            },
        });

        ToolRegistry.register({
            name: 'queryDeployUpstreams',
            description: '查询 nginx upstream 定义及后端服务器（含服务名解析结果）。适合"upstream 指向哪些后端"',
            parameters: { type: 'object', properties: { keyword: { type: 'string', description: 'upstream 名/网关名关键词' }, limit: { type: 'number', description: '返回条数上限，默认30' } }, required: [] },
            execute(args) {
                const err = dpNeedsData(); if (err) return { success: false, error: err };
                const upstreams = DataSource.ctx.byType.upstreams || [];
                let hit = upstreams;
                if (args.keyword) hit = hit.filter((u) => dpMatch(u, args.keyword));
                const limit = Math.min(Number(args.limit) || 30, 60);
                const result = hit.slice(0, limit).map((u) => ({
                    name: u.name, gateway: u.gateway,
                    servers: (u.servers || []).map((s) => ({ host: s.host, port: s.port, resolvedService: s.resolvedService })),
                }));
                if (!result.length) return { success: false, error: '未找到匹配的 upstream' };
                return { success: true, data: result, summary: `${result.length} 个 upstream（共 ${upstreams.length}）` };
            },
        });

        ToolRegistry.register({
            name: 'queryDeployDeps',
            description: '查询服务间依赖关系（depends_on 启动依赖 / env_ref 环境引用 / route 网关路由），可按来源/目标服务过滤。适合"谁依赖 mysql/服务依赖关系"',
            parameters: { type: 'object', properties: { from: { type: 'string', description: '来源服务名关键词' }, to: { type: 'string', description: '目标服务名关键词' }, type: { type: 'string', description: '依赖类型（depends_on/env_ref/route）' }, limit: { type: 'number', description: '返回条数上限，默认50' } }, required: [] },
            execute(args) {
                const err = dpNeedsData(); if (err) return { success: false, error: err };
                let deps = DataSource.ctx.byType.dependencies || [];
                if (args.from) deps = deps.filter((d) => String(d.from || d.source || '').toLowerCase().includes(String(args.from).toLowerCase()));
                if (args.to) deps = deps.filter((d) => String(d.to || d.target || '').toLowerCase().includes(String(args.to).toLowerCase()));
                if (args.type) deps = deps.filter((d) => d.type === args.type);
                const limit = Math.min(Number(args.limit) || 50, 100);
                const result = deps.slice(0, limit).map((d) => ({ from: d.from || d.source, to: d.to || d.target, type: d.type }));
                if (!result.length) return { success: false, error: '未找到匹配的依赖关系' };
                return { success: true, data: result, summary: `${result.length} 条依赖` };
            },
        });

        ToolRegistry.register({
            name: 'queryMiddleware',
            description: '查询部署中间件（MySQL/Redis/MinIO/ES/Nacos/PostgreSQL 等）及其版本、端口、消费方列表。适合"用了哪些中间件/redis 被谁用"',
            parameters: { type: 'object', properties: { kind: { type: 'string', description: '中间件类型（mysql/redis/minio/elasticsearch/nacos/postgresql）' }, keyword: { type: 'string', description: '名称关键词' } }, required: [] },
            execute(args) {
                const err = dpNeedsData(); if (err) return { success: false, error: err };
                let mws = DataSource.ctx.byType.middleware || [];
                if (args.kind) mws = mws.filter((m) => m.kind === args.kind);
                if (args.keyword) mws = mws.filter((m) => dpMatch(m, args.keyword));
                if (!mws.length) return { success: false, error: `未找到匹配的中间件${args.kind ? `(${args.kind})` : ''}` };
                const result = mws.map((m) => ({
                    label: m.label, kind: m.kind, name: m.name, version: m.version,
                    image: m.image, ports: m.ports, consumers: m.consumers || [],
                }));
                return { success: true, data: result, summary: `${result.length} 个中间件` };
            },
        });

        ToolRegistry.register({
            name: 'queryDeployEnvs',
            description: '查询环境配置文件（.env.prod/.env.sit 等）的变量统计与服务引用。适合"有哪些环境/环境差异概览"（变量值已脱敏）',
            parameters: { type: 'object', properties: { name: { type: 'string', description: '环境名关键词（如 prod/sit）' }, limit: { type: 'number', description: '变量展示上限，默认40' } }, required: [] },
            execute(args) {
                const err = dpNeedsData(); if (err) return { success: false, error: err };
                let envs = DataSource.ctx.byType.environments || [];
                if (args.name) envs = envs.filter((e) => String(e.name || '').toLowerCase().includes(String(args.name).toLowerCase()));
                if (!envs.length) return { success: false, error: '未找到匹配的环境配置' };
                const limit = Math.min(Number(args.limit) || 40, 100);
                const result = envs.map((e) => ({
                    name: e.name, file: e.file,
                    variableCount: e.variableCount, secretCount: e.secretCount,
                    serviceRefs: e.serviceRefs || [],
                    variables: (e.variables || []).slice(0, limit),
                }));
                return { success: true, data: result, summary: `${result.length} 个环境文件` };
            },
        });

        ToolRegistry.register({
            name: 'queryDeployFiles',
            description: '查询部署配置源文件（compose/k8s/nginx/dockerfile/env/shell/ci），可按类型过滤。适合"部署目录有哪些文件"',
            parameters: { type: 'object', properties: { type: { type: 'string', description: '文件类型（compose/k8s/nginx/dockerfile/env/shell/ci/config）' }, keyword: { type: 'string', description: '文件名关键词' }, limit: { type: 'number', description: '返回条数上限，默认50' } }, required: [] },
            execute(args) {
                const err = dpNeedsData(); if (err) return { success: false, error: err };
                let files = DataSource.ctx.byType.files || [];
                if (args.type) files = files.filter((f) => f.type === args.type);
                if (args.keyword) files = files.filter((f) => String(f.relativePath || f.fileName || '').toLowerCase().includes(String(args.keyword).toLowerCase()));
                const limit = Math.min(Number(args.limit) || 50, 120);
                const result = files.slice(0, limit).map((f) => ({
                    path: f.relativePath || f.fileName, type: f.type, fileSize: f.fileSize,
                    serviceCount: f.serviceCount, kinds: f.kinds,
                    routeCount: f.routeCount, upstreamCount: f.upstreamCount,
                    baseImage: f.baseImage, variableCount: f.variableCount,
                }));
                if (!result.length) return { success: false, error: `未找到匹配的部署文件${args.type ? `(类型 ${args.type})` : ''}` };
                return { success: true, data: result, summary: `${result.length} 个文件（共 ${files.length}）` };
            },
        });

        ToolRegistry.register({
            name: 'queryDeployLayers',
            description: '查询部署架构分层（接入层/前端层/应用服务层/适配器层/任务层/数据层/可观测层/CI-CD层/工具层）及各层服务清单。适合"分层架构如何划分"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = dpNeedsData(); if (err) return { success: false, error: err };
                const layers = DataSource.ctx.byType.layers || [];
                if (!layers.length) return { success: false, error: '无分层数据' };
                const result = layers.map((l) => ({
                    label: l.label, key: l.key,
                    services: (l.services || l.serviceNames || []).map((s) => (typeof s === 'string' ? s : s.name)),
                }));
                return { success: true, data: result, summary: `${result.length} 个分层` };
            },
        });

        ToolRegistry.register({
            name: 'getDeployHealth',
            description: '获取部署架构健康度总评：综合评分、等级（A-E）、四维得分（安全/高可用/配置一致性/依赖）、Top 问题。适合"部署架构健康吗/有什么风险"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = dpNeedsData(); if (err) return { success: false, error: err };
                const audits = DataSource.ctx.raw?.audits;
                if (!audits?.health) return { success: false, error: '未找到健康度审计数据，请确保使用最新版 nice-aos deploy export 生成蓝图' };
                const h = audits.health;
                return {
                    success: true,
                    data: {
                        score: h.score, grade: h.grade,
                        errorCount: h.errorCount, warnCount: h.warnCount, infoCount: h.infoCount,
                        dimensions: (h.dimensions || []).map((d) => ({ label: d.label, score: d.score, weight: d.weight })),
                        topFindings: (h.topFindings || []).slice(0, 10).map((f) => ({ level: f.level, title: f.title, detail: f.detail })),
                    },
                    summary: `健康度 ${h.score} 分（等级 ${h.grade}），${h.errorCount} 错误 / ${h.warnCount} 警告 / ${h.infoCount} 提示`,
                };
            },
        });

        ToolRegistry.register({
            name: 'getDeployAudit',
            description: '获取部署审计明细：安全（latest镜像/明文敏感值/端口暴露/无鉴权路由）、高可用（健康检查/探针/副本/限额）、一致性（环境漂移）、依赖（断链/循环依赖）。参数 scenario: security/resilience/configConsistency/dependency',
            parameters: { type: 'object', properties: { scenario: { type: 'string', description: '审计场景（security/resilience/configConsistency/dependency）' } }, required: ['scenario'] },
            execute(args) {
                const err = dpNeedsData(); if (err) return { success: false, error: err };
                const audits = DataSource.ctx.raw?.audits;
                if (!audits) return { success: false, error: '未找到审计数据，请确保使用最新版 nice-aos deploy export 生成蓝图' };
                const scenario = String(args.scenario || '').trim();
                const a = audits[scenario];
                if (!a) return { success: false, error: `未知审计场景 "${scenario}"（支持 security / resilience / configConsistency / dependency）` };
                return {
                    success: true,
                    data: {
                        label: a.label, score: a.score, stats: a.stats,
                        findings: (a.findings || []).slice(0, 20).map((f) => ({ level: f.level, title: f.title, detail: f.detail, location: f.location })),
                    },
                    summary: `${a.label}：得分 ${a.score}，${(a.findings || []).length} 项发现`,
                };
            },
        });
    }

    // ============================================================
    //  后端服务蓝图工具（仅在 PAGE_TYPE === 'service' 时注册）
    // ============================================================
    function registerServiceTools() {
        const svNeedsData = () => {
            if (DataSource.status !== 'ready' || !DataSource.ctx) return '数据尚未加载';
            return null;
        };
        const svMatch = (o, kw) => {
            kw = String(kw ?? '').trim().toLowerCase();
            if (!kw) return true;
            return [o.name, o.key, o.label, o.path, o.className, o.httpMethod, o.category, o.moduleKey, o.location].filter(Boolean).some((f) => String(f).toLowerCase().includes(kw));
        };

        ToolRegistry.register({
            name: 'getServiceStats',
            description: '获取后端服务整体统计：文件/包/类/枚举/接口/方法/端点/表/依赖/测试/分析错误数、HTTP 方法分布、技术栈清单、健康分。适合"这个 Java 后端有多大/整体如何/技术栈是什么"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = svNeedsData(); if (err) return { success: false, error: err };
                const { byType, meta, raw } = DataSource.ctx;
                const s = meta;
                return {
                    success: true,
                    data: {
                        repositoryName: s.repositoryName,
                        modulePrefixSource: s.modulePrefixSource,
                        files: s.fileCount, packages: s.packageCount,
                        classes: s.classCount, enums: s.enumCount, interfaces: s.interfaceCount, methods: s.methodCount,
                        endpoints: s.endpointCount, tables: s.tableCount, dependencies: s.dependencyCount,
                        tests: s.testMethodCount, analysisErrors: s.analysisErrorCount,
                        avgCyclomatic: s.avgCyclomatic,
                        endpointByMethod: s.endpointByMethod,
                        modules: (byType.modules || []).length,
                        layers: (byType.layers || []).length,
                        techStack: (byType.techStack || []).map((t) => `${t.label}×${t.count}`),
                        healthScore: raw?.audits?.health?.score,
                        healthGrade: raw?.audits?.health?.grade,
                    },
                    summary: `${s.classCount + s.enumCount} 个类 / ${s.methodCount} 方法 / ${s.endpointCount} 端点 / ${s.tableCount} 表 / ${s.dependencyCount} 依赖，健康分 ${raw?.audits?.health?.score ?? '-'}`,
                };
            },
        });

        ToolRegistry.register({
            name: 'queryServiceModules',
            description: '查询后端服务模块列表：包数/类/接口/方法/端点/职责。可按模块 key 或标签关键词过滤。适合"有哪些模块/模块规模/职责"',
            parameters: { type: 'object', properties: { keyword: { type: 'string', description: '模块 key/标签关键词（如 core/adapter）' }, limit: { type: 'number', description: '返回条数上限，默认30' } }, required: [] },
            execute(args) {
                const err = svNeedsData(); if (err) return { success: false, error: err };
                const modules = DataSource.ctx.byType.modules || [];
                let hit = modules;
                if (args.keyword) hit = hit.filter((m) => svMatch(m, args.keyword));
                const limit = Math.min(Number(args.limit) || 30, 80);
                const result = hit.slice(0, limit).map((m) => ({
                    key: m.key, label: m.label, packagePrefix: m.packagePrefix,
                    packageCount: m.packageCount, classCount: m.classCount, interfaceCount: m.interfaceCount,
                    methodCount: m.methodCount, endpointCount: m.endpointCount, responsibility: m.responsibility,
                }));
                if (!result.length) return { success: false, error: `未找到匹配的模块${args.keyword ? `(关键词 ${args.keyword})` : ''}` };
                return { success: true, data: result, summary: `${result.length} 个模块（共 ${modules.length}）` };
            },
        });

        ToolRegistry.register({
            name: 'queryServiceLayers',
            description: '查询后端服务架构分层：接口层/业务层/数据访问/Mapper/实体/DTO/配置/适配/任务/工具 的类/接口/方法/端点统计。适合"分层架构/Controller 和 Service 各多少"',
            parameters: { type: 'object', properties: { keyword: { type: 'string', description: '分层 key/标签关键词（如 controller/service/repository）' }, limit: { type: 'number', description: '返回条数上限，默认30' } }, required: [] },
            execute(args) {
                const err = svNeedsData(); if (err) return { success: false, error: err };
                const layers = DataSource.ctx.byType.layers || [];
                let hit = layers;
                if (args.keyword) hit = hit.filter((l) => svMatch(l, args.keyword));
                const limit = Math.min(Number(args.limit) || 30, 50);
                const result = hit.slice(0, limit).map((l) => ({
                    key: l.key, label: l.label, packageCount: l.packageCount,
                    classCount: l.classCount, interfaceCount: l.interfaceCount,
                    methodCount: l.methodCount, endpointCount: l.endpointCount,
                }));
                if (!result.length) return { success: false, error: `未找到匹配的分层${args.keyword ? `(关键词 ${args.keyword})` : ''}` };
                return { success: true, data: result, summary: `${result.length} 个分层（共 ${layers.length}）` };
            },
        });

        ToolRegistry.register({
            name: 'queryServiceEndpoints',
            description: '查询 REST API 端点：HTTP 方法/路径/框架/Controller 类/领域前缀/模块。可按 HTTP 方法、路径关键词、Controller、领域过滤。适合"有哪些 API 端点/GET 接口"',
            parameters: { type: 'object', properties: { method: { type: 'string', description: 'HTTP 方法（GET/POST/PUT/DELETE/PATCH）' }, path: { type: 'string', description: '路径关键词（如 /users）' }, controller: { type: 'string', description: 'Controller 类名关键词' }, domain: { type: 'string', description: '领域前缀（如 users/projects）' }, limit: { type: 'number', description: '返回条数上限，默认50' } }, required: [] },
            execute(args) {
                const err = svNeedsData(); if (err) return { success: false, error: err };
                const eps = DataSource.ctx.byType.endpoints || [];
                let hit = eps;
                if (args.method) hit = hit.filter((e) => String(e.httpMethod).toUpperCase() === String(args.method).toUpperCase());
                if (args.path) hit = hit.filter((e) => String(e.path || '').toLowerCase().includes(String(args.path).toLowerCase()));
                if (args.controller) hit = hit.filter((e) => String(e.className || '').toLowerCase().includes(String(args.controller).toLowerCase()));
                if (args.domain) hit = hit.filter((e) => String(e.domainPrefix || '').toLowerCase().includes(String(args.domain).toLowerCase()));
                const limit = Math.min(Number(args.limit) || 50, 100);
                const result = hit.slice(0, limit).map((e) => ({
                    method: e.httpMethod, path: e.path || '(类级路径)', className: e.className,
                    domainPrefix: e.domainPrefix, moduleKey: e.moduleKey, hasPathVariables: e.hasPathVariables,
                }));
                if (!result.length) return { success: false, error: '未找到匹配的端点' };
                return { success: true, data: result, summary: `${result.length} 个端点（共 ${eps.length}）` };
            },
        });

        ToolRegistry.register({
            name: 'queryServiceTables',
            description: '查询后端数据库表：列数/主键/外键数/实体映射/孤儿表标记。可按表名关键词过滤、按 isOrphan=true 查孤儿表。适合"有哪些表/孤儿表/实体映射"',
            parameters: { type: 'object', properties: { keyword: { type: 'string', description: '表名关键词' }, isOrphan: { type: 'boolean', description: '仅孤儿表（无实体映射且无外键）' }, limit: { type: 'number', description: '返回条数上限，默认50' } }, required: [] },
            execute(args) {
                const err = svNeedsData(); if (err) return { success: false, error: err };
                const tables = DataSource.ctx.byType.tables || [];
                let hit = tables;
                if (args.isOrphan === true) hit = hit.filter((t) => t.isOrphan);
                if (args.keyword) hit = hit.filter((t) => String(t.name || '').toLowerCase().includes(String(args.keyword).toLowerCase()));
                const limit = Math.min(Number(args.limit) || 50, 100);
                const result = hit.slice(0, limit).map((t) => ({
                    name: t.name, comment: t.comment, columnCount: t.columnCount, primaryKey: t.primaryKey,
                    fkCount: t.fkCount, matchedEntityClass: t.matchedEntityClass || null,
                    isOrphan: t.isOrphan, orphanReason: t.orphanReason,
                }));
                if (!result.length) return { success: false, error: '未找到匹配的表' };
                return { success: true, data: result, summary: `${result.length} 张表（共 ${tables.length}${tables.filter((t) => t.isOrphan).length > 0 ? `，其中孤儿表 ${tables.filter((t) => t.isOrphan).length}` : ''}）` };
            },
        });

        ToolRegistry.register({
            name: 'queryServiceDeps',
            description: '查询外部依赖与技术栈：依赖名/版本/scope/技术分类。可按分类（jpa/spring-boot/redis/elasticsearch/mysql/minio/jjwt 等）或关键词过滤。适合"用了哪些技术/某依赖版本/技术栈"',
            parameters: { type: 'object', properties: { category: { type: 'string', description: '技术分类（jpa/redis/spring-security/minio/spring-boot 等）' }, keyword: { type: 'string', description: '依赖名关键词（如 jjwt/minio）' }, limit: { type: 'number', description: '返回条数上限，默认50' } }, required: [] },
            execute(args) {
                const err = svNeedsData(); if (err) return { success: false, error: err };
                const deps = DataSource.ctx.byType.dependencies || [];
                const techStack = DataSource.ctx.byType.techStack || [];
                let hit = deps;
                if (args.category) hit = hit.filter((d) => d.category === args.category);
                if (args.keyword) hit = hit.filter((d) => String(d.name || '').toLowerCase().includes(String(args.keyword).toLowerCase()));
                const limit = Math.min(Number(args.limit) || 50, 100);
                const result = hit.slice(0, limit).map((d) => ({
                    name: d.name, version: d.version || '(未指定)', scope: d.scope, source: d.source, category: d.category, label: d.label,
                }));
                return {
                    success: true,
                    data: { techStack: techStack.map((t) => `${t.label}×${t.count}`), dependencies: result, total: deps.length },
                    summary: `技术栈 ${techStack.length} 类；依赖 ${result.length} 项（共 ${deps.length}）`,
                };
            },
        });

        ToolRegistry.register({
            name: 'getServiceQuality',
            description: '获取代码质量：高复杂度方法 TOP（圈复杂度/嵌套深度/位置/模块）+ 测试统计（单元/集成/测试类）。适合"哪些方法复杂度高/重构对象/测试覆盖"',
            parameters: { type: 'object', properties: { limit: { type: 'number', description: '热点条数上限，默认20' } }, required: [] },
            execute(args) {
                const err = svNeedsData(); if (err) return { success: false, error: err };
                const hotspots = DataSource.ctx.byType.complexityHotspots || [];
                const testStats = (DataSource.ctx.byType.testStats || [])[0] || {};
                const limit = Math.min(Number(args.limit) || 20, 50);
                return {
                    success: true,
                    data: {
                        hotspots: hotspots.slice(0, limit).map((h) => ({
                            cyclomaticComplexity: h.cyclomaticComplexity, location: h.location,
                            maxNestingDepth: h.maxNestingDepth, branchCount: h.branchCount, loopCount: h.loopCount, moduleKey: h.moduleKey,
                        })),
                        testStats: {
                            total: testStats.total, unitTest: testStats.unitTest, integrationTest: testStats.integrationTest,
                            testSetup: testStats.testSetup, testClassCount: testStats.testClassCount,
                            byClass: (testStats.byClass || []).slice(0, 10),
                        },
                    },
                    summary: `热点方法 ${hotspots.length} 个（cc≥15）；测试 ${testStats.total ?? 0} 个（单元 ${testStats.unitTest ?? 0} / 集成 ${testStats.integrationTest ?? 0}）`,
                };
            },
        });

        ToolRegistry.register({
            name: 'getServiceHealth',
            description: '获取后端服务健康度总评：综合评分、等级（A-E）、五维得分（代码复杂度/数据层/测试覆盖率/分析质量/依赖健康）、Top 问题。适合"后端服务健康吗/有什么风险"',
            parameters: { type: 'object', properties: {}, required: [] },
            execute() {
                const err = svNeedsData(); if (err) return { success: false, error: err };
                const h = DataSource.ctx.raw?.audits?.health;
                if (!h) return { success: false, error: '未找到健康度审计数据，请确保使用最新版 nice-aos service export 生成蓝图' };
                return {
                    success: true,
                    data: {
                        score: h.score, grade: h.grade,
                        errorCount: h.errorCount, warnCount: h.warnCount, infoCount: h.infoCount,
                        dimensions: (h.dimensions || []).map((d) => ({ label: d.label, score: d.score, weight: d.weight })),
                        topFindings: (h.topFindings || []).slice(0, 10).map((f) => ({ level: f.level, title: f.title, detail: f.detail })),
                    },
                    summary: `健康度 ${h.score} 分（等级 ${h.grade}），${h.errorCount} 错误 / ${h.warnCount} 警告 / ${h.infoCount} 提示`,
                };
            },
        });

        ToolRegistry.register({
            name: 'getServiceAudit',
            description: '获取服务健康审计明细：代码复杂度/数据层健康/测试覆盖率/分析质量/依赖健康。参数 dimension: complexity/dataHealth/testCoverage/analysisQuality/dependencyHealth',
            parameters: { type: 'object', properties: { dimension: { type: 'string', description: '审计维度（complexity/dataHealth/testCoverage/analysisQuality/dependencyHealth）' } }, required: ['dimension'] },
            execute(args) {
                const err = svNeedsData(); if (err) return { success: false, error: err };
                const audits = DataSource.ctx.raw?.audits;
                if (!audits) return { success: false, error: '未找到审计数据，请确保使用最新版 nice-aos service export 生成蓝图' };
                const dimension = String(args.dimension || '').trim();
                const a = audits[dimension];
                if (!a) return { success: false, error: `未知审计维度 "${dimension}"（支持 complexity / dataHealth / testCoverage / analysisQuality / dependencyHealth）` };
                return {
                    success: true,
                    data: {
                        label: a.label, score: a.score, stats: a.stats,
                        findings: (a.findings || []).slice(0, 20).map((f) => ({ level: f.level, title: f.title, detail: f.detail, location: f.location })),
                    },
                    summary: `${a.label}：得分 ${a.score}，${(a.findings || []).length} 项发现`,
                };
            },
        });

        ToolRegistry.register({
            name: 'queryServiceGraph',
            description: '查询后端服务图谱关系：模块依赖（moduleView：模块间包依赖/跨模块调用）、分层调用流（layerView：跨层方法调用）、模块×技术栈（techView：模块使用哪些技术）。参数 view: module/layer/tech',
            parameters: { type: 'object', properties: { view: { type: 'string', description: '视图（module/layer/tech），缺省返回全部' } }, required: [] },
            execute(args) {
                const err = svNeedsData(); if (err) return { success: false, error: err };
                const g = DataSource.ctx.byType.moduleGraph[0];
                if (!g) return { success: false, error: '未找到图谱数据，请确保使用最新版 nice-aos service export 生成蓝图' };
                const pick = (view) => {
                    const v = g[view + 'View'];
                    if (!v) return null;
                    return {
                        nodes: v.nodes.map((n) => ({ name: n.name, size: n.classCount || n.methodCount || n.count })),
                        edges: v.edges.slice(0, 30).map((e) => ({ source: e.source, target: e.target, weight: e.weight, kind: e.kind || null })),
                        nodeCount: v.nodeCount, edgeCount: v.edgeCount,
                    };
                };
                const result = {};
                if (!args.view || args.view === 'module') result.moduleGraph = pick('module');
                if (!args.view || args.view === 'layer') result.layerFlow = pick('layer');
                if (!args.view || args.view === 'tech') result.moduleTech = pick('tech');
                return { success: true, data: result, summary: `模块依赖 ${g.moduleView?.edgeCount ?? 0} 边 / 分层调用流 ${g.layerView?.edgeCount ?? 0} 边 / 模块×技术栈 ${g.techView?.edgeCount ?? 0} 边` };
            },
        });
    }

    function currentViewContext() {
        const activeTab = $d('.bp-tab-btn.is-active, .tab-btn.is-active, nav .active, [aria-selected="true"]');
        const activeText = activeTab ? activeTab.textContent.trim() : '';
        const hash = location.hash || '';
        const title = document.title || '';
        return { title: title.slice(0, 60), activeTab: activeText, hash };
    }

    // ============================================================
    //  Agent 引擎（多模型 + ReAct 工具循环 + 流式）
    // ============================================================
    let abortFlag = false;

    // ============================================================
    //  智能体定义（多场景切换）
    // ============================================================
    const AGENTS = {
        // 代码蓝图页：本体蓝图智能体
        code_ontology: {
            key: 'code_ontology',
            label: '本体蓝图',
            icon: 'sitemap',
            description: '代码本体结构问答',
            pageType: 'code',
            systemPrompt: `你是「nice-aos 蓝图 AI 代码分析助手」，运行在项目代码本体蓝图页上。你可以调用代码分析工具查询项目结构（模块/组件/Hook/Store/Service/路由/接口/类/依赖/功能域/死代码等）。
分析代码问题时：
- 优先调用工具获取真实数据，禁止凭记忆编造项目不存在的信息；
- 工具返回的结构化数据，用清晰的中文 Markdown 汇总，保持简洁；
- 涉及"引用/依赖/调用关系"时用 listLinks，涉及整体规模时用 getStats，涉及具体对象详情时用 getNodeDetails；
- 工具返回 success:false 或找不到数据时，如实告知并建议其它查询方式。
注意：你讨论的是"代码本体蓝图快照"数据（来自 aos 扫描生成 snapshot.json），字段含义：archLayer=架构分层，domain=功能域，fileId/filePath=源文件，orphanCandidates/死代码候选=未被引用的可疑代码。
当前数据源：\${DataSource.ctx?.sourceLabel || '未加载'}。`,
            suggestedQuestions: [
                '项目整体结构如何？有多少源文件和组件',
                '有哪些 Service 和 Store？',
                '列出所有死代码候选',
                '架构分层是怎样的？',
                '存在循环依赖吗？',
                '依赖治理情况：未使用的依赖',
            ],
        },

        // 部署蓝图页：部署架构智能体
        deploy_architecture: {
            key: 'deploy_architecture',
            label: '部署蓝图',
            icon: 'server',
            description: '服务/镜像/路由/依赖/中间件/环境/分层/审计问答',
            pageType: 'deploy',
            systemPrompt: `你是「部署架构分析智能体」，运行在部署架构蓝图页（deployoverview）上。你的专长是部署配置层面的问答：服务清单、镜像与版本、网关路由（nginx location → proxy_pass / upstream）、服务依赖（depends_on / 环境引用 / 路由推导）、中间件（MySQL/Redis/MinIO/ES/Nacos 等）及消费方、环境配置、部署分层、以及部署审计（安全/高可用/配置一致性/依赖）。
分析部署问题时：
- 优先调用工具获取真实数据，禁止凭记忆编造部署配置不存在的信息；
- 工具返回的结构化数据，用清晰的中文 Markdown 表格或列表汇总，保持简洁；
- 涉及"整体规模/有多少服务"时用 getDeployStats，涉及"某服务详情"时用 getServiceDeployDetails（传 serviceName）；
- 涉及"nginx 路由/某路径转发到哪"时用 queryDeployRoutes，涉及"upstream 后端"时用 queryDeployUpstreams；
- 涉及"谁依赖谁/依赖 mysql 的服务"时用 queryDeployDeps（from/to/type 过滤），涉及"中间件版本与消费方"时用 queryMiddleware；
- 涉及"环境差异/有哪些 .env"时用 queryDeployEnvs，涉及"分层架构"时用 queryDeployLayers，涉及"部署文件清单"时用 queryDeployFiles；
- 涉及"健康度/风险"时用 getDeployHealth，涉及某一审计维度明细（security/resilience/configConsistency/dependency）时用 getDeployAudit（传 scenario）；
- 工具返回 success:false 或找不到数据时，如实告知并建议其它查询方式。
注意：数据来自 aos deploy scan 生成的部署架构快照（Dockerfile / docker-compose / K8s manifest / nginx.conf / .env 解析归一化）。字段含义：type=服务类型（gateway/frontend/backend/adapter/job/db/cache/storage/search/registry/observability/cicd/tool），layer=部署分层，imageVersion=镜像版本 tag，envRef=环境变量推导的依赖，configRefs=K8s ConfigMap/Secret 引用。环境变量敏感值（密码/密钥/token）已自动脱敏。
当前数据源：\${DataSource.ctx?.sourceLabel || '未加载'}。`,
            suggestedQuestions: [
                '部署架构整体如何？有多少服务和分层？',
                'nginx 路由是怎么配置的？',
                '用了哪些中间件？版本是多少？',
                '哪些服务依赖 mysql？',
                '部署架构健康吗？有什么风险？',
                '有哪些环境配置？',
            ],
        },

        // Java 后端服务蓝图页：后端服务智能体
        service_blueprint: {
            key: 'service_blueprint',
            label: '服务蓝图',
            icon: 'server',
            description: '模块/分层/API/数据层/技术栈/质量/健康/图谱问答',
            pageType: 'service',
            systemPrompt: `你是「Java 后端服务分析智能体」，运行在后端服务蓝图页（service-blueprint）上。你的专长是基于 asdm-aos Java 后端本体快照的服务层面问答：模块架构、架构分层（Controller/Service/Repository/Mapper/Entity/DTO/Config/Adapter/任务/工具）、API 面、数据层（表/实体映射/孤儿表/外键链）、技术栈判定（JPA/MyBatis/Spring Security/JJWT/ShedLock/SpringDoc/Redis/ES/S3/OBS/MinIO 等）、代码质量（高复杂度方法/测试统计）、五维健康审计、以及模块间关系图谱。
分析服务问题时：
- 优先调用工具获取真实数据，禁止凭记忆编造后端项目不存在的信息；
- 工具返回的结构化数据，用清晰的中文 Markdown 表格或列表汇总，保持简洁；
- 涉及"整体规模/技术栈是什么"时用 getServiceStats，涉及"模块划分/职责"时用 queryServiceModules；
- 涉及"分层架构/Controller 和 Service 各多少"时用 queryServiceLayers，涉及"API 端点/GET 接口"时用 queryServiceEndpoints；
- 涉及"数据库表/孤儿表/实体映射"时用 queryServiceTables，涉及"用了哪些技术/某依赖版本"时用 queryServiceDeps；
- 涉及"高复杂度方法/重构对象/测试覆盖"时用 getServiceQuality，涉及"模块间依赖/分层调用流/模块用了哪些技术"时用 queryServiceGraph；
- 涉及"健康度/风险"时用 getServiceHealth，涉及某一审计维度明细（complexity/dataHealth/testCoverage/analysisQuality/dependencyHealth）时用 getServiceAudit（传 dimension）；
- 工具返回 success:false 或找不到数据时，如实告知并建议其它查询方式。
注意：数据来自 aos service 命令基于 asdm-aos 本体快照构建的后端服务蓝图快照。字段含义：moduleKey=模块（按包前缀动态推导），layerKey=分层，endpointInfo=API 端点，matchedEntityClass=实体映射的表，isOrphan=孤儿表（无实体且无外键），complexityHotspots=圈复杂度≥15 的高复杂度方法，audits.health=五维健康评分（A=优秀, B=良好, C=一般, D=待改进, E=较差）。
当前数据源：\${DataSource.ctx?.sourceLabel || '未加载'}。`,
            suggestedQuestions: [
                '这个 Java 后端整体如何？技术栈是什么？',
                '有哪些服务模块？各自规模与职责？',
                '分层架构是怎样的？Controller 和 Service 各多少？',
                '有多少 API 端点？GET 接口有哪些？',
                '数据库有哪些表？有孤儿表吗？',
                '哪些方法复杂度高？需要重构吗？',
                '后端服务健康吗？有什么风险？',
                '模块之间有什么关系？分层调用流如何？',
            ],
        },

        // 数据库蓝图页：结构智能体（默认）
        db_structure: {
            key: 'db_structure',
            label: '结构分析',
            icon: 'database',
            description: '表/列/外键/索引/迁移/领域结构问答',
            pageType: 'database',
            systemPrompt: `你是「数据库结构分析智能体」，运行在数据库结构蓝图页上。你的专长是数据库结构层面的问答：表定义、列结构、主键外键、索引、迁移历史、领域分组、模式特征等。
分析数据库结构问题时：
- 优先调用工具获取真实数据，禁止凭记忆编造数据库不存在的信息；
- 工具返回的结构化数据，用清晰的中文 Markdown 表格汇总，保持简洁；
- 涉及"表结构/列定义"时用 getTableDetails，涉及"外键关系"时用 queryForeignKeys，涉及整体规模时用 getDbStats，涉及"模式特征"时用 getDbPatterns；
- 用户问健康度、索引优化、演进分析等概览类问题时，建议切换到「数据概览」智能体；
- 工具返回 success:false 或找不到数据时，如实告知并建议其它查询方式。
注意：数据来自 aos db scan 生成的数据库蓝图快照。字段含义：domain=领域分组，patterns=模式特征（soft_delete/audit_columns/multi_tenant/self_reference/uuid_primary 等），migrationVersion=创建该表的迁移版本。
当前数据源：\${DataSource.ctx?.sourceLabel || '未加载'}。`,
            suggestedQuestions: [
                '数据库整体结构如何？有多少表和领域？',
                '数据库有哪些外键关系？',
                '有哪些领域分组？各包含哪些表？',
                '哪些表有软删除？',
                '迁移历史是怎样的？',
                '多租户表有哪些？',
            ],
        },

        // 数据库蓝图页：数据概览智能体（新增）
        db_overview: {
            key: 'db_overview',
            label: '数据概览',
            icon: 'chart',
            description: '健康度/演进/索引优化/领域耦合/命名规范/迁移影响审计',
            pageType: 'database',
            systemPrompt: `你是「数据概览分析智能体」，运行在数据库蓝图页的数据概览视图上。你的专长是数据库审计与概览分析：Schema 健康度评估、模型演进趋势、索引优化建议、领域依赖耦合、命名规范审计、外键链路分析等。
分析概览类问题时：
- 优先调用工具获取真实审计数据，禁止凭记忆编造；
- 用清晰的中文 Markdown 输出，善用表格、列表、分级标题；
- 涉及"健康度/质量评估"时用 getDbHealth，涉及"索引优化"时用 getDbIndexAnalysis；
- 涉及"领域依赖/耦合度"时用 getDbDomainCoupling，涉及"演进趋势"时用 getDbEvolution；
- 涉及"命名规范"时用 getDbNamingAudit，涉及"表的上下游依赖链"时用 getDbFkChain；
- 涉及"某版本影响/迁移风险/版本变化"时用 getDbImpact（传入 version 参数）；
- 给出评分时附带解读，给出问题时附带改进建议，保持专业且实用；
- 工具返回 success:false 或找不到数据时，如实告知并建议先确认数据库快照版本。
注意：审计数据来自 aos db audit 系列分析，包含 7 大审计场景（健康度/迁移影响/领域依赖/索引优化/模型演进/外键链路/命名规范）。健康度评分越高越好（A=优秀, B=良好, C=一般, D=待改进）。
当前数据源：\${DataSource.ctx?.sourceLabel || '未加载'}。`,
            suggestedQuestions: [
                '数据库健康度如何？有什么质量问题？',
                '索引设计合理吗？有什么优化建议？',
                '领域之间的依赖关系如何？',
                '数据库是如何演进的？哪个版本变化最大？',
                '命名规范怎么样？有哪些不统一的地方？',
                'users 表的上下游依赖有哪些？',
                'V2.1 版本有什么影响？风险高吗？',
            ],
        },
    };

    // 当前智能体状态
    const currentAgent = {
        key: PAGE_TYPE === 'database' ? 'db_structure' : PAGE_TYPE === 'deploy' ? 'deploy_architecture' : PAGE_TYPE === 'service' ? 'service_blueprint' : 'code_ontology',
    };

    function getAgentList() {
        return Object.values(AGENTS).filter((a) => a.pageType === PAGE_TYPE);
    }

    function getCurrentAgent() {
        const list = getAgentList();
        return list.find((a) => a.key === currentAgent.key) || list[0];
    }

    function setAgent(key) {
        currentAgent.key = key;
        // 重新渲染相关 UI
        renderAgentChip();
        renderMessages(); // 刷新空状态建议
    }

    function buildSystemInstruction(agentCtx) {
        const agent = getCurrentAgent();
        if (!agent) return '';
        // 替换模板变量
        return agent.systemPrompt.replace(/\$\{([^}]+)\}/g, (_, expr) => {
            try { return eval(expr) ?? ''; } catch { return ''; }
        });
    }

    function buildReActPrompt(userMessage, history, toolsDesc, currentIter, maxIter) {
        const historyText = history.map((m) => {
            const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统';
            return `${label}: ${m.role === 'assistant' ? cleanToolCallMarkers(m.content) : m.content}`;
        }).join('\n');

        const toolHistory = history
            .filter((m) => m.role === 'system' && m.content.includes('tool_result'))
            .map((m) => m.content).join('\n');

        const ctx = currentViewContext();
        const ctxNote = ctx?.title ? `\n页面当前标题: ${ctx.title}${ctx.activeTab ? `；当前视图: ${ctx.activeTab}` : ''}` : '';

        return `（提示：你的角色设定已在系统指令中给出。）

## 可用工具
${toolsDesc}

## 对话历史
${historyText || '（无历史记录）'}

${toolHistory ? '## 工具调用结果\n' + toolHistory + '\n' : ''}
## 页面上下文
${ctxNote || '（无）'}

## 当前任务
用户消息: ${userMessage}

## 执行指令
你正在执行第 ${currentIter}/${maxIter} 次迭代。
在回答之前，请先思考是否需要使用工具：
- 如需要调用工具，必须严格使用以下格式（一段完整合法的 JSON，必须以 </tool_calls> 闭合）：
<tool_calls>{"name":"工具名称","arguments":{"参数名":"值"}}</tool_calls>
- 若不需要工具，直接回答用户问题。

工具调用格式要求：
1. JSON 必须合法：键与字符串值一律用双引号，无注释、无尾逗号，不要用 markdown 代码围栏包裹
2. 参数对象键名固定为 "arguments"
3. 每次迭代最多调用一个工具；决定调用时只输出一段 <tool_calls>...</tool_calls>，不要附加其它文本
4. 工具调用完成后，系统会把结果加入对话历史，你再继续下一轮
5. 只有获得所有必要信息后才给出最终回答
6. 若收到 formatError 的工具结果，说明上次格式有误，请严格重新输出一次
7. 最终回答使用中文，使用 Markdown 格式`;
    }

    function parseToolCalls(text) {
        const calls = [];
        // 宽松匹配：兼容大小写、单复数（tool_call/tool_calls）
        const re = /<tool_call[s]?>([\s\S]*?)<\/tool_call[s]?>/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
            try {
                const obj = JSON.parse(m[1].trim());
                if (obj && obj.name) calls.push({ name: obj.name, arguments: obj.arguments || {} });
            } catch { /* 忽略解码失败 */ }
        }
        return calls;
    }
    function cleanToolCallMarkers(text) {
        let t = String(text || '');
        // 清理成对的 tool_calls / tool_call 标签（兼容大小写、单复数）
        t = t.replace(/<tool_call[s]?>[\s\S]*?<\/tool_call[s]?>/gi, '');
        // 清理 tool_result 标签（成对）
        t = t.replace(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/gi, '');
        // 清理未闭合的特殊标签（tool_call/tool_calls/tool_result 的开始或结束标签）
        t = t.replace(/<\/?tool_call[s]?[^>]*>/gi, '');
        t = t.replace(/<\/?tool_result[^>]*>/gi, '');
        return t.trim();
    }

    function callAiApi(prompt, { systemInstruction }, useStream, onChunk) {
        const s = getSettings();
        const apiUrl = s.apiUrl || CONFIG.AI_DEFAULT_URL;
        const apiKey = (s.apiKey || '').trim();
        if (!apiKey) return Promise.reject(new Error('未配置 API Key，请在设置面板填写（支持多供应商）'));
        const payload = {
            model: s.model || CONFIG.AI_DEFAULT_MODEL,
            messages: [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: prompt },
            ],
            temperature: 0.7,
            stream: !!useStream,
        };
        if (useStream) return fetchStream(apiUrl, apiKey, payload, onChunk);
        return gmJsonFetch(apiUrl, apiKey, payload);
    }

    function gmJsonFetch(url, apiKey, payload) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('AI 请求超时')), CONFIG.AI_TIMEOUT);
            GM_xmlhttpRequest({
                method: 'POST', url, timeout: CONFIG.AI_TIMEOUT,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                data: JSON.stringify(payload),
                onload: (r) => {
                    clearTimeout(t);
                    try {
                        const j = JSON.parse(r.responseText);
                        if (j.error) reject(new Error(j.error.message || 'AI 返回错误'));
                        const text = j.choices?.[0]?.message?.content ?? '';
                        resolve(text);
                    } catch { reject(new Error('AI 响应解析失败')); }
                },
                onerror: (e) => { clearTimeout(t); reject(new Error(e.error || '网络错误')); },
                ontimeout: () => { clearTimeout(t); reject(new Error('AI 请求超时')); },
            });
        });
    }

    async function fetchStream(url, apiKey, payload, onChunk) {
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify(payload),
            });
            if (!resp.ok) {
                const detail = await resp.text().catch(() => '');
                throw new Error(`HTTP ${resp.status} ${detail.slice(0, 120)}`);
            }
            if (!resp.body) throw new Error('当前环境不支持流式读取');
            const reader = resp.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buf = '';
            let full = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    const t = line.trim();
                    if (!t || !t.startsWith('data:')) continue;
                    const data = t.slice(5).trim();
                    if (data === '[DONE]') continue;
                    try {
                        const j = JSON.parse(data);
                        const delta = j.choices?.[0]?.delta?.content ?? '';
                        if (delta) { full += delta; if (onChunk) onChunk(delta); }
                    } catch { /* 忽略不完整块 */ }
                }
            }
            return full;
        } catch (e) {
            throw e;
        }
    }

    async function runAgentLoop(userMessage, history, agentName, onChunk, onToolCall) {
        const toolsDesc = ToolRegistry.toolsDescription();
        const systemInstruction = buildSystemInstruction(agentName);
        const s = getSettings();
        const maxIter = Math.min(Number(s.maxIterations) || CONFIG.MAX_ITERATIONS, 8);
        let currentHistory = [...history];
        const toolCallLog = [];

        for (let i = 0; i < maxIter; i++) {
            if (abortFlag) return { response: '', completed: false, aborted: true, toolCalls: toolCallLog, iterations: i };
            const prompt = buildReActPrompt(userMessage, currentHistory, toolsDesc, i + 1, maxIter);

            let aiResponse;
            try {
                if (i === 0 && onChunk) {
                    aiResponse = await callAiApi(prompt, { systemInstruction }, true, onChunk);
                } else {
                    aiResponse = await callAiApi(prompt, { systemInstruction }, false);
                    if (onChunk) onChunk(aiResponse);
                }
            } catch (e) {
                if (abortFlag) return { response: '', completed: false, aborted: true, toolCalls: toolCallLog, iterations: i + 1 };
                return { response: `AI 调用失败: ${e.message}`, completed: false, iterations: i + 1, error: e.message };
            }
            if (abortFlag) return { response: cleanToolCallMarkers(aiResponse || ''), completed: false, aborted: true, iterations: i + 1, toolCalls: toolCallLog };

            currentHistory.push({ role: 'assistant', content: aiResponse });

            const toolCalls = parseToolCalls(aiResponse);
            if (toolCalls.length === 0) {
                const cleanResponse = cleanToolCallMarkers(aiResponse);
                const attempted = /<tool_call/i.test(aiResponse) || (/^\s*\{/.test(aiResponse) && /"(?:name|tool|function)"\s*:/.test(aiResponse));
                if (attempted && i + 1 < maxIter && !abortFlag) {
                    currentHistory.push({ role: 'system', content: `<tool_result>${JSON.stringify({ success: false, formatError: true, error: '上一次输出包含工具调用标签但格式不合法，请重新输出一段合法调用：仅输出 <tool_calls>{"name":"工具名称","arguments":{"参数名":"值"}}</tool_calls>' })}</tool_result>` });
                    continue;
                }
                return { response: cleanResponse || '（本轮未能生成有效回复，请重试或换个问法）', completed: true, iterations: i + 1, toolCalls: toolCallLog };
            }

            const toolCall = toolCalls[0];
            if (onToolCall) onToolCall(toolCall.name, toolCall.arguments, 'start');
            if (onChunk) onChunk(''); // 结束已输出的流式文本，进入工具阶段

            const result = await ToolRegistry.execute(toolCall.name, toolCall.arguments, DataSource.ctx);
            toolCallLog.push({ name: toolCall.name, args: toolCall.arguments, ok: result.success });
            if (onToolCall) onToolCall(toolCall.name, toolCall.arguments, result.success ? 'done' : 'error', result);

            currentHistory.push({ role: 'system', content: `<tool_result>${JSON.stringify(result)}</tool_result>` });
        }
        return { response: '（已达到最大迭代次数，未得到最终回答，请缩小问题范围重试）', completed: false, iterations: maxIter, toolCalls: toolCallLog };
    }

    // ============================================================
    //  会话管理
    // ============================================================
    const ChatManager = {
        all() {
            const chats = parseStored(Store.get(CONFIG.SK.CHATS, null), {});
            return chats;
        },
        list() {
            const chats = this.all();
            return Object.values(chats).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        },
        get(id) { return this.all()[id] || null; },
        active() { const id = Store.get(CONFIG.SK.ACTIVE); return id ? this.get(id) : null; },
        setActive(id) { Store.set(CONFIG.SK.ACTIVE, id); },
        save(conv) { const chats = this.all(); chats[conv.id] = conv; Store.set(CONFIG.SK.CHATS, JSON.stringify(chats)); },
        remove(id) { const chats = this.all(); delete chats[id]; Store.set(CONFIG.SK.CHATS, JSON.stringify(chats)); if (Store.get(CONFIG.SK.ACTIVE) === id) Store.del(CONFIG.SK.ACTIVE); },
        newConv(title = '新会话') {
            const c = { id: uid(), title, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
            this.save(c); this.setActive(c.id); return c;
        },
        ensureActive() {
            let c = this.active();
            if (!c) c = this.newConv();
            return c;
        },
        isRunning(c) { return c?.meta?.running; },
        markRunning(c, running, meta = {}) {
            c.meta = c.meta || {};
            c.meta.running = running;
            if (!running) { c.meta.lastError = meta.lastError || undefined; c.updatedAt = Date.now(); }
            this.save(c);
        },
    };

    // ============================================================
    //  UI
    // ============================================================
    let panel = null;
    let panelOpen = false;
    const ui = { renderConvList: null, renderMessages: null, renderHeader: null, activeConv: null };

    function ensureStyles() {
        const css = `
.ba-toast{position:fixed;right:20px;bottom:80px;z-index:2147483647;background:#334155;color:#fff;padding:10px 16px;border-radius:10px;font:13px/1.4 system-ui;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;transform:translateY(8px);transition:.25s;pointer-events:none;max-width:340px}
.ba-toast-show{opacity:1;transform:none}
.ba-toast-error{background:#b91c1c}
.ba-toast-success{background:#15803d}
.ba-fab{position:fixed;right:26px;bottom:26px;z-index:2147483600;width:52px;height:52px;border-radius:16px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;box-shadow:0 8px 24px rgba(99,102,241,.45);transition:.25s}
.ba-fab:hover{transform:translateY(-2px) scale(1.05)}
.ba-fab-pulse::after{content:'';position:absolute;inset:0;border-radius:16px;border:2px solid rgba(139,92,246,.6);animation:baPulse 2s infinite}
@keyframes baPulse{0%{transform:scale(1);opacity:.8}70%{transform:scale(1.6);opacity:0}100%{opacity:0}}
.ba-panel{position:fixed;right:18px;bottom:18px;top:18px;width:580px;max-width:94vw;z-index:2147483610;background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:18px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(2,6,23,.55);color:#e2e8f0;font:14px/1.5 system-ui;transition:transform .28s,opacity .28s;transform:translateX(120%);opacity:0;pointer-events:none}
.ba-panel-open{transform:none;opacity:1;pointer-events:auto}
.ba-head{position:relative;display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(148,163,184,.14);background:#111c33}
.ba-head-title{font-weight:600;font-size:14px;color:#f1f5f9;display:flex;align-items:center;gap:7px;flex:1;min-width:0}
.ba-head-title b{color:#a5b4fc}
.ba-sess-title{font-size:12px;color:#94a3b8;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
.ba-icon-btn{background:transparent;border:none;color:#94a3b8;cursor:pointer;width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;padding:0}
.ba-icon-btn:hover{background:rgba(148,163,184,.12);color:#e2e8f0}
.ba-icon-btn.is-danger:hover{background:rgba(220,38,38,.2);color:#fca5a5}
.ba-model-chip{display:flex;align-items:center;gap:6px;font-size:12px;color:#a5b4fc;padding:4px 9px;border:1px solid rgba(165,180,252,.3);border-radius:20px;cursor:pointer;max-width:170px}
.ba-model-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ba-agent-chip{display:flex;align-items:center;gap:5px;font-size:11px;color:#94a3b8;padding:3px 8px;border:1px solid rgba(148,163,184,.25);border-radius:14px;cursor:pointer;background:rgba(148,163,184,.06);white-space:nowrap}
.ba-agent-chip:hover{color:#e2e8f0;border-color:rgba(148,163,184,.45);background:rgba(148,163,184,.12)}
.ba-agent-menu{position:absolute;top:46px;right:80px;z-index:7;background:#1e293b;border:1px solid rgba(148,163,184,.2);border-radius:10px;padding:8px;min-width:220px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.ba-agent-menu .am-title{font-size:11px;color:#64748b;padding:4px 8px 2px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.ba-agent-menu .am-item{font-size:12px;padding:8px 10px;border-radius:8px;cursor:pointer;display:flex;gap:8px;align-items:flex-start;color:#e2e8f0}
.ba-agent-menu .am-item:hover{background:rgba(148,163,184,.12)}
.ba-agent-menu .am-item.cur{background:rgba(99,102,241,.15);color:#c7d2fe}
.ba-agent-menu .am-item .am-info{flex:1;min-width:0}
.ba-agent-menu .am-item .am-label{font-weight:600}
.ba-agent-menu .am-item .am-desc{font-size:11px;color:#64748b;margin-top:2px;line-height:1.3}
.ba-body{flex:1;overflow:hidden;display:flex}
.ba-side{width:140px;border-right:1px solid rgba(148,163,184,.14);background:#0b1425;display:flex;flex-direction:column}
.ba-side-item{padding:8px 10px;font-size:12px;color:#94a3b8;cursor:pointer;display:flex;gap:7px;align-items:center;border-left:2px solid transparent;user-select:none}
.ba-side-item:hover{background:rgba(148,163,184,.07)}
.ba-side-item.active{background:#1e293b;color:#e2e8f0;border-left-color:#6366f1}
.ba-side-item .ba-t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ba-side-new{width:100%;margin:8px;width:calc(100% - 16px)}
.ba-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:none;border-radius:8px;cursor:pointer;font:13px/1 system-ui;padding:7px 12px;transition:.15s}
.ba-btn-primary{background:#6366f1;color:#fff}
.ba-btn-primary:hover{background:#4f46e5}
.ba-btn-secondary{background:rgba(148,163,184,.14);color:#e2e8f0}
.ba-btn-secondary:hover{background:rgba(148,163,184,.24)}
.ba-chat{flex:1;display:flex;flex-direction:column;min-width:0}
.ba-msgs{flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:12px}
.ba-msg{max-width:100%;display:flex;flex-direction:column}
.ba-msg-row{display:flex;gap:8px;align-items:flex-start}
.ba-msg-avatar{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:11px}
.ba-msg-user .ba-msg-avatar{background:#6366f1}
.ba-msg-ai .ba-msg-avatar{background:linear-gradient(135deg,#8b5cf6,#6366f1)}
.ba-msg.bubble{border-radius:12px;padding:9px 11px;font-size:13px;line-height:1.6;word-break:break-word}
.ba-msg-user{margin-left:auto;background:#6366f1;color:#fff;border-top-right-radius:3px;max-width:86%}
.ba-msg-ai{background:#1e293b;border-top-left-radius:3px;max-width:100%}
.ba-msg-ai .md-body{margin:0}
.ba-msg-ai .md-body p{margin:.35em 0}
.ba-msg-ai .md-body pre{background:#0f172a;border:1px solid rgba(148,163,184,.15);border-radius:8px;padding:8px 10px;overflow-x:auto;font-size:12px}
.ba-msg-ai .md-body code{font-family:ui-monospace,Consolas,monospace}
.ba-msg-ai .md-body table{border-collapse:collapse;font-size:12px;margin:.5em 0}
.ba-msg-ai .md-body th,.md-body td{border:1px solid rgba(148,163,184,.25);padding:4px 8px}
.ba-msg-ai .md-body th{background:#111c33}
.ba-msg-ai .md-body ul,.ba-msg-ai .md-body ol{padding-left:18px;margin:.35em 0}
.ba-msg-ai .md-body h1,.md-body h2,.md-body h3{margin:.5em 0 .3em;font-size:1.05em}
.ba-typing{display:inline-flex;gap:4px;padding:6px 2px}
.ba-typing i{width:6px;height:6px;border-radius:50%;background:#a5b4fc;animation:baBlink 1s infinite}
.ba-typing i:nth-child(2){animation-delay:.15s}
.ba-typing i:nth-child(3){animation-delay:.3s}
@keyframes baBlink{0%,80%,100%{opacity:.25}40%{opacity:1}}
.ba-tool-calls{display:flex;flex-direction:column;gap:4px;margin-top:4px}
.ba-tool-chip{display:flex;flex-direction:column;border:1px solid rgba(99,102,241,.35);background:rgba(99,102,241,.1);border-radius:8px;padding:5px 8px;font-size:12px;cursor:pointer;transition:background .2s,border-color .2s;animation:ba-fade-in .3s ease-out}
.ba-tool-chip:hover{background:rgba(99,102,241,.18);border-color:rgba(99,102,241,.5)}
.ba-tool-chip .ba-tc-row{display:flex;align-items:center;gap:6px;width:100%;min-width:0}
.ba-tool-chip .ba-tc-icon{width:18px;height:18px;border-radius:5px;background:rgba(99,102,241,.25);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#a5b4fc}
.ba-tool-chip .ba-tc-icon svg{width:11px;height:11px}
.ba-tool-chip .ba-tc-body{flex:1;min-width:0;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden}
.ba-tool-chip .ba-tc-name{color:#c7d2fe;font-weight:600;font-size:12px;flex-shrink:0}
.ba-tool-chip .ba-tc-args{color:#94a3b8;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.ba-tool-chip .ba-tc-state{flex-shrink:0;display:flex;align-items:center;justify-content:center;width:14px;height:14px}
.ba-tool-chip.ba-running .ba-tc-state{color:#a5b4fc}
.ba-tool-chip.ba-done .ba-tc-state{color:#86efac}
.ba-tool-chip.ba-tool-fail{border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.08)}
.ba-tool-chip.ba-tool-fail .ba-tc-icon{background:rgba(248,113,113,.25);color:#fca5a5}
.ba-tool-chip.ba-tool-fail .ba-tc-name{color:#fca5a5}
.ba-tool-chip.ba-tool-fail .ba-tc-state{color:#fca5a5}
.ba-tool-chip .ba-tc-detail{display:none;margin-top:5px;padding-top:5px;border-top:1px solid rgba(148,163,184,.15);color:#94a3b8;font-size:11px;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace}
.ba-tool-chip.ba-expanded .ba-tc-detail{display:block}
.ba-tc-spinner{display:inline-block;width:12px;height:12px;border:2px solid rgba(165,180,252,.3);border-top-color:#a5b4fc;border-radius:50%;animation:ba-spin 1s linear infinite}
@keyframes ba-fade-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
@keyframes ba-spin{to{transform:rotate(360deg)}}
.ba-tool-err{color:#fca5a5;margin-top:3px}
.ba-input{display:flex;gap:8px;padding:12px 14px;border-top:1px solid rgba(148,163,184,.14);background:#0b1425}
.ba-input textarea{flex:1;resize:none;border:1px solid rgba(148,163,184,.2);background:#0f172a;color:#e2e8f0;border-radius:10px;padding:11px 13px;font:13px/1.5 system-ui;outline:none;max-height:120px;min-height:44px}
.ba-input textarea:focus{border-color:#6366f1}
.ba-send{width:38px;height:38px;border:none;border-radius:10px;background:#6366f1;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.ba-send:hover{background:#4f46e5}
.ba-send.stop{background:#dc2626}
.ba-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#64748b;gap:10px;text-align:center;padding:20px}
.ba-empty .ba-e-icon{opacity:.5}
.ba-empty h4{color:#94a3b8;font-weight:600;margin:0}
.ba-sugg{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;max-width:380px}
.ba-sugg button{font-size:11px;color:#a5b4fc;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.25);border-radius:14px;padding:4px 9px;cursor:pointer}
.ba-sugg button:hover{background:rgba(99,102,241,.22)}
.ba-set-pane{position:absolute;inset:0;background:#0f172a;z-index:10;display:flex;flex-direction:column}
.ba-set-pane .ba-set-body{flex:1;overflow-y:auto;padding:16px}
.ba-set-section{margin-bottom:8px}
.ba-set-section-title{font-weight:600;font-size:13px;color:#e2e8f0;margin-bottom:10px;display:flex;align-items:center;gap:6px}
.ba-set-divider{height:1px;background:rgba(148,163,184,.12);margin:14px 0}
.ba-preset-item{display:flex;align-items:center;gap:6px;padding:8px 10px;border:1px solid rgba(148,163,184,.15);border-radius:10px;background:#0b1425}
.ba-field{margin-bottom:14px}
.ba-field label{display:block;font-size:12px;color:#94a3b8;margin-bottom:5px}
.ba-field input,.ba-field select,.ba-field textarea{width:100%;background:#0b1425;border:1px solid rgba(148,163,184,.2);color:#e2e8f0;border-radius:8px;padding:8px 10px;font:13px system-ui;box-sizing:border-box}
.ba-field select{width:100%}
.ba-field .hint{font-size:11px;color:#64748b;margin-top:4px}
.ba-set-foot{padding:12px 16px;border-top:1px solid rgba(148,163,184,.14);display:flex;justify-content:flex-end;gap:8px;background:#0b1425}
.ba-opts{position:absolute;top:46px;right:52px;z-index:8;background:#1e293b;border:1px solid rgba(148,163,184,.2);border-radius:10px;padding:5px;display:flex;flex-direction:column;gap:2px;box-shadow:0 10px 30px rgba(0,0,0,.4);min-width:180px}
.ba-opts button{display:flex;gap:8px;align-items:center;font-size:12px;color:#e2e8f0;background:transparent;border:none;padding:7px 10px;border-radius:6px;cursor:pointer;text-align:left;width:100%}
.ba-opts button:hover{background:rgba(148,163,184,.12)}
.ba-opts button:disabled{opacity:.4;cursor:not-allowed}
.ba-model-menu{position:absolute;top:46px;right:12px;z-index:7;background:#1e293b;border:1px solid rgba(148,163,184,.2);border-radius:10px;padding:8px;min-width:240px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.ba-model-menu .mm-group{font-size:11px;color:#64748b;margin:6px 4px 3px}
.ba-model-menu .mm-item{font-size:12px;padding:7px 9px;border-radius:6px;cursor:pointer;display:flex;gap:8px;align-items:center;color:#e2e8f0}
.ba-model-menu .mm-item:hover{background:rgba(148,163,184,.12)}
.ba-model-menu .mm-item.cur{color:#a5b4fc;font-weight:600}
.ba-confirm{position:fixed;inset:0;background:rgba(2,6,23,.6);z-index:20;display:flex;align-items:center;justify-content:center}
.ba-confirm-box{background:#1e293b;border-radius:14px;padding:20px;width:300px;text-align:center}
.ba-confirm-box p{margin:0 0 16px;color:#e2e8f0}
@media (max-width:640px){.ba-side{width:120px}.ba-panel{width:94vw;right:3vw;left:3vw}}
`;
        GM_addStyle(css);
    }

    function mdToHtml(md) {
        if (!md) return '';
        let h = String(md);
        // 清理特殊标签（tool_calls / tool_call / tool_result）
        h = cleanToolCallMarkers(h);
        h = esc(h);
        h = h.replace(/^#### (.*)$/gm, '<h4>$1</h4>');
        h = h.replace(/^### (.*)$/gm, '<h3>$1</h3>');
        h = h.replace(/^## (.*)$/gm, '<h2>$1</h2>');
        h = h.replace(/^# (.*)$/gm, '<h3>$1</h3>');
        h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
        h = h.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1<i>$2</i>');
        h = h.replace(/~~~([\s\S]*?)~~~/g, '<pre><code>$1</code></pre>');
        h = h.replace(/`{1,2}(.+?)`{1,2}/g, '<code>$1</code>');
        h = h.replace(/\n/g, '\n');
        h = h.split('\n').map((ln) => ln.trim() ? ln : '<br>').join('\n');
        // 列表
        h = h.replace(/((^|\n)(?:•|•)[^\n]+)+/g, (m) => '<ul>' + m.split('\n').map((l) => `<li>${l.replace(/^\s*[-•]\s*/, '')}</li>`).join('') + '</ul>');
        // 表格简化
        h = h.replace(/((?:^|\n)\|[^\n]+)+\n?/g, (m) => {
            const rows = m.trim().split('\n').filter((l) => l.startsWith('|')).map((l) => `<tr>${l.split('|').filter((x) => x.trim() !== '').map((c) => `<td>${c.trim()}</td>`).join('')}</tr>`);
            return rows.length ? `<table>${rows.join('')}</table>` : '';
        });
        // 段落
        h = h.split('\n').map((ln) => ln.replace(/<br>$/, '')).map((ln) => ln.trim() ? ln : '\n').join('\n');
        h = h.replace(/(?:^|\n)(?!<h|<ul|<table|<pre|<br)([^<\n][^\n]*)/g, (m) => `<p>${m.replace(/^[ \t]*/,'')}</p>`);
        return h;
    }

    // ---- 渲染函数 ----
    function renderModelChip() {
        const s = getSettings();
        const prov = MODEL_PROVIDERS[s.provider];
        const chip = $d('#ba-model-chip');
        // 查找匹配的预设名称
        const preset = (s.modelPresets || []).find((p) => p.provider === s.provider && p.model === s.model && p.apiUrl === s.apiUrl);
        const label = preset ? preset.name : (prov?.name || '自定义') + ' · ' + (s.model || '未选模型');
        if (chip) chip.innerHTML = `${getIcon('lightbulb', 14)} <span>${esc(label)}</span>`;
    }

    function appendMessage(conv, msg) {
        if (!conv) return;
        if (!conv.messages) conv.messages = [];
        conv.messages.push(msg);
        ChatManager.save(conv);
    }

    function renderMessages() {
        const conv = ui.activeConv;
        const box = $d('#ba-msgs');
        if (!box) return;
        box.innerHTML = '';
        const s = getSettings();
        const agent = getCurrentAgent();
        if (!conv) {
            const empty = el('div', 'ba-empty');
            if (PAGE_TYPE === 'database') {
                const suggs = (agent?.suggestedQuestions || []).slice(0, 6).map((q) =>
                    `<button data-s="${esc(q)}">${esc(q.length > 14 ? q.slice(0, 14) + '…' : q)}</button>`
                ).join('');
                empty.innerHTML = `${getIcon(agent?.icon || 'database', 44)}
                    <h4>${agent ? esc(agent.label) + ' 智能体' : '数据库蓝图 AI 分析助手'}</h4>
                    <p style="margin:0;font-size:12px">${agent ? esc(agent.description) : '针对当前数据库结构进行问答分析'}</p>
                    <div class="ba-sugg">${suggs}</div>`;
            } else {
                const suggs = (agent?.suggestedQuestions || []).slice(0, 6).map((q) =>
                    `<button data-s="${esc(q)}">${esc(q.length > 14 ? q.slice(0, 14) + '…' : q)}</button>`
                ).join('');
                empty.innerHTML = `${getIcon(agent?.icon || 'robot', 44)}
                    <h4>${agent ? esc(agent.label) + ' 智能体' : 'AOS 蓝图 AI 分析助手'}</h4>
                    <p style="margin:0;font-size:12px">${agent ? esc(agent.description) : '针对当前项目代码本体进行问答分析'}</p>
                    <div class="ba-sugg">${suggs}</div>`;
            }
            $all('.ba-sugg button', empty).forEach((b) => b.addEventListener('click', () => sendMessage(b.dataset.s)));
            box.appendChild(empty);
            return;
        }
        if (!conv.messages.length) {
            const empty = el('div', 'ba-empty');
            const agentSuggs = (agent?.suggestedQuestions || []).slice(0, 3);
            const suggs = agentSuggs.map((q) => `<button data-s="${esc(q)}">${esc(q.length > 12 ? q.slice(0, 12) + '…' : q)}</button>`).join('');
            empty.innerHTML = `<h4 style="margin:0">${esc(conv.title)}</h4>
                <p style="margin:0;font-size:12px;">发送消息开始对话<br>${DataSource.ctx?.sourceLabel || '数据未加载，请在「设置」刷新数据源'}</p>
                <div class="ba-sugg">${suggs}</div>`;
            $all('.ba-sugg button', empty).forEach((b) => b.addEventListener('click', () => sendMessage(b.dataset.s)));
            box.appendChild(empty);
            box.scrollTop = 0;
            return;
        }
        for (const m of conv.messages) {
            if (m.type === 'tool') { box.appendChild(toolNode(m)); continue; }
            box.appendChild(messageNode(m));
        }
        box.scrollTop = box.scrollHeight;
    }

    function messageNode(m) {
        if (m.type === 'user') {
            const n = el('div', 'ba-msg ba-msg-row ba-msg-user ba-msg bubble');
            n.innerHTML = esc(m.content || '').replace(/\n/g, '<br>');
            return n;
        }
        const wrap = el('div', 'ba-msg ba-msg-row ba-msg-ai');
        const av = el('div', 'ba-msg-avatar');
        av.innerHTML = getIcon('robot', 14);
        const body = el('div', 'ba-msg md-body');
        if (m.loading) {
            body.innerHTML = `<span class="ba-typing"><i></i><i></i><i></i></span>`;
        } else if (m.error) {
            body.innerHTML = `<div class="ba-tool-err">${esc(m.error)}</div>`;
        } else {
            body.innerHTML = mdToHtml(m.content || '');
        }
        wrap.appendChild(av); wrap.appendChild(body);
        return wrap;
    }

    function toolNode(m) {
        const n = el('div', 'ba-msg ba-msg-ai');
        const toolName = m.tool?.name || '工具';
        const display = getToolDisplay(toolName);
        const args = m.tool?.args ?? {};
        const argsSummary = formatToolArgs(args);
        const argsJson = JSON.stringify(args, null, 2);
        const isRunning = m.state === 'running';
        const isDone = m.state === 'done';
        const isFail = m.state === 'error' || m.state === 'fail';
        const stateClass = isRunning ? 'ba-running' : isDone ? 'ba-done' : isFail ? 'ba-tool-fail' : '';

        let stateIndicator;
        if (isRunning) {
            stateIndicator = '<span class="ba-tc-spinner" title="执行中"></span>';
        } else if (isDone) {
            stateIndicator = getIcon('check', 14);
        } else if (isFail) {
            stateIndicator = getIcon('close', 14);
        } else {
            stateIndicator = '';
        }

        const errorMsg = isFail && m.tool?.error ? `<div class="ba-tool-err" style="margin-top:4px">${esc(m.tool.error)}</div>` : '';

        n.innerHTML = `<div class="ba-tool-chip ${stateClass}">
            <div class="ba-tc-row">
                <div class="ba-tc-icon">${getIcon(display.icon, 12)}</div>
                <div class="ba-tc-body">
                    <div class="ba-tc-name">${esc(display.label)}</div>
                    ${argsSummary ? `<div class="ba-tc-args">${esc(argsSummary)}</div>` : ''}
                </div>
                <div class="ba-tc-state">${stateIndicator}</div>
            </div>
            <div class="ba-tc-detail">${esc(argsJson)}${errorMsg}</div>
        </div>`;

        const chip = n.querySelector('.ba-tool-chip');
        chip.addEventListener('click', () => {
            chip.classList.toggle('ba-expanded');
        });

        return n;
    }

    function renderConvList() {
        const box = $d('#ba-sess-list');
        if (!box) return;
        box.innerHTML = '';
        const list = ChatManager.list();
        const activeId = ui.activeConv?.id;
        if (!list.length) {
            box.innerHTML = '<div style="padding:10px;font-size:11px;color:#64748b">暂无历史会话</div>';
            return;
        }
        for (const c of list) {
            const item = el('div', 'ba-side-item' + (c.id === activeId ? ' active' : ''));
            const title = (c.title || '会话').slice(0, 12);
            const running = c.meta?.running;
            item.innerHTML = `${getIcon(running ? 'bot' : 'history', 13)} <span class="ba-t">${esc(title)}</span>`;
            item.title = c.title;
            item.addEventListener('click', () => { openConv(c.id); });
            box.appendChild(item);
        }
    }

    // ---- 面板构建 ----
    function openPanel() {
        if (!panelOpen) {
            panel.classList.add('ba-panel-open');
            panelOpen = true;
            document.querySelector('.ba-fab').style.display = 'none';
        }
        const c = ChatManager.ensureActive();
        openConv(c.id);
    }
    function closePanel() {
        panel.classList.remove('ba-panel-open');
        panelOpen = false;
        const fab = document.querySelector('.ba-fab');
        if (fab) fab.style.display = 'flex';
    }
    function openConv(id) {
        const conv = ChatManager.get(id);
        if (!conv) return;
        ui.activeConv = conv;
        ChatManager.setActive(id);
        const st = $d('#ba-sess-title');
        if (st) st.textContent = conv.title;
        renderConvList();
        renderMessages();
        renderModelChip();
    }
    function newConversation() {
        const c = ChatManager.newConv();
        c.title = '新会话';
        ChatManager.save(c);
        openConv(c.id);
        $d('#ba-inp')?.focus();
    }

    function buildPanel() {
        panel = el('div', 'ba-panel');
        const isDb = PAGE_TYPE === 'database';
        const isDeploy = PAGE_TYPE === 'deploy';
        const isService = PAGE_TYPE === 'service';
        const agent = getCurrentAgent();
        const panelTitleIcon = isDb ? 'database' : isDeploy ? 'server' : isService ? 'server' : 'robot';
        const panelTitleText = isDb ? '数据蓝图 <b>AI 分析</b>' : isDeploy ? '部署蓝图 <b>AI 分析</b>' : isService ? '服务蓝图 <b>AI 分析</b>' : 'AOS 蓝图 <b>AI 分析</b>';
        const inputPlaceholder = isDb
            ? (agent.key === 'db_overview'
                ? '询问数据库概览/审计，如：健康度？索引优化建议？发送 Enter，换行 Shift+Enter'
                : '询问数据库结构，如：数据库有哪些表？外键关系？发送 Enter，换行 Shift+Enter')
            : isDeploy
                ? '询问部署架构，如：有哪些服务？nginx 路由怎么配的？发送 Enter，换行 Shift+Enter'
                : isService
                    ? '询问后端服务，如：有哪些模块？技术栈是什么？健康度？发送 Enter，换行 Shift+Enter'
                    : '询问项目代码结构，如：这个项目的 Service 有哪些？发送 Enter，换行 Shift+Enter';
        panel.innerHTML = `
            <div class="ba-head">
                <div class="ba-head-title">${getIcon(panelTitleIcon, 18)} ${panelTitleText}</div>
                <span id="ba-agent-chip" class="ba-agent-chip" title="切换智能体">${getIcon(agent.icon, 12)} ${esc(agent.label)}</span>
                <span id="ba-sess-title" class="ba-sess-title">新会话</span>
                <button class="ba-icon-btn" id="ba-model-btn" title="切换模型">${getIcon('lightbulb', 16)}</button>
                <button class="ba-icon-btn" id="ba-menu-btn" title="更多">${getIcon('gear', 16)}</button>
                <button class="ba-icon-btn" id="ba-close-btn" title="收起">${getIcon('close', 16)}</button>
                <div class="ba-agent-menu" id="ba-agent-menu" style="display:none"></div>
                <div class="ba-model-menu" id="ba-model-menu" style="display:none"></div>
                <div class="ba-opts" id="ba-opts" style="display:none"></div>
            </div>
            <div class="ba-body">
                <div class="ba-side">
                    <button class="ba-btn ba-btn-primary ba-side-new" id="ba-new-btn">${getIcon('plus', 13)} 新建</button>
                    <div id="ba-sess-list" style="overflow-y:auto;flex:1"></div>
                </div>
                <div class="ba-chat">
                    <div class="ba-msgs" id="ba-msgs"></div>
                    <div class="ba-input">
                        <textarea id="ba-inp" placeholder="${inputPlaceholder}"/></textarea>
                        <button class="ba-send" id="ba-send-btn" title="发送">${getIcon('send', 17)}</button>
                    </div>
                </div>
            </div>
            <div class="ba-set-pane" id="ba-set-pane" style="display:none"></div>`;
        document.body.appendChild(panel);

        $d('#ba-close-btn').addEventListener('click', closePanel);
        $d('#ba-new-btn').addEventListener('click', newConversation);
        $d('#ba-menu-btn').addEventListener('click', (e) => toggleMenu(e, buildOptsMenu));
        $d('#ba-model-btn').addEventListener('click', (e) => toggleModelMenu(e));
        $d('#ba-agent-chip').addEventListener('click', (e) => toggleAgentMenu(e));
        const sendBtn = $d('#ba-send-btn');
        sendBtn.addEventListener('click', () => sendMessage());
        const inp = $d('#ba-inp');
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });
        document.addEventListener('click', (e) => {
            if (!panel.contains(e.target)) {
                const mo = $d('#ba-model-menu'); if (mo) mo.style.display = 'none';
                const am = $d('#ba-agent-menu'); if (am) am.style.display = 'none';
                const op = $d('#ba-opts'); if (op) op.style.display = 'none';
            }
        });
    }

    function renderAgentChip() {
        const chip = $d('#ba-agent-chip');
        if (!chip) return;
        const agent = getCurrentAgent();
        chip.innerHTML = getIcon(agent.icon, 12) + ' ' + esc(agent.label);
    }

    function toggleAgentMenu(e) {
        e.stopPropagation();
        const menu = $d('#ba-agent-menu');
        const mm = $d('#ba-model-menu');
        const op = $d('#ba-opts');
        if (mm) mm.style.display = 'none';
        if (op) op.style.display = 'none';
        const visible = menu.style.display === 'block';
        menu.style.display = visible ? 'none' : 'block';
        if (!visible) {
            const agents = getAgentList();
            menu.innerHTML = '<div class="am-title">选择智能体</div>' +
                agents.map((a) => {
                    const isCur = a.key === currentAgent.key;
                    return `<div class="am-item ${isCur ? 'cur' : ''}" data-agent="${a.key}">
                        ${getIcon(a.icon, 16)}
                        <div class="am-info">
                            <div class="am-label">${esc(a.label)}</div>
                            <div class="am-desc">${esc(a.description)}</div>
                        </div>
                        ${isCur ? '<span style="color:#a5b4fc">✓</span>' : ''}
                    </div>`;
                }).join('');
            $all('.am-item', menu).forEach((item) => {
                item.addEventListener('click', () => {
                    const key = item.dataset.agent;
                    setAgent(key);
                    menu.style.display = 'none';
                });
            });
        }
    }

    function toggleMenu(e, buildFn) {
        e.stopPropagation();
        const menu = $d('#ba-opts');
        const mm = $d('#ba-model-menu'); if (mm) mm.style.display = 'none';
        const visible = menu.style.display === 'block';
        menu.style.display = visible ? 'none' : 'block';
        if (!visible) menu.innerHTML = buildFn();
    }
    function buildOptsMenu() {
        const s = getSettings();
        const chips = [];
        const running = ui.activeConv?.meta?.running;
        if (running) chips.push(`<button data-a="stop">${getIcon('stop', 14)} 停止生成</button>`);
        chips.push(`<button data-a="new">${getIcon('plus', 14)} 新建会话</button>`);
        chips.push(`<button data-a="rename" ${ui.activeConv ? '' : 'disabled'}>${getIcon('edit', 14)} 重命名会话</button>`);
        chips.push(`<button data-a="export-json" ${ui.activeConv ? '' : 'disabled'}>${getIcon('download', 14)} 导出 JSON</button>`);
        chips.push(`<button data-a="export-md" ${ui.activeConv ? '' : 'disabled'}>${getIcon('download', 14)} 导出 Markdown</button>`);
        chips.push(`<button data-a="del">${getIcon('trash', 14)} 删除会话</button>`);
        chips.push(`<button data-a="clear">${getIcon('trash', 14)} 清空全部会话</button>`);
        chips.push(`<div style="height:1px;background:rgba(148,163,184,.15);margin:4px 0"></div>`);
        chips.push(`<button data-a="settings">${getIcon('gear', 14)} 设置</button>`);
        chips.push(`<button data-a="refresh" ${DataSource.ctx ? '' : 'disabled'}>${getIcon('database', 14)} 刷新数据源</button>`);
        return chips.join('');
    }
    function attachMenuActions() {
        $d('#ba-opts').addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = e.target.closest('button[data-a]'); if (!btn) return;
            if (btn.disabled) return;
            const a = btn.dataset.a;
            closeMenu('#ba-opts');
            // 延迟一帧执行，确保菜单关闭动画不影响后续操作
            setTimeout(() => { try { handleMenuAction(a); } catch (err) { console.error('[BA-Agent] 菜单操作失败:', err); } }, 0);
        });
    }
    function closeMenu(sel) { const m = $d(sel); if (m) m.style.display = 'none'; }
    function handleMenuAction(a) {
        const conv = ui.activeConv;
        switch (a) {
            case 'stop': stopGeneration(); break;
            case 'new': newConversation(); break;
            case 'rename': promptRename(); break;
            case 'export-json': if (conv) exportConversation(conv, 'json'); break;
            case 'export-md': if (conv) exportConversation(conv, 'md'); break;
            case 'del': confirmAction(`删除会话「${conv?.title || ''}」？`, () => { if (conv) { ChatManager.remove(conv.id); if (ui.activeConv?.id === conv.id) { ui.activeConv = null; ChatManager.setActive(''); } } renderMessages(); renderConvList(); }); break;
            case 'clear': confirmAction('清空全部会话历史？', () => { Store.set(CONFIG.SK.CHATS, '{}'); Store.del(CONFIG.SK.ACTIVE); ui.activeConv = null; renderMessages(); renderConvList(); }); break;
            case 'settings': openSettings(); break;
            case 'refresh': refreshData(); break;
        }
    }
    function promptRename() {
        if (!ui.activeConv) return;
        const title = prompt('会话名称：', ui.activeConv.title);
        if (title && title.trim()) { ui.activeConv.title = title.trim(); ChatManager.save(ui.activeConv); renderConvList(); $d('#ba-sess-title').textContent = title.trim(); }
    }
    function confirmAction(msg, fn) {
        const b = el('div', 'ba-confirm');
        b.innerHTML = `<div class="ba-confirm-box"><p>${esc(msg)}</p>
            <div style="display:flex;gap:8px;justify-content:center"><button class="ba-btn ba-btn-secondary" data-c="no">取消</button><button class="ba-btn ba-btn-primary" data-c="yes">确定</button></div></div>`;
        b.addEventListener('click', (e) => {
            const v = e.target.closest('[data-c]');
            if (v) { b.remove(); if (v.dataset.c === 'yes') fn(); }
        });
        document.body.appendChild(b);
    }

    function toggleModelMenu(e) {
        e.stopPropagation();
        const mm = $d('#ba-model-menu');
        const op = $d('#ba-opts'); op.style.display = 'none';
        const visible = mm.style.display === 'block';
        mm.style.display = visible ? 'none' : 'block';
        if (visible) return;
        const s = getSettings();
        let html2 = '<div class="mm-group">我的模型配置</div>';
        for (const p of s.modelPresets || []) {
            const isCur = s.provider === p.provider && s.model === p.model && s.apiUrl === p.apiUrl;
            html2 += `<div class="mm-item${isCur ? ' cur' : ''}" data-preset="${p.id}" title="${esc(p.apiUrl || '')}">${getIcon('lightbulb', 13)} <div style="flex:1;min-width:0"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</div><div style="font-size:11px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(MODEL_PROVIDERS[p.provider]?.name || p.provider)} · ${esc(p.model || '')}</div></div>${isCur ? ' ✓' : ''}</div>`;
        }
        html2 += `<div style="height:1px;background:rgba(148,163,184,.15);margin:6px 4px"></div>`;
        html2 += `<div class="mm-item" data-action="manage-presets" style="color:#94a3b8">${getIcon('gear', 13)} 管理模型配置…</div>`;
        mm.innerHTML = html2;
        $all('.mm-item[data-preset]', mm).forEach((it) => it.addEventListener('click', () => {
            const preset = (s.modelPresets || []).find((p) => p.id === it.dataset.preset);
            if (preset) {
                saveSettings({ provider: preset.provider, model: preset.model, apiUrl: preset.apiUrl });
                mm.style.display = 'none';
                renderModelChip();
                toast(`已切换至 ${preset.name}`, 'success');
            }
        }));
        $all('.mm-item[data-action="manage-presets"]', mm).forEach((it) => it.addEventListener('click', () => {
            mm.style.display = 'none';
            openSettings('presets');
        }));
    }

    function openSettings(tab) {
        const pane = $d('#ba-set-pane');
        const s = getSettings();
        // 打开设置时隐藏所有下拉菜单，避免层级冲突
        const mo = $d('#ba-model-menu'); if (mo) mo.style.display = 'none';
        const am = $d('#ba-agent-menu'); if (am) am.style.display = 'none';
        const op = $d('#ba-opts'); if (op) op.style.display = 'none';
        pane.style.display = 'flex';
        let provOpts = Object.entries(MODEL_PROVIDERS).map(([k, p]) => `<option value="${k}" ${s.provider === k ? 'selected' : ''}>${p.name}</option>`).join('');

        // 生成预设列表 HTML
        function renderPresetList() {
            const presets = getSettings().modelPresets || [];
            if (!presets.length) return '<div style="font-size:12px;color:#64748b;padding:8px 4px">暂无预设，点击下方按钮添加。</div>';
            return presets.map((p) => `
                <div class="ba-preset-item" data-id="${p.id}">
                    <div style="flex:1;min-width:0">
                        <div style="font-weight:600;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</div>
                        <div style="font-size:11px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(MODEL_PROVIDERS[p.provider]?.name || p.provider)} · ${esc(p.model || '')}</div>
                    </div>
                    <button class="ba-icon-btn" data-pact="use" data-id="${p.id}" title="使用此配置">${getIcon('check', 14)}</button>
                    <button class="ba-icon-btn" data-pact="edit" data-id="${p.id}" title="编辑">${getIcon('edit', 14)}</button>
                    <button class="ba-icon-btn is-danger" data-pact="del" data-id="${p.id}" title="删除">${getIcon('trash', 14)}</button>
                </div>
            `).join('');
        }

        pane.innerHTML = `
            <div style="padding:12px 16px;border-bottom:1px solid rgba(148,163,184,.14);background:#111c33;font-weight:600;display:flex;align-items:center;gap:8px">${getIcon('gear', 16)} 设置</div>
            <div class="ba-set-body">
                <div class="ba-set-section">
                    <div class="ba-set-section-title">${getIcon('lightbulb', 14)} 模型配置管理</div>
                    <div id="ba-preset-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px">
                        ${renderPresetList()}
                    </div>
                    <div id="ba-preset-form" style="display:none;border:1px solid rgba(148,163,184,.15);border-radius:10px;padding:12px;background:#0b1425;margin-bottom:10px">
                        <div style="font-weight:600;margin-bottom:8px;font-size:13px" id="ba-preset-form-title">添加预设</div>
                        <input type="hidden" id="pf-id"/>
                        <div class="ba-field">
                            <label>预设名称</label>
                            <input id="pf-name" placeholder="例如：工作用 DeepSeek"/>
                        </div>
                        <div class="ba-field">
                            <label>供应商</label>
                            <select id="pf-provider">${provOpts}</select>
                        </div>
                        <div class="ba-field">
                            <label>API 地址</label>
                            <input id="pf-url" placeholder="https://api.deepseek.com/v1/chat/completions"/>
                        </div>
                        <div class="ba-field">
                            <label>模型 ID</label>
                            <input id="pf-model" placeholder="deepseek-chat"/>
                        </div>
                        <div style="display:flex;gap:6px">
                            <button class="ba-btn ba-btn-primary" id="pf-save" style="flex:1">保存预设</button>
                            <button class="ba-btn ba-btn-secondary" id="pf-cancel">取消</button>
                        </div>
                    </div>
                    <div style="display:flex;gap:6px;margin-bottom:4px">
                        <button class="ba-btn ba-btn-secondary" id="ba-add-preset" style="flex:1">${getIcon('plus', 13)} 添加预设</button>
                        <button class="ba-btn ba-btn-secondary" id="ba-save-cur-preset">保存当前为预设</button>
                    </div>
                </div>
                <div class="ba-set-divider"></div>
                <div class="ba-field">
                    <label>模型供应商</label>
                    <select id="st-provider">${provOpts}</select>
                </div>
                <div class="ba-field">
                    <label>API 地址 (OpenAI 兼容)</label>
                    <input id="st-url" value="${esc(s.apiUrl || '')}" placeholder="https://api.deepseek.com/v1/chat/completions"/>
                </div>
                <div class="ba-field">
                    <label>模型 ID</label>
                    <input id="st-model" value="${esc(s.model || '')}" placeholder="deepseek-chat"/>
                </div>
                <div class="ba-field">
                    <label>API Key <span data-copy style="cursor:pointer;color:#818cf8;font-size:11px">粘贴</span></label>
                    <input id="st-key" value="${esc(s.apiKey || '')}" placeholder="sk-…" style="width:calc(100%);"/>
                </div>
                <div class="ba-field">
                    <label>最大工具迭代次数</label>
                    <input id="st-maxiter" type="number" value="${s.maxIterations || CONFIG.MAX_ITERATIONS}" min="1" max="8"/>
                    <div class="hint">ReAct 工具循环步数上限。回答一次复杂问题时 agent 可多次调用工具。</div>
                </div>
                <div class="ba-field">
                    <label>${PAGE_TYPE === 'database' ? '本地数据库快照地址 (db-snapshot.json，可选)' : PAGE_TYPE === 'deploy' ? '本地部署快照地址 (deploy-snapshot.json，可选)' : PAGE_TYPE === 'service' ? '本地服务快照地址 (service-snapshot.json，可选)' : '本地快照地址 (snapshot.json，可选)'}</label>
                    <input id="st-snap" value="${esc(s.snapshotUrl || '')}" placeholder="${PAGE_TYPE === 'database' ? 'http://127.0.0.1:8420/db-snapshot.json' : PAGE_TYPE === 'deploy' ? 'http://127.0.0.1:8420/deploy-snapshot.json' : PAGE_TYPE === 'service' ? 'http://127.0.0.1:8420/service-snapshot.json' : 'http://127.0.0.1:8420/snapshot.json（nice-aos serve）'}"/>
                    <div class="hint">${PAGE_TYPE === 'database' ? '当蓝图页未内嵌 db-viewer-data 时，从此地址拉取数据库快照。' : PAGE_TYPE === 'deploy' ? '当蓝图页未内嵌 deploy-viewer-data 时，从此地址拉取部署快照。' : PAGE_TYPE === 'service' ? '当蓝图页未内嵌 service-viewer-data 时，从此地址拉取服务快照（service-snapshot.json，含 moduleGraph 图谱）。' : '当蓝图页未内嵌 viewer-data 时，从此地址拉取快照。可用 <code>nice-aos serve</code> 一行启动本地数据源（默认 127.0.0.1:8420，CORS 就绪）。'}</div>
                </div>
                <div class="ba-field">
                    <label>当前数据源</label>
                    <div style="font-size:12px;color:#a5b4fc">${DataSource.status === 'ready' ? DataSource.ctx?.sourceLabel : DataSource.status === 'error' ? '<span style="color:#fca5a5">' + esc(DataSource.error) + '</span>' : (DataSource.status === 'loading' ? '加载中…' : '未加载')}</div>
                </div>
                <div class="ba-field" style="display:flex;gap:6px">
                    <button class="ba-btn ba-btn-primary ba-set-reload" style="flex:1">保存并刷新数据源</button>
                    <button class="ba-btn ba-btn-secondary ba-set-viewdrv">重读页面数据</button>
                </div>
            </div>
            <div class="ba-set-foot">
                <button class="ba-btn ba-btn-secondary" id="st-cancel">取消</button>
                <button class="ba-btn ba-btn-primary" id="st-save">保存</button>
            </div>`;

        // ---- 预设管理逻辑 ----
        function refreshPresetList() {
            const list = $d('#ba-preset-list');
            if (list) list.innerHTML = renderPresetList();
            attachPresetActions();
        }
        function showPresetForm(preset) {
            const form = $d('#ba-preset-form');
            form.style.display = 'block';
            $d('#ba-preset-form-title').textContent = preset ? '编辑预设' : '添加预设';
            $d('#pf-id').value = preset?.id || '';
            $d('#pf-name').value = preset?.name || '';
            $d('#pf-provider').value = preset?.provider || 'deepseek';
            $d('#pf-url').value = preset?.apiUrl || MODEL_PROVIDERS[preset?.provider || 'deepseek']?.apiUrl || '';
            $d('#pf-model').value = preset?.model || MODEL_PROVIDERS[preset?.provider || 'deepseek']?.defaultModel || '';
        }
        function hidePresetForm() {
            $d('#ba-preset-form').style.display = 'none';
        }
        function attachPresetActions() {
            // 预设列表操作
            $all('#ba-preset-list [data-pact]', pane).forEach((btn) => {
                btn.addEventListener('click', () => {
                    const id = btn.dataset.id;
                    const presets = getSettings().modelPresets || [];
                    const preset = presets.find((p) => p.id === id);
                    if (!preset) return;
                    if (btn.dataset.pact === 'use') {
                        saveSettings({ provider: preset.provider, model: preset.model, apiUrl: preset.apiUrl });
                        // 同步更新表单字段
                        $d('#st-provider').value = preset.provider;
                        $d('#st-url').value = preset.apiUrl;
                        $d('#st-model').value = preset.model;
                        renderModelChip();
                        toast(`已切换至 ${preset.name}`, 'success');
                    } else if (btn.dataset.pact === 'edit') {
                        showPresetForm(preset);
                    } else if (btn.dataset.pact === 'del') {
                        if (presets.length <= 1) { toast('至少保留一个预设', 'error'); return; }
                        confirmAction(`删除预设「${preset.name}」？`, () => {
                            const newPresets = presets.filter((p) => p.id !== id);
                            saveSettings({ modelPresets: newPresets });
                            refreshPresetList();
                            toast('已删除', 'success');
                        });
                    }
                });
            });
        }

        $d('#ba-add-preset').addEventListener('click', () => showPresetForm(null));
        $d('#ba-save-cur-preset').addEventListener('click', () => {
            const cur = getSettings();
            const prov = MODEL_PROVIDERS[cur.provider];
            const name = prompt('预设名称：', prov?.name ? prov.name + ' · ' + (cur.model || '自定义') : '自定义配置');
            if (!name || !name.trim()) return;
            const presets = [...(cur.modelPresets || []), {
                id: uid(), name: name.trim(), provider: cur.provider, model: cur.model, apiUrl: cur.apiUrl || '',
            }];
            saveSettings({ modelPresets: presets });
            refreshPresetList();
            toast('已保存为预设', 'success');
        });
        $d('#pf-cancel').addEventListener('click', hidePresetForm);
        $d('#pf-provider').addEventListener('change', () => {
            const p = MODEL_PROVIDERS[$d('#pf-provider').value];
            $d('#pf-url').value = p?.apiUrl || '';
            $d('#pf-model').value = p?.defaultModel || '';
        });
        $d('#pf-save').addEventListener('click', () => {
            const id = $d('#pf-id').value;
            const name = $d('#pf-name').value.trim();
            const provider = $d('#pf-provider').value;
            const apiUrl = $d('#pf-url').value.trim();
            const model = $d('#pf-model').value.trim();
            if (!name) { toast('请输入预设名称', 'error'); return; }
            const presets = [...(getSettings().modelPresets || [])];
            if (id) {
                // 编辑
                const idx = presets.findIndex((p) => p.id === id);
                if (idx >= 0) presets[idx] = { ...presets[idx], name, provider, apiUrl, model };
            } else {
                // 新增
                presets.push({ id: uid(), name, provider, apiUrl, model });
            }
            saveSettings({ modelPresets: presets });
            hidePresetForm();
            refreshPresetList();
            renderModelChip();
            toast(id ? '预设已更新' : '预设已添加', 'success');
        });
        attachPresetActions();

        // 如果从模型菜单跳转，滚动到预设管理区域
        if (tab === 'presets') {
            const body = $d('.ba-set-body', pane);
            if (body) body.scrollTop = 0;
        }

        const sel = $d('#st-provider');
        sel.addEventListener('change', () => {
            const p = MODEL_PROVIDERS[sel.value];
            $d('#st-url').value = p?.apiUrl || '';
            $d('#st-model').value = p?.defaultModel || '';
        });
        $d('#st-save').addEventListener('click', () => {
            saveSettings({
                provider: sel.value,
                apiUrl: $d('#st-url').value.trim(),
                model: $d('#st-model').value.trim(),
                apiKey: $d('#st-key').value.trim(),
                maxIterations: Math.min(Number($d('#st-maxiter').value) || CONFIG.MAX_ITERATIONS, 8),
                snapshotUrl: $d('#st-snap').value.trim(),
            });
            pane.style.display = 'none';
            renderModelChip();
            toast('设置已保存', 'success');
        });
        $d('#st-cancel').addEventListener('click', () => { pane.style.display = 'none'; });
        $all('.ba-set-reload', pane).forEach((b) => b.addEventListener('click', async () => {
            saveSettings({
                provider: sel.value, apiUrl: $d('#st-url').value.trim(), model: $d('#st-model').value.trim(),
                apiKey: $d('#st-key').value.trim(), maxIterations: Number($d('#st-maxiter').value) || CONFIG.MAX_ITERATIONS, snapshotUrl: $d('#st-snap').value.trim(),
            });
            await refreshData(true);
        }));
        $all('.ba-set-viewdrv', pane).forEach((b) => b.addEventListener('click', async () => {
            const idx = DataSource.readInjected();
            if (idx) { DataSource.ctx = idx; DataSource.status = 'ready'; toast('已重读页面内嵌数据', 'success'); }
            else toast(PAGE_TYPE === 'database' ? '页面未发现内嵌 db-viewer-data' : PAGE_TYPE === 'deploy' ? '页面未发现内嵌 deploy-viewer-data' : PAGE_TYPE === 'service' ? '页面未发现内嵌 service-viewer-data' : '页面未发现内嵌 viewer-data', 'error');
        }));
    }

    async function refreshData(silent) {
        if (!silent) toast('加载数据源…');
        await DataSource.load();
        renderMessages();
        if (DataSource.status === 'error' && !silent) toast(DataSource.error, 'error');
        if (DataSource.status === 'ready' && !silent) toast(`数据源就绪：${DataSource.ctx.sourceLabel}`, 'success');
    }

    // ---- 对话发送与流式 ----
    async function sendMessage(text) {
        const inp = $d('#ba-inp');
        const message = (text ?? inp.value).trim();
        if (!message) return;
        let conv = ui.activeConv || ChatManager.ensureActive();
        if (conv.meta?.running) { toast('请先停止当前生成', 'error'); return; }
        if (DataSource.status !== 'ready') {
            const ok2 = await ensureData();
            if (!ok2) { openSettings(); toast('请先配置并加载数据源', 'error'); return; }
        }
        const s = getSettings();
        if (!(s.apiKey || '').trim()) {
            openSettings(); toast('请先配置 API Key（支持多模型供应商）', 'error'); return;
        }

        inp.value = '';
        conv.title = conv.title === '新会话' ? message.slice(0, 20) : conv.title;
        appendMessage(conv, { type: 'user', content: message });
        const aiMsg = { type: 'ai', role: 'assistant', content: '', loading: true };
        conv.messages.push(aiMsg);
        ChatManager.markRunning(conv, true);
        ui.activeConv = conv;
        renderConvList();
        renderMessages();

        const box = $d('#ba-msgs');
        const aiBody = box.lastElementChild?.querySelector('.md-body');
        if (aiBody) aiBody.innerHTML = `<span class="ba-typing"><i></i><i></i><i></i></span>`;
        sendBtnState(true);

        abortFlag = false;
        const history = conv.messages
            .filter((m) => m.type === 'ai' || m.type === 'user')
            .slice(0, -1)
            .map((m) => ({ role: m.type === 'user' ? 'user' : 'assistant', content: m.content }));

        let toolRunningEl = null;
        const onToolCall = (name, args, state, result) => {
            if (state === 'start') {
                const tMsg = { type: 'tool', tool: { name, args }, state: 'running' };
                conv.messages.push(tMsg);
                ChatManager.save(conv);
                renderMessages();
                toolRunningEl = $d('#ba-msgs').lastElementChild?.querySelector('.ba-tool-chip');
            } else if (toolRunningEl) {
                const tMsg = conv.messages[conv.messages.length - 1];
                if (tMsg?.type === 'tool') { tMsg.state = state === 'done' ? 'done' : 'error'; if (state === 'error') tMsg.tool.error = result?.error || '执行失败'; }
                else { conv.messages.push({ type: 'tool', tool: { name, args, error: result?.error }, state: state === 'done' ? 'done' : 'error' }); }
                ChatManager.save(conv);
                renderMessages();
            }
        };
        const onChunk = (delta) => {
            aiMsg.content += delta;
            aiMsg.loading = false;
            ChatManager.save(conv);
            const box2 = $d('#ba-msgs');
            const body = box2.lastElementChild?.querySelector('.md-body');
            if (body && body !== aiBody) body.innerHTML = mdToHtml(aiMsg.content || '');
            else if (aiBody) aiBody.innerHTML = mdToHtml(aiMsg.content || '') || (aiMsg.content ? '' : '<span class="ba-typing"><i></i><i></i><i></i></span>');
            box2.scrollTop = box2.scrollHeight;
        };

        try {
            const res = await runAgentLoop(message, history, conv.title, onChunk, onToolCall);
            aiMsg.content = res.response;
            aiMsg.loading = false;
            if (res.error) aiMsg.error = res.error;
            ChatManager.markRunning(conv, false);
            renderMessages();
        } catch (e) {
            aiMsg.content = '';
            aiMsg.error = e.message || String(e);
            aiMsg.loading = false;
            ChatManager.markRunning(conv, false);
            renderMessages();
        } finally {
            sendBtnState(false);
        }
    }

    function sendBtnState(running) {
        const btn = $d('#ba-send-btn');
        if (!btn) return;
        btn.classList.toggle('stop', running);
        btn.innerHTML = running ? getIcon('stop', 17) : getIcon('send', 17);
    }
    function stopGeneration() { abortFlag = true; toast('正在停止…'); }

    async function ensureData() {
        if (DataSource.status === 'ready') return true;
        await DataSource.load();
        return DataSource.status === 'ready';
    }

    function exportConversation(conv, format) {
        if (!conv?.messages?.length) { toast('无内容可导出', 'error'); return; }
        const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const fname = `aos-chat-${conv.title}_${ts}.${format === 'json' ? 'json' : 'md'}`;
        if (format === 'json') {
            const data = { provider: getSettings().provider, model: getSettings().model, dataSource: DataSource.ctx?.sourceLabel || '', exportedAt: new Date().toISOString(), conversation: conv.messages };
            downloadFile(JSON.stringify(data, null, 2), fname, 'application/json');
        } else {
            const lines = [];
            lines.push(`# 会话：${conv.title}`);
            lines.push(`- 数据源: ${DataSource.ctx?.sourceLabel || ''}`);
            lines.push(`- 模型: ${getSettings().provider} / ${getSettings().model}`);
            lines.push(`- 导出时间: ${new Date().toISOString()}`);
            lines.push('');
            for (const m of conv.messages) {
                if (m.type === 'user') lines.push(`## 用户\n${m.content}\n`);
                else if (m.type === 'ai') lines.push(`## AI\n${m.content || (m.error ? `（错误：${m.error}）` : '')}\n`);
                else if (m.type === 'tool') lines.push(`> 工具 ${m.tool?.name}: ${JSON.stringify(m.tool?.args)} ${m.tool?.error ? `（${m.tool.error}）` : ''}`);
            }
            downloadFile(lines.join('\n'), fname, 'text/markdown');
        }
        toast(`已导出 ${format.toUpperCase()}`);
    }

    // ---- 浮窗按钮 ----
    function createFab() {
        const fab = el('button', 'ba-fab ba-fab-pulse');
        fab.id = 'ba-fab';
        fab.title = PAGE_TYPE === 'database' ? '数据库蓝图 AI 分析' : PAGE_TYPE === 'deploy' ? '部署蓝图 AI 分析' : PAGE_TYPE === 'service' ? '服务蓝图 AI 分析' : 'AOS 蓝图 AI 分析';
        fab.innerHTML = getIcon(PAGE_TYPE === 'database' ? 'database' : PAGE_TYPE === 'deploy' ? 'server' : PAGE_TYPE === 'service' ? 'server' : 'chat', 24);
        fab.addEventListener('click', openPanel);
        document.body.appendChild(fab);
    }

    // ============================================================
    //  初始化
    // ============================================================
    function init() {
        ensureStyles();
        if (PAGE_TYPE === 'database') {
            registerDatabaseTools();
        } else if (PAGE_TYPE === 'deploy') {
            registerDeployTools();
        } else if (PAGE_TYPE === 'service') {
            registerServiceTools();
        } else {
            registerAnalysisTools();
        }
        buildPanel();
        attachMenuActions();
        createFab();
        // 异步加载数据源（页面内嵌优先，随后尝试配置的本地快照）
        DataSource.load().then(() => {
            renderMessages();
            settingsCache = null; // 确保 provider 默认值
            readSettings();
        });
        // 会话数据变化时回到当前视图
        PanelRefreshHook();
        const logMsg = PAGE_TYPE === 'database' ? '数据库蓝图 AI 分析助手已启动'
            : PAGE_TYPE === 'deploy' ? '部署蓝图 AI 分析助手已启动'
            : PAGE_TYPE === 'service' ? '后端服务蓝图 AI 分析助手已启动'
            : 'AOS 蓝图 AI 分析助手已启动';
        console.log('%c[BA-Agent] ' + logMsg, 'color:#8b5cf6;font-weight:bold');
    }

    // 在面板构建后监听洞
    function PanelRefreshHook() {
        // 空钩子：渲染函数直接使用 ui.activeConv
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();