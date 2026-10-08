const express = require('express');
const pluginAuth = require('../middleware/pluginAuth');
const requireSuper = require('../middleware/requireSuper');
const { state } = require('../services');
const { loadAllPlayers } = require('../players');
const { isMcName, isUuid } = require('../validation');

const MAX_CHANNEL = 999;
const isChannel = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_CHANNEL;
const isJsonRequest = (req) => req.is('application/json');

/** 放送・ミュート操作は同じロジックを「プラグイン経由」と「管理パネル経由」で共有する。 */
function actions(router, prefix, auth, resolveActor) {
  const guard = [auth, (req, res, next) => (isJsonRequest(req) ? next() : res.status(415).json({ error: 'JSON only' }))];

  router.post(`${prefix}/broadcast/start`, guard, (req, res) => {
    const actor = resolveActor(req);
    if (!actor) return res.status(400).json({ error: 'Valid uuid and mc_name are required' });
    state.startBroadcast(actor.uuid, actor.name, req.body?.message);
    res.json({ ok: true });
  });

  router.post(`${prefix}/broadcast/stop`, guard, (req, res) => {
    const actor = resolveActor(req, { optional: true });
    // プラグインは uuid なしで「全放送停止」も可能。管理パネルは自分の放送のみ停止
    const stopped = actor ? Number(state.stopBroadcast(actor.uuid)) : state.stopAllBroadcasts();
    res.json({ ok: true, stopped });
  });

  router.post(`${prefix}/channel/mute`, guard, (req, res) => {
    const { channel, muted } = req.body || {};
    if (!isChannel(channel) || typeof muted !== 'boolean') {
      return res.status(400).json({ error: `channel (1-${MAX_CHANNEL}) and muted (boolean) are required` });
    }
    state.setMuted(channel, muted);
    res.json({ ok: true });
  });
}

const router = express.Router();

// プラグイン用（共有シークレット）。権限判定（msal.broadcast / msal.mute.<ch>）はプラグイン側で済ませる
actions(router, '/plugin', pluginAuth, (req, { optional = false } = {}) => {
  const { uuid, mc_name: name } = req.body || {};
  if (isUuid(uuid) && isMcName(name)) return { uuid: uuid.toLowerCase(), name };
  if (isUuid(uuid) && optional) return { uuid: uuid.toLowerCase(), name: '' };
  return null;
});

// 管理パネル用（Super Admin セッション）。放送者は自分自身
actions(router, '/admin', requireSuper, (req) => ({ uuid: req.session.uuid, name: req.session.mc_name }));

router.get('/admin/state', requireSuper, async (req, res, next) => {
  try {
    const players = (await loadAllPlayers()).map((p) => ({ u: p.u, n: p.n, w: p.w, c: p.c, p: p.p }));
    res.json({
      players,
      broadcasts: state.activeBroadcasts(),
      muted: [...state.mutedChannels()].sort((a, b) => a - b),
      duck: state.getDuck(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/settings', requireSuper, (req, res) => {
  if (!isJsonRequest(req)) return res.status(415).json({ error: 'JSON only' });
  const duck = req.body?.duck;
  if (!Number.isInteger(duck) || duck < 0 || duck > 100) {
    return res.status(400).json({ error: 'duck must be an integer 0..100' });
  }
  state.setDuck(duck);
  res.json({ ok: true });
});

module.exports = router;
