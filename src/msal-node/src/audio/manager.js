const { spawn } = require('node:child_process');
const { PcmFeeder } = require('./pcmFeeder');

const URL_SCHEMES = new Set(['http:', 'https:', 'rtmp:', 'rtmps:', 'rtsp:', 'srt:']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RANGE = 128;
const RECONNECT_DELAY_MS = 2000;

class AudioError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** URL 方式で使う ffmpeg 引数（mono / 48kHz / s16le を stdout へ）。 */
function buildFfmpegArgs({ source, loop = false, live = false }) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin',
    // file: や concat: 経由のローカルファイル読み出しを許さない
    '-protocol_whitelist', 'http,https,tcp,tls,crypto,rtmp,rtsp,rtp,udp,srt'];
  if (live) args.push('-fflags', 'nobuffer', '-flags', 'low_delay');
  else {
    if (loop) args.push('-stream_loop', '-1');
    args.push('-re');
  }
  args.push('-i', source, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1');
  return args;
}

function validateSourceUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new AudioError(400, 'source must be a valid URL'); }
  if (!URL_SCHEMES.has(u.protocol)) throw new AudioError(400, 'source scheme must be http/https/rtmp/rtmps/rtsp/srt');
  return u.toString();
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function normalizeOptions(o, { partial = false } = {}) {
  const out = {};
  if (!partial || o.world !== undefined) {
    if (typeof o.world !== 'string' || !o.world || o.world.length > 64) throw new AudioError(400, 'world is required');
    out.world = o.world;
  }
  if (!partial || o.x !== undefined || o.y !== undefined || o.z !== undefined) {
    if (![o.x, o.y, o.z].every(finite)) throw new AudioError(400, 'x, y, z must be numbers');
    out.pos = [o.x, o.y, o.z];
  }
  if (o.range !== undefined) {
    if (!finite(o.range) || o.range < 1 || o.range > MAX_RANGE) throw new AudioError(400, `range must be 1..${MAX_RANGE}`);
    out.range = o.range;
  }
  if (o.volume !== undefined) {
    if (!finite(o.volume) || o.volume < 0 || o.volume > 1) throw new AudioError(400, 'volume must be 0..1');
    out.volume = o.volume;
  }
  return out;
}

/**
 * 音源（座標付きの仮想スピーカー）の管理。
 * 依存（LiveKit への publish / ffmpeg 起動）は注入できるのでテストでは差し替える。
 */
