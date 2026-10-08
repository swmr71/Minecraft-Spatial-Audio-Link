// 実サーバー + 実 Redis の通しテスト。Redis に接続できない環境ではスキップする。
// 既定は redis://127.0.0.1:6379/15（テスト専用 DB）。MSAL_TEST_REDIS_URL で変更可能。
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { createClient } = require('redis');
const WebSocket = require('ws');

const REDIS_URL = process.env.MSAL_TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const KEY = 'k'.repeat(32);
const UUID_A = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const UUID_B = '61699b2e-d327-4a01-9f1e-0ea8c3f06bc6';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function connectRedis() {
  const client = createClient({ url: REDIS_URL, socket: { reconnectStrategy: false, connectTimeout: 1000 } });
  client.on('error', () => {});
  try {
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

test('backend 通しテスト（認証・ワンタイム・総当たり対策・WS）', async (t) => {
  const redis = await connectRedis();
  if (!redis) return t.skip(`Redis (${REDIS_URL}) に接続できないためスキップ`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'ignore',
    env: {
      ...process.env, PORT: String(port), SESSION_SECRET: 's'.repeat(32), PLUGIN_API_KEY: KEY,
      REDIS_URL, LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'x'.repeat(40),
      LIVEKIT_WS_URL: 'wss://lk.example', DB_PATH: ':memory:', TRUST_PROXY: '0',
      SUPER_ADMIN_UUIDS: UUID_A,
    },
  });

  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* 起動待ち */ }
      await sleep(100);
    }
    await redis.flushDb();

    const post = (p, body, headers = {}) => fetch(base + p, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    const login = (name, code) => fetch(`${base}/login/`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ mc_name: name, code }),
    });
    const issue = async (uuid, name) => (await (await post('/api/vc/token/generate/', { uuid, mc_name: name }, { 'x-msal-key': KEY })).json()).token;

    await t.test('コード発行は共有シークレット必須 / 入力検証', async () => {
      assert.equal((await post('/api/vc/token/generate/', { uuid: UUID_A, mc_name: 'Alice' })).status, 401);
      assert.equal((await post('/api/vc/token/generate/', { uuid: UUID_A, mc_name: 'Alice' }, { 'x-msal-key': 'wrong' })).status, 401);
      assert.equal((await post('/api/vc/token/generate/', { uuid: 'x', mc_name: '<b>' }, { 'x-msal-key': KEY })).status, 400);
    });

    let cookie;
    await t.test('ログイン成功は 1 回限り・HttpOnly/SameSite cookie', async () => {
      const code = await issue(UUID_A, 'Alice');
      assert.match(code, /^\d{6}$/);
      const wrong = code === '000000' ? '000001' : '000000';
      assert.equal((await login('Alice', wrong)).status, 401);

      const ok = await login('Alice', code);
      assert.equal(ok.status, 302);
      const setCookie = ok.headers.get('set-cookie');
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);
      cookie = setCookie.split(';')[0];

      assert.equal((await login('Alice', code)).status, 401, 'コードの再利用は不可');
    });

    await t.test('ダッシュボード/LiveKit トークンはログイン必須', async () => {
      assert.equal((await fetch(`${base}/dashboard/`, { redirect: 'manual' })).status, 302);
      assert.equal((await post('/api/vc/livekit/token/', {})).status, 401);
      assert.equal((await post('/api/vc/livekit/token/', {}, { cookie })).status, 200);
      const html = await (await fetch(`${base}/dashboard/`, { headers: { cookie } })).text();
      assert.ok(html.includes('data-uuid="' + UUID_A + '"'));
    });

    await t.test('WebSocket: Origin 不正・未認証は拒否、認証済みは pos/sub を差分配信', async () => {
      const url = `ws://127.0.0.1:${port}/ws/vchat/spatial/`;
      const origin = `http://127.0.0.1:${port}`;

      const status = await new Promise((resolve) => {
        const bad = new WebSocket(url, { headers: { cookie, origin: 'https://evil.example' } });
        bad.on('unexpected-response', (req, res) => resolve(res.statusCode));
        bad.on('error', () => {});
      });
      assert.equal(status, 403);

      const anonCode = await new Promise((resolve) => {
        new WebSocket(url, { headers: { origin } }).on('close', resolve);
      });
      assert.equal(anonCode, 4401);

      const put = (u, n, p, w, c) => redis.setEx(`vchat:player:${u}`, 10, JSON.stringify({ u, n, p, y: 0, w, c }));
      await put(UUID_A, 'Alice', [0, 64, 0], 'world', 0);
      await put(UUID_B, 'Bob', [30, 64, 0], 'world', 0);
      await put('00000000-0000-0000-0000-000000000003', 'Far', [500, 64, 0], 'world', 0);

      const ws = new WebSocket(url, { headers: { cookie, origin } });
      const msgs = [];
      ws.on('message', (m) => msgs.push(JSON.parse(m)));
      await sleep(900);

      const pos = msgs.find((m) => m.t === 'pos');
      assert.deepEqual(pos.d.map((p) => `${p.n}:${p.k}`).sort(), ['Alice:self', 'Bob:prox']);
      assert.deepEqual(msgs.filter((m) => m.t === 'sub').map((m) => m.add), [[UUID_B]], 'sub は変化時のみ');
      assert.ok(msgs.filter((m) => m.t === 'pos').length >= 2, '250ms 周期で配信');

      await put(UUID_A, 'Alice', [0, 64, 0], 'world', 7);
      await put(UUID_B, 'Bob', [0, 64, 0], 'world_nether', 7);
      await sleep(600);
      const bob = [...msgs].reverse().find((m) => m.t === 'pos').d.find((p) => p.n === 'Bob');
      assert.deepEqual([bob.k, bob.dist, bob.ng], ['radio', 2000, 1]);

      ws.close();
    });

    await t.test('RBAC: 管理 API は Super Admin のみ / プラグイン API は共有シークレット必須', async () => {
      // Bob（一般）としてログイン
      const code = await issue(UUID_B, 'Bobby');
      const bobCookie = (await login('Bobby', code)).headers.get('set-cookie').split(';')[0];

      assert.equal((await fetch(`${base}/api/vc/admin/state`)).status, 401);
      assert.equal((await fetch(`${base}/api/vc/admin/state`, { headers: { cookie: bobCookie } })).status, 403);
      assert.equal((await post('/api/vc/admin/broadcast/start', { message: 'x' }, { cookie: bobCookie })).status, 403);
      assert.equal((await post('/api/vc/admin/settings', { duck: 10 }, { cookie: bobCookie })).status, 403);
      assert.equal((await fetch(`${base}/api/vc/admin/state`, { headers: { cookie } })).status, 200);

      assert.equal((await post('/api/vc/plugin/broadcast/start', { uuid: UUID_B, mc_name: 'Bobby' })).status, 401);
      assert.equal((await post('/api/vc/plugin/channel/mute', { channel: 3, muted: true })).status, 401);

      const dash = await (await fetch(`${base}/dashboard/`, { headers: { cookie } })).text();
      assert.ok(dash.includes('data-role="super"'));
      const bobDash = await (await fetch(`${base}/dashboard/`, { headers: { cookie: bobCookie } })).text();
      assert.ok(bobDash.includes('data-role="user"'));
    });

    await t.test('入力検証: 設定値・チャンネル・Content-Type', async () => {
      assert.equal((await post('/api/vc/admin/settings', { duck: 101 }, { cookie })).status, 400);
      assert.equal((await post('/api/vc/admin/settings', { duck: 'x' }, { cookie })).status, 400);
      assert.equal((await post('/api/vc/admin/channel/mute', { channel: 0, muted: true }, { cookie })).status, 400);
      assert.equal((await post('/api/vc/admin/channel/mute', { channel: 5, muted: 'yes' }, { cookie })).status, 400);
      const form = await fetch(`${base}/api/vc/admin/settings`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'duck=10',
      });
      assert.equal(form.status, 415);
    });

    await t.test('放送・ダッキング・ミュート・傍受が WebSocket に反映される', async () => {
      const url = `ws://127.0.0.1:${port}/ws/vchat/spatial/`;
      const origin = `http://127.0.0.1:${port}`;
      const put = (u, n, p, w, c) => redis.setEx(`vchat:player:${u}`, 20, JSON.stringify({ u, n, p, y: 0, w, c }));
      const UUID_C = '00000000-0000-0000-0000-0000000000cc';
      const UUID_D = '00000000-0000-0000-0000-0000000000dd';
      // Alice(super): world ch0 / Carol: 遠方 ch8 / Dave: 遠方 ch8
      await put(UUID_A, 'Alice', [0, 64, 0], 'world', 0);
      await put(UUID_C, 'Carol', [900, 64, 0], 'world', 8);
      await put(UUID_D, 'Dave', [950, 64, 0], 'world', 8);

      const ws = new WebSocket(url, { headers: { cookie, origin } });
      const msgs = [];
      ws.on('message', (m) => msgs.push(JSON.parse(m)));
      const lastPos = () => [...msgs].reverse().find((m) => m.t === 'pos');
      const lastBc = () => [...msgs].reverse().find((m) => m.t === 'bc');
      const kinds = () => Object.fromEntries(lastPos().d.map((p) => [p.n, p.k]));

      await sleep(700);
      assert.deepEqual(lastBc(), { t: 'bc', d: [], duck: 30 }, '接続直後に既定のダッキング量が届く');
      assert.deepEqual(kinds(), { Alice: 'self' });

      // プラグインから Carol の放送開始 → Alice に global
      assert.equal((await post('/api/vc/plugin/broadcast/start', { uuid: UUID_C, mc_name: 'Carol', message: 'メンテ' }, { 'x-msal-key': KEY })).status, 200);
      await sleep(700);
      assert.equal(kinds().Carol, 'global');
      assert.deepEqual(lastBc().d.map((b) => [b.n, b.msg]), [['Carol', 'メンテ']]);

      // ダッキング量変更
      assert.equal((await post('/api/vc/admin/settings', { duck: 12 }, { cookie })).status, 200);
      await sleep(700);
      assert.equal(lastBc().duck, 12);

      // 放送停止（uuid 無し = 全停止）
      assert.equal((await post('/api/vc/plugin/broadcast/stop', {}, { 'x-msal-key': KEY })).status, 200);
      await sleep(700);
      assert.equal(kinds().Carol, undefined);
      assert.deepEqual(lastBc().d, []);

      // 傍受: 全チャンネル → Carol/Dave が radio(ng=0)。チャンネル指定・解除も反映
      ws.send(JSON.stringify({ t: 'eavesdrop', ch: 'all' }));
      await sleep(700);
      assert.deepEqual([kinds().Carol, kinds().Dave], ['radio', 'radio']);
      assert.equal(lastPos().d.find((p) => p.n === 'Carol').ng, 0);
      ws.send(JSON.stringify({ t: 'eavesdrop', ch: 99 }));
      await sleep(700);
      assert.deepEqual(kinds(), { Alice: 'self' });
      ws.send(JSON.stringify({ t: 'eavesdrop', ch: null }));

      // ミュート: 一般ユーザー Bobby が ch8 で聞いている状態で ch8 をミュート → 聞こえなくなる
      await put(UUID_B, 'Bobby', [0, 64, 0], 'world', 8);
      const bobCode = await issue(UUID_B, 'Bobby');
      const bobCookie = (await login('Bobby', bobCode)).headers.get('set-cookie').split(';')[0];
      const bws = new WebSocket(url, { headers: { cookie: bobCookie, origin } });
      const bmsgs = [];
      bws.on('message', (m) => bmsgs.push(JSON.parse(m)));
      const bKinds = () => Object.fromEntries([...bmsgs].reverse().find((m) => m.t === 'pos').d.map((p) => [p.n, p.k]));
      await sleep(700);
      assert.equal(bKinds().Carol, 'radio');
      // 一般ユーザーが傍受を要求しても無視される
      bws.send(JSON.stringify({ t: 'eavesdrop', ch: 'all' }));

      assert.equal((await post('/api/vc/plugin/channel/mute', { channel: 8, muted: true }, { 'x-msal-key': KEY })).status, 200);
      await sleep(700);
      assert.equal(bKinds().Carol, undefined);
      const st = await (await fetch(`${base}/api/vc/admin/state`, { headers: { cookie } })).json();
      assert.deepEqual(st.muted, [8]);
      assert.ok(st.players.some((p) => p.n === 'Carol'));

      assert.equal((await post('/api/vc/admin/channel/mute', { channel: 8, muted: false }, { cookie })).status, 200);
      await sleep(700);
      assert.equal(bKinds().Carol, 'radio');

      ws.close();
      bws.close();
    });

    await t.test('認証中に切断してもサーバーは落ちない', async () => {
      const q = new WebSocket(`ws://127.0.0.1:${port}/ws/vchat/spatial/`, { headers: { cookie, origin: `http://127.0.0.1:${port}` } });
      q.on('open', () => q.terminate());
      q.on('error', () => {});
      await sleep(300);
      assert.equal((await fetch(`${base}/healthz`)).ok, true);
    });

    // IP 単位の失敗制限に達するため、ログインを使う他のテストの後に置く
    await t.test('連続失敗で 429（コードも失効）', async () => {
      const code = await issue(UUID_B, 'Bob');
      const wrong = code === '999999' ? '999998' : '999999';
      let last;
      for (let i = 0; i < 6; i++) last = await login('Bob', wrong);
      assert.equal(last.status, 429);
      assert.equal((await login('Bob', code)).status, 429);
    });
  } finally {
    server.kill('SIGTERM');
    await redis.flushDb().catch(() => {});
    await redis.quit().catch(() => {});
  }
});
