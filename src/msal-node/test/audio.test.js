const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { PcmFeeder } = require('../src/audio/pcmFeeder');
const { createAudioManager, buildFfmpegArgs, validateSourceUrl, AudioError } = require('../src/audio/manager');
const { computeVisible } = require('../src/visibility');

const pcm = (ms) => Buffer.alloc((48000 * 2 * ms) / 1000, 1); // s16le mono 48kHz

test('PcmFeeder: プリバッファが溜まるまで送らず、その後は実時間のペースで 10ms フレームを送る', () => {
  const clock = { t: 0 };
  const frames = [];
  const f = new PcmFeeder({ sink: (x) => frames.push(x), now: () => clock.t, prebufferMs: 200 });

  f.push(pcm(100));
  f.tick();
  assert.equal(frames.length, 0, 'prebuffer 未満');

  f.push(pcm(300));
  f.tick(); // 再生開始 (t0 = 0)
  assert.equal(frames.length, 0);
  clock.t = 50;
  f.tick();
  assert.equal(frames.length, 5);
  assert.equal(frames[0].length, 480);
  clock.t = 1000;
  f.tick();
  assert.equal(frames.length, 40, '溜まっている 400ms 分で打ち止め');
});

test('PcmFeeder: 枯渇したら無音を送らず溜め直し、上限超過で push が false → 排出で通知', () => {
  const clock = { t: 0 };
  const frames = [];
  const f = new PcmFeeder({ sink: (x) => frames.push(x), now: () => clock.t, prebufferMs: 50, maxBufferMs: 100 });

  f.push(pcm(60));
  f.tick();
  clock.t = 1000;
  f.tick();
  assert.equal(frames.length, 6);
  assert.equal(f.state, 'buffering');
  f.tick();
  assert.equal(frames.length, 6, '枯渇中は何も送らない');

  assert.equal(f.push(pcm(120)), false, '100ms 超でバックプレッシャ');
  let drained = 0;
  f.onDrain(() => drained++);
  f.tick(); // buffering -> playing
  clock.t = 1200;
  f.tick();
  assert.equal(drained, 1);
  f.tick();
  assert.equal(drained, 1, '1 回だけ');
});

