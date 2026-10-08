const redisClient = require('./redisClient');
const { isValidPlayer } = require('./visibility');

const PLAYER_KEY_PATTERN = 'vchat:player:*';

/** SCAN + MGET で全プレイヤー状態を取得する（KEYS はブロッキングなので使わない）。 */
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
      console.error('[players] invalid player JSON:', e.message);
    }
  }
  return players;
}

module.exports = { loadAllPlayers };
