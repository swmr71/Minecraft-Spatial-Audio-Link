const test = require('node:test');
const assert = require('node:assert/strict');
const vad = require('../public/static/vad.js');

test('rmsToDb: 満振幅は 0dB、1/10 は -20dB、無音は下限でクランプ', () => {
  assert.equal(vad.rmsToDb(1), 0);
  assert.ok(Math.abs(vad.rmsToDb(0.1) + 20) < 1e-9);
  assert.equal(vad.rmsToDb(0), -160);
});

test('rmsOf: 正弦波の RMS は振幅/√2', () => {
  const n = 4800;
  const sine = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 100 * i) / 48000));
  assert.ok(Math.abs(vad.rmsOf(sine) - 0.5 / Math.SQRT2) < 1e-3);
});

test('calibrate: 背景ノイズ + 5dB（突発音の上位 10% は無視）', () => {
  const quiet = Array(90).fill(-50);
  const spikes = Array(10).fill(-20); // 咳など
  assert.equal(vad.calibrate([...quiet, ...spikes]), -45);
});

test('calibrate: 下限・上限・サンプル無し', () => {
  assert.equal(vad.calibrate(Array(50).fill(-100)), vad.FLOOR_DB); // 極端な静寂でも -60dB より下げない
  assert.equal(vad.calibrate(Array(50).fill(-10)), vad.CEIL_DB);   // 極端に騒がしくても -20dB を超えない
  assert.equal(vad.calibrate([]), null);
});

test('gate: しきい値超えで開き、ホールド時間が過ぎると閉じる', () => {
  const gate = vad.createGate(-45, 300);
  assert.equal(gate.update(-60, 0), false);
  assert.equal(gate.update(-30, 20), true);
  assert.equal(gate.update(-60, 200), true, 'ホールド中は開いたまま');
  assert.equal(gate.update(-60, 320), true);
  assert.equal(gate.update(-60, 321), false);
  assert.equal(gate.update(-44, 400), true, '再び超えれば開く');
});
