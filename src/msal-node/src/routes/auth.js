const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { tokenStore, loginLimiter } = require('../services');
const { isMcName, isLoginCode, escapeHtml } = require('../validation');

const router = express.Router();

const publicDir = path.join(__dirname, '..', '..', 'public');
const loginHtml = fs.readFileSync(path.join(publicDir, 'login.html'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(publicDir, 'dashboard.html'), 'utf8');

// {{key}} はすべて HTML エスケープして埋め込む（JS へは data 属性経由で渡す）
function render(template, vars) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => escapeHtml(vars[key] ?? ''));
}

function loginPage(res, { status = 200, error = '', mcName = '' } = {}) {
  const errorHtml = error ? `<div class="error">${escapeHtml(error)}</div>` : '';
  res.status(status).send(
    // error は組み立て済みHTML（上でエスケープ済み）なので専用置換する
    render(loginHtml, { mc_name: mcName }).replace('<!--ERROR-->', errorHtml)
  );
}

// 3. ログイン画面
router.get('/login/', (req, res) => {
  const prefill = isMcName(req.query.mc_name) ? req.query.mc_name : '';
  loginPage(res, { mcName: prefill });
});

router.post('/login/', (req, res) => {
  const mcName = req.body?.mc_name;
  const code = req.body?.code;
  const ipKey = `ip:${req.ip}`;

  if (loginLimiter.isBlocked(ipKey)) {
    return loginPage(res, { status: 429, error: '試行回数が多すぎます。しばらくしてからやり直してください。' });
  }
  if (!isMcName(mcName) || !isLoginCode(code)) {
    loginLimiter.fail(ipKey);
    return loginPage(res, { status: 400, error: 'Minecraft ID と 6 桁のコードを入力してください。' });
  }

  const nameKey = `name:${mcName.toLowerCase()}`;
  if (loginLimiter.isBlocked(nameKey)) {
    return loginPage(res, { status: 429, mcName, error: '試行回数が多すぎます。ゲーム内で /vc join からコードを再発行してください。' });
  }

  const user = tokenStore.consume(mcName, code);
  if (!user) {
    loginLimiter.fail(ipKey);
    // 同一 MCID への連続失敗でコードを失効させ、総当たりを成立させない
    if (loginLimiter.fail(nameKey)) tokenStore.invalidateName(mcName);
    return loginPage(res, { status: 401, mcName, error: '名前かコードが違うか、コードの有効期限が切れています。' });
  }

  loginLimiter.reset(nameKey);
  // セッション固定化対策: ログイン成功時に ID を振り直す
  req.session.regenerate((err) => {
    if (err) {
      console.error('[auth] session regenerate failed:', err);
      return loginPage(res, { status: 500, error: 'ログインに失敗しました。もう一度お試しください。' });
    }
    req.session.mc_name = user.mcName;
    req.session.uuid = user.uuid;
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('[auth] session save failed:', saveErr);
        return loginPage(res, { status: 500, error: 'ログインに失敗しました。もう一度お試しください。' });
      }
      res.redirect('/dashboard/');
    });
  });
});

// 4. ダッシュボード
router.get('/dashboard/', (req, res) => {
  const { mc_name: mcName, uuid } = req.session;

  if (!mcName || !uuid) {
    return res.redirect('/login/');
  }

  res.send(render(dashboardHtml, {
    mc_name: mcName,
    uuid,
    livekit_ws_url: config.livekit.wsUrl,
  }));
});

router.post('/logout/', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login/');
  });
});

module.exports = router;
