const express = require('express');
const { AccessToken } = require('livekit-server-sdk');

const router = express.Router();

// 2. LiveKitトークン発行
router.post('/livekit/token/', async (req, res) => {
  const mcName = req.session.mc_name;
  const uuid = req.session.uuid;

  if (!mcName || !uuid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY || 'devkey',
    process.env.LIVEKIT_API_SECRET,
    { identity: uuid, name: mcName }
  );
  at.addGrant({
    roomJoin: true,
    room: 'minecraft-vc',
    canPublish: true,
    canSubscribe: true,
  });

  return res.json({ token: await at.toJwt() });
});

module.exports = router;
