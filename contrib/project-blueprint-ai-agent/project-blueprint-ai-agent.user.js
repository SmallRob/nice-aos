// ==UserScript==
// @name         AOS 项目级蓝图 AI 助手
// @name:zh-CN   AOS 项目级蓝图 AI 助手
// @name:en      AOS Project-Level Blueprint AI Assistant
// @namespace    https://github.com/nice-aos
// @version      1.0.0
// @description  nice-aos 蓝图 AI 对话（项目级）。**接管所有 7 种蓝图**：(1) 原 5 种 viewer-data 页（code/database/deploy/service/planning）；(2) 新 2 种静态聚合蓝图（architecture-blueprint.html / summary-blueprint.html，DOM 解析）。**项目级会话/缓存分桶**：projectId 从 URL 路径第一段推断，同一项目下 7 种页面共享会话与跨页数据，跨项目完全隔离。**跨蓝图数据共享**通过 getSharedData 工具实现（如架构页能查 code 页解析出的 services）。存储用 GM_getValue/setValue → 降级 localStorage。**取代原 blueprint-ai-agent 脚本**——原脚本可以禁用，新脚本是单一入口。
// @description:en Project-level blueprint AI (v2). Replaces blueprint-ai-agent. Takes over all 7 blueprint types: 5 viewer-data pages (code/database/deploy/service/planning) + 2 static aggregations (architecture/summary, DOM-parsed). Per-project session/cache bucketing by URL-derived projectId; same project shares across pages, projects isolated. Cross-blueprint data via getSharedData tool. GM_* with localStorage fallback. Original blueprint-ai-agent can be disabled.
// @icon         data:image/svg+xml,%3Csvg%20viewBox='0%200%2024%2024'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3E%3Crect%20width='24'%20height='24'%20rx='6'%20fill='%237c5cff'/%3E%3Cpath%20d='M7%205.5h10a1.5%201.5%200%200%201%201.5%201.5v7a1.5%201.5%200%200%201-1.5%201.5h-4.5l-4%203.2V15.5H7a1.5%201.5%200%200%201-1.5-1.5V7A1.5%201.5%200%200%201%207%205.5z'%20fill='white'/%3E%3Cpath%20d='M12%207.5l1%202.8a2%202%200%200%200%201.1%201.1L17%2012.5l-2.9%201.1a2%202%200%200%200-1.1%201.1L12%2017.5l-1-2.8a2%202%200%200%200-1.1-1.1L7%2012.5l2.9-1.1a2%202%200%200%200%201.1-1.1L12%207.5z'%20fill='%237c5cff'/%3E%3C/svg%3E
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

/*
 * project-blueprint-ai-agent.user.js  v1.0.0
 *
 * 与原脚本 blueprint-ai-agent.user.js v1.1.0 的关系：
 *   - 本脚本完整接管 7 种蓝图（5 viewer-data + 2 DOM 解析）
 *   - 原脚本可禁用（本脚本是单一入口）；两者并存也可（key 前缀隔离互不冲突）
 *   - 关键增强：项目级会话分桶（projectId 从 URL 第一段推断）+ 跨蓝图数据共享
 *
 * 存储：GM_setValue/getValue/deleteValue 优先，降级 localStorage
 * key 前缀：ba_ai_chats_proj:<projectId> / ba_ai_cache_proj:<projectId>:<pageType>
 */

