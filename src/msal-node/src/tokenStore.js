const crypto = require('crypto');

/**
 * ワンタイムのログインコード。
 * - 暗号論的乱数で 6 桁を発行
 * - 有効期限あり・使用後は即削除（1 回限り）
 * - 同一 UUID の古いコードは再発行時に破棄
 */
function createTokenStore(db, { ttlSec, now = () => Date.now() }) {
  const ttlMs = ttlSec * 1000;

  const del = db.prepare('DELETE FROM login_tokens WHERE uuid = ?');
  const ins = db.prepare('INSERT INTO login_tokens (uuid, mc_name, token, created_at) VALUES (?, ?, ?, ?)');
  const byName = db.prepare('SELECT id, uuid, mc_name, token, created_at FROM login_tokens WHERE mc_name = ? COLLATE NOCASE');
  const delById = db.prepare('DELETE FROM login_tokens WHERE id = ?');
  const delByName = db.prepare('DELETE FROM login_tokens WHERE mc_name = ? COLLATE NOCASE');
  const delExpired = db.prepare('DELETE FROM login_tokens WHERE created_at < ?');

  function safeEqual(a, b) {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  }

  return {
    issue(uuid, mcName) {
      const token = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      del.run(uuid);
      ins.run(uuid, mcName, token, now());
      return token;
    },

    /** 成功時は { uuid, mcName } を返してコードを破棄。失敗時は null。 */
    consume(mcName, code) {
      let match = null;
      for (const row of byName.all(mcName)) {
        if (now() - row.created_at > ttlMs) {
          delById.run(row.id);
          continue;
        }
        if (safeEqual(row.token, code)) match = row;
      }
      if (!match) return null;
      delById.run(match.id);
      return { uuid: match.uuid, mcName: match.mc_name };
    },

    invalidateName(mcName) {
      delByName.run(mcName);
    },

    sweep() {
      delExpired.run(now() - ttlMs);
    },
  };
}

module.exports = { createTokenStore };
