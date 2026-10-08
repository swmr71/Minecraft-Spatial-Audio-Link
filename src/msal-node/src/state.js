/**
 * 放送・ミュート・ダッキング設定の共有状態（単一プロセス前提）。
 * - 放送はメモリのみ（短命。最大継続時間で自動終了）
 * - ミュート中チャンネルとダッキング量は store に永続化して再起動で失わない
 */
function createState({ duckPercent = 30, broadcastMaxMs = 300_000, now = Date.now, store = null } = {}) {
  const broadcasts = new Map(); // uuid -> { u, n, msg, until }
  const muted = new Set();
  let duck = duckPercent;
  let version = 1; // 変化検知用。WS はこれが変わったときだけ bc メッセージを送る

  const persist = () => {
    if (store) Promise.resolve(store.save({ duck, muted: [...muted] })).catch((e) => console.error('[state] persist failed:', e));
  };

  function prune() {
    const t = now();
    for (const [uuid, b] of broadcasts) {
      if (b.until <= t) {
        broadcasts.delete(uuid);
        version++;
      }
    }
  }

  return {
    async load() {
      if (!store) return;
      const saved = await store.load();
      if (!saved) return;
      if (Number.isInteger(saved.duck) && saved.duck >= 0 && saved.duck <= 100) duck = saved.duck;
      for (const c of saved.muted || []) if (Number.isInteger(c) && c > 0) muted.add(c);
      version++;
    },

    startBroadcast(uuid, name, message = '') {
      broadcasts.set(uuid, { u: uuid, n: name, msg: String(message).slice(0, 200), until: now() + broadcastMaxMs });
      version++;
    },

    stopBroadcast(uuid) {
      const removed = broadcasts.delete(uuid);
      if (removed) version++;
      return removed;
    },

    stopAllBroadcasts() {
      const n = broadcasts.size;
      broadcasts.clear();
      if (n) version++;
      return n;
    },

    activeBroadcasts() {
      prune();
      return [...broadcasts.values()].map(({ u, n, msg }) => ({ u, n, msg }));
    },

    setMuted(channel, isMuted) {
      const had = muted.has(channel);
      if (isMuted) muted.add(channel);
      else muted.delete(channel);
      if (had !== isMuted) {
        version++;
        persist();
      }
    },

    mutedChannels() {
      return new Set(muted);
    },

    setDuck(percent) {
      duck = percent;
      version++;
      persist();
    },

    getDuck() {
      return duck;
    },

    getVersion() {
      prune();
      return version;
    },
  };
}

/** Redis に JSON で保存する store。 */
function createRedisStore(redis, key = 'vchat:settings') {
  return {
    async load() {
      const raw = await redis.get(key);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    save: (data) => redis.set(key, JSON.stringify(data)),
  };
}

module.exports = { createState, createRedisStore };
