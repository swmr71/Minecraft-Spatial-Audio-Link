const test = require('node:test');
const assert = require('node:assert/strict');
const { computeVisible, radioNoiseGain } = require('../src/visibility');

const player = (u, p, w = 'world', c = 0) => ({ u, n: u, p, y: 0, w, c });

test('radioNoiseGain: 500m 未満は 0、2000m 以上は 1、中間は線形（要件定義 §5.2）', () => {
  assert.equal(radioNoiseGain(0), 0);
  assert.equal(radioNoiseGain(499.9), 0);
  assert.equal(radioNoiseGain(500), 0);
  assert.equal(radioNoiseGain(1250), 0.5);
  assert.equal(radioNoiseGain(2000), 1);
  assert.equal(radioNoiseGain(5000), 1);
});

test('近接: 同一ワールドで 100m 以内のみ購読対象', () => {
  const me = player('me', [0, 64, 0]);
  const all = [
    me,
    player('near', [30, 64, 0]),
    player('edge', [100, 64, 0]),
    player('far', [100.5, 64, 0]),
  ];
  const kinds = Object.fromEntries(computeVisible(me, all).map((p) => [p.u, p.k]));
  assert.deepEqual(kinds, { me: 'self', near: 'prox', edge: 'prox' });
});

test('近接: 別ワールドは座標が近くても対象外', () => {
  const me = player('me', [0, 64, 0], 'world');
  const nether = player('nether', [1, 64, 1], 'world_nether');
  assert.deepEqual(computeVisible(me, [me, nether]).map((p) => p.u), ['me']);
});

test('ラジオ: 同一チャンネルは距離無関係に購読、別ワールドは 2000m 固定でノイズ最大', () => {
  const me = player('me', [0, 64, 0], 'world', 5);
  const far = player('far', [1250, 64, 0], 'world', 5);
  const cross = player('cross', [0, 64, 0], 'world_nether', 5);
  const other = player('other', [10, 64, 0], 'world', 6);

  const result = Object.fromEntries(computeVisible(me, [me, far, cross, other]).map((p) => [p.u, p]));
  assert.equal(result.far.k, 'radio');
  assert.equal(result.far.ng, 0.5);
  assert.equal(result.cross.k, 'radio');
  assert.equal(result.cross.dist, 2000);
  assert.equal(result.cross.ng, 1);
  assert.equal(result.other.k, 'prox'); // チャンネル違いでも近ければ近接として聞こえる
});

test('ラジオが近接より優先される', () => {
  const me = player('me', [0, 64, 0], 'world', 3);
  const buddy = player('buddy', [5, 64, 0], 'world', 3);
  assert.equal(computeVisible(me, [me, buddy])[1].k, 'radio');
});

test('チャンネル 0（OFF）同士はラジオ扱いにならない', () => {
  const me = player('me', [0, 64, 0], 'world', 0);
  const other = player('other', [500, 64, 0], 'world', 0);
  assert.deepEqual(computeVisible(me, [me, other]).map((p) => p.u), ['me']);
});

test('壊れたプレイヤーデータは無視する', () => {
  const me = player('me', [0, 64, 0]);
  const broken = { u: 'x', p: [0, 'a', 0], w: 'world' };
  assert.deepEqual(computeVisible(me, [me, broken]).map((p) => p.u), ['me']);
});
