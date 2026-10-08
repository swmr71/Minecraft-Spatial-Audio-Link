const { WebSocketServer } = require('ws');
const cookie = require('cookie');
const cookieSignature = require('cookie-signature');
const redisClient = require('../redisClient');
const { computeVisible } = require('../visibility');
const { loadAllPlayers } = require('../players');
const { state, isSuperAdmin } = require('../services');

const WS_PATHS = new Set(['/ws/vchat/', '/ws/vchat/spatial/']);
// 仕様: 座標同期は 250ms 周期（Plugin 5 ticks に合わせる）
const BROADCAST_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 30_000;

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
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 });
  // ws -> { uuid, isSuper, subs:Set<string>, eavesdrop, bcVersion }（認証済みクライアントのみ）
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
    // クライアント → サーバー: 傍受設定のみ（Super Admin 限定）
    ws.on('message', (data) => {
      const client = clients.get(ws);
      if (!client?.isSuper) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg?.t !== 'eavesdrop') return;
      const ch = msg.ch;
      if (ch === null || ch === 'all' || (Number.isInteger(ch) && ch >= 1 && ch <= 999)) client.eavesdrop = ch;
    });

    resolveSession(req, sessionSecret)
      .then((session) => {
        if (ws.readyState !== ws.OPEN) return;
        if (!session) return ws.close(4401, 'unauthorized');
        clients.set(ws, { uuid: session.uuid, isSuper: isSuperAdmin(session.uuid), subs: new Set(), eavesdrop: null, bcVersion: -1 });
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
      const ctxBase = { broadcasters: state.activeBroadcasts(), mutedChannels: state.mutedChannels() };
      const version = state.getVersion();

      for (const [ws, client] of clients) {
        if (ws.readyState !== ws.OPEN) continue;
        // 放送・ダッキングの変化は version が変わったときだけ通知（接続直後は必ず送る）
        if (client.bcVersion !== version) {
          client.bcVersion = version;
          ws.send(JSON.stringify({ t: 'bc', d: ctxBase.broadcasters, duck: state.getDuck() }));
        }

        // ゲーム内にいない（TTL 切れ）場合は無音。ただし Super Admin は放送・傍受のためゲーム外でも参加できる
        const me = byUuid.get(client.uuid)
          ?? (client.isSuper ? { u: client.uuid, n: 'admin', p: [0, 0, 0], y: 0, w: null, c: 0, virtual: true } : null);
        if (!me) continue;

        const visible = computeVisible(me, players, { ...ctxBase, eavesdrop: client.eavesdrop });
        ws.send(JSON.stringify({ t: 'pos', d: visible }));

        // 購読リストは変化があったときだけ差分通知（詳細設計 §3）
        const next = new Set(visible.filter((p) => p.k !== 'self').map((p) => p.u));
        const add = [...next].filter((u) => !client.subs.has(u));
        const remove = [...client.subs].filter((u) => !next.has(u));
        if (add.length || remove.length) {
          client.subs = next;
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
