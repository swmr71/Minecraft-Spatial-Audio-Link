const express = require('express');
const pluginAuth = require('../middleware/pluginAuth');
const { audio } = require('../services');

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof audio.AudioError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
};
const jsonOnly = (req, res, next) => (req.is('application/json') ? next() : res.status(415).json({ error: 'JSON only' }));

/**
 * 音源 API（プラグイン向け・共有シークレット必須）。ボディパーサーより前に mount するストリーミング用。
 * POST /:id/push … PCM を HTTP のチャンク転送で流し込む（raw s16le / mono / 48000Hz）。
 *   ffmpeg 例: -f s16le -ac 1 -ar 48000 -method POST -chunked_post 1 -headers "X-MSAL-Key: ..." http://host/api/vc/plugin/audio/<id>/push
 */
const pushRouter = express.Router();
pushRouter.post('/:id/push', pluginAuth, handle(async (req, res) => {
  audio.attachPush(req.params.id, req, () => {
    if (!res.headersSent) res.json({ ok: true });
  });
}));

/** 制御 API（JSON）。 */
const router = express.Router();
const base = '/plugin/audio';

router.post(`${base}/start`, pluginAuth, jsonOnly, handle(async (req, res) => {
  const b = req.body || {};
  const info = await audio.start({
    id: b.id, source: b.source, world: b.world, x: b.x, y: b.y, z: b.z,
    range: b.range, volume: b.volume, loop: b.loop, live: b.live, reconnect: b.reconnect,
  });
  res.json({ ok: true, audio: info, pushPath: info.mode === 'push' ? `/api/vc/plugin/audio/${info.id}/push` : undefined });
}));

router.post(`${base}/update`, pluginAuth, jsonOnly, handle(async (req, res) => {
  const { id, ...rest } = req.body || {};
  res.json({ ok: true, audio: audio.update(id, rest) });
}));

router.post(`${base}/stop`, pluginAuth, jsonOnly, handle(async (req, res) => {
  const { id, all } = req.body || {};
  if (all === true) return res.json({ ok: true, stopped: await audio.stopAll() });
  if (typeof id !== 'string') return res.status(400).json({ error: 'id or all:true is required' });
  res.json({ ok: true, stopped: Number(await audio.stop(id)) });
}));

router.get(`${base}/list`, pluginAuth, (req, res) => res.json({ audio: audio.list() }));

module.exports = { router, pushRouter };