(function () {
    'use strict';

    // ============================================================
    //  项目识别（URL 推断 + 降级链）
    // ============================================================
    function safeKey(s) { return String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || '__unknown__'; }
    function computeProjectId() {
        try {
            const segs = location.pathname.split('/').filter(Boolean);
            if (segs.length && segs[0]) return safeKey(segs[0]);
        } catch { /* ignore */ }
        try { return safeKey('__host__' + location.host); } catch { /* ignore */ }
        return '__unknown__';
    }
    const PROJECT_ID = computeProjectId();

    // ============================================================
    //  页面类型检测（7 种全部接管）
    // ============================================================
    function detectPageType() {
        // 原 5 种：viewer-data 内嵌 JSON
        if (document.getElementById('planning-viewer-data')) return 'planning';
        if (document.getElementById('service-viewer-data')) return 'service';
        if (document.getElementById('deploy-viewer-data')) return 'deploy';
        if (document.getElementById('db-viewer-data')) return 'database';
        if (document.getElementById('viewer-data') || document.querySelector('#viewer')) return 'code';
        // 新 2 种：基于 URL 路径 + h1
        const path = location.pathname.toLowerCase();
        if (path.endsWith('/architecture-blueprint.html') || path.includes('/architecture-blueprint.html')) {
            const h1 = document.querySelector('h1');
            if (h1 && /架构蓝图/.test(h1.textContent || '')) return 'architecture';
        }
        if (path.endsWith('/summary-blueprint.html') || path.includes('/summary-blueprint.html')) {
            const h1 = document.querySelector('h1');
            if (h1 && /总览/.test(h1.textContent || '')) return 'summary';
        }
        return null;
    }
    const PAGE_TYPE = detectPageType();
    if (!PAGE_TYPE) return;

    // ============================================================
    //  配置与常量（项目级 key 前缀）
    // ============================================================
    const KP = `proj:${PROJECT_ID}`;
    const CONFIG = {
        AI_DEFAULT_URL: 'https://api.deepseek.com/v1/chat/completions',
        AI_DEFAULT_MODEL: 'deepseek-chat',
        PANEL_WIDTH: 580,
        MAX_ITERATIONS: 5,
        TOOL_TIMEOUT: 25000,
        AI_TIMEOUT: 120000,
        CACHE_TTL: 30 * 60 * 1000,
        TOAST_DURATION: 3000,
        SK: {
            SETTINGS: `ba_ai_settings_${KP}`,
            CHATS: `ba_ai_chats_${KP}`,
            ACTIVE: `ba_ai_active_${KP}`,
            VER: `ba_ai_ver_${KP}`,
            CACHE: `ba_ai_cache_${KP}`,
            SNAP: `ba_ai_snap_${KP}`,
        },
    };

    const MODEL_PROVIDERS = {
        deepseek: { name: 'DeepSeek', apiUrl: 'https://api.deepseek.com/v1/chat/completions', models: [{ value: 'deepseek-chat', label: 'DeepSeek Chat' }, { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' }], defaultModel: 'deepseek-chat', apiKeyUrl: 'https://platform.deepseek.com/api_keys' },
        glm: { name: '智谱GLM', apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', models: [{ value: 'glm-4-flash', label: 'GLM-4-Flash (免费)' }, { value: 'glm-4-plus', label: 'GLM-4-Plus' }], defaultModel: 'glm-4-flash', apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
        qwen: { name: '通义千问', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', models: [{ value: 'qwen-plus', label: 'Qwen Plus' }, { value: 'qwen-max', label: 'Qwen Max' }], defaultModel: 'qwen-plus', apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey' },
        moonshot: { name: 'Kimi', apiUrl: 'https://api.moonshot.cn/v1/chat/completions', models: [{ value: 'moonshot-v1-8k', label: 'Moonshot v1 8K' }], defaultModel: 'moonshot-v1-8k', apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys' },
        doubao: { name: '豆包', apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', models: [{ value: 'doubao-seed-1-6-pro-250528', label: 'Doubao Seed 1.6 Pro' }], defaultModel: 'doubao-seed-1-6-pro-250528', apiKeyUrl: 'https://console.volcengine.com/ark' },
        openai: { name: 'OpenAI', apiUrl: 'https://api.openai.com/v1/chat/completions', models: [{ value: 'gpt-4o-mini', label: 'GPT-4o Mini' }, { value: 'gpt-4o', label: 'GPT-4o' }], defaultModel: 'gpt-4o-mini', apiKeyUrl: 'https://platform.openai.com/api-keys' },
        custom: { name: '自定义', apiUrl: '', models: [{ value: '', label: '自定义模型 ID' }], defaultModel: '', apiKeyUrl: '', keyHint: '输入兼容 OpenAI 格式的 API 地址与模型 ID' },
    };

    // ============================================================
    //  小工具
    // ============================================================
    const $d = (sel, scope = document) => scope.querySelector(sel);
    const $all = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));
    const el = (tag, cls = '', html = '') => { const n = document.createElement(tag); if (cls) n.className = cls; if (html) n.innerHTML = html; return n; };
    const parseStored = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
    const deepClone = (o) => JSON.parse(JSON.stringify(o));
    const uid = () => 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const trunc = (s, n = 120) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

    let toastTimer;
    function toast(msg, type = 'info') {
        let t = $d('.pba-toast');
        if (!t) { t = el('div', 'pba-toast'); document.body.appendChild(t); }
        t.textContent = msg;
        t.className = 'pba-toast pba-toast-' + type + ' pba-toast-show';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove('pba-toast-show'), CONFIG.TOAST_DURATION);
    }
    function getIcon(name, size = 16) {
        const I = SVG_ICONS[name] || SVG_ICONS.robot;
        return `<svg class="pba-ic" style="width:${size}px;height:${size}px" viewBox="0 0 24 24" fill="none">${I}</svg>`;
    }
    function downloadFile(content, filename, mime = 'text/plain') {
        const blob = new Blob([content], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename;
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
        if (!Array.isArray(s.modelPresets) || s.modelPresets.length === 0) {
            const prov = MODEL_PROVIDERS[s.provider];
            s.modelPresets = [{ id: uid(), name: prov?.name ? prov.name + ' · ' + (s.model || '默认') : '默认配置', provider: s.provider, model: s.model, apiUrl: s.apiUrl || prov?.apiUrl || '' }];
        }
        return s;
    }
    let settingsCache = null;
    const getSettings = () => settingsCache || (settingsCache = readSettings());
    const saveSettings = (patch) => { settingsCache = { ...getSettings(), ...patch }; Store.set(CONFIG.SK.SETTINGS, JSON.stringify(settingsCache)); };

    // ============================================================
    //  SVG 图标
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
        link: `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
        bot: `<rect x="4" y="7" width="16" height="12" rx="3" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="13" r="1.2" fill="currentColor"/><circle cx="15" cy="13" r="1.2" fill="currentColor"/><path d="M12 3v4M9 2h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
    };

    // ============================================================
    //  数据类型 & 工具显示配置
    // ============================================================
    const DATA_TYPES = ['project', 'domain', 'module', 'sourcefile', 'component', 'hook', 'store', 'service', 'interface', 'class', 'method', 'route', 'userscript', 'scriptfunction', 'dependency', 'gmusage', 'injectionpoint', 'networkendpoint'];
    const TYPE_LABELS = { project: '工程', domain: '功能域', module: '模块', sourcefile: '源文件', component: '组件', hook: 'Hook', store: 'Store', service: 'Service', interface: '接口', class: '类', method: '方法', route: '路由', userscript: '油猴脚本', scriptfunction: '脚本函数', dependency: '依赖', gmusage: 'GM调用', injectionpoint: '注入点', networkendpoint: '网络端点' };

    const TOOL_DISPLAY = {
        // 通用
        getStats: { label: '总览统计', icon: 'chart' },
        queryObjects: { label: '对象查询', icon: 'search' },
        getNodeDetails: { label: '对象详情', icon: 'file' },
        listLinks: { label: '关联查询', icon: 'sitemap' },
        getSharedData: { label: '跨蓝图数据', icon: 'link' },
        listSharedPages: { label: '已缓存页面', icon: 'book' },
        // 数据库专属
        getDbStats: { label: '数据库概览', icon: 'chart' },
        getDbHealth: { label: '健康度评估', icon: 'chart' },
        // 部署专属
        getDeployStats: { label: '部署概览', icon: 'chart' },
        getDeployHealth: { label: '部署健康', icon: 'chart' },
        // 服务专属
        getServiceStats: { label: '服务概览', icon: 'chart' },
        getServiceHealth: { label: '服务健康', icon: 'chart' },
        // 规划专属
        getPlanningStats: { label: '规划概览', icon: 'chart' },
        getPlanningHealthAudit: { label: '规划健康审计', icon: 'lightbulb' },
        queryPlanningFeatures: { label: '特性查询', icon: 'chart' },
        // 架构专属
        getArchStats: { label: '架构总览', icon: 'chart' },
        queryArchServices: { label: '服务查询', icon: 'server' },
        getArchServiceDetails: { label: '服务详情', icon: 'file' },
        queryArchLayers: { label: '分层架构', icon: 'sitemap' },
        queryArchTechGroups: { label: '技术栈', icon: 'code' },
        queryArchTables: { label: '表格查询', icon: 'file' },
        getArchTabContent: { label: 'Tab 内容', icon: 'book' },
        // 总览专属
        getSummaryStats: { label: '总览统计', icon: 'chart' },
        querySummaryProjects: { label: '项目查询', icon: 'sitemap' },
        getSummaryProjectDetail: { label: '项目详情', icon: 'file' },
    };
    function getToolDisplay(name) {
        const key = String(name || '');
        return TOOL_DISPLAY[key] || { label: key || '工具', icon: 'code' };
    }
    function formatToolArgs(args) {
        if (!args || typeof args !== 'object') return '';
        const entries = Object.entries(args);
        if (!entries.length) return '';
        return entries.slice(0, 2).map(([k, v]) => {
            const val = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
            return `${k}: ${val.length > 24 ? val.slice(0, 24) + '…' : val}`;
        }).join(' · ');
    }

    // ============================================================
    //  解析器：原 5 种 viewer-data
    // ============================================================
    const ViewerParsers = {
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

        _buildCodeIndex(raw) {
            const byId = new Map();
            const byType = {};
            const arrays = this._typeArrays(raw) || {};
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
            const project = raw.Project?.[0] || raw.dataMap?.project?.[0] || arrays.project?.[0] || { id: 'proj:unknown', name: '未命名项目', fileCount: (arrays.sourcefile || []).length };
            return { byId, byType, project, meta, pageType: 'code' };
        },

        _buildDbIndex(raw) {
            const byName = new Map();
            const byType = {};
            const DB_TYPES = ['tables', 'foreignKeys', 'indexes', 'migrations', 'domains', 'views', 'triggers', 'procedures'];
            for (const t of DB_TYPES) { const arr = raw[t] || []; byType[t] = arr; if (t === 'tables') for (const x of arr) if (x.name) byName.set(x.name, x); }
            const project = { name: '数据库蓝图', id: PROJECT_ID };
            return { byId: byName, byType, byName, project, meta: raw.meta || raw._meta || {}, pageType: 'database' };
        },

        _buildDeployIndex(raw) {
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
            for (const s of byType.services) if (s.name) byName.set(s.name, s);
            const project = { name: '部署蓝图', id: PROJECT_ID };
            return { byId: byName, byType, byName, project, meta: raw.meta || raw._meta || {}, pageType: 'deploy' };
        },

        _buildServiceIndex(raw) {
            const byType = {
                modules: raw.modules || [],
                layers: raw.layers || [],
                endpoints: raw.endpoints || [],
                tables: raw.tables || [],
                dependencies: raw.dependencies || [],
                techStack: raw.techStack || [],
            };
            const byName = new Map();
            for (const m of byType.modules) if (m.key) byName.set(m.key, m);
            for (const t of byType.tables) if (t.name) byName.set(t.name, t);
            const project = { name: raw.serviceName || raw.name || '后端服务', id: PROJECT_ID };
            return { byId: byName, byType, byName, project, meta: raw.meta || raw._meta || {}, pageType: 'service' };
        },

        _buildPlanningIndex(raw) {
            const byType = {
                features: raw.features || [],
                modules: raw.modules || [],
                releases: raw.releases || [],
                milestones: raw.milestones || [],
                themes: raw.themes || [],
                dependencies: raw.dependencies || [],
                stats: raw.stats ? [raw.stats] : [],
                audit: raw.audit ? [raw.audit] : [],
            };
            const byId = new Map();
            for (const f of byType.features) if (f.id) byId.set(f.id, f);
            for (const m of byType.modules) if (m.key) byId.set(m.key, m);
            const project = { name: raw.productName || '产品规划', id: PROJECT_ID };
            return { byId, byType, byName: byId, project, meta: raw.meta || raw._meta || {}, pageType: 'planning' };
        },

        read() {
            const sel = PAGE_TYPE === 'code' ? 'viewer-data'
                : PAGE_TYPE === 'database' ? 'db-viewer-data'
                : PAGE_TYPE === 'deploy' ? 'deploy-viewer-data'
                : PAGE_TYPE === 'service' ? 'service-viewer-data'
                : PAGE_TYPE === 'planning' ? 'planning-viewer-data'
                : null;
            if (!sel) return null;
            const el = document.getElementById(sel);
            if (!el) return null;
            try {
                const parsed = JSON.parse(el.textContent);
                if (PAGE_TYPE === 'code') return this._buildCodeIndex(parsed && ('dataMap' in parsed) ? parsed : { dataMap: parsed });
                if (PAGE_TYPE === 'database') return this._buildDbIndex(parsed);
                if (PAGE_TYPE === 'deploy') return this._buildDeployIndex(parsed);
                if (PAGE_TYPE === 'service') return this._buildServiceIndex(parsed);
                if (PAGE_TYPE === 'planning') return this._buildPlanningIndex(parsed);
                return null;
            } catch (e) { console.warn('[PBA-Agent] viewer-data parse error', e); return null; }
        },
    };

    // ============================================================
    //  解析器：architecture-blueprint.html（DOM）
    // ============================================================
    const ArchParser = {
        parse() {
            const h1 = $d('h1');
            const title = h1 ? h1.textContent.trim() : '';
            const projectName = title.replace(/(项目)?全景?架构蓝图.*$/, '').replace(/(.*?项目)\s*$/, '$1').trim() || title || '未命名项目';

            const stats = [];
            $all('.cards .card').forEach((c) => {
                const k = $d('.k', c)?.textContent?.trim() || '';
                const v = $d('.v', c)?.textContent?.trim() || '';
                if (k) stats.push({ key: k, value: v });
            });

            const services = [];
            $all('.svc').forEach((s) => {
                const a = $d('a', s);
                services.push({
                    role: $d('.role', s)?.textContent?.trim() || '',
                    name: $d('.name', s)?.textContent?.trim() || '',
                    href: a?.getAttribute('href') || '',
                    meta: $d('.meta', s)?.textContent?.trim() || '',
                    port: $d('.port', s)?.textContent?.trim() || '',
                    tech: $d('.tech', s)?.textContent?.trim() || '',
                });
            });

            const layers = [];
            $all('.layer').forEach((l) => {
                layers.push({
                    title: $d('.title', l)?.textContent?.trim() || '',
                    small: $d('.title small', l)?.textContent?.trim() || '',
                    services: $all('.svc .name', l).map((n) => n.textContent.trim()),
                });
            });

            const techGroups = [];
            $all('.techgroup').forEach((tg) => {
                techGroups.push({
                    name: $d('.tgv', tg)?.textContent?.trim() || '',
                    summary: $d('.tgt', tg)?.textContent?.trim() || '',
                    items: $all('.techitem', tg).map((it) => ({
                        name: $d('.tiname', it)?.textContent?.trim() || '',
                        version: $d('.tiver', it)?.textContent?.trim() || '',
                    })),
                });
            });

            const tables = [];
            let currentH2 = '';
            $all('h2, table').forEach((n) => {
                if (n.tagName === 'H2') currentH2 = n.textContent.trim();
                else if (n.tagName === 'TABLE') {
                    const headers = Array.from(n.querySelectorAll('thead th')).map((th) => th.textContent.trim());
                    const rows = Array.from(n.querySelectorAll('tbody tr')).map((tr) => {
                        const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim().replace(/\s+/g, ' '));
                        const obj = {};
                        headers.forEach((h, i) => { obj[h || `col${i}`] = cells[i] ?? ''; });
                        return obj;
                    });
                    if (rows.length) tables.push({ heading: currentH2, headers, rows });
                }
            });

            const tabs = $all('.tab').map((t) => ({ key: t.getAttribute('data-tab'), label: t.textContent.trim() }));

            return {
                byId: new Map(services.map((s) => [s.name, s])),
                byType: { services, layers, techGroups, tables },
                byName: new Map(services.map((s) => [s.name, s])),
                project: { name: projectName, id: PROJECT_ID, source: 'architecture-blueprint.html' },
                meta: { stats, tabs, parsedAt: Date.now(), source: 'DOM' },
                pageType: 'architecture',
            };
        },
    };

    // ============================================================
    //  解析器：summary-blueprint.html（DOM）
    // ============================================================
    const SummaryParser = {
        parse() {
            const h1 = $d('h1');
            const title = h1 ? h1.textContent.trim() : '';
            const projectName = title.replace(/(项目)?代码本体总览.*$/, '$1').trim() || title || '未命名项目';

            const stats = [];
            $all('.cards .card').forEach((c) => {
                const k = $d('.k', c)?.textContent?.trim() || '';
                const v = $d('.v', c)?.textContent?.trim() || '';
                if (k) stats.push({ key: k, value: v });
            });

            const projects = [];
            $all('table tbody tr').forEach((tr) => {
                const a = tr.querySelector('a[href$="/blueprint.html"]');
                if (!a) return;
                const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim().replace(/\s+/g, ' '));
                projects.push({ name: a.textContent.trim(), href: a.getAttribute('href') || '', cells });
            });

            const byId = new Map(projects.map((p) => [p.name, p]));
            return {
                byId,
                byType: { projects, stats },
                byName: byId,
                project: { name: projectName, id: PROJECT_ID, source: 'summary-blueprint.html' },
                meta: { stats, parsedAt: Date.now(), source: 'DOM' },
                pageType: 'summary',
            };
        },
    };

    // ============================================================
    //  DataSource（项目级共享缓存）
    // ============================================================
    const DataSource = {
        ctx: null, status: 'unloaded', error: '',
        _cacheKey(pageType) { return `${CONFIG.SK.CACHE}:${pageType}`; },

        readSharedCache(pageType) {
            try {
                const raw = Store.get(this._cacheKey(pageType), null);
                if (!raw) return null;
                const obj = JSON.parse(raw);
                if (obj?.expiresAt && obj.expiresAt < Date.now()) return null;
                return obj?.data || null;
            } catch { return null; }
        },

        writeSharedCache(pageType, data) {
            try {
                Store.set(this._cacheKey(pageType), JSON.stringify({ data, expiresAt: Date.now() + CONFIG.CACHE_TTL, at: Date.now() }));
                return true;
            } catch (e) { console.warn('[PBA-Agent] writeSharedCache failed', e); return false; }
        },

        readInjected() {
            // 优先：本项目下同 pageType 的缓存命中
            const cached = this.readSharedCache(PAGE_TYPE);
            if (cached) return cached;
            return null;
        },

        readDom() {
            try {
                if (PAGE_TYPE === 'architecture') return ArchParser.parse();
                if (PAGE_TYPE === 'summary') return SummaryParser.parse();
                return ViewerParsers.read();
            } catch (e) { console.error('[PBA-Agent] parse error', e); return null; }
        },

        async load() {
            this.status = 'loading'; this.error = '';
            try {
                // 1) 共享缓存命中（同 projectId 此前打开过本页面类型）
                const cached = this.readInjected();
                if (cached) { this.ctx = { ...cached, sourceLabel: `共享缓存（${PAGE_TYPE}）` }; this.status = 'ready'; return this.ctx; }
                // 2) 解析
                const parsed = this.readDom();
                if (parsed) {
                    this.writeSharedCache(PAGE_TYPE, parsed);
                    this.ctx = { ...parsed, sourceLabel: `页面解析（${PAGE_TYPE}）` };
                    this.status = 'ready';
                    return this.ctx;
                }
                this.status = 'error';
                this.error = `未找到 ${PAGE_TYPE} 页面的数据源（既无内嵌 viewer-data 也无 DOM 结构）`;
                return null;
            } catch (e) { this.status = 'error'; this.error = String(e.message || e); return null; }
        },
    };

    // ============================================================
    //  ToolRegistry + 通用工具
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

    function needsData() { if (DataSource.status !== 'ready' || !DataSource.ctx) return '数据尚未加载，请点击右上 ⚙ → 刷新数据源'; return null; }
    const matchObj = (o, kw) => { kw = String(kw ?? '').trim().toLowerCase(); if (!kw) return true; return [o.name, o.id, o.path, o.filePath, o.key].filter(Boolean).some((f) => String(f).toLowerCase().includes(kw)); };
    function getNodeByQuery(q) {
        const { byId, byType } = DataSource.ctx;
        let o = byId.get(q);
        if (!o) {
            const [pt, ...rest] = q.split(':');
            if (rest.length) {
                const type = pt.toLowerCase();
                if (DATA_TYPES.includes(type)) o = (byType[type] || []).find((x) => x.name === rest.join(':') || x.filePath === rest.join(':'));
            }
        }
        return o || null;
    }

    // ---- 通用：getStats（适用 code / db / deploy / service / planning） ----
    ToolRegistry.register({
        name: 'getStats', description: '当前页数据源总览：项目名 + 各类型对象数量 + 关键计数。适用 code/database/deploy/service/planning 五种页面。',
        parameters: { type: 'object', properties: {}, required: [] },
        execute() {
            const err = needsData(); if (err) return { success: false, error: err };
            const { byType, project, meta } = DataSource.ctx;
            const counts = {};
            for (const k of Object.keys(byType)) counts[k] = (byType[k] || []).length;
            return { success: true, data: { project: project.name, pageType: PAGE_TYPE, counts, meta }, summary: `${project.name}（${PAGE_TYPE}）｜${Object.values(counts).reduce((a, b) => a + b, 0)} 个对象` };
        },
    });

    // ---- 通用：queryObjects（按类型） ----
    ToolRegistry.register({
        name: 'queryObjects',
        description: '按类型查询本体对象。type 取值依页面：code 模式（project/domain/module/sourcefile/component/hook/store/service/interface/class/method/route/dependency）；database 模式（tables/foreignKeys/indexes/migrations/domains/views/triggers/procedures）；deploy 模式（services/routes/upstreams/dependencies/middleware/environments/files/layers）；service 模式（modules/layers/endpoints/tables/dependencies/techStack）；planning 模式（features/modules/releases/milestones/themes/dependencies）。',
        parameters: { type: 'object', properties: { type: { type: 'string', description: '对象类型（见描述）' }, keyword: { type: 'string', description: '可选过滤关键词' }, limit: { type: 'number', description: '返回条数上限，默认 20' } }, required: ['type'] },
        execute(args) {
            const err = needsData(); if (err) return { success: false, error: err };
            const type = String(args.type || '').toLowerCase();
            const arr = DataSource.ctx.byType[type] || [];
            const limit = Math.min(Number(args.limit) || 20, 100);
            const hit = arr.filter((o) => matchObj(o, args.keyword)).slice(0, limit);
            if (!hit.length) return { success: false, error: `未找到类型 ${type} 的对象` };
            const compact = hit.map((o) => ({ id: o.id || o.key || o.name, name: o.name || o.key, type, path: o.path || o.filePath, _t: o._t }));
            return { success: true, data: compact, summary: `${type} ${hit.length} 条（共 ${arr.length}）` };
        },
    });

    // ---- 通用：getNodeDetails ----
    ToolRegistry.register({
        name: 'getNodeDetails', description: '获取单个对象的完整详情（按 name/id 查询）',
        parameters: { type: 'object', properties: { query: { type: 'string', description: '对象 name / id' } }, required: ['query'] },
        execute(args) {
            const err = needsData(); if (err) return { success: false, error: err };
            const o = getNodeByQuery(String(args.query || '').trim());
            if (!o) return { success: false, error: `未找到 "${args.query}"` };
            const out = {};
            for (const k of Object.keys(o)) { if (!k.startsWith('_') && o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = o[k]; }
            return { success: true, data: out, summary: `${o.name || o.id || o.key}` };
        },
    });

    // ---- 通用：listLinks（关系字段） ----
    ToolRegistry.register({
        name: 'listLinks', description: '列出某对象的关系字段（imports/deps/usedBy/...）',
        parameters: { type: 'object', properties: { query: { type: 'string', description: '对象 name/id' } }, required: ['query'] },
        execute(args) {
            const err = needsData(); if (err) return { success: false, error: err };
            const o = getNodeByQuery(String(args.query || '').trim());
            if (!o) return { success: false, error: `未找到 "${args.query}"` };
            const links = {};
            for (const k of Object.keys(o)) {
                if (k.endsWith('Ids') || k.endsWith('Ids') || k === 'dependencies' || k === 'imports') links[k] = o[k];
            }
            return { success: true, data: links, summary: `${o.name}｜${Object.keys(links).length} 个关系字段` };
        },
    });

    // ============================================================
    //  数据库专属工具（精简版）
    // ============================================================
    function registerDbTools() {
        ToolRegistry.register({ name: 'getDbStats', description: '数据库蓝图总览：表/外键/索引/迁移/领域等数量 + 健康分（若有）', parameters: { type: 'object', properties: {}, required: [] }, execute() {
            const err = needsData(); if (err) return { success: false, error: err };
            const t = DataSource.ctx.byType;
            return { success: true, data: { tables: (t.tables || []).length, fks: (t.foreignKeys || []).length, indexes: (t.indexes || []).length, migrations: (t.migrations || []).length, domains: (t.domains || []).length }, summary: `${(t.tables || []).length} 表 / ${(t.foreignKeys || []).length} 外键 / ${(t.indexes || []).length} 索引` };
        } });
        ToolRegistry.register({ name: 'getDbHealth', description: '数据库健康度评估（来自 db-viewer-data 的 audit 字段，若有）', parameters: { type: 'object', properties: {}, required: [] }, execute() {
            const err = needsData(); if (err) return { success: false, error: err };
            const audit = DataSource.ctx.byType.audit?.[0] || DataSource.ctx.meta?.audit;
            if (!audit) return { success: false, error: '当前数据库快照无 audit 字段' };
            return { success: true, data: audit, summary: `健康分 ${audit.score ?? '?'}（${audit.level ?? '?'}）` };
        } });
    }

    // ============================================================
    //  部署专属工具
    // ============================================================
    function registerDeployTools() {
        ToolRegistry.register({ name: 'getDeployStats', description: '部署蓝图总览：服务/路由/上游/依赖/中间件/环境数', parameters: { type: 'object', properties: {}, required: [] }, execute() {
            const err = needsData(); if (err) return { success: false, error: err };
            const t = DataSource.ctx.byType;
            return { success: true, data: { services: (t.services || []).length, routes: (t.routes || []).length, upstreams: (t.upstreams || []).length, dependencies: (t.dependencies || []).length, middleware: (t.middleware || []).length, environments: (t.environments || []).length }, summary: `${(t.services || []).length} 服务 / ${(t.routes || []).length} 路由 / ${(t.middleware || []).length} 中间件` };
        } });
        ToolRegistry.register({ name: 'getDeployHealth', description: '部署健康度审计', parameters: { type: 'object', properties: {}, required: [] }, execute() {
            const err = needsData(); if (err) return { success: false, error: err };
            const audit = DataSource.ctx.meta?.audit || DataSource.ctx.byType.audit?.[0];
            if (!audit) return { success: false, error: '当前部署快照无 audit 字段' };
            return { success: true, data: audit, summary: `健康分 ${audit.score ?? '?'}` };
        } });
    }

    // ============================================================
    //  服务专属工具
    // ============================================================
    function registerServiceTools() {
        ToolRegistry.register({ name: 'getServiceStats', description: '后端服务蓝图总览：模块/分层/端点/表/技术栈数', parameters: { type: 'object', properties: {}, required: [] }, execute() {
            const err = needsData(); if (err) return { success: false, error: err };
            const t = DataSource.ctx.byType;
            return { success: true, data: { project: DataSource.ctx.project.name, modules: (t.modules || []).length, layers: (t.layers || []).length, endpoints: (t.endpoints || []).length, tables: (t.tables || []).length, techStack: (t.techStack || []).length }, summary: `${(t.modules || []).length} 模块 / ${(t.endpoints || []).length} 端点` };
        } });
        ToolRegistry.register({ name: 'getServiceHealth', description: '后端服务健康度', parameters: { type: 'object', properties: {}, required: [] }, execute() {
            const err = needsData(); if (err) return { success: false, error: err };
            const audit = DataSource.ctx.meta?.audit;
            if (!audit) return { success: false, error: '当前服务快照无 audit 字段' };
            return { success: true, data: audit, summary: `健康分 ${audit.score ?? '?'}` };
        } });
    }

    // ============================================================
    //  规划专属工具
    // ============================================================
    function registerPlanningTools() {
        ToolRegistry.register({ name: 'getPlanningStats', description: '产品规划总览：特性/模块/发布/里程碑/主题数 + 健康分', parameters: { type: 'object', properties: {}, required: [] }, execute() {
            const err = needsData(); if (err) return { success: false, error: err };
            const t = DataSource.ctx.byType;
            const audit = t.audit?.[0];
            return { success: true, data: { features: (t.features || []).length, modules: (t.modules || []).length, releases: (t.releases || []).length, milestones: (t.milestones || []).length, themes: (t.themes || []).length, healthScore: audit?.score, healthLevel: audit?.level }, summary: `${(t.features || []).length} 特性 / ${(t.modules || []).length} 模块 / 健康分 ${audit?.score ?? '?'}` };
        } });
        ToolRegistry.register({ name: 'queryPlanningFeatures', description: '查询产品特性清单（按 status/priority/version/keyword 过滤）', parameters: { type: 'object', properties: { status: { type: 'string', description: '状态（implementing/designing/done/blocked/...）' }, priority: { type: 'string', description: '优先级（P1/P2/P3）' }, keyword: { type: 'string', description: '关键词' }, limit: { type: 'number', description: '上限，默认 30' } }, required: [] }, execute(args) {
            const err = needsData(); if (err) return { success: false, error: err };
            let arr = DataSource.ctx.byType.features || [];
            if (args.status) arr = arr.filter((f) => String(f.status || '').toLowerCase() === String(args.status).toLowerCase());
            if (args.priority) arr = arr.filter((f) => String(f.priority || '').toUpperCase() === String(args.priority).toUpperCase());
            if (args.keyword) { const kw = String(args.keyword).toLowerCase(); arr = arr.filter((f) => String(f.title || '').toLowerCase().includes(kw) || String(f.id || '').toLowerCase().includes(kw)); }
            const limit = Math.min(Number(args.limit) || 30, 100);
            const out = arr.slice(0, limit).map((f) => ({ id: f.id, title: f.title, status: f.status, priority: f.priority, targetVersion: f.targetVersion, completion: f.completion }));
            if (!out.length) return { success: false, error: '未找到匹配特性' };
            return { success: true, data: out, summary: `${out.length} 个特性（共 ${arr.length} 匹配）` };
        } });
        ToolRegistry.register({ name: 'getPlanningHealthAudit', description: '规划健康审计（四维评分 + 问题清单）', parameters: { type: 'object', properties: {}, required: [] }, execute() {
            const err = needsData(); if (err) return { success: false, error: err };
            const audit = DataSource.ctx.byType.audit?.[0];
            if (!audit) return { success: false, error: '当前规划快照无 audit 字段' };
            return { success: true, data: audit, summary: `健康分 ${audit.score}（${audit.level}）` };
        } });
    }

    // ============================================================
    //  架构专属工具
    // ============================================================
    function registerArchTools() {
        ToolRegistry.register({ name: 'getArchStats', description: '架构蓝图总览：6 张统计卡 + 服务/分层/技术栈数', parameters: { type: 'object', properties: {}, required: [] }, execute() {
            const err = needsData(); if (err) return { success: false, error: err };
            const m = DataSource.ctx.meta || {};
            const t = DataSource.ctx.byType;
            return { success: true, data: { project: DataSource.ctx.project.name, stats: m.stats, serviceCount: (t.services || []).length, layerCount: (t.layers || []).length, techGroupCount: (t.techGroups || []).length }, summary: `${DataSource.ctx.project.name}｜服务 ${(t.services || []).length} / 分层 ${(t.layers || []).length} / 技术栈组 ${(t.techGroups || []).length}` };
        } });
        ToolRegistry.register({ name: 'queryArchServices', description: '查询架构蓝图中的服务（按 role/keyword 过滤）', parameters: { type: 'object', properties: { role: { type: 'string', description: '按 role 过滤' }, keyword: { type: 'string', description: '按 name 模糊匹配' }, limit: { type: 'number', description: '上限，默认 30' } }, required: [] }, execute(args) {
            const err = needsData(); if (err) return { success: false, error: err };
            let arr = DataSource.ctx.byType.services || [];
            if (args.role) arr = arr.filter((s) => String(s.role || '').toLowerCase() === String(args.role).toLowerCase());
            if (args.keyword) { const kw = String(args.keyword).toLowerCase(); arr = arr.filter((s) => String(s.name || '').toLowerCase().includes(kw)); }
            const limit = Math.min(Number(args.limit) || 30, 100);
            const out = arr.slice(0, limit);
            if (!out.length) return { success: false, error: '未找到匹配服务' };
            return { success: true, data: out, summary: `${out.length} 个服务` };
        } });
        ToolRegistry.register({ name: 'getArchServiceDetails', description: '获取架构蓝图中某个服务的详情', parameters: { type: 'object', properties: { name: { type: 'string', description: '服务名或模糊关键词' } }, required: ['name'] }, execute(args) {
            const err = needsData(); if (err) return { success: false, error: err };
            const kw = String(args.name || '').toLowerCase();
            const hit = (DataSource.ctx.byType.services || []).find((s) => String(s.name).toLowerCase() === kw) || (DataSource.ctx.byType.services || []).find((s) => String(s.name).toLowerCase().includes(kw));
            if (!hit) return { success: false, error: `未找到服务 "${args.name}"` };
            return { success: true, data: hit, summary: hit.name };
        } });
        ToolRegistry.register({ name: 'queryArchLayers', description: '查询架构分层（client / gateway / application / integration / tool）', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '分层名关键词' } }, required: [] }, execute(args) {
            const err = needsData(); if (err) return { success: false, error: err };
            let arr = DataSource.ctx.byType.layers || [];
            if (args.keyword) { const kw = String(args.keyword).toLowerCase(); arr = arr.filter((l) => String(l.title || '').toLowerCase().includes(kw)); }
            if (!arr.length) return { success: false, error: '未找到分层' };
            return { success: true, data: arr, summary: `${arr.length} 个分层` };
        } });
        ToolRegistry.register({ name: 'queryArchTechGroups', description: '查询技术栈分组', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '技术/组名关键词' } }, required: [] }, execute(args) {
            const err = needsData(); if (err) return { success: false, error: err };
            let arr = DataSource.ctx.byType.techGroups || [];
            if (args.keyword) { const kw = String(args.keyword).toLowerCase(); arr = arr.filter((g) => String(g.name || '').toLowerCase().includes(kw) || (g.items || []).some((it) => String(it.name || '').toLowerCase().includes(kw))); }
            if (!arr.length) return { success: false, error: '未找到技术栈' };
            return { success: true, data: arr, summary: `${arr.length} 个技术栈组` };
        } });
        ToolRegistry.register({ name: 'queryArchTables', description: '查询架构蓝图中的表格（Java 后端 / 文档配置 / API 控制器等）', parameters: { type: 'object', properties: { heading: { type: 'string', description: '表格所属 h2 标题关键词' } }, required: [] }, execute(args) {
            const err = needsData(); if (err) return { success: false, error: err };
            let arr = DataSource.ctx.byType.tables || [];
            if (args.heading) { const kw = String(args.heading).toLowerCase(); arr = arr.filter((t) => String(t.heading || '').toLowerCase().includes(kw)); }
            if (!arr.length) return { success: false, error: '未找到表格' };
            return { success: true, data: arr, summary: `${arr.length} 张表格` };
        } });
        ToolRegistry.register({ name: 'getArchTabContent', description: '获取架构蓝图指定 tab 的文本（overall/services/tech/layers/integration/deployment/deploy-arch）', parameters: { type: 'object', properties: { tab: { type: 'string', description: 'tab 的 data-tab 值' } }, required: ['tab'] }, execute(args) {
            const err = needsData(); if (err) return { success: false, error: err };
            const tab = String(args.tab);
            const panel = $d(`.panel[data-tab="${tab}"]`);
            if (!panel) return { success: false, error: `tab "${tab}" 不存在` };
            return { success: true, data: { tab, text: panel.textContent.trim().slice(0, 30000) }, summary: `tab=${tab}｜文本 ${panel.textContent.length} 字符` };
        } });
    }

    // ============================================================
    //  总览专属工具
    // ============================================================
    function registerSummaryTools() {
        ToolRegistry.register({ name: 'getSummaryStats', description: '代码本体总览的统计卡（代码总行数 / 源文件 / 主语言 / Java 后端）', parameters: { type: 'object', properties: {}, required: [] }, execute() {
            const err = needsData(); if (err) return { success: false, error: err };
            const m = DataSource.ctx.meta || {};
            const t = DataSource.ctx.byType;
            return { success: true, data: { project: DataSource.ctx.project.name, stats: m.stats, projectCount: (t.projects || []).length }, summary: `${DataSource.ctx.project.name}｜${(t.projects || []).length} 个子项目` };
        } });
        ToolRegistry.register({ name: 'querySummaryProjects', description: '查询总览中的子项目（按 keyword/framework 过滤）', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '项目名关键词' }, framework: { type: 'string', description: '框架关键词' }, limit: { type: 'number', description: '上限，默认 30' } }, required: [] }, execute(args) {
            const err = needsData(); if (err) return { success: false, error: err };
            let arr = DataSource.ctx.byType.projects || [];
            if (args.keyword) { const kw = String(args.keyword).toLowerCase(); arr = arr.filter((p) => String(p.name).toLowerCase().includes(kw)); }
            if (args.framework) { const fw = String(args.framework).toLowerCase(); arr = arr.filter((p) => (p.cells || []).some((c) => String(c).toLowerCase().includes(fw))); }
            const limit = Math.min(Number(args.limit) || 30, 100);
            const out = arr.slice(0, limit);
            if (!out.length) return { success: false, error: '未找到项目' };
            return { success: true, data: out, summary: `${out.length} 个项目` };
        } });
        ToolRegistry.register({ name: 'getSummaryProjectDetail', description: '获取总览中某个子项目的详情（含 blueprint.html 链接）', parameters: { type: 'object', properties: { name: { type: 'string', description: '子项目名' } }, required: ['name'] }, execute(args) {
            const err = needsData(); if (err) return { success: false, error: err };
            const kw = String(args.name || '').toLowerCase();
            const hit = (DataSource.ctx.byType.projects || []).find((p) => String(p.name).toLowerCase() === kw) || (DataSource.ctx.byType.projects || []).find((p) => String(p.name).toLowerCase().includes(kw));
            if (!hit) return { success: false, error: `未找到项目 "${args.name}"` };
            return { success: true, data: hit, summary: hit.name };
        } });
    }

    // ============================================================
    //  跨蓝图数据共享工具
    // ============================================================
    const SHAREABLE_PAGES = ['code', 'database', 'deploy', 'service', 'planning', 'architecture', 'summary'];
    function registerSharedTools() {
        ToolRegistry.register({ name: 'listSharedPages', description: '列出本项目下所有已缓存的蓝图页（同 projectId）', parameters: { type: 'object', properties: {}, required: [] }, execute() {
            const found = [];
            for (const pt of SHAREABLE_PAGES) {
                const d = DataSource.readSharedCache(pt);
                if (d) {
                    found.push({ pageType: pt, project: d.project?.name, cachedAt: d.meta?.parsedAt ? new Date(d.meta.parsedAt).toISOString() : null });
                }
            }
            return { success: true, data: found, summary: found.length ? `已缓存 ${found.length} 个页面` : '本项目下尚无其他页面的共享缓存' };
        } });
        ToolRegistry.register({ name: 'getSharedData', description: '查询本项目下其他蓝图页的解析结果。pageType: code/database/deploy/service/planning/architecture/summary。query 可选关键词。', parameters: { type: 'object', properties: { pageType: { type: 'string', description: '页面类型' }, query: { type: 'string', description: '关键词（按 name 模糊匹配）' }, limit: { type: 'number', description: '上限，默认 20' } }, required: ['pageType'] }, execute(args) {
            const pt = String(args.pageType || '');
            if (!SHAREABLE_PAGES.includes(pt)) return { success: false, error: `pageType 必须是 ${SHAREABLE_PAGES.join('/')} 之一` };
            const d = DataSource.readSharedCache(pt);
            if (!d) return { success: false, error: `本项目下未缓存 ${pt} 页（用户需先打开对应页面）` };
            const kw = String(args.query || '').toLowerCase();
            const limit = Math.min(Number(args.limit) || 20, 100);
            const arr = [];
            const t = d.byType || {};
            if (kw) {
                if (t.sourcefile) for (const o of t.sourcefile) if (String(o.name || o.path || '').toLowerCase().includes(kw)) arr.push({ _t: 'sourcefile', name: o.name, path: o.path || o.filePath });
                if (t.component) for (const o of t.component) if (String(o.name || '').toLowerCase().includes(kw)) arr.push({ _t: 'component', name: o.name });
                if (t.service) for (const o of t.service) if (String(o.name || '').toLowerCase().includes(kw)) arr.push({ _t: 'service', name: o.name });
                if (t.hook) for (const o of t.hook) if (String(o.name || '').toLowerCase().includes(kw)) arr.push({ _t: 'hook', name: o.name });
                if (t.tables) for (const o of t.tables) if (String(o.name || '').toLowerCase().includes(kw)) arr.push({ _t: 'table', name: o.name });
                if (t.services) for (const o of t.services) if (String(o.name || '').toLowerCase().includes(kw)) arr.push({ _t: 'deploy-service', name: o.name, port: o.port, image: o.image });
                if (t.modules) for (const o of t.modules) if (String(o.name || o.key || '').toLowerCase().includes(kw)) arr.push({ _t: 'module', name: o.name || o.key });
                if (t.endpoints) for (const o of t.endpoints) if (String(o.path || o.name || '').toLowerCase().includes(kw)) arr.push({ _t: 'endpoint', name: o.name, path: o.path });
                if (t.features) for (const o of t.features) if (String(o.id || o.title || '').toLowerCase().includes(kw)) arr.push({ _t: 'feature', id: o.id, title: o.title, status: o.status });
                if (t.services && PAGE_TYPE === 'architecture' && pt === 'architecture') {} // 已在 t.services 中
                if (t.projects) for (const o of t.projects) if (String(o.name || '').toLowerCase().includes(kw)) arr.push({ _t: 'subproject', name: o.name, href: o.href });
            } else {
                if (t.sourcefile) for (const o of t.sourcefile) arr.push({ _t: 'sourcefile', name: o.name });
                if (t.tables) for (const o of t.tables) arr.push({ _t: 'table', name: o.name });
                if (t.services) for (const o of t.services) arr.push({ _t: 'deploy-service', name: o.name });
                if (t.modules) for (const o of t.modules) arr.push({ _t: 'module', name: o.name || o.key });
                if (t.features) for (const o of t.features) arr.push({ _t: 'feature', id: o.id, title: o.title });
                if (t.projects) for (const o of t.projects) arr.push({ _t: 'subproject', name: o.name });
            }
            const out = arr.slice(0, limit);
            return { success: true, data: out, summary: `${pt}：${arr.length} 条${kw ? `（已按 "${args.query}" 过滤）` : ''}` };
        } });
    }

    // ============================================================
    //  会话管理（项目级分桶）
    // ============================================================
    const ChatManager = {
        all() { return parseStored(Store.get(CONFIG.SK.CHATS, null), {}); },
        list() { const chats = this.all(); return Object.values(chats).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); },
        get(id) { return this.all()[id] || null; },
        active() { const id = Store.get(CONFIG.SK.ACTIVE); return id ? this.get(id) : null; },
        setActive(id) { Store.set(CONFIG.SK.ACTIVE, id); },
        save(conv) { const chats = this.all(); chats[conv.id] = conv; Store.set(CONFIG.SK.CHATS, JSON.stringify(chats)); },
        remove(id) { const chats = this.all(); delete chats[id]; Store.set(CONFIG.SK.CHATS, JSON.stringify(chats)); if (Store.get(CONFIG.SK.ACTIVE) === id) Store.del(CONFIG.SK.ACTIVE); },
        newConv(title = '新会话') { const c = { id: uid(), title, createdAt: Date.now(), updatedAt: Date.now(), messages: [], projectId: PROJECT_ID, pageType: PAGE_TYPE }; this.save(c); this.setActive(c.id); return c; },
        ensureActive() { let c = this.active(); if (!c) c = this.newConv(); return c; },
        isRunning(c) { return c?.meta?.running; },
        markRunning(c, running, meta = {}) { c.meta = c.meta || {}; c.meta.running = running; if (!running) { c.meta.lastError = meta.lastError || undefined; c.updatedAt = Date.now(); } this.save(c); },
    };

    // ============================================================
    //  Agent 定义
    // ============================================================
    const AGENT_DEFS = {
        code: { key: 'code', label: '代码本体', icon: 'sitemap', description: '模块/组件/Hook/Store/Service 等本体问答', systemPrompt: '你是「项目级代码本体 AI 助手」。可以调用 getStats / queryObjects / getNodeDetails / listLinks 查询项目结构。你也能跨蓝图查询其他页面的解析结果（getSharedData / listSharedPages）。当前项目: __PID__ ｜ 数据源: __SRC__' },
        database: { key: 'database', label: '数据库蓝图', icon: 'database', description: '表/外键/索引/迁移/领域/审计', systemPrompt: '你是「项目级数据库蓝图 AI 助手」。可以调用 queryObjects(type=tables/foreignKeys/indexes/migrations/domains/views/...) / getDbStats / getDbHealth 等。你也能跨蓝图查询。当前项目: __PID__ ｜ 数据源: __SRC__' },
        deploy: { key: 'deploy', label: '部署蓝图', icon: 'server', description: '服务/路由/依赖/中间件/审计', systemPrompt: '你是「项目级部署蓝图 AI 助手」。可以调用 queryObjects(type=services/routes/upstreams/dependencies/middleware/environments/files/layers) / getDeployStats / getDeployHealth。你也能跨蓝图查询。当前项目: __PID__ ｜ 数据源: __SRC__' },
        service: { key: 'service', label: '后端服务', icon: 'server', description: '模块/分层/端点/技术栈/健康', systemPrompt: '你是「项目级后端服务蓝图 AI 助手」。可以调用 queryObjects(type=modules/layers/endpoints/tables/dependencies/techStack) / getServiceStats / getServiceHealth。你也能跨蓝图查询。当前项目: __PID__ ｜ 数据源: __SRC__' },
        planning: { key: 'planning', label: '产品规划', icon: 'chart', description: '特性/模块/发布/里程碑/审计', systemPrompt: '你是「项目级产品规划 AI 助手」。可以调用 queryPlanningFeatures / getPlanningStats / getPlanningHealthAudit / queryObjects(type=features/modules/releases/milestones/themes/dependencies)。你也能跨蓝图查询。当前项目: __PID__ ｜ 数据源: __SRC__' },
        architecture: { key: 'architecture', label: '架构蓝图', icon: 'sitemap', description: '全景架构 / 服务 / 分层 / 技术栈 / 集成 / 部署', systemPrompt: '你是「项目级架构蓝图 AI 助手」。可以调用 getArchStats / queryArchServices / getArchServiceDetails / queryArchLayers / queryArchTechGroups / queryArchTables / getArchTabContent。你也能跨蓝图查询其他页面（getSharedData）。当前项目: __PID__ ｜ 数据源: __SRC__' },
        summary: { key: 'summary', label: '代码总览', icon: 'chart', description: '项目代码本体 / 子项目行数分布', systemPrompt: '你是「项目级代码本体总览 AI 助手」。可以调用 getSummaryStats / querySummaryProjects / getSummaryProjectDetail。你也能跨蓝图查询其他页面（getSharedData）。当前项目: __PID__ ｜ 数据源: __SRC__' },
    };
    function getCurrentAgent() { return AGENT_DEFS[PAGE_TYPE]; }
    function buildSystemPrompt() {
        const a = AGENT_DEFS[PAGE_TYPE];
        return a.systemPrompt.replace('__PID__', PROJECT_ID).replace('__SRC__', DataSource.ctx?.sourceLabel || '未加载');
    }

    // ============================================================
    //  Agent 引擎（ReAct + 多模型 + 流式）
    // ============================================================
    let abortFlag = false;

    async function callAiApi({ url, apiKey, body, onChunk, timeoutMs }) {
        if (url.startsWith('http') && typeof fetch === 'function') {
            try {
                const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify({ ...body, stream: true }) });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const reader = r.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    const lines = buf.split('\n');
                    buf = lines.pop() || '';
                    for (const line of lines) {
                        if (!line.startsWith('data:')) continue;
                        const payload = line.slice(5).trim();
                        if (payload === '[DONE]') return;
                        try {
                            const json = JSON.parse(payload);
                            const delta = json.choices?.[0]?.delta?.content || '';
                            if (delta && onChunk) onChunk(delta);
                        } catch { /* ignore */ }
                    }
                }
                return;
            } catch (e) {
                if (typeof GM_xmlhttpRequest !== 'function') throw e;
                return new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({ method: 'POST', url, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, data: JSON.stringify({ ...body, stream: false }), timeout: timeoutMs || CONFIG.AI_TIMEOUT, onload: (r) => { try { const json = JSON.parse(r.responseText); const content = json.choices?.[0]?.message?.content || ''; if (content && onChunk) onChunk(content); resolve(); } catch (err) { reject(err); } }, onerror: (e) => reject(new Error(e.error || '请求失败')), ontimeout: () => reject(new Error('请求超时')) });
                });
            }
        }
        throw new Error('无 fetch 且无 GM_xmlhttpRequest');
    }

    async function runAgentLoop(userMessage, history, onChunk, onToolCall) {
        const s = getSettings();
        if (!(s.apiKey || '').trim()) throw new Error('请先在设置中配置 API Key');
        const maxIter = Number(s.maxIterations) || CONFIG.MAX_ITERATIONS;
        const messages = [{ role: 'system', content: buildSystemPrompt() }, ...history, { role: 'user', content: userMessage }];
        const toolCallLog = [];
        let finalResponse = '';
        for (let iter = 0; iter < maxIter; iter++) {
            if (abortFlag) return { response: '（已停止）', completed: true, iterations: iter, toolCalls: toolCallLog };
            const body = { model: s.model, messages, temperature: 0.4, stream: true };
            let aiText = '';
            await callAiApi({ url: s.apiUrl, apiKey: s.apiKey, body, onChunk: (d) => { aiText += d; if (onChunk) onChunk(d); } });
            const toolMatches = [...aiText.matchAll(/<tool_calls>\s*(\{[\s\S]*?\})\s*<\/tool_calls>/g)];
            if (toolMatches.length === 0) { finalResponse = aiText; break; }
            let lastCall = null;
            for (const m of toolMatches) { try { lastCall = JSON.parse(m[1]); } catch { /* ignore */ } }
            if (!lastCall || !lastCall.name) { finalResponse = aiText; break; }
            const toolName = String(lastCall.name);
            const toolArgs = lastCall.arguments || {};
            onToolCall?.(toolName, toolArgs, 'start', null);
            const result = await ToolRegistry.execute(toolName, toolArgs, { projectId: PROJECT_ID, pageType: PAGE_TYPE });
            onToolCall?.(toolName, toolArgs, result.success ? 'done' : 'error', result);
            toolCallLog.push({ name: toolName, args: toolArgs, ok: result.success });
            messages.push({ role: 'assistant', content: aiText });
            messages.push({ role: 'user', content: `<tool_result name="${toolName}">\n${JSON.stringify(result, null, 2)}\n</tool_result>` });
        }
        return { response: finalResponse || '（已达到最大迭代次数）', completed: !!finalResponse, iterations: maxIter, toolCalls: toolCallLog };
    }

    // ============================================================
    //  UI
    // ============================================================
    let panel = null;
    let panelOpen = false;
    const ui = { renderConvList: null, renderMessages: null, activeConv: null };

    function ensureStyles() {
        const css = `
.pba-toast{position:fixed;right:20px;bottom:80px;z-index:2147483647;background:#334155;color:#fff;padding:10px 16px;border-radius:10px;font:13px/1.4 system-ui;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;transform:translateY(8px);transition:.25s;pointer-events:none;max-width:340px}
.pba-toast-show{opacity:1;transform:none}
.pba-toast-error{background:#b91c1c}
.pba-toast-success{background:#15803d}
.pba-fab{position:fixed;right:26px;bottom:26px;z-index:2147483600;width:52px;height:52px;border-radius:16px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#7c5cff,#ec4899);color:#fff;box-shadow:0 8px 24px rgba(124,92,255,.45);transition:.25s}
.pba-fab:hover{transform:translateY(-2px) scale(1.05)}
.pba-fab-pulse::after{content:'';position:absolute;inset:0;border-radius:16px;border:2px solid rgba(124,92,255,.6);animation:pbaPulse 2s infinite}
@keyframes pbaPulse{0%{transform:scale(1);opacity:.8}70%{transform:scale(1.6);opacity:0}100%{opacity:0}}
.pba-panel{position:fixed;right:18px;bottom:18px;top:18px;width:580px;max-width:94vw;z-index:2147483610;background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:18px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(2,6,23,.55);color:#e2e8f0;font:14px/1.5 system-ui;transition:transform .28s,opacity .28s;transform:translateX(120%);opacity:0;pointer-events:none}
.pba-panel-open{transform:none;opacity:1;pointer-events:auto}
.pba-head{position:relative;display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(148,163,184,.14);background:#111c33}
.pba-head-title{font-weight:600;font-size:14px;color:#f1f5f9;display:flex;align-items:center;gap:7px;flex:1;min-width:0}
.pba-head-title b{color:#c4b5fd}
.pba-proj-badge{font-size:10px;padding:2px 7px;background:rgba(124,92,255,.18);color:#c4b5fd;border:1px solid rgba(124,92,255,.35);border-radius:10px;letter-spacing:.04em;font-family:ui-monospace,monospace;flex-shrink:0}
.pba-sess-title{font-size:12px;color:#94a3b8;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
.pba-icon-btn{background:transparent;border:none;color:#94a3b8;cursor:pointer;width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;padding:0}
.pba-icon-btn:hover{background:rgba(148,163,184,.12);color:#e2e8f0}
.pba-model-chip{display:flex;align-items:center;gap:6px;font-size:12px;color:#c4b5fd;padding:4px 9px;border:1px solid rgba(196,181,253,.3);border-radius:20px;cursor:pointer;max-width:170px}
.pba-body{flex:1;overflow:hidden;display:flex}
.pba-side{width:140px;border-right:1px solid rgba(148,163,184,.14);background:#0b1425;display:flex;flex-direction:column}
.pba-side-item{padding:8px 10px;font-size:12px;color:#94a3b8;cursor:pointer;display:flex;gap:7px;align-items:center;border-left:2px solid transparent;user-select:none}
.pba-side-item:hover{background:rgba(148,163,184,.07)}
.pba-side-item.active{background:#1e293b;color:#e2e8f0;border-left-color:#7c5cff}
.pba-side-item .pba-t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pba-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:none;border-radius:8px;cursor:pointer;font:13px/1 system-ui;padding:7px 12px;transition:.15s}
.pba-btn-primary{background:#7c5cff;color:#fff}
.pba-btn-primary:hover{background:#6d4ce0}
.pba-btn-secondary{background:rgba(148,163,184,.14);color:#e2e8f0}
.pba-btn-secondary:hover{background:rgba(148,163,184,.24)}
.pba-chat{flex:1;display:flex;flex-direction:column;min-width:0}
.pba-msgs{flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:12px}
.pba-msg{max-width:100%;display:flex;flex-direction:column}
.pba-msg-user{margin-left:auto;background:#7c5cff;color:#fff;border-top-right-radius:3px;max-width:86%;padding:9px 11px;font-size:13px;line-height:1.6;word-break:break-word}
.pba-msg-ai{background:#1e293b;border-top-left-radius:3px;max-width:100%;padding:9px 11px;font-size:13px;line-height:1.6;word-break:break-word}
.pba-msg-ai .md-body{margin:0}
.pba-msg-ai .md-body p{margin:.35em 0}
.pba-msg-ai .md-body pre{background:#0f172a;border:1px solid rgba(148,163,184,.15);border-radius:8px;padding:8px 10px;overflow-x:auto;font-size:12px}
.pba-msg-ai .md-body code{font-family:ui-monospace,Consolas,monospace}
.pba-msg-ai .md-body table{border-collapse:collapse;font-size:12px;margin:.5em 0}
.pba-msg-ai .md-body th,.md-body td{border:1px solid rgba(148,163,184,.25);padding:4px 8px}
.pba-msg-ai .md-body th{background:#111c33}
.pba-msg-ai .md-body ul,.pba-msg-ai .md-body ol{padding-left:18px;margin:.35em 0}
.pba-msg-ai .md-body h1,.md-body h2,.md-body h3{margin:.5em 0 .3em;font-size:1.05em}
.pba-typing{display:inline-flex;gap:4px;padding:6px 2px}
.pba-typing i{width:6px;height:6px;border-radius:50%;background:#c4b5fd;animation:pbaBlink 1s infinite}
.pba-typing i:nth-child(2){animation-delay:.15s}
.pba-typing i:nth-child(3){animation-delay:.3s}
@keyframes pbaBlink{0%,80%,100%{opacity:.25}40%{opacity:1}}
.pba-tool-calls{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.pba-tool-chip{display:flex;flex-direction:column;border:1px solid rgba(124,92,255,.35);background:rgba(124,92,255,.1);border-radius:8px;padding:5px 8px;font-size:12px;cursor:pointer;transition:background .2s,border-color .2s}
.pba-tool-chip:hover{background:rgba(124,92,255,.18);border-color:rgba(124,92,255,.5)}
.pba-tool-chip .pba-tc-row{display:flex;align-items:center;gap:6px;width:100%;min-width:0}
.pba-tool-chip .pba-tc-icon{width:18px;height:18px;border-radius:5px;background:rgba(124,92,255,.25);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#c4b5fd}
.pba-tool-chip .pba-tc-icon svg{width:11px;height:11px}
.pba-tool-chip .pba-tc-body{flex:1;min-width:0;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden}
.pba-tool-chip .pba-tc-name{color:#ddd6fe;font-weight:600;font-size:12px;flex-shrink:0}
.pba-tool-chip .pba-tc-args{color:#94a3b8;font-size:11px;overflow:hidden;text-overflow:ellipsis}
.pba-tool-chip .pba-tc-state{font-size:11px;color:#94a3b8;flex-shrink:0}
.pba-tool-chip .pba-tc-detail{display:none;margin-top:4px;padding-top:4px;border-top:1px dashed rgba(124,92,255,.25);font-family:ui-monospace,monospace;font-size:11px;color:#cbd5e1;white-space:pre-wrap;word-break:break-all}
.pba-tool-chip.pba-expanded .pba-tc-detail{display:block}
.pba-tool-chip .pba-tool-err{margin-top:4px;color:#fca5a5}
.pba-tool-chip.pba-state-error{border-color:rgba(220,38,38,.45);background:rgba(220,38,38,.08)}
.pba-input-wrap{padding:10px 12px;border-top:1px solid rgba(148,163,184,.14);background:#0b1425;display:flex;gap:8px;align-items:flex-end}
.pba-input{flex:1;background:#0f172a;border:1px solid rgba(148,163,184,.2);border-radius:10px;color:#e2e8f0;font:13px/1.5 system-ui;padding:9px 11px;resize:none;max-height:120px;min-height:38px;outline:none}
.pba-input:focus{border-color:rgba(196,181,253,.5)}
.pba-send{background:linear-gradient(135deg,#7c5cff,#ec4899);color:#fff;border:none;border-radius:10px;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.pba-send:hover{filter:brightness(1.1)}
.pba-send.stop{background:linear-gradient(135deg,#ef4444,#f59e0b)}
.pba-suggest{display:flex;flex-wrap:wrap;gap:6px;padding:6px 12px 10px;background:#0b1425;border-top:1px solid rgba(148,163,184,.08)}
.pba-suggest button{font-size:11px;padding:4px 9px;border-radius:14px;border:1px solid rgba(196,181,253,.25);background:rgba(124,92,255,.08);color:#c4b5fd;cursor:pointer}
.pba-suggest button:hover{background:rgba(124,92,255,.18);border-color:rgba(196,181,253,.45)}
.pba-menu{position:absolute;top:46px;right:14px;z-index:7;background:#1e293b;border:1px solid rgba(148,163,184,.2);border-radius:10px;padding:6px;min-width:200px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.pba-menu .pm-item{font-size:13px;padding:8px 10px;border-radius:8px;cursor:pointer;color:#e2e8f0;display:flex;gap:8px;align-items:center}
.pba-menu .pm-item:hover{background:rgba(148,163,184,.12)}
.pba-menu .pm-item.is-danger{color:#fca5a5}
.pba-pane{position:absolute;inset:0;background:#0f172a;z-index:8;padding:18px;display:none;overflow-y:auto}
.pba-pane h3{margin:0 0 14px;font-size:15px;color:#c4b5fd}
.pba-pane label{display:block;font-size:12px;color:#94a3b8;margin:10px 0 4px}
.pba-pane input,.pba-pane select{width:100%;box-sizing:border-box;background:#0b1425;border:1px solid rgba(148,163,184,.2);border-radius:8px;color:#e2e8f0;padding:8px 10px;font:13px system-ui;outline:none}
.pba-pane input:focus,.pba-pane select:focus{border-color:rgba(196,181,253,.5)}
.pba-pane .pba-row{display:flex;gap:8px;margin-top:14px}
.pba-pane .pba-row .pba-btn{flex:1}
`;
        if (typeof GM_addStyle === 'function') GM_addStyle(css);
        else { const s = el('style'); s.textContent = css; document.head.appendChild(s); }
    }

    function mdToHtml(s) {
        if (!s) return '';
        const e = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const lines = String(s).split('\n');
        let html = '';
        let inCode = false, inList = false, inTable = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('```')) { if (inCode) { html += '</code></pre>'; inCode = false; } else { html += '<pre><code>'; inCode = true; } continue; }
            if (inCode) { html += e(line) + '\n'; continue; }
            if (/^\|.*\|$/.test(line)) {
                if (!inTable) { html += '<table>'; inTable = true; }
                const cells = line.split('|').slice(1, -1).map((c) => c.trim());
                const isHeader = i + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[i + 1]);
                if (isHeader) { html += '<thead><tr>' + cells.map((c) => `<th>${e(c)}</th>`).join('') + '</tr></thead><tbody>'; i++; }
                else { html += '<tr>' + cells.map((c) => `<td>${e(c)}</td>`).join('') + '</tr>'; }
                continue;
            }
            if (inTable && !/^\|.*\|$/.test(line)) { html += '</tbody></table>'; inTable = false; }
            if (/^[-*]\s/.test(line)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${e(line.replace(/^[-*]\s/, ''))}</li>`; continue; }
            if (inList && !/^[-*]\s/.test(line)) { html += '</ul>'; inList = false; }
            if (/^###\s/.test(line)) { html += `<h3>${e(line.replace(/^###\s/, ''))}</h3>`; continue; }
            if (/^##\s/.test(line)) { html += `<h2>${e(line.replace(/^##\s/, ''))}</h2>`; continue; }
            if (line.trim() === '') continue;
            html += `<p>${e(line).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</p>`;
        }
        if (inCode) html += '</code></pre>';
        if (inList) html += '</ul>';
        if (inTable) html += '</tbody></table>';
        return html;
    }

    function appendMessage(conv, msg) { if (!conv.messages) conv.messages = []; conv.messages.push(msg); ChatManager.save(conv); }

    function renderMessages() {
        const box = $d('#pba-msgs'); if (!box) return;
        box.innerHTML = '';
        const conv = ui.activeConv; if (!conv) return;
        for (const m of conv.messages) {
            if (m.type === 'user') { const n = el('div', 'pba-msg pba-msg-user'); n.textContent = m.content; box.appendChild(n); }
            else if (m.type === 'ai') { const n = el('div', 'pba-msg pba-msg-ai'); n.innerHTML = `<div class="md-body">${m.loading ? '<span class="pba-typing"><i></i><i></i><i></i></span>' : mdToHtml(m.content || (m.error ? `（错误：${esc(m.error)}）` : ''))}</div>`; box.appendChild(n); }
            else if (m.type === 'tool') {
                const n = el('div', 'pba-msg');
                const display = getToolDisplay(m.tool?.name);
                const isErr = m.state === 'error';
                const stateLabel = m.state === 'running' ? '执行中…' : m.state === 'done' ? '✓' : '✗';
                const argsSummary = formatToolArgs(m.tool?.args);
                const argsJson = JSON.stringify(m.tool?.args || {}, null, 2);
                const errMsg = isErr && m.tool?.error ? `<div class="pba-tool-err">${esc(m.tool.error)}</div>` : '';
                n.innerHTML = `<div class="pba-tool-calls"><div class="pba-tool-chip ${isErr ? 'pba-state-error' : ''}">
                    <div class="pba-tc-row">
                        <div class="pba-tc-icon">${getIcon(display.icon, 12)}</div>
                        <div class="pba-tc-body">
                            <div class="pba-tc-name">${esc(display.label)}</div>
                            ${argsSummary ? `<div class="pba-tc-args">${esc(argsSummary)}</div>` : ''}
                        </div>
                        <div class="pba-tc-state">${stateLabel}</div>
                    </div>
                    <div class="pba-tc-detail">${esc(argsJson)}${errMsg}</div>
                </div></div>`;
                const chip = n.querySelector('.pba-tool-chip');
                chip.addEventListener('click', () => chip.classList.toggle('pba-expanded'));
                box.appendChild(n);
            }
        }
        box.scrollTop = box.scrollHeight;
    }

    function renderConvList() {
        const box = $d('#pba-sess-list'); if (!box) return;
        box.innerHTML = '';
        const list = ChatManager.list();
        const activeId = ui.activeConv?.id;
        if (!list.length) { box.innerHTML = '<div style="padding:10px;font-size:11px;color:#64748b">暂无历史会话<br><span style="font-size:10px;opacity:.7">项目 ' + esc(PROJECT_ID) + '</span></div>'; return; }
        for (const c of list) {
            const item = el('div', 'pba-side-item' + (c.id === activeId ? ' active' : ''));
            const title = (c.title || '会话').slice(0, 12);
            const ptIcon = c.pageType === 'architecture' ? '🏗️' : c.pageType === 'summary' ? '📊' : c.pageType === 'code' ? '📦' : c.pageType === 'database' ? '🗄️' : c.pageType === 'deploy' ? '🚀' : c.pageType === 'service' ? '⚙️' : c.pageType === 'planning' ? '📋' : '💬';
            item.innerHTML = `<span style="font-size:11px">${ptIcon}</span><span class="pba-t">${esc(title)}</span>`;
            item.title = `${c.title}（${c.pageType || '?'}）`;
            item.addEventListener('click', () => openConv(c.id));
            box.appendChild(item);
        }
    }

    function openPanel() { if (!panelOpen) { panel.classList.add('pba-panel-open'); panelOpen = true; $d('.pba-fab').style.display = 'none'; } const c = ChatManager.ensureActive(); openConv(c.id); }
    function closePanel() { panel.classList.remove('pba-panel-open'); panelOpen = false; const fab = $d('.pba-fab'); if (fab) fab.style.display = 'flex'; }
    function openConv(id) { const conv = ChatManager.get(id); if (!conv) return; ui.activeConv = conv; ChatManager.setActive(id); const st = $d('#pba-sess-title'); if (st) st.textContent = conv.title; renderConvList(); renderMessages(); }
    function newConversation() { const c = ChatManager.newConv(); c.title = '新会话'; ChatManager.save(c); openConv(c.id); $d('#pba-inp')?.focus(); }

    function buildPanel() {
        panel = el('div', 'pba-panel');
        const agent = getCurrentAgent();
        const titleMap = { code: '代码蓝图 <b>AI 分析</b>', database: '数据蓝图 <b>AI 分析</b>', deploy: '部署蓝图 <b>AI 分析</b>', service: '服务蓝图 <b>AI 分析</b>', planning: '规划蓝图 <b>AI 分析</b>', architecture: '架构蓝图 <b>AI 分析</b>', summary: '代码总览 <b>AI 分析</b>' };
        const titleText = titleMap[PAGE_TYPE] || 'AOS 蓝图 <b>AI 分析</b>';
        panel.innerHTML = `
            <div class="pba-head">
                <div class="pba-head-title">${getIcon(agent.icon, 18)} ${titleText}</div>
                <span class="pba-proj-badge" title="项目 ID（从 URL 推断）">${esc(PROJECT_ID)}</span>
                <span id="pba-sess-title" class="pba-sess-title">新会话</span>
                <button id="pba-menu-btn" class="pba-icon-btn" title="更多">${getIcon('gear', 16)}</button>
                <button id="pba-close-btn" class="pba-icon-btn" title="关闭">${getIcon('close', 16)}</button>
            </div>
            <div class="pba-body">
                <div class="pba-side">
                    <button class="pba-btn pba-btn-primary" id="pba-new-btn" style="margin:8px">${getIcon('plus', 13)} 新会话</button>
                    <div id="pba-sess-list" style="flex:1;overflow-y:auto"></div>
                </div>
                <div class="pba-chat">
                    <div id="pba-msgs" class="pba-msgs"></div>
                    <div id="pba-suggest" class="pba-suggest"></div>
                    <div class="pba-input-wrap">
                        <textarea id="pba-inp" class="pba-input" placeholder="例如：列出所有服务 / Java 后端有几个 / 跨蓝图查询 code 的 components"></textarea>
                        <button id="pba-send-btn" class="pba-send" title="发送">${getIcon('send', 17)}</button>
                    </div>
                </div>
            </div>
            <div id="pba-menu" class="pba-menu" style="display:none">
                <div class="pm-item" data-act="settings">${getIcon('gear', 14)} 设置（模型 / API Key）</div>
                <div class="pm-item" data-act="refresh">${getIcon('history', 14)} 刷新数据源</div>
                <div class="pm-item" data-act="export-json">${getIcon('download', 14)} 导出当前会话 JSON</div>
                <div class="pm-item" data-act="export-md">${getIcon('download', 14)} 导出当前会话 Markdown</div>
                <div class="pm-item is-danger" data-act="clear">${getIcon('trash', 14)} 清空本项目所有会话</div>
            </div>
            <div id="pba-settings" class="pba-pane">
                <h3>设置（项目：${esc(PROJECT_ID)}）</h3>
                <label>模型供应商</label>
                <select id="pba-st-provider">${Object.entries(MODEL_PROVIDERS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('')}</select>
                <label>API URL</label>
                <input id="pba-st-url" type="text" placeholder="https://api.deepseek.com/v1/chat/completions">
                <label>模型 ID</label>
                <input id="pba-st-model" type="text" placeholder="deepseek-chat">
                <label>API Key</label>
                <input id="pba-st-key" type="password" placeholder="sk-...">
                <label>最大迭代次数</label>
                <input id="pba-st-maxiter" type="number" value="5" min="1" max="20">
                <div class="pba-row">
                    <button class="pba-btn pba-btn-primary" id="pba-st-save">保存</button>
                    <button class="pba-btn pba-btn-secondary" id="pba-st-cancel">取消</button>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        $d('#pba-close-btn').addEventListener('click', closePanel);
        $d('#pba-new-btn').addEventListener('click', newConversation);
        $d('#pba-menu-btn').addEventListener('click', (e) => { e.stopPropagation(); const m = $d('#pba-menu'); m.style.display = m.style.display === 'none' ? 'block' : 'none'; });
        document.addEventListener('click', () => { const m = $d('#pba-menu'); if (m) m.style.display = 'none'; });
        $d('#pba-send-btn').addEventListener('click', () => { const inp = $d('#pba-inp'); if (abortFlag) { stopGeneration(); return; } sendMessage(inp.value); });
        $d('#pba-inp').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

        $all('.pba-menu .pm-item', panel).forEach((it) => {
            it.addEventListener('click', async (e) => {
                e.stopPropagation();
                const act = it.getAttribute('data-act');
                $d('#pba-menu').style.display = 'none';
                if (act === 'settings') openSettings();
                else if (act === 'refresh') { await refreshData(false); }
                else if (act === 'export-json') exportConversation(ui.activeConv, 'json');
                else if (act === 'export-md') exportConversation(ui.activeConv, 'md');
                else if (act === 'clear') { if (confirm(`清空项目「${PROJECT_ID}」的所有会话？`)) { Store.set(CONFIG.SK.CHATS, '{}'); Store.del(CONFIG.SK.ACTIVE); ui.activeConv = null; newConversation(); } }
            });
        });

        const sg = $d('#pba-suggest');
        const defaults = { code: ['项目整体结构？', '有哪些 Service 和 Store？', '架构分层是怎样的？', '跨蓝图查其他页面'], database: ['数据库有哪些表？', '外键关系如何？', '健康度评估？'], deploy: ['部署服务有多少？', 'nginx 路由怎么配的？', '依赖 mysql 的服务？'], service: ['后端模块有哪些？', '技术栈？', '健康度？'], planning: ['有哪些特性？', 'P1 优先级？', '健康审计？'], architecture: ['项目多大？', 'Java 后端服务？', '分层架构？', '技术栈？'], summary: ['总代码行数？', '最大子项目？', 'Java 后端占多少？'] };
        for (const q of (defaults[PAGE_TYPE] || [])) { const b = el('button'); b.textContent = q; b.addEventListener('click', () => sendMessage(q)); sg.appendChild(b); }

        const pane = $d('#pba-settings');
        function openSettings() {
            const s = getSettings();
            $d('#pba-st-provider').value = s.provider;
            $d('#pba-st-url').value = s.apiUrl || '';
            $d('#pba-st-model').value = s.model || '';
            $d('#pba-st-key').value = s.apiKey || '';
            $d('#pba-st-maxiter').value = s.maxIterations || CONFIG.MAX_ITERATIONS;
            pane.style.display = 'block';
        }
        $d('#pba-st-provider').addEventListener('change', (e) => { const p = MODEL_PROVIDERS[e.target.value]; if (p) { $d('#pba-st-url').value = p.apiUrl; $d('#pba-st-model').value = p.defaultModel; } });
        $d('#pba-st-save').addEventListener('click', () => { saveSettings({ provider: $d('#pba-st-provider').value, apiUrl: $d('#pba-st-url').value.trim(), model: $d('#pba-st-model').value.trim(), apiKey: $d('#pba-st-key').value.trim(), maxIterations: Number($d('#pba-st-maxiter').value) || CONFIG.MAX_ITERATIONS }); pane.style.display = 'none'; toast('设置已保存（项目：' + PROJECT_ID + '）', 'success'); });
        $d('#pba-st-cancel').addEventListener('click', () => { pane.style.display = 'none'; });
    }

    function createFab() {
        const fab = el('button', 'pba-fab pba-fab-pulse');
        fab.id = 'pba-fab';
        fab.title = `项目级蓝图 AI 助手（${PROJECT_ID} / ${PAGE_TYPE}）`;
        const iconMap = { code: 'sitemap', database: 'database', deploy: 'server', service: 'server', planning: 'chart', architecture: 'sitemap', summary: 'chart' };
        fab.innerHTML = getIcon(iconMap[PAGE_TYPE] || 'chat', 24);
        fab.addEventListener('click', openPanel);
        document.body.appendChild(fab);
    }

    async function refreshData(silent) { if (!silent) toast('加载数据源…'); await DataSource.load(); renderMessages(); if (DataSource.status === 'error' && !silent) toast(DataSource.error, 'error'); if (DataSource.status === 'ready' && !silent) toast(`数据源就绪：${DataSource.ctx.sourceLabel}`, 'success'); }

    async function sendMessage(text) {
        const inp = $d('#pba-inp');
        const message = (text ?? inp.value).trim();
        if (!message) return;
        let conv = ui.activeConv || ChatManager.ensureActive();
        if (conv.meta?.running) { toast('请先停止当前生成', 'error'); return; }
        if (DataSource.status !== 'ready') { await refreshData(true); if (DataSource.status !== 'ready') { toast('数据源未就绪：' + (DataSource.error || ''), 'error'); return; } }
        const s = getSettings();
        if (!(s.apiKey || '').trim()) { toast('请先在设置中配置 API Key', 'error'); return; }

        inp.value = '';
        conv.title = conv.title === '新会话' ? message.slice(0, 20) : conv.title;
        appendMessage(conv, { type: 'user', content: message });
        const aiMsg = { type: 'ai', role: 'assistant', content: '', loading: true };
        conv.messages.push(aiMsg);
        ChatManager.markRunning(conv, true);
        ui.activeConv = conv;
        renderConvList(); renderMessages();
        sendBtnState(true);

        const history = conv.messages.filter((m) => m.type === 'ai' || m.type === 'user').slice(0, -1).map((m) => ({ role: m.type === 'user' ? 'user' : 'assistant', content: m.content }));

        const onToolCall = (name, args, state, result) => {
            if (state === 'start') { conv.messages.push({ type: 'tool', tool: { name, args }, state: 'running' }); ChatManager.save(conv); renderMessages(); }
            else {
                const tMsg = conv.messages[conv.messages.length - 1];
                if (tMsg?.type === 'tool') { tMsg.state = state === 'done' ? 'done' : 'error'; if (state === 'error') tMsg.tool.error = result?.error; }
                else { conv.messages.push({ type: 'tool', tool: { name, args, error: result?.error }, state: state === 'done' ? 'done' : 'error' }); }
                ChatManager.save(conv); renderMessages();
            }
        };
        const onChunk = (delta) => { aiMsg.content += delta; aiMsg.loading = false; ChatManager.save(conv); renderMessages(); const box = $d('#pba-msgs'); if (box) box.scrollTop = box.scrollHeight; };

        try {
            const res = await runAgentLoop(message, history, onChunk, onToolCall);
            aiMsg.content = res.response; aiMsg.loading = false;
            if (res.error) aiMsg.error = res.error;
            ChatManager.markRunning(conv, false); renderMessages();
        } catch (e) { aiMsg.content = ''; aiMsg.error = e.message || String(e); aiMsg.loading = false; ChatManager.markRunning(conv, false); renderMessages(); }
        finally { sendBtnState(false); }
    }

    function sendBtnState(running) { const btn = $d('#pba-send-btn'); if (!btn) return; btn.classList.toggle('stop', running); btn.innerHTML = running ? getIcon('stop', 17) : getIcon('send', 17); }
    function stopGeneration() { abortFlag = true; toast('正在停止…'); }

    function exportConversation(conv, format) {
        if (!conv?.messages?.length) { toast('无内容可导出', 'error'); return; }
        const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const fname = `pba-chat-${PROJECT_ID}-${conv.pageType || PAGE_TYPE}-${conv.title}_${ts}.${format === 'json' ? 'json' : 'md'}`;
        if (format === 'json') {
            const data = { projectId: PROJECT_ID, pageType: conv.pageType || PAGE_TYPE, provider: getSettings().provider, model: getSettings().model, dataSource: DataSource.ctx?.sourceLabel || '', exportedAt: new Date().toISOString(), conversation: conv.messages };
            downloadFile(JSON.stringify(data, null, 2), fname, 'application/json');
        } else {
            const lines = [`# 会话：${conv.title}`, `- 项目: ${PROJECT_ID}`, `- 数据源: ${DataSource.ctx?.sourceLabel || ''}`, `- 模型: ${getSettings().provider} / ${getSettings().model}`, `- 导出时间: ${new Date().toISOString()}`, ''];
            for (const m of conv.messages) {
                if (m.type === 'user') lines.push(`## 用户\n${m.content}\n`);
                else if (m.type === 'ai') lines.push(`## AI\n${m.content || (m.error ? `（错误：${m.error}）` : '')}\n`);
                else if (m.type === 'tool') lines.push(`> 工具 ${m.tool?.name}: ${JSON.stringify(m.tool?.args)} ${m.tool?.error ? `（${m.tool.error}）` : ''}`);
            }
            downloadFile(lines.join('\n'), fname, 'text/markdown');
        }
        toast(`已导出 ${format.toUpperCase()}`);
    }

    // ============================================================
    //  初始化
    // ============================================================
    function init() {
        ensureStyles();
        // 根据 PAGE_TYPE 注册对应领域工具 + 共享工具
        if (PAGE_TYPE === 'database') registerDbTools();
        else if (PAGE_TYPE === 'deploy') registerDeployTools();
        else if (PAGE_TYPE === 'service') registerServiceTools();
        else if (PAGE_TYPE === 'planning') registerPlanningTools();
        else if (PAGE_TYPE === 'architecture') registerArchTools();
        else if (PAGE_TYPE === 'summary') registerSummaryTools();
        registerSharedTools();
        buildPanel();
        createFab();
        DataSource.load().then(() => { renderMessages(); settingsCache = null; readSettings(); });
        console.log(`%c[PBA-Agent] 项目级蓝图 AI 助手已启动 | project=${PROJECT_ID} | pageType=${PAGE_TYPE}`, 'color:#7c5cff;font-weight:bold');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

})();
