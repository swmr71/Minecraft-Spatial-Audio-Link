const express = require('express');
const { AccessToken } = require('livekit-server-sdk');
const config = require('../config');

const router = express.Router();

// 2. LiveKit トークン発行（Web ログイン済みユーザーのみ）
router.post('/livekit/token/', async (req, res, next) => {
  const { mc_name: mcName, uuid } = req.session;

  if (!mcName || !uuid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: uuid,
      name: mcName,
      ttl: config.livekit.tokenTtl,
    });
    at.addGrant({
      roomJoin: true,
      room: config.livekit.room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    return res.json({ token: await at.toJwt() });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
