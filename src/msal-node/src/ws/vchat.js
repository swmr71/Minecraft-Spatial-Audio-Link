const { WebSocketServer } = require('ws');
const cookie = require('cookie');
const cookieSignature = require('cookie-signature');
const redisClient = require('../redisClient');
const { computeVisible, isValidPlayer } = require('../visibility');

const WS_PATHS = new Set(['/ws/vchat/', '/ws/vchat/spatial/']);
// 仕様: 座標同期は 250ms 周期（Plugin 5 ticks に合わせる）
const BROADCAST_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PLAYER_KEY_PATTERN = 'vchat:player:*';

async function resolveSession(req, sessionSecret) {
  const raw = cookie.parse(req.headers.cookie || '')['connect.sid'];
  if (!raw) return null;

  const decoded = decodeURIComponent(raw);
  const sid = decoded.startsWith('s:') ? cookieSignature.unsign(decoded.slice(2), sessionSecret) : false;
  if (!sid) return null;

  const stored = await redisClient.get(`sess:${sid}`);
  if (!stored) return null;

  try {
    const session = JSON.parse(stored);
    return session?.uuid ? session : null;
  } catch {
    return null;
  }
}

/** SCAN + MGET で全プレイヤー状態を 1 回だけ取得する（KEYS はブロッキングなので使わない）。 */
async function loadAllPlayers() {
  const keys = [];
  for await (const key of redisClient.scanIterator({ MATCH: PLAYER_KEY_PATTERN, COUNT: 200 })) {
    // redis v4 は 1 件ずつ、v5 は配列で返す
    if (Array.isArray(key)) keys.push(...key);
    else keys.push(key);
  }
  if (keys.length === 0) return [];

  const values = await redisClient.mGet(keys);
  const players = [];
  for (const raw of values) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (isValidPlayer(parsed)) players.push(parsed);
    } catch (e) {
      console.error('[ws] invalid player JSON:', e.message);
    }
  }
  return players;
}

function isAllowedOrigin(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function attachVChatWebSocket(server, { sessionSecret, allowedOrigins = [] }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  // ws -> { uuid, subs:Set<string> }（認証済みクライアントのみ）
  const clients = new Map();

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const { pathname } = new URL(req.url, 'http://localhost');
    if (!WS_PATHS.has(pathname)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    // Cross-Site WebSocket Hijacking 対策
    if (!isAllowedOrigin(req, allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    // await より前に同期でハンドラを付ける（認証中の切断・エラーを取りこぼさない）
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (e) => console.error('[ws] client error:', e.message));
    ws.on('close', () => clients.delete(ws));

    resolveSession(req, sessionSecret)
      .then((session) => {
        if (ws.readyState !== ws.OPEN) return;
        if (!session) return ws.close(4401, 'unauthorized');
        clients.set(ws, { uuid: session.uuid, subs: new Set() });
      })
      .catch((e) => {
        console.error('[ws] session resolve failed:', e);
        ws.close(1011, 'internal error');
      });
  });

  let ticking = false;
  const tick = setInterval(async () => {
    if (ticking || clients.size === 0) return; // 前回が終わっていなければスキップ
    ticking = true;
    try {
      const players = await loadAllPlayers();
      const byUuid = new Map(players.map((p) => [p.u, p]));

      for (const [ws, state] of clients) {
        if (ws.readyState !== ws.OPEN) continue;
        const me = byUuid.get(state.uuid);
        if (!me) continue; // ゲーム内にいない（TTL 切れ）

        const visible = computeVisible(me, players);
        ws.send(JSON.stringify({ t: 'pos', d: visible }));

        // 購読リストは変化があったときだけ差分通知（詳細設計 §3）
        const next = new Set(visible.filter((p) => p.k !== 'self').map((p) => p.u));
        const add = [...next].filter((u) => !state.subs.has(u));
        const remove = [...state.subs].filter((u) => !next.has(u));
        if (add.length || remove.length) {
          state.subs = next;
          ws.send(JSON.stringify({ t: 'sub', add, remove }));
        }
      }
    } catch (e) {
      console.error('[ws] broadcast loop error:', e);
    } finally {
      ticking = false;
    }
  }, BROADCAST_INTERVAL_MS);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => {
    clearInterval(tick);
    clearInterval(heartbeat);
  });

  return wss;
}

module.exports = { attachVChatWebSocket };
