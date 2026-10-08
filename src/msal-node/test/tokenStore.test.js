const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createTokenStore } = require('../src/tokenStore');
const { createFailureLimiter } = require('../src/rateLimiter');
const { isMcName, isUuid, isLoginCode, escapeHtml } = require('../src/validation');

function makeStore(opts = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE login_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL, mc_name TEXT NOT NULL,
    token TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  const clock = { t: 1_000_000 };
  const store = createTokenStore(db, { ttlSec: 300, now: () => clock.t, ...opts });
  return { store, clock };
}

const UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';

test('コードは 6 桁数字で、1 回使うと無効になる（ワンタイム）', () => {
  const { store } = makeStore();
  const code = store.issue(UUID, 'Notch');
  assert.match(code, /^\d{6}$/);
  assert.deepEqual(store.consume('Notch', code), { uuid: UUID, mcName: 'Notch' });
  assert.equal(store.consume('Notch', code), null);
});

test('MCID は大文字小文字を区別しない', () => {
  const { store } = makeStore();
  const code = store.issue(UUID, 'Notch');
  assert.ok(store.consume('nOtCh', code));
});

test('有効期限を過ぎたコードは使えない', () => {
  const { store, clock } = makeStore();
  const code = store.issue(UUID, 'Notch');
  clock.t += 301_000;
  assert.equal(store.consume('Notch', code), null);
});

test('再発行すると古いコードは無効になる', () => {
  const { store } = makeStore();
  let first = store.issue(UUID, 'Notch');
  let second = store.issue(UUID, 'Notch');
  while (second === first) second = store.issue(UUID, 'Notch'); // 1/1,000,000 の衝突回避
  assert.equal(store.consume('Notch', first), null);
  assert.ok(store.consume('Notch', second));
});

test('間違ったコード・別人のコードは拒否', () => {
  const { store } = makeStore();
  const code = store.issue(UUID, 'Notch');
  const wrong = code === '000000' ? '000001' : '000000';
  assert.equal(store.consume('Notch', wrong), null);
  assert.equal(store.consume('Jeb_', code), null);
});

test('失敗カウンタ: 上限でブロックし、ウィンドウ経過で解除', () => {
  const clock = { t: 0 };
  const limiter = createFailureLimiter({ max: 3, windowMs: 1000, now: () => clock.t });
  assert.equal(limiter.fail('k'), false);
  assert.equal(limiter.fail('k'), false);
  assert.equal(limiter.fail('k'), true);
  assert.equal(limiter.isBlocked('k'), true);
  clock.t += 1001;
  assert.equal(limiter.isBlocked('k'), false);
  limiter.fail('k');
  limiter.reset('k');
  assert.equal(limiter.isBlocked('k'), false);
});

test('入力バリデーション', () => {
  assert.ok(isMcName('Steve_01'));
  assert.ok(isMcName('.BedrockUser'));
  assert.ok(!isMcName('<script>'));
  assert.ok(!isMcName(''));
  assert.ok(!isMcName('a'.repeat(21)));
  assert.ok(!isMcName(['a']));
  assert.ok(isUuid(UUID));
  assert.ok(!isUuid('not-a-uuid'));
  assert.ok(isLoginCode('012345'));
  assert.ok(!isLoginCode('12345'));
  assert.ok(!isLoginCode('abcdef'));
  assert.equal(escapeHtml('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
});
