// configAnalyzer 单元测试
// 覆盖 8 种文件类型的轻量级语义提取 + 行数计算 + .env.* 规范化
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConfigFile, analyzeConfigFileFromDisk } from '../src/analyzers/configAnalyzer.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-analyzer-'));

function writeFixture(name, text) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
}

test('CSS：提取 @import / @keyframes / 选择器 / CSS 变量', () => {
  const css = `
@import url('./theme.css');
@import "common.css";

:root {
  --color-primary: #4dabf7;
  --spacing-unit: 8px;
}

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

.btn-primary { background: var(--color-primary); padding: var(--spacing-unit); }
.card { border-radius: 4px; }
`;
  const facts = analyzeConfigFile('a.css', css);
  assert.equal(facts.lineCount, 13);
  assert.equal(facts.ext, 'css');
  assert.equal(facts.configKind, 'css');
  const kinds = facts.configItems.map((i) => `${i.kind}:${i.name}`);
  assert.ok(kinds.includes('import:./theme.css'));
  assert.ok(kinds.includes('import:common.css'));
  assert.ok(kinds.includes('keyframes:fadeIn'));
  assert.ok(kinds.includes('var:--color-primary'));
  assert.ok(kinds.includes('var:--spacing-unit'));
  assert.ok(facts.configItems.some((i) => i.kind === 'selector' && i.name === '.btn-primary'));
});

test('HTML：提取 title / script src / link href / meta / anchor', () => {
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="/favicon.ico">
  <title>AI 资源中心</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
  <section id="hero" data-testid="hero">Hello</section>
</body>
</html>`;
  const facts = analyzeConfigFile('index.html', html);
  assert.equal(facts.ext, 'html');
  const items = facts.configItems;
  assert.ok(items.find((i) => i.kind === 'title' && i.name === 'AI 资源中心'));
  assert.ok(items.find((i) => i.kind === 'script' && i.name === '/src/main.tsx'));
  assert.ok(items.find((i) => i.kind === 'link' && i.name === '/favicon.ico'));
  assert.ok(items.find((i) => i.kind === 'meta' && i.name === 'viewport'));
  assert.ok(items.find((i) => i.kind === 'anchor' && i.name === 'root'));
});

test('SQL：提取 CREATE TABLE / VIEW / INDEX / FUNCTION / PROCEDURE 名称', () => {
  const sql = `-- 创建表
CREATE TABLE \`user_account\` (
  id BIGINT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS public.order_items (id BIGINT);
CREATE INDEX idx_user_email ON user_account (email);
CREATE OR REPLACE VIEW active_users AS SELECT * FROM user_account WHERE active = 1;
CREATE FUNCTION calc_total (price DECIMAL) RETURNS DECIMAL AS $$
BEGIN
  RETURN price * 1.13;
END;
$$ LANGUAGE plpgsql;
CREATE PROCEDURE refresh_stats (IN p_date DATE) LANGUAGE SQL AS $$ ANALYZE $$;
CREATE TRIGGER trg_audit AFTER INSERT ON user_account FOR EACH ROW EXECUTE PROCEDURE audit_log();
-- 字符串内的关键字不应被误识别
INSERT INTO log VALUES ('CREATE TABLE fake_table (id INT)');
`;
  const facts = analyzeConfigFile('V1__init.sql', sql);
  assert.equal(facts.lineCount, 16);
  const items = facts.configItems;
  assert.ok(items.find((i) => i.kind === 'table' && i.name === 'user_account'));
  assert.ok(items.find((i) => i.kind === 'table' && i.name === 'order_items'));
  assert.ok(items.find((i) => i.kind === 'index' && i.name === 'idx_user_email'));
  assert.ok(items.find((i) => i.kind === 'view' && i.name === 'active_users'));
  assert.ok(items.find((i) => i.kind === 'function' && i.name === 'calc_total'));
  assert.ok(items.find((i) => i.kind === 'procedure' && i.name === 'refresh_stats'));
  assert.ok(items.find((i) => i.kind === 'trigger' && i.name === 'trg_audit'));
  // 字符串内的 fake_table 不应被误识别
  assert.ok(!items.find((i) => i.name === 'fake_table'));
});

