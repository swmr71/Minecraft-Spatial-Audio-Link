const { isSuperAdmin } = require('../services');

/** Super Admin としてログイン済みのセッションのみ通す。 */
module.exports = function requireSuper(req, res, next) {
  if (!req.session?.uuid) return res.status(401).json({ error: 'Unauthorized' });
  if (!isSuperAdmin(req.session.uuid)) return res.status(403).json({ error: 'Forbidden' });
  next();
};
