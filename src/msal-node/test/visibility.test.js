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

test('放送: 全員に global として届く（ゲーム内にいなくても・距離無関係・ワールド無関係）', () => {
  const me = player('me', [0, 64, 0], 'world');
  const far = player('far', [5000, 64, 0], 'world_the_end', 9);
  const ctx = { broadcasters: [{ u: 'far', n: 'Far', msg: 'hi' }, { u: 'ghost', n: 'Ghost' }] };
  const result = Object.fromEntries(computeVisible(me, [me, far], ctx).map((p) => [p.u, p]));
  assert.equal(result.far.k, 'global');
  assert.equal(result.far.msg, 'hi');
  assert.equal(result.ghost.k, 'global');
  assert.equal(result.ghost.p, undefined);
});

test('放送者本人には自分自身が self のまま（global で二重登録しない）', () => {
  const me = player('me', [0, 64, 0]);
  const result = computeVisible(me, [me], { broadcasters: [{ u: 'me', n: 'me' }] });
  assert.deepEqual(result.map((p) => `${p.u}:${p.k}`), ['me:self']);
});

test('ミュート中のチャンネルの発話者はラジオでは聞こえない（近ければ近接で聞こえる）', () => {
  const me = player('me', [0, 64, 0], 'world', 4);
  const near = player('near', [10, 64, 0], 'world', 4);
  const far = player('far', [900, 64, 0], 'world', 4);
  const ctx = { mutedChannels: new Set([4]) };
  const result = Object.fromEntries(computeVisible(me, [me, near, far], ctx).map((p) => [p.u, p.k]));
  assert.deepEqual(result, { me: 'self', near: 'prox' });
});

test('傍受: all は全チャンネルの発話者、数値は指定チャンネルのみ。ノイズなし・ミュート無視', () => {
  const me = player('me', [0, 64, 0], 'world', 0);
  const a = player('a', [1500, 64, 0], 'world', 2);
  const b = player('b', [1500, 64, 0], 'world', 3);
  const idle = player('idle', [1500, 64, 0], 'world', 0);
  const muted = new Set([2]);

  const all = computeVisible(me, [me, a, b, idle], { eavesdrop: 'all', mutedChannels: muted });
  assert.deepEqual(all.map((p) => p.u).sort(), ['a', 'b', 'me']);
  assert.ok(all.filter((p) => p.k === 'radio').every((p) => p.ng === 0));

  const only3 = computeVisible(me, [me, a, b, idle], { eavesdrop: 3 });
  assert.deepEqual(only3.map((p) => p.u).sort(), ['b', 'me']);
});