test('ffmpeg 引数: モノラル 48kHz s16le を stdout へ、ローカルファイル系プロトコルは禁止', () => {
  const args = buildFfmpegArgs({ source: 'https://example.com/a.mp4', loop: true });
  assert.deepEqual(args.slice(args.indexOf('-i')), ['-i', 'https://example.com/a.mp4', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1']);
  assert.ok(args.includes('-stream_loop') && args.includes('-re'));
  const wl = args[args.indexOf('-protocol_whitelist') + 1].split(',');
  assert.ok(!wl.includes('file') && !wl.includes('concat') && wl.includes('https'));
  const live = buildFfmpegArgs({ source: 'rtmp://x/live/k', live: true });
  assert.ok(live.includes('nobuffer') && !live.includes('-re'));
});

test('source URL の検証', () => {
  assert.equal(validateSourceUrl('https://example.com/a.mp3'), 'https://example.com/a.mp3');
  for (const bad of ['file:///etc/passwd', 'concat:a|b', '/etc/passwd', 'ftp://x/y', 'data:audio/wav;base64,AAAA', 'javascript:alert(1)']) {
    assert.throws(() => validateSourceUrl(bad), (e) => e instanceof AudioError && e.status === 400, bad);
  }
});

function makeManager(extra = {}) {
  const published = [];
  const closed = [];
  const procs = [];
  const manager = createAudioManager({
    createPublisher: async ({ id, onClose }) => {
      const p = { id, onClose, frames: [], sink: (f) => p.frames.push(f), close: async () => closed.push(id) };
      published.push(p);
      return p;
    },
    spawnProcess: () => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => { proc.killed = true; };
      procs.push(proc);
      return proc;
    },
    logger: { log() {}, error() {} },
    ...extra,
  });
  return { manager, published, closed, procs };
}
const spot = { world: 'world', x: 10, y: 64, z: -5 };

test('manager: 入力検証・上限・置き換え・更新・停止', async () => {
  const { manager, closed } = makeManager({ maxSources: 2 });
  await assert.rejects(manager.start({ id: 'bad id', ...spot }), { status: 400 });
  await assert.rejects(manager.start({ id: 'a', world: '', x: 0, y: 0, z: 0 }), { status: 400 });
  await assert.rejects(manager.start({ id: 'a', world: 'w', x: 'x', y: 0, z: 0 }), { status: 400 });
  await assert.rejects(manager.start({ id: 'a', ...spot, range: 0 }), { status: 400 });
  await assert.rejects(manager.start({ id: 'a', ...spot, range: 500 }), { status: 400 });
  await assert.rejects(manager.start({ id: 'a', ...spot, volume: 2 }), { status: 400 });

  const a = await manager.start({ id: 'a', ...spot, range: 40 });
  assert.deepEqual([a.mode, a.range, a.volume], ['push', 40, 1]);
  await manager.start({ id: 'b', ...spot });
  await assert.rejects(manager.start({ id: 'c', ...spot }), { status: 429 });

  await manager.start({ id: 'a', ...spot, range: 10 }); // 同じ id は作り直し（上限に数えない）
  assert.deepEqual(closed, ['a']);
  assert.equal(manager.list().find((x) => x.id === 'a').range, 10);

  const u = manager.update('a', { x: 1, y: 2, z: 3, volume: 0.5 });
  assert.deepEqual([u.pos, u.volume, u.world], [[1, 2, 3], 0.5, 'world']);
  assert.throws(() => manager.update('zzz', { volume: 1 }), { status: 404 });

  assert.deepEqual(manager.listForVisibility().find((s) => s.u === 'audio:a'), { u: 'audio:a', n: 'a', p: [1, 2, 3], w: 'world', range: 10, vol: 0.5 });
  assert.equal(await manager.stop('a'), true);
  assert.equal(await manager.stop('a'), false);
  assert.equal(await manager.stopAll(), 1);
});

test('manager: push は最後の接続が勝ち、データは LiveKit へ流れ、切れたまま放置されると撤去される', async () => {
  const clock = { t: 0 };
  const { manager, published } = makeManager({ now: () => clock.t, idleTimeoutSec: 5 });
  await manager.start({ id: 'tv', ...spot });
  assert.throws(() => manager.attachPush('nope', new PassThrough()), { status: 404 });

  const req1 = new PassThrough();
  manager.attachPush('tv', req1);
  assert.equal(manager.list()[0].pushing, true);
  const req2 = new PassThrough();
  manager.attachPush('tv', req2);
  assert.equal(req1.destroyed, true, '古い接続は切られる');

  req2.write(pcm(300));
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(published[0].frames.length > 0, 'フレームが sink へ届く');

  req2.end();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(manager.list()[0].pushing, false);
  clock.t = 6000;
  await new Promise((r) => setTimeout(r, 1100)); // idle タイマーは 1 秒周期
  assert.equal(manager.list().length, 0, 'idle で撤去');
});

test('manager: URL 方式は ffmpeg の出力を流し、終了で撤去（reconnect なら再起動）、LiveKit 切断でも撤去', async () => {
  const { manager, procs, published } = makeManager();
  const info = await manager.start({ id: 'v', source: 'rtmp://example/live/k', ...spot });
  assert.equal(info.mode, 'url');
  assert.equal(manager.list()[0].source, 'rtmp://example/live/k');
  assert.throws(() => manager.attachPush('v', new PassThrough()), { status: 404 }, 'URL 方式に push は不可');

  procs[0].stdout.write(pcm(300));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(published[0].frames.length > 0);
  procs[0].emit('close', 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(manager.list().length, 0);

  await manager.start({ id: 'w', source: 'https://example.com/a.mp3', ...spot });
  published[1].onClose();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(manager.list().length, 0);
});

test('manager: URL 中の認証情報は list に出さない', async () => {
  const { manager } = makeManager();
  await manager.start({ id: 'v', source: 'rtmp://user:secret@example/live/k', ...spot });
  assert.ok(!JSON.stringify(manager.list()).includes('secret'));
});

test('visibility: 音源は同一ワールドの range 以内だけ聞こえる（座標を持つ k:src）', () => {
  const me = { u: 'me', n: 'me', p: [0, 64, 0], y: 0, w: 'world', c: 0 };
  const sources = [
    { u: 'audio:near', n: 'near', p: [20, 64, 0], w: 'world', range: 32, vol: 0.8 },
    { u: 'audio:far', n: 'far', p: [40, 64, 0], w: 'world', range: 32, vol: 1 },
    { u: 'audio:nether', n: 'nether', p: [1, 64, 0], w: 'world_nether', range: 32, vol: 1 },
  ];
  const result = computeVisible(me, [me], { sources });
  assert.deepEqual(result.map((p) => `${p.u}:${p.k}`), ['me:self', 'audio:near:src']);
  const near = result[1];
  assert.deepEqual([near.dist, near.range, near.vol, near.p], [20, 32, 0.8, [20, 64, 0]]);
  // ゲーム外の Super Admin（w なし）には聞こえない
  assert.equal(computeVisible({ ...me, w: null, virtual: true }, [], { sources }).length, 1);
});
