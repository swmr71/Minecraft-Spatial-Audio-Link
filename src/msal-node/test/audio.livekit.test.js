// 実 LiveKit サーバー + ffmpeg を使った音源 API の通しテスト。
// 次の環境変数が無い環境ではスキップする（CI では実行しない）:
//   MSAL_TEST_LIVEKIT_URL (ws://127.0.0.1:7880), MSAL_TEST_LIVEKIT_KEY, MSAL_TEST_LIVEKIT_SECRET, MSAL_TEST_REDIS_URL
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const { MSAL_TEST_LIVEKIT_URL: LK_URL, MSAL_TEST_LIVEKIT_KEY: LK_KEY, MSAL_TEST_LIVEKIT_SECRET: LK_SECRET, MSAL_TEST_REDIS_URL: REDIS_URL } = process.env;
const PKEY = 'p'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('音源 API を実 LiveKit で通す（push / URL / 自動撤去）', async (t) => {
  if (!LK_URL || !LK_KEY || !LK_SECRET || !REDIS_URL) return t.skip('MSAL_TEST_LIVEKIT_* / MSAL_TEST_REDIS_URL が未設定');
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('ffmpeg が無い');

  const rtc = require('@livekit/rtc-node');
  const { AccessToken } = require('livekit-server-sdk');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn('node', ['src/index.js'], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: { ...process.env, PORT: String(port), SESSION_SECRET: 's'.repeat(32), PLUGIN_API_KEY: PKEY, REDIS_URL,
      LIVEKIT_API_KEY: LK_KEY, LIVEKIT_API_SECRET: LK_SECRET, LIVEKIT_WS_URL: LK_URL, DB_PATH: ':memory:', TRUST_PROXY: '0',
      AUDIO_IDLE_TIMEOUT_SEC: '2' },
  });
  const ffmpegs = [];
  const room = new rtc.Room();
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* 起動待ち */ }
      await sleep(100);
    }
    const api = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-msal-key': PKEY }, body: JSON.stringify(body) });
    const list = async () => (await (await fetch(`${base}/api/vc/plugin/audio/list`, { headers: { 'x-msal-key': PKEY } })).json()).audio;

    // 受信側（ブラウザの代わり）: 参加者ごとの最大振幅を記録
    const at = new AccessToken(LK_KEY, LK_SECRET, { identity: 'listener' });
    at.addGrant({ roomJoin: true, room: 'minecraft-vc', canSubscribe: true, canPublish: false });
    const peaks = {};
    const left = [];
    room.on(rtc.RoomEvent.TrackSubscribed, async (track, pub, p) => {
      for await (const f of new rtc.AudioStream(track, 48000, 1)) for (const s of f.data) peaks[p.identity] = Math.max(peaks[p.identity] || 0, Math.abs(s));
    });
    room.on(rtc.RoomEvent.ParticipantDisconnected, (p) => left.push(p.identity));
    await room.connect(LK_URL, await at.toJwt(), { autoSubscribe: true });

    await t.test('push 方式: ffmpeg の HTTP チャンク POST がそのまま音になり、途切れたら自動撤去される', async () => {
      const started = await (await api('/api/vc/plugin/audio/start', { id: 'tv', world: 'world', x: 10, y: 64, z: 10, range: 40 })).json();
      assert.equal(started.audio.mode, 'push');
      const ff = spawn('ffmpeg', ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '30',
        '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-headers', `X-MSAL-Key: ${PKEY}\r\n`, '-method', 'POST', '-chunked_post', '1', base + started.pushPath], { stdio: 'ignore' });
      ffmpegs.push(ff);
      await sleep(3500);
      assert.ok(peaks['audio:tv'] > 1000, `音が届く (peak=${peaks['audio:tv']})`);
      assert.equal((await list())[0].pushing, true);
      ff.kill('SIGTERM');
      await sleep(3800); // idle 2 秒 + 周期
      assert.equal((await list()).length, 0);
      assert.ok(left.includes('audio:tv'), 'LiveKit からも退出する');
    });

    await t.test('URL 方式: 壊れた URL は自動撤去される', async () => {
      await api('/api/vc/plugin/audio/start', { id: 'broken', world: 'world', x: 0, y: 0, z: 0, source: `http://127.0.0.1:${port}/nonexistent.wav` });
      await sleep(2500);
      assert.equal((await list()).length, 0);
    });
  } finally {
    ffmpegs.forEach((f) => f.kill());
    await room.disconnect().catch(() => {});
    await rtc.dispose(); // ネイティブ層を解放しないとテストプロセスが終了しない
    server.kill('SIGTERM');
    await sleep(300);
  }
});
