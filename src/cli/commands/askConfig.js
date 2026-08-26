// ask 模型服务配置：加密存取 + provider 预置 + 环境变量覆盖
// 布局（沿 nice-os home 惯例）：
//   ~/.nice-aos/config.json  配置本体（apiKey 以 enc:v1:<iv>:<tag>:<cipher> 密文存储）
//   ~/.nice-aos/.keyring     AES-256-GCM 密钥（32 字节随机，chmod 600）
// 加密为防文件泄露/误提交的混淆级保护（本地 CLI 工具的常规强度），
// 环境变量 NICE_AOS_API_KEY/BASE_URL/MODEL 明文优先（CI / 临时覆盖场景）。
// NICE_AOS_CONFIG_DIR 可覆盖配置目录（测试用）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const PROVIDERS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
};

export function getConfigDir() {
  if (process.env.NICE_AOS_CONFIG_DIR) return process.env.NICE_AOS_CONFIG_DIR;
  return path.join(os.homedir(), '.nice-aos');
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

function getKeyringPath() {
  return path.join(getConfigDir(), '.keyring');
}

// 密钥环：首次访问生成 32 字节随机密钥（0600）
function loadKeyring() {
  const keyPath = getKeyringPath();
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath);
    if (raw.length === 32) return raw;
    // 长度异常视为损坏 → 重建（旧密文不可解，需重新 set）
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* 非 POSIX */ }
  return key;
}

// AES-256-GCM 加密，输出 enc:v1:<iv b64>:<tag b64>:<cipher b64>
export function encryptSecret(plain) {
  const key = loadKeyring();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(payload) {
  if (typeof payload !== 'string' || !payload.startsWith('enc:v1:')) return null;
  const [, , ivB64, tagB64, cipherB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !cipherB64) return null;
  try {
    const key = loadKeyring();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(cipherB64, 'base64')), decipher.final()]).toString('utf-8');
  } catch {
    return null; // keyring 重建后旧密文解不开 → 视为未配置
  }
}

function readConfigFile() {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfigFile(config) {
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8');
}

// 读取生效配置（环境变量优先于落盘配置）：
// 返回 { provider, baseUrl, model, apiKey, apiKeySource: 'env'|'file' } 或 null（未配置）
export function loadAskConfig() {
  const envKey = process.env.NICE_AOS_API_KEY?.trim();
  const envBase = process.env.NICE_AOS_BASE_URL?.trim();
  const envModel = process.env.NICE_AOS_MODEL?.trim();

  const stored = readConfigFile().ask ?? null;
  let provider = null, baseUrl = envBase, model = envModel, apiKey = envKey || null, apiKeySource = envKey ? 'env' : null;

  if (stored) {
    provider = stored.provider ?? null;
    baseUrl = baseUrl || stored.baseUrl || null;
    model = model || stored.model || null;
    if (!apiKey && stored.apiKeyEnc) {
      const plain = decryptSecret(stored.apiKeyEnc);
      if (plain) { apiKey = plain; apiKeySource = 'file'; }
    }
  }

  if (!apiKey || !baseUrl || !model) return null;
  return { provider, baseUrl, model, apiKey, apiKeySource };
}

// 保存配置（apiKey 落盘前加密；明文字段原样更新）
export function saveAskConfig({ provider, baseUrl, model, apiKey } = {}) {
  const config = readConfigFile();
  const ask = { ...(config.ask ?? {}) };
  if (provider !== undefined) ask.provider = provider || null;
  if (baseUrl !== undefined) ask.baseUrl = baseUrl || null;
  if (model !== undefined) ask.model = model || null;
  if (apiKey !== undefined) ask.apiKeyEnc = apiKey ? encryptSecret(apiKey.trim()) : null;
  config.ask = ask;
  writeConfigFile(config);
  return ask;
}

export function clearAskConfig() {
  const config = readConfigFile();
  delete config.ask;
  writeConfigFile(config);
}

// 掩码显示：sk-abcd1234…wxyz → sk-ab****wxyz
export function maskApiKey(key) {
  if (!key) return null;
  const k = key.trim();
  if (k.length <= 8) return '****';
  return `${k.slice(0, 5)}****${k.slice(-4)}`;
}

// config show 的对外视图（不含明文 key）
export function describeAskConfig() {
  const cfg = loadAskConfig();
  if (!cfg) {
    return { configured: false, hint: '未配置模型服务。可用: nice-aos ask config set --provider deepseek --api-key <key> 或环境变量 NICE_AOS_API_KEY/BASE_URL/MODEL' };
  }
  return {
    configured: true,
    provider: cfg.provider ?? 'custom',
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: maskApiKey(cfg.apiKey),
    apiKeySource: cfg.apiKeySource,
  };
}
