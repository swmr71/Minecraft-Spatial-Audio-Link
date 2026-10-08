/**
 * 「誰の声を聞くか」の判定ロジック（仕様書 §2 / 要件定義 §3, §5）。純粋関数のみ。
 *
 * 優先順位: ラジオ > 近接。
 *  - 近接   : 同一ワールド かつ d <= SUBSCRIBE_DISTANCE（100m）で購読。実際に聞こえるのは 50m 以内（クライアント側で減衰）。
 *  - ラジオ : 同一チャンネル（c != 0）。別ワールドは d = 2000m 固定。500m 超でノイズ混入。
 */
const PROXIMITY_AUDIBLE = 50;
const SUBSCRIBE_DISTANCE = 100;
const RADIO_MAX_DISTANCE = 2000;
const RADIO_NOISE_START = 500;

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** ラジオノイズ利得 G_noise（要件定義 §5.2）。0..1 */
function radioNoiseGain(d) {
  if (d < RADIO_NOISE_START) return 0;
  if (d > RADIO_MAX_DISTANCE) return 1;
  return (d - RADIO_NOISE_START) / (RADIO_MAX_DISTANCE - RADIO_NOISE_START);
}

function isValidPlayer(p) {
  return p && typeof p.u === 'string' && Array.isArray(p.p) && p.p.length === 3 && p.p.every(Number.isFinite);
}

/**
 * @param {object} me      自分のプレイヤーデータ
 * @param {object[]} all   全プレイヤー（自分を含んでよい）
 * @returns {object[]} 自分 + 聞くべき相手。k: self|prox|radio, dist: 距離, ng: ノイズ利得(radioのみ)
 */
function computeVisible(me, all) {
  const result = [{ ...me, k: 'self', dist: 0 }];

  for (const other of all) {
    if (other.u === me.u || !isValidPlayer(other)) continue;

    const sameWorld = (me.w ?? null) === (other.w ?? null);
    const d = sameWorld ? distance(me.p, other.p) : RADIO_MAX_DISTANCE;
    const sameChannel = me.c > 0 && me.c === other.c;

    if (sameChannel) {
      result.push({ ...other, k: 'radio', dist: d, ng: radioNoiseGain(d) });
    } else if (sameWorld && d <= SUBSCRIBE_DISTANCE) {
      result.push({ ...other, k: 'prox', dist: d });
    }
  }
  return result;
}

module.exports = {
  PROXIMITY_AUDIBLE,
  SUBSCRIBE_DISTANCE,
  RADIO_MAX_DISTANCE,
  RADIO_NOISE_START,
  distance,
  radioNoiseGain,
  isValidPlayer,
  computeVisible,
};