function createAudioManager({
  createPublisher, maxSources = 8, idleTimeoutSec = 30, ffmpegPath = 'ffmpeg',
  spawnProcess = spawn, now = () => performance.now(), logger = console,
}) {
  const sessions = new Map();

  function touch(s) {
    s.lastActivity = now();
  }

  async function teardown(s, reason) {
    if (s.closed) return;
    s.closed = true;
    sessions.delete(s.id);
    clearInterval(s.idleTimer);
    clearTimeout(s.reconnectTimer);
    s.feeder?.stop();
    s.activePush?.destroy();
    s.proc?.kill('SIGKILL');
    await s.publisher?.close().catch(() => {});
    logger.log(`[audio] stopped ${s.id} (${reason})`);
  }

  function startFfmpeg(s) {
    const proc = spawnProcess(ffmpegPath, buildFfmpegArgs({ source: s.source, loop: s.loop, live: s.live }), { stdio: ['ignore', 'pipe', 'pipe'] });
    s.proc = proc;
    proc.stderr.on('data', (d) => logger.log(`[ffmpeg:${s.id}] ${String(d).trim()}`));
    proc.stdout.on('data', (chunk) => {
      touch(s);
      if (!s.feeder.push(chunk)) {
        proc.stdout.pause();
        s.feeder.onDrain(() => proc.stdout.resume());
      }
    });
    proc.on('error', (e) => {
      logger.error(`[audio] ffmpeg failed to start for ${s.id}: ${e.message}`);
      teardown(s, 'ffmpeg error');
    });
    proc.on('close', () => {
      if (s.closed || s.proc !== proc) return;
      if (s.reconnect) s.reconnectTimer = setTimeout(() => !s.closed && startFfmpeg(s), RECONNECT_DELAY_MS);
      else teardown(s, 'source ended');
    });
  }

  const info = (s) => ({
    id: s.id, mode: s.source ? 'url' : 'push', world: s.world, pos: s.pos, range: s.range, volume: s.volume,
    source: s.source ? s.source.replace(/\/\/[^/@]*@/, '//***@') : null, // URL 中の認証情報は返さない
    pushing: Boolean(s.activePush),
  });

  return {
    AudioError,

    async start(opts) {
      if (!ID_RE.test(opts.id ?? '')) throw new AudioError(400, 'id must match [A-Za-z0-9_-]{1,64}');
      const base = normalizeOptions(opts);
      const source = opts.source !== undefined ? validateSourceUrl(opts.source) : null;
      if (!sessions.has(opts.id) && sessions.size >= maxSources) throw new AudioError(429, `too many audio sources (max ${maxSources})`);

      // 同じ id は作り直す（再生し直し）
      const old = sessions.get(opts.id);
      if (old) await teardown(old, 'replaced');

      const s = {
        id: opts.id, world: base.world, pos: base.pos, range: base.range ?? 32, volume: base.volume ?? 1,
        source, loop: Boolean(opts.loop), live: Boolean(opts.live), reconnect: Boolean(opts.reconnect),
        closed: false, activePush: null, proc: null, lastActivity: now(),
      };
      sessions.set(s.id, s); // 先に登録して同時 start の上限超過を防ぐ
      try {
        s.publisher = await createPublisher({ id: s.id, onClose: () => teardown(s, 'livekit disconnected') });
      } catch (e) {
        sessions.delete(s.id);
        logger.error(`[audio] publisher failed for ${s.id}:`, e.message);
        throw new AudioError(502, 'failed to join LiveKit');
      }
      if (s.closed) { // 接続待ちの間に stop された
        await s.publisher.close().catch(() => {});
        throw new AudioError(409, 'audio source was stopped while starting');
      }
      s.feeder = new PcmFeeder({ sink: (f) => s.publisher.sink(f) });
      s.feeder.start();

      if (source) startFfmpeg(s);
      else {
        // push 方式: データが途切れたまま放置された音源は自動撤去
        s.idleTimer = setInterval(() => {
          if (!s.activePush && now() - s.lastActivity > idleTimeoutSec * 1000) teardown(s, 'idle');
        }, 1000);
        s.idleTimer.unref?.();
      }
      return info(s);
    },

    /** push 方式: Readable（HTTP リクエスト）から PCM を受け取る。終了時に done が呼ばれる。 */
    attachPush(id, req, done) {
      const s = sessions.get(id);
      if (!s || s.source) throw new AudioError(404, 'push audio source not found');
      s.activePush?.destroy(); // 最後の接続が勝つ（MCVideo の再起動など）
      s.activePush = req;
      touch(s);

      req.on('data', (chunk) => {
        touch(s);
        if (!s.feeder.push(chunk)) {
          req.pause();
          s.feeder.onDrain(() => req.resume());
        }
      });
      const finish = () => {
        if (s.activePush === req) s.activePush = null;
        touch(s);
        done?.();
      };
      req.on('end', finish);
      req.on('close', finish);
      req.on('error', finish);
    },

    update(id, opts) {
      const s = sessions.get(id);
      if (!s) throw new AudioError(404, 'audio source not found');
      const n = normalizeOptions(opts, { partial: true });
      if (n.world !== undefined) s.world = n.world;
      if (n.pos !== undefined) s.pos = n.pos;
      if (n.range !== undefined) s.range = n.range;
      if (n.volume !== undefined) s.volume = n.volume;
      return info(s);
    },

    async stop(id) {
      const s = sessions.get(id);
      if (!s) return false;
      await teardown(s, 'stopped');
      return true;
    },

    async stopAll() {
      const all = [...sessions.values()];
      await Promise.all(all.map((s) => teardown(s, 'shutdown')));
      return all.length;
    },

    get: (id) => sessions.get(id),
    list: () => [...sessions.values()].map(info),

    /** 可視判定（visibility.computeVisible の ctx.sources）用。 */
    listForVisibility: () => [...sessions.values()].map((s) => ({
      u: `audio:${s.id}`, n: s.id, p: s.pos, w: s.world, range: s.range, vol: s.volume,
    })),
  };
}

module.exports = { createAudioManager, buildFfmpegArgs, validateSourceUrl, AudioError, MAX_RANGE };
