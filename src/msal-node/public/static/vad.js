/* クライアント側 VAD の純粋ロジック（仕様書 §3.3）。ブラウザでは window.MSALVad、Node ではテスト用に module.exports。
 *
 * 接続時に 3 秒間の静寂を測定し、「背景ノイズ + 5dB」をしきい値にする。
 * 以降は音量がしきい値を超えている間（+ホールド時間）だけゲートを開き、閉じている間は送信を止める。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MSALVad = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const CALIBRATION_MS = 3000;
  const MARGIN_DB = 5;
  const FLOOR_DB = -60;   // 無音に近い環境でもこれ未満にはしない（デジタル無音で常時開かない）
  const CEIL_DB = -20;    // うるさい環境でも声が通るよう上限を設ける
  const HOLD_MS = 300;    // 発話の語尾が切れないよう、しきい値を下回ってもしばらく開けておく
  const NOISE_PERCENTILE = 0.9; // 咳・物音などの突発音に引っ張られないよう上位 10% は除外する

  const rmsToDb = (rms) => 20 * Math.log10(Math.max(rms, 1e-8));

  function rmsOf(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / (samples.length || 1));
  }

  /** 静寂測定で集めた dB 値の配列からしきい値(dB)を決める。サンプルが無ければ null。 */
  function calibrate(dbSamples) {
    if (!dbSamples.length) return null;
    const sorted = [...dbSamples].sort((a, b) => a - b);
    const noise = sorted[Math.max(0, Math.ceil(sorted.length * NOISE_PERCENTILE) - 1)];
    return Math.min(CEIL_DB, Math.max(FLOOR_DB, noise + MARGIN_DB));
  }

  /** ヒステリシス付きのゲート。update(db, nowMs) が現在開いているかを返す。 */
  function createGate(thresholdDb, holdMs = HOLD_MS) {
    let openUntil = -Infinity;
    return {
      update(db, nowMs) {
        if (db >= thresholdDb) openUntil = nowMs + holdMs;
        return nowMs <= openUntil;
      },
      get thresholdDb() { return thresholdDb; },
    };
  }

  return { CALIBRATION_MS, MARGIN_DB, FLOOR_DB, CEIL_DB, HOLD_MS, rmsToDb, rmsOf, calibrate, createGate };
}));
