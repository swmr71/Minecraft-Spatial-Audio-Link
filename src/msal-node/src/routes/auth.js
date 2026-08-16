const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const router = express.Router();

const loginHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'login.html'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'dashboard.html'), 'utf8');

function render(template, vars) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (vars[key] ?? ''));
}

function errorHtml(message) {
  return message ? `<div class="error">${message}</div>` : '';
}

// 3. ログイン画面
router.get('/login/', (req, res) => {
  res.send(render(loginHtml, { error: errorHtml('') }));
});

router.post('/login/', (req, res) => {
  const { mc_name: mcName, code } = req.body;

  const loginToken = db
    .prepare('SELECT * FROM login_tokens WHERE mc_name = ? AND token = ?')
    .get(mcName, code);

  if (loginToken) {
    req.session.mc_name = loginToken.mc_name;
    req.session.uuid = loginToken.uuid;
    return res.redirect('/dashboard/');
  }

  res.send(render(loginHtml, { error: errorHtml('名前かコードが違うで') }));
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
    livekit_ws_url: process.env.LIVEKIT_WS_URL || 'wss://livekit.clusters-prj.com',
  }));
});

module.exports = router;
