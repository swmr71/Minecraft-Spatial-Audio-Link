require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (set it in .env)`);
  }
  return value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer (got "${raw}")`);
  }
  return value;
}

function list(name) {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  port: int('PORT', 8010),
  sessionSecret: required('SESSION_SECRET'),
  sessionMaxAgeMs: int('SESSION_MAX_AGE_HOURS', 12) * 60 * 60 * 1000,
  // Cloudflare Tunnel / リバースプロキシ配下では 1 を指定する（secure cookie 判定に必要）
  trustProxy: int('TRUST_PROXY', 1),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379/0',
  // プラグイン → バックエンド API の共有シークレット
  pluginApiKey: required('PLUGIN_API_KEY'),
  livekit: {
    apiKey: required('LIVEKIT_API_KEY'),
    apiSecret: required('LIVEKIT_API_SECRET'),
    wsUrl: required('LIVEKIT_WS_URL'),
    room: process.env.LIVEKIT_ROOM || 'minecraft-vc',
    tokenTtl: process.env.LIVEKIT_TOKEN_TTL || '2h',
  },
  // ログインコード（ワンタイム）の有効期限
  loginTokenTtlSec: int('LOGIN_TOKEN_TTL_SEC', 300),
  // 同一 IP / 同一 MCID あたりのログイン失敗上限（windowSec 内）
  loginMaxFailures: int('LOGIN_MAX_FAILURES', 5),
  loginFailureWindowSec: int('LOGIN_FAILURE_WINDOW_SEC', 300),
  dbPath: process.env.DB_PATH || null,
  // 空欄 = 同一オリジンのみ。複数指定はカンマ区切り
  allowedOrigins: list('ALLOWED_ORIGINS'),
};

if (config.sessionSecret.length < 16 || config.sessionSecret === 'change-me') {
  throw new Error('SESSION_SECRET is too weak (16+ random characters required)');
}
if (config.pluginApiKey.length < 16 || config.pluginApiKey === 'change-me') {
  throw new Error('PLUGIN_API_KEY is too weak (16+ random characters required)');
}

module.exports = config;
