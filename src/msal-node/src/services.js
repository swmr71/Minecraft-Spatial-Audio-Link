// 共有インスタンス（DB・トークンストア・ログイン試行制限）
const config = require('./config');
const db = require('./db');
const { createTokenStore } = require('./tokenStore');
const { createFailureLimiter } = require('./rateLimiter');

const tokenStore = createTokenStore(db, { ttlSec: config.loginTokenTtlSec });
const loginLimiter = createFailureLimiter({
  max: config.loginMaxFailures,
  windowMs: config.loginFailureWindowSec * 1000,
});

module.exports = { tokenStore, loginLimiter };
