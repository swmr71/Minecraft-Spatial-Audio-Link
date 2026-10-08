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
 * @param {object} [ctx]
 * @param {{u:string,n:string,msg?:string}[]} [ctx.broadcasters] 放送中のユーザー（全員に聞こえる。ゲーム内にいなくてもよい）
 * @param {Set<number>} [ctx.mutedChannels] ミュート中のラジオチャンネル（そのチャンネルの発話者はラジオでは聞こえない）
 * @param {null|'all'|number} [ctx.eavesdrop] 傍受（Super Admin のみ）。全チャンネル or 指定チャンネルの発話者を聞く
 * @param {{u:string,n:string,p:number[],w:string,range:number,vol:number}[]} [ctx.sources] 音源（座標付きスピーカー。動画の音など）。range 以内で聞こえる
 * @returns {object[]} 自分 + 聞くべき相手。k: self|global|prox|radio|src, dist: 距離, ng: ノイズ利得(radioのみ)
 */
function computeVisible(me, all, ctx = {}) {
  const { broadcasters = [], mutedChannels = new Set(), eavesdrop = null, sources = [] } = ctx;
  const result = [{ ...me, k: 'self', dist: 0 }];
  const seen = new Set([me.u]);

  // 放送は最優先（要件定義 §3.2 / 仕様書 §2.1）。位置情報は持たない（定位・減衰なし）
  const byUuid = new Map(all.map((p) => [p.u, p]));
  for (const b of broadcasters) {
    if (seen.has(b.u)) continue;
    seen.add(b.u);
    const known = byUuid.get(b.u);
    result.push({ u: b.u, n: known?.n ?? b.n, k: 'global', dist: 0, msg: b.msg });
  }

  for (const other of all) {
    if (seen.has(other.u) || !isValidPlayer(other)) continue;

    const sameWorld = (me.w ?? null) === (other.w ?? null);
    const d = sameWorld ? distance(me.p, other.p) : RADIO_MAX_DISTANCE;
    const sameChannel = me.c > 0 && me.c === other.c && !mutedChannels.has(other.c);

    let entry = null;
    if (sameChannel) {
      entry = { ...other, k: 'radio', dist: d, ng: radioNoiseGain(d) };
    } else if (sameWorld && d <= SUBSCRIBE_DISTANCE) {
      entry = { ...other, k: 'prox', dist: d };
    } else if (eavesdrop && other.c > 0 && (eavesdrop === 'all' || eavesdrop === other.c)) {
      // 傍受は明瞭に聞く（ノイズなし）
      entry = { ...other, k: 'radio', dist: d, ng: 0 };
    }

    if (entry) {
      seen.add(other.u);
      result.push(entry);
    }
  }

  // 音源: 同一ワールドで range 以内のものだけ（購読 = 可聴距離）。ワールド越境はしない
  for (const src of sources) {
    if (!me.w || me.w !== src.w) continue;
    const d = distance(me.p, src.p);
    if (d <= src.range) {
      result.push({ u: src.u, n: src.n, p: src.p, w: src.w, k: 'src', dist: d, range: src.range, vol: src.vol });
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
