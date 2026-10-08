const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const RedisStore = require('connect-redis').default;

const config = require('./config');
const redisClient = require('./redisClient');
const { tokenStore, loginLimiter, state, audio } = require('./services');
const authRoutes = require('./routes/auth');
const tokenRoutes = require('./routes/token');
const livekitRoutes = require('./routes/livekit');
const adminRoutes = require('./routes/admin');
const audioRoutes = require('./routes/audio');
const { attachVChatWebSocket } = require('./ws/vchat');

async function main() {
  await redisClient.connect();
  await state.load();

  const app = express();
  app.disable('x-powered-by');
  // Cloudflare Tunnel 配下: X-Forwarded-* を信頼して req.ip / secure cookie を正しく扱う
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    });
    next();
  });

  // 音源の PCM ストリーム（長時間の POST）。ボディパーサー・セッションより前に置く
  app.use('/api/vc/plugin/audio', audioRoutes.pushRouter);

  // 既定は同一オリジンのみ。ALLOWED_ORIGINS を指定したときだけ CORS を許可する。
  app.use(cors({
    origin: config.allowedOrigins.length ? config.allowedOrigins : false,
    credentials: true,
  }));
  app.use(express.json({ limit: '4kb' }));
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));
  app.use(session({
    store: new RedisStore({ client: redisClient, prefix: 'sess:', ttl: config.sessionMaxAgeMs / 1000 }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: config.sessionMaxAgeMs,
    },
  }));

  app.use('/static', express.static(path.join(__dirname, '..', 'public', 'static'), { index: false, maxAge: '1h' }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/', authRoutes);
  app.use('/api/vc', tokenRoutes);
  app.use('/api/vc', livekitRoutes);
  app.use('/api/vc', adminRoutes);
  app.use('/api/vc', audioRoutes.router);

  app.use((req, res) => res.status(404).json({ error: 'Not Found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[http] unhandled error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  });

  const server = http.createServer(app);
  // push 方式の音源は何時間も続く 1 本の POST になるため、リクエスト全体のタイムアウトは無効にする
  // （ヘッダ受信のタイムアウトは維持。短い JSON の API はボディサイズ制限で守る）
  server.requestTimeout = 0;
  const wss = attachVChatWebSocket(server, {
    sessionSecret: config.sessionSecret,
    allowedOrigins: config.allowedOrigins,
  });

  const sweeper = setInterval(() => {
    tokenStore.sweep();
    loginLimiter.sweep();
  }, 60_000);
  sweeper.unref();

  server.listen(config.port, () => {
    console.log(`msal-node listening on :${config.port}`);
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[msal-node] ${signal} received, shutting down...`);
    clearInterval(sweeper);
    wss.close();
    await audio.stopAll().catch(() => {});
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    server.close(async () => {
      await redisClient.quit().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start msal-node:', err);
  process.exit(1);
});
