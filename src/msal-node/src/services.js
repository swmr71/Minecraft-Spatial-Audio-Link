// 共有インスタンス（DB・トークンストア・ログイン試行制限）
const config = require('./config');
const db = require('./db');
const { createTokenStore } = require('./tokenStore');
const { createFailureLimiter } = require('./rateLimiter');
const { createState, createRedisStore } = require('./state');
const redisClient = require('./redisClient');
const { createAudioManager } = require('./audio/manager');
const { createRtcPublisher } = require('./audio/rtcPublisher');

const tokenStore = createTokenStore(db, { ttlSec: config.loginTokenTtlSec });
const loginLimiter = createFailureLimiter({
  max: config.loginMaxFailures,
  windowMs: config.loginFailureWindowSec * 1000,
});

const state = createState({
  duckPercent: config.defaultDuckPercent,
  broadcastMaxMs: config.broadcastMaxSeconds * 1000,
  store: createRedisStore(redisClient),
});

const audio = createAudioManager({
  createPublisher: createRtcPublisher,
  maxSources: config.audio.maxSources,
  idleTimeoutSec: config.audio.idleTimeoutSec,
  ffmpegPath: config.audio.ffmpegPath,
});

/** Super Admin（Sawamura）は UUID で固定（仕様書 §4）。Moderator はゲーム内の LuckPerms 権限をプラグイン側で評価する。 */
const isSuperAdmin = (uuid) => typeof uuid === 'string' && config.superAdminUuids.includes(uuid.toLowerCase());

module.exports = { tokenStore, loginLimiter, state, audio, isSuperAdmin };
