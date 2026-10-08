/**
 * 超軽量なインメモリのスライディングウィンドウ式失敗カウンタ。
 * 単一プロセス前提（msal-node は 1 プロセス運用）。
 */
function createFailureLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map(); // key -> number[] (timestamp)

  function prune(key) {
    const cutoff = now() - windowMs;
    const list = (hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  return {
    isBlocked(key) {
      return prune(key).length >= max;
    },
    fail(key) {
      const list = prune(key);
      list.push(now());
      hits.set(key, list);
      return list.length >= max;
    },
    reset(key) {
      hits.delete(key);
    },
    sweep() {
      for (const key of [...hits.keys()]) prune(key);
    },
  };
}

module.exports = { createFailureLimiter };