test('YAML：提取顶层 key + 缩进 2 的子 key（含 docker-compose / k8s 强信号）', () => {
  const yaml = `version: '3.8'
services:
  asdm-portal:
    image: nginx:1.27
    ports:
      - "8080:80"
  asdm-api:
    image: my-api:1.0
networks:
  asdm-net:
    driver: bridge
`;
  const facts = analyzeConfigFile('docker-compose.yml', yaml);
  const items = facts.configItems;
  assert.ok(items.find((i) => i.kind === 'version' && i.name === '3.8'));
  assert.ok(items.find((i) => i.kind === 'services'));
  assert.ok(items.find((i) => i.kind === 'subkey' && i.name === 'asdm-portal'));
  assert.ok(items.find((i) => i.kind === 'subkey' && i.name === 'asdm-api'));
  assert.ok(items.find((i) => i.kind === 'key' && i.name === 'networks'));
});

test('INI / CONF：提取 [section] 段名 + key 名称', () => {
  const conf = `# nginx
worker_processes  auto;
events {
    worker_connections  1024;
}
http {
    server {
        listen 80;
        server_name localhost;
        location / {
            root /var/www;
        }
        location /api {
            proxy_pass http://backend;
        }
    }
}
`;
  const facts = analyzeConfigFile('nginx.conf', conf);
  const items = facts.configItems;
  assert.ok(items.find((i) => i.kind === 'section' && i.name === 'events'));
  assert.ok(items.find((i) => i.kind === 'section' && i.name === 'http'));
  assert.ok(items.find((i) => i.kind === 'section' && i.name === 'server'));
  assert.ok(items.find((i) => i.kind === 'key' && i.name === 'worker_processes'));
  assert.ok(items.find((i) => i.kind === 'key' && i.name === 'listen'));
});

test('TOML：提取 [section] 段名 + key 名称', () => {
  const toml = `[package]
name = "myapp"
version = "1.0.0"

[dependencies]
serde = "1.0"
tokio = "1.35"
`;
  const facts = analyzeConfigFile('Cargo.toml', toml);
  const items = facts.configItems;
  assert.ok(items.find((i) => i.kind === 'section' && i.name === 'package'));
  assert.ok(items.find((i) => i.kind === 'section' && i.name === 'dependencies'));
  assert.ok(items.find((i) => i.kind === 'key' && i.name === 'name'));
  assert.ok(items.find((i) => i.kind === 'key' && i.name === 'version'));
});

test('.env：仅提取 KEY 名（不取 value，敏感信息保护）', () => {
  const env = `# 数据库配置
DB_HOST=localhost
DB_PORT=5432
DB_PASSWORD=supersecret-do-not-leak
API_KEY=sk-abc-very-secret
`;
  const facts = analyzeConfigFile('.env', env);
  assert.equal(facts.ext, 'env');
  const items = facts.configItems;
  assert.ok(items.find((i) => i.kind === 'var' && i.name === 'DB_HOST'));
  assert.ok(items.find((i) => i.kind === 'var' && i.name === 'API_KEY'));
  // 确保 value 没泄露
  const dump = JSON.stringify(items);
  assert.ok(!dump.includes('supersecret'));
  assert.ok(!dump.includes('sk-abc-very-secret'));
});

test('行数计算：含末行换行 / 不含末行换行 / 多行 SQL 注释', () => {
  assert.equal(analyzeConfigFile('a.txt', 'a\nb\nc\n').lineCount, 3);
  assert.equal(analyzeConfigFile('a.txt', 'a\nb\nc').lineCount, 3);
  assert.equal(analyzeConfigFile('a.txt', '').lineCount, 0);
  assert.equal(analyzeConfigFile('a.txt', 'single line').lineCount, 1);
});

test('大文件：> 2MB 跳过详细解析但仍算行数（防 OOM）', () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  const facts = analyzeConfigFile('big.css', big);
  assert.ok(facts.lineCount >= 1);
  assert.equal(facts.configTruncated, true);
  assert.equal(facts.configItems.length, 0);
});

test('磁盘分析：analyzeConfigFileFromDisk + extOverride 规范化 .env.development', () => {
  const p = writeFixture('.env.development', 'VITE_PORT=3000\nVITE_HOST=0.0.0.0\n');
  const projectRoot = tmp;
  const rel = '.env.development';
  const facts = analyzeConfigFileFromDisk(rel, projectRoot, 'env');
  assert.equal(facts.ext, 'env');
  assert.equal(facts.lineCount, 2);
  assert.ok(facts.configItems.find((i) => i.name === 'VITE_PORT'));
  assert.ok(facts.configItems.find((i) => i.name === 'VITE_HOST'));
});

test('未识别 ext：返回空 items（不抛错）', () => {
  const facts = analyzeConfigFile('foo.xyz', 'whatever');
  assert.equal(facts.ext, 'xyz');
  assert.equal(facts.configItems.length, 0);
});
