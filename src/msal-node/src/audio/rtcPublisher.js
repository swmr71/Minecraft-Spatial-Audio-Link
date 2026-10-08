const config = require('../config');

/**
 * LiveKit ルームに「音源」参加者（identity: audio:<id>）として入り、PCM フレームを publish する。
 * @livekit/rtc-node はネイティブ依存なので、最初の音源が作られるまで読み込まない。
 */
async function createRtcPublisher({ id, onClose }) {
  const rtc = require('@livekit/rtc-node');
  const { AccessToken } = require('livekit-server-sdk');

  const identity = `audio:${id}`;
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, { identity, name: id, ttl: '24h' });
  at.addGrant({ roomJoin: true, room: config.livekit.room, canPublish: true, canSubscribe: false, canPublishData: false });
  const jwt = await at.toJwt();

  const room = new rtc.Room();
  let closing = false;
  room.on(rtc.RoomEvent.Disconnected, () => { if (!closing) onClose?.(); });
  await room.connect(config.livekit.internalUrl, jwt, { autoSubscribe: false, dynacast: false });

  const source = new rtc.AudioSource(48000, 1, 1000);
  const track = rtc.LocalAudioTrack.createAudioTrack(identity, source);
  try {
    await room.localParticipant.publishTrack(track, new rtc.TrackPublishOptions({
      source: rtc.TrackSource.SOURCE_UNKNOWN,
      dtx: false, // 音楽・映像の音は DTX で切れ切れにしない
      audioEncoding: { maxBitrate: 64000 },
    }));
  } catch (e) {
    await room.disconnect().catch(() => {});
    throw e;
  }

  return {
    sink: (int16) => source.captureFrame(new rtc.AudioFrame(int16, 48000, 1, int16.length)),
    async close() {
      closing = true;
      await source.close?.().catch(() => {});
      await room.disconnect().catch(() => {});
    },
  };
}

module.exports = { createRtcPublisher };
