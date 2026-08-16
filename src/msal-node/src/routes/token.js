const express = require('express');
const db = require('../db');

const router = express.Router();

// 1. トークン生成（プラグイン用）
router.post('/token/generate/', (req, res) => {
  const { uuid, mc_name: mcName } = req.body;

  if (!uuid || !mcName) {
    return res.status(400).json({ error: 'UUID and MCID are required' });
  }

  const tokenCode = String(Math.floor(100000 + Math.random() * 900000));

  db.prepare('DELETE FROM login_tokens WHERE uuid = ?').run(uuid);
  db.prepare(
    'INSERT INTO login_tokens (uuid, mc_name, token) VALUES (?, ?, ?)'
  ).run(uuid, mcName, tokenCode);

  return res.json({ token: tokenCode });
});

module.exports = router;
