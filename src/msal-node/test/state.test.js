const test = require('node:test');
const assert = require('node:assert/strict');
const { createState } = require('../src/state');

test('放送: 開始・停止・最大継続時間で自動終了し、変化のたびに version が進む', () => {
  const clock = { t: 0 };
  const s = createState({ broadcastMaxMs: 1000, now: () => clock.t });
  const v0 = s.getVersion();

  s.startBroadcast('a', 'Alice', 'hello');
  s.startBroadcast('b', 'Bob');
  assert.deepEqual(s.activeBroadcasts().map((b) => b.u).sort(), ['a', 'b']);
  assert.ok(s.getVersion() > v0);

  assert.equal(s.stopBroadcast('a'), true);
  assert.equal(s.stopBroadcast('a'), false);

  clock.t += 1001;
  assert.deepEqual(s.activeBroadcasts(), []);
});

test('メッセージは 200 文字に切り詰める', () => {
  const s = createState();
  s.startBroadcast('a', 'A', 'x'.repeat(500));
  assert.equal(s.activeBroadcasts()[0].msg.length, 200);
});

test('ミュートとダッキングは変更時のみ version を進めて永続化する', async () => {
  const saved = [];
  const store = { load: async () => ({ duck: 55, muted: [3, 'x', -1] }), save: async (d) => saved.push(d) };
  const s = createState({ store });
  await s.load();
  assert.equal(s.getDuck(), 55);
  assert.deepEqual([...s.mutedChannels()], [3]);

  const v = s.getVersion();
  s.setMuted(3, true); // 既にミュート済み: 変化なし
  assert.equal(s.getVersion(), v);
  assert.equal(saved.length, 0);

  s.setMuted(4, true);
  s.setDuck(10);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.at(-1), { duck: 10, muted: [3, 4] });
});
