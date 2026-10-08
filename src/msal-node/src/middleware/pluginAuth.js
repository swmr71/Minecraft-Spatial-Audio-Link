const crypto = require('crypto');
const config = require('../config');

const expected = Buffer.from(config.pluginApiKey);

/** プラグイン専用 API の共有シークレット認証（X-MSAL-Key ヘッダ）。 */
module.exports = function pluginAuth(req, res, next) {
  const provided = Buffer.from(String(req.get('x-msal-key') || ''));
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};
