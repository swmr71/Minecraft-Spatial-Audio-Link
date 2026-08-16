const { WebSocketServer } = require('ws');
const cookie = require('cookie');
const cookieSignature = require('cookie-signature');
const redisClient = require('../redisClient');

const WS_PATHS = new Set(['/ws/vchat/', '/ws/vchat/spatial/']);
const BROADCAST_INTERVAL_MS = 1000;
const NEARBY_DISTANCE = 200;

function isNearby(p1, p2) {
  const dist = Math.sqrt(p1.reduce((sum, v, i) => sum + (v - p2[i]) ** 2, 0));
  return dist <= NEARBY_DISTANCE;
}

async function resolveSession(req, sessionSecret) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const raw = cookies['connect.sid'];
  if (!raw) return null;

  const decoded = decodeURIComponent(raw);
  const sid = decoded.startsWith('s:') ? cookieSignature.unsign(decoded.slice(2), sessionSecret) : false;
  if (!sid) return null;

  const stored = await redisClient.get(`sess:${sid}`);
  if (!stored) return null;

  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

async function broadcastPositions(ws, myUuid) {
  const keys = await redisClient.keys('vchat:player:*');
  const allData = {};

  for (const key of keys) {
    const raw = await redisClient.get(key);
    if (!raw) continue;
    try {
      const decoded = JSON.parse(raw);
      allData[decoded.u] = decoded;
    } catch (e) {
      console.error('[Debug] JSON Parse Error:', e);
    }
  }

  const me = allData[myUuid];
  if (!me) return;

  const currentTargets = [];
  for (const [u, data] of Object.entries(allData)) {
    if (u === myUuid) {
      currentTargets.push(data);
      continue;
    }
    if (isNearby(me.p, data.p) || (me.c !== 0 && me.c === data.c)) {
      currentTargets.push(data);
    }
  }

  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ t: 'pos', d: currentTargets }));
  }
}

function attachVChatWebSocket(server, sessionSecret) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (!WS_PATHS.has(pathname)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws, req) => {
    const session = await resolveSession(req, sessionSecret);
    const myUuid = session?.uuid || null;

    const interval = setInterval(() => {
      if (!myUuid) return;
      broadcastPositions(ws, myUuid).catch((e) => console.error('Error in broadcast loop:', e));
    }, BROADCAST_INTERVAL_MS);

    ws.on('close', () => clearInterval(interval));
  });

  return wss;
}

module.exports = { attachVChatWebSocket };
