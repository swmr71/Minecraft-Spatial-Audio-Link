const express = require('express');
const pluginAuth = require('../middleware/pluginAuth');
const { tokenStore } = require('../services');
const { isMcName, isUuid } = require('../validation');

const router = express.Router();

// 1. ログインコード生成（プラグイン専用・共有シークレット必須）
router.post('/token/generate/', pluginAuth, (req, res) => {
  const { uuid, mc_name: mcName } = req.body || {};

  if (!isUuid(uuid) || !isMcName(mcName)) {
    return res.status(400).json({ error: 'Valid uuid and mc_name are required' });
  }

  return res.json({ token: tokenStore.issue(uuid.toLowerCase(), mcName) });
});

module.exports = router;
