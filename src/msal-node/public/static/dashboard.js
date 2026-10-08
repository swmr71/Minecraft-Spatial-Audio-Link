/* Spatial VC dashboard
 * - LiveKit は autoSubscribe:false。サーバーから届く購読リスト(sub)の相手だけ購読する（要件定義 §4.2）
 * - 近接: HRTF + 50m で無音になる距離減衰 + 距離に応じた高域カット（仕様書 §3.1）
 * - ラジオ: バンドパス + 距離に応じたノイズ混入（要件定義 §3.3 / §5.2）、定位なし
 */
(() => {
  'use strict';

  const { uuid: MY_UUID, livekitUrl: LIVEKIT_WS_URL } = document.body.dataset;

  const PROX_AUDIBLE = 50;        // m。これを超えると無音
  const RADAR_RANGE = 100;        // m。購読範囲と同じ
  const LOWPASS_NEAR_HZ = 18000;
  const LOWPASS_FAR_HZ = 1500;
  const RADIO_NOISE_SHARE = 0.9;  // ノイズ最大時（2km）にノイズが占める割合
  const RADIO_NOISE_LEVEL = 0.3;  // ノイズ全体の音量
  const GAIN_SMOOTHING = 0.08;    // 秒（setTargetAtTime の時定数）

  const $ = (id) => document.getElementById(id);
  const CONNECT_BTN = $('connect-btn');
  const MUTE_BTN = $('mute-btn');
  const LEAVE_BTN = $('leave-btn');
  const ACTIVE_CONTROLS = $('active-controls');
  const STATUS = $('status-indicator');
  const AUDIO_CONTAINER = $('audio-container');
  const RADAR_CANVAS = $('radar-canvas');
  const RADAR_CTX = RADAR_CANVAS.getContext('2d');
  const COORDS = { x: $('pos-x'), y: $('pos-y'), z: $('pos-z') };
  const GAUGE_L = $('gauge-l');
  const GAUGE_R = $('gauge-r');

  let audio = null;            // { ctx, master, analyser*, noiseBuffer }
  let room = null;
  let ws = null;
  let wsRetryMs = 1000;
  let wsRetryTimer = null;
  let active = false;          // 接続中（再接続ループを回すか）
  let micMuted = false;
  let rafId = null;
  let visible = new Map();     // uuid -> サーバーから届いた最新の状態
  let wanted = new Set();      // 購読すべき uuid
  const voices = new Map();    // uuid -> Voice
  let myState = null;

  // ---------------------------------------------------------------- Web Audio

  function setupAudio() {
    if (audio) return audio;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();
    const analyserMaster = ctx.createAnalyser();
    const analyserL = ctx.createAnalyser();
    const analyserR = ctx.createAnalyser();
    [analyserMaster, analyserL, analyserR].forEach((a) => { a.fftSize = 256; });

    // 複数発話が重なっても音割れしないよう最終段にコンプレッサ（仕様書 §3.2）
    const compressor = ctx.createDynamicsCompressor();
    master.connect(compressor);
    compressor.connect(analyserMaster);
    analyserMaster.connect(ctx.destination);

    const splitter = ctx.createChannelSplitter(2);
    analyserMaster.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    // ホワイトノイズ（ラジオ用）。1 秒分を生成してループ再生する
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    audio = { ctx, master, analyserMaster, analyserL, analyserR, noiseBuffer };
    return audio;
  }

  class Voice {
    constructor(track) {
      const { ctx, master, noiseBuffer } = setupAudio();
      this.ctx = ctx;

      // Chromium は MediaStream をメディア要素に接続しないと WebAudio へ音が流れない。
      // 生音声が二重再生されないよう要素自体はミュートしておく。
      this.element = track.attach();
      this.element.muted = true;
      AUDIO_CONTAINER.appendChild(this.element);

      this.source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));

      // 近接: lowpass -> HRTF panner -> gain
      this.lowpass = ctx.createBiquadFilter();
      this.lowpass.type = 'lowpass';
      this.lowpass.frequency.value = LOWPASS_NEAR_HZ;
      this.panner = ctx.createPanner();
      this.panner.panningModel = 'HRTF';
      this.panner.distanceModel = 'linear';
      this.panner.refDistance = 1;
      this.panner.maxDistance = PROX_AUDIBLE;
      this.panner.rolloffFactor = 1;
      this.proxGain = ctx.createGain();
      this.proxGain.gain.value = 0;
      this.source.connect(this.lowpass).connect(this.panner).connect(this.proxGain).connect(master);

      // ラジオ: 300Hz-3kHz の帯域制限（無線機の質感）-> gain
      this.radioHp = ctx.createBiquadFilter();
      this.radioHp.type = 'highpass';
      this.radioHp.frequency.value = 300;
      this.radioLp = ctx.createBiquadFilter();
      this.radioLp.type = 'lowpass';
      this.radioLp.frequency.value = 3000;
      this.radioGain = ctx.createGain();
      this.radioGain.gain.value = 0;
      this.source.connect(this.radioHp).connect(this.radioLp).connect(this.radioGain).connect(master);

      // ラジオノイズ
      this.noise = ctx.createBufferSource();
      this.noise.buffer = noiseBuffer;
      this.noise.loop = true;
      const noiseBp = ctx.createBiquadFilter();
      noiseBp.type = 'bandpass';
      noiseBp.frequency.value = 1800;
      noiseBp.Q.value = 0.5;
      this.noiseGain = ctx.createGain();
      this.noiseGain.gain.value = 0;
      this.noise.connect(noiseBp).connect(this.noiseGain).connect(master);
      this.noise.start();
    }

    #ramp(param, value) {
      param.setTargetAtTime(value, this.ctx.currentTime, GAIN_SMOOTHING);
    }

    /** サーバーからの状態で音を更新する。info が無ければ無音。 */
    update(info) {
      const now = this.ctx.currentTime;
      if (!info) {
        this.#ramp(this.proxGain.gain, 0);
        this.#ramp(this.radioGain.gain, 0);
        this.#ramp(this.noiseGain.gain, 0);
        return;
      }

      if (info.k === 'radio') {
        const ng = info.ng || 0;
        this.#ramp(this.proxGain.gain, 0);
        this.#ramp(this.radioGain.gain, 1 - RADIO_NOISE_SHARE * ng);
        this.#ramp(this.noiseGain.gain, RADIO_NOISE_SHARE * ng * RADIO_NOISE_LEVEL);
        return;
      }

      // prox
      const t = Math.min(info.dist / PROX_AUDIBLE, 1);
      const cutoff = LOWPASS_NEAR_HZ * Math.pow(LOWPASS_FAR_HZ / LOWPASS_NEAR_HZ, t);
      this.lowpass.frequency.setTargetAtTime(cutoff, now, 0.1);
      const [x, y, z] = info.p;
      this.panner.positionX.setTargetAtTime(x, now, 0.1);
      this.panner.positionY.setTargetAtTime(y, now, 0.1);
      this.panner.positionZ.setTargetAtTime(z, now, 0.1);
      this.#ramp(this.proxGain.gain, 1);
      this.#ramp(this.radioGain.gain, 0);
      this.#ramp(this.noiseGain.gain, 0);
    }

    destroy() {
      try { this.noise.stop(); } catch { /* 既に停止済み */ }
      this.source.disconnect();
      [this.lowpass, this.panner, this.proxGain, this.radioHp, this.radioLp, this.radioGain, this.noiseGain]
        .forEach((n) => n.disconnect());
      this.element.srcObject = null;
      this.element.remove();
    }
  }

  function applyVisibility() {
    for (const [uuid, voice] of voices) voice.update(visible.get(uuid));
  }

  function updateListener(me) {
    const { ctx } = setupAudio();
    const l = ctx.listener;
    const now = ctx.currentTime;
    const [x, y, z] = me.p;
    l.positionX.setTargetAtTime(x, now, 0.1);
    l.positionY.setTargetAtTime(y, now, 0.1);
    l.positionZ.setTargetAtTime(z, now, 0.1);
    // Minecraft の yaw: 0 = +z(南), 90 = -x(西)
    const rad = (me.y * Math.PI) / 180;
    l.forwardX.setTargetAtTime(-Math.sin(rad), now, 0.1);
    l.forwardY.setTargetAtTime(0, now, 0.1);
    l.forwardZ.setTargetAtTime(Math.cos(rad), now, 0.1);
  }

  // ---------------------------------------------------------------- LiveKit

  /** 購読リストに従って購読 / 解除する（autoSubscribe:false 前提）。 */
  function syncSubscriptions(participant) {
    const targets = participant ? [participant] : [...room.remoteParticipants.values()];
    for (const p of targets) {
      for (const pub of p.trackPublications.values()) {
        if (pub.kind !== 'audio') continue;
        const should = wanted.has(p.identity);
        if (pub.isSubscribed !== should) pub.setSubscribed(should);
      }
    }
  }

  function removeVoice(identity) {
    const voice = voices.get(identity);
    if (voice) {
      voice.destroy();
      voices.delete(identity);
    }
  }

  async function connectRoom() {
    const res = await fetch('/api/vc/livekit/token/', { method: 'POST', credentials: 'same-origin' });
    if (res.status === 401) {
      location.href = '/login/';
      throw new Error('セッションが切れました');
    }
    if (!res.ok) throw new Error(`トークン取得に失敗しました (HTTP ${res.status})`);
    const { token } = await res.json();

    const { Room, RoomEvent } = window.LivekitClient;
    const r = new Room({
      adaptiveStream: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    // 接続前にイベントを登録する（接続中の購読を取りこぼさない）
    r.on(RoomEvent.TrackPublished, (pub, participant) => syncSubscriptions(participant));
    r.on(RoomEvent.ParticipantConnected, (participant) => syncSubscriptions(participant));
    r.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind !== 'audio') return;
      removeVoice(participant.identity);
      const voice = new Voice(track);
      voices.set(participant.identity, voice);
      voice.update(visible.get(participant.identity));
    });
    r.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => removeVoice(participant.identity));
    r.on(RoomEvent.ParticipantDisconnected, (participant) => removeVoice(participant.identity));
    r.on(RoomEvent.Disconnected, () => { if (active) teardown('状態: 切断されました。再接続してください'); });

    await r.connect(LIVEKIT_WS_URL, token, { autoSubscribe: false });
    await r.localParticipant.setMicrophoneEnabled(true);
    return r;
  }

  // ---------------------------------------------------------------- 座標 WebSocket

  function openSpatialWS() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${scheme}://${location.host}/ws/vchat/spatial/`);

    ws.onopen = () => { wsRetryMs = 1000; };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.t === 'pos') {
        visible = new Map(msg.d.map((p) => [p.u, p]));
        myState = visible.get(MY_UUID) || null;
        if (myState) updateListener(myState);
        applyVisibility();
      } else if (msg.t === 'sub') {
        msg.add.forEach((u) => wanted.add(u));
        msg.remove.forEach((u) => wanted.delete(u));
        if (room) syncSubscriptions();
      }
    };

    ws.onclose = (e) => {
      ws = null;
      if (!active) return;
      // 古い座標で喋り続けないよう無音にする
      visible = new Map();
      myState = null;
      wanted = new Set();
      applyVisibility();
      if (e.code === 4401) {
        location.href = '/login/';
        return;
      }
      STATUS.innerText = '状態: 座標サーバーに再接続中...';
      wsRetryTimer = setTimeout(openSpatialWS, wsRetryMs);
      wsRetryMs = Math.min(wsRetryMs * 2, 10000);
    };
  }

  // ---------------------------------------------------------------- 描画

  function drawRadar() {
    const center = RADAR_CANVAS.width / 2;
    const scale = center / RADAR_RANGE;
    RADAR_CTX.clearRect(0, 0, RADAR_CANVAS.width, RADAR_CANVAS.height);

    if (myState) {
      COORDS.x.innerText = myState.p[0].toFixed(1);
      COORDS.y.innerText = myState.p[1].toFixed(1);
      COORDS.z.innerText = myState.p[2].toFixed(1);
    }

    RADAR_CTX.save();
    RADAR_CTX.translate(center, center);
    if (myState) RADAR_CTX.rotate(-((myState.y * Math.PI) / 180) - Math.PI);

    RADAR_CTX.strokeStyle = '#00ff0022';
    RADAR_CTX.lineWidth = 1;
    [25, 50, 75, 100].forEach((r) => {
      RADAR_CTX.beginPath();
      RADAR_CTX.arc(0, 0, r * scale, 0, Math.PI * 2);
      RADAR_CTX.stroke();
    });

    if (myState) {
      for (const p of visible.values()) {
        const relX = p.p[0] - myState.p[0];
        const relZ = p.p[2] - myState.p[2];
        if (p.k !== 'self' && p.w !== myState.w) continue; // 別ワールドはレーダーに出さない
        if (Math.hypot(relX, relZ) > RADAR_RANGE) continue;

        const x = relX * scale;
        const y = relZ * scale;
        RADAR_CTX.fillStyle = p.k === 'self' ? '#00d2d3' : p.k === 'radio' ? '#feca57' : '#ff7675';
        RADAR_CTX.beginPath();
        RADAR_CTX.arc(x, y, 4, 0, Math.PI * 2);
        RADAR_CTX.fill();
        RADAR_CTX.fillStyle = '#fff';
        RADAR_CTX.font = '10px sans-serif';
        RADAR_CTX.fillText(p.n, x + 6, y + 4);
      }
    }
    RADAR_CTX.restore();

    RADAR_CTX.beginPath();
    RADAR_CTX.moveTo(center, center);
    RADAR_CTX.lineTo(center, center - 30);
    RADAR_CTX.strokeStyle = '#00d2d3';
    RADAR_CTX.lineWidth = 2;
    RADAR_CTX.stroke();
  }

  function peak(analyser, buf) {
    analyser.getByteFrequencyData(buf);
    let max = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] > max) max = buf[i];
    return max;
  }

  let gaugeBufs = null;
  function drawGauges() {
    if (!audio) return;
    gaugeBufs ||= {
      l: new Uint8Array(audio.analyserL.frequencyBinCount),
      r: new Uint8Array(audio.analyserR.frequencyBinCount),
      m: new Uint8Array(audio.analyserMaster.frequencyBinCount),
    };
    const master = peak(audio.analyserMaster, gaugeBufs.m);
    const l = peak(audio.analyserL, gaugeBufs.l) || master;
    const r = peak(audio.analyserR, gaugeBufs.r) || master;
    GAUGE_L.style.width = `${(l / 255) * 100}%`;
    GAUGE_R.style.width = `${(r / 255) * 100}%`;
  }

  function frame() {
    drawRadar();
    drawGauges();
    rafId = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- 接続 / 切断

  function showActive(on) {
    CONNECT_BTN.classList.toggle('hidden', on);
    CONNECT_BTN.disabled = on;
    ACTIVE_CONTROLS.classList.toggle('hidden', !on);
  }

  function teardown(statusText) {
    active = false;
    clearTimeout(wsRetryTimer);
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    if (room) {
      const r = room;
      room = null;
      r.removeAllListeners();
      r.disconnect().catch(() => {});
    }
    for (const identity of [...voices.keys()]) removeVoice(identity);
    visible = new Map();
    wanted = new Set();
    myState = null;
    micMuted = false;
    MUTE_BTN.innerText = 'マイクをミュート';
    MUTE_BTN.classList.remove('active');

    STATUS.innerText = statusText;
    showActive(false);
    COORDS.x.innerText = COORDS.y.innerText = COORDS.z.innerText = '---';
    RADAR_CTX.clearRect(0, 0, RADAR_CANVAS.width, RADAR_CANVAS.height);
    GAUGE_L.style.width = GAUGE_R.style.width = '0%';
  }

  CONNECT_BTN.addEventListener('click', async () => {
    CONNECT_BTN.disabled = true;
    STATUS.innerText = '状態: 接続中...';
    try {
      // ユーザー操作の中で AudioContext を作成 / 再開する（autoplay ポリシー対策）
      const { ctx } = setupAudio();
      if (ctx.state === 'suspended') await ctx.resume();

      active = true;
      room = await connectRoom();
      showActive(true);
      STATUS.innerText = '状態: 接続成功（立体音響有効）';
      openSpatialWS();
      frame();
    } catch (e) {
      console.error(e);
      teardown('エラー: ' + e.message);
    }
  });

  MUTE_BTN.addEventListener('click', async () => {
    if (!room) return;
    const next = !micMuted;
    try {
      await room.localParticipant.setMicrophoneEnabled(!next);
    } catch (e) {
      console.error(e);
      STATUS.innerText = 'エラー: マイクを切り替えられませんでした';
      return;
    }
    micMuted = next;
    MUTE_BTN.innerText = micMuted ? 'マイクを解除' : 'マイクをミュート';
    MUTE_BTN.classList.toggle('active', micMuted);
    STATUS.innerText = micMuted ? '状態: ミュート中' : '状態: 接続中';
  });

  LEAVE_BTN.addEventListener('click', () => teardown('状態: 退出しました'));
})();
