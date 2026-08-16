require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const RedisStore = require('connect-redis').default;

const redisClient = require('./redisClient');
const authRoutes = require('./routes/auth');
const tokenRoutes = require('./routes/token');
const livekitRoutes = require('./routes/livekit');
const { attachVChatWebSocket } = require('./ws/vchat');

const PORT = process.env.PORT || 8010;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required (set it in .env)');
}

async function main() {
  await redisClient.connect();

  const app = express();
  app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(session({
    store: new RedisStore({ client: redisClient, prefix: 'sess:' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  }));

  app.use('/', authRoutes);
  app.use('/api/vc', tokenRoutes);
  app.use('/api/vc', livekitRoutes);

  const server = http.createServer(app);
  attachVChatWebSocket(server, SESSION_SECRET);

  server.listen(PORT, () => {
    console.log(`msal-node listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start msal-node:', err);
  process.exit(1);
});
