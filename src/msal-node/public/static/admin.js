/* Super Admin（Sawamura）専用の管理パネル。サーバー側でも requireSuper で保護されている。
 * 全チャンネル傍受 / 強制放送 / チャンネルミュート / ダッキング量の調整 / オンラインプレイヤー一覧
 */
(() => {
  'use strict';
  if (document.body.dataset.role !== 'super') return;

  const $ = (id) => document.getElementById(id);
  const card = $('admin-card');
  card.classList.remove('hidden');

  const REFRESH_MS = 2000;

  async function call(path, body) {
    const res = await fetch(`/api/vc/admin/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  function notify(text, isError = false) {
    const el = $('admin-msg');
    el.textContent = text;
    el.style.color = isError ? '#ff7675' : '#7bed9f';
  }

  async function act(label, fn) {
    try {
      await fn();
      notify(`${label}: OK`);
      refresh();
    } catch (e) {
      notify(`${label}: 失敗 (${e.message})`, true);
    }
  }

  const channelValue = () => Number.parseInt($('admin-channel').value, 10);

  $('admin-bc-start').addEventListener('click', () =>
    act('放送開始', () => call('broadcast/start', { message: $('admin-bc-msg').value })));
  $('admin-bc-stop').addEventListener('click', () =>
    act('放送停止', () => call('broadcast/stop', {})));
  $('admin-mute').addEventListener('click', () =>
    act('ミュート', () => call('channel/mute', { channel: channelValue(), muted: true })));
  $('admin-unmute').addEventListener('click', () =>
    act('ミュート解除', () => call('channel/mute', { channel: channelValue(), muted: false })));

  const duck = $('admin-duck');
  duck.addEventListener('input', () => { $('admin-duck-val').textContent = duck.value; });
  duck.addEventListener('change', () =>
    act('ダッキング量', () => call('settings', { duck: Number.parseInt(duck.value, 10) })));

  function applyEavesdrop() {
    const mode = $('admin-eaves-mode').value;
    $('admin-eaves-ch').classList.toggle('hidden', mode !== 'channel');
    let ch = null;
    if (mode === 'all') ch = 'all';
    if (mode === 'channel') {
      const n = Number.parseInt($('admin-eaves-ch').value, 10);
      ch = Number.isInteger(n) && n >= 1 ? n : null;
    }
    window.MSALDash?.setEavesdrop(ch);
  }
  $('admin-eaves-mode').addEventListener('change', applyEavesdrop);
  $('admin-eaves-ch').addEventListener('change', applyEavesdrop);

  async function refresh() {
    let st;
    try {
      const res = await fetch('/api/vc/admin/state', { credentials: 'same-origin' });
      if (!res.ok) return;
      st = await res.json();
    } catch {
      return;
    }

    // textContent のみ使用（プレイヤー名は信用しない）
    const tbody = $('admin-players');
    tbody.replaceChildren(...st.players.map((p) => {
      const tr = document.createElement('tr');
      for (const v of [p.n, p.w, p.c || '-']) {
        const td = document.createElement('td');
        td.textContent = String(v);
        tr.appendChild(td);
      }
      return tr;
    }));
    const audioList = $('admin-audio');
    audioList.replaceChildren(...st.audio.map((a) => {
      const row = document.createElement('div');
      row.className = 'audio-row';
      const label = document.createElement('span');
      label.textContent = `🔊 ${a.id}（${a.mode}${a.mode === 'push' ? (a.pushing ? ' 受信中' : ' 待機') : ''} / ${a.world} ${a.pos.map((n) => Math.round(n)).join(',')} / ${a.range}m）`;
      const stop = document.createElement('button');
      stop.className = 'btn btn-mute';
      stop.textContent = '停止';
      stop.addEventListener('click', () => act(`音源 ${a.id} 停止`, () => call('audio/stop', { id: a.id })));
      row.append(label, stop);
      return row;
    }));
    if (!st.audio.length) audioList.textContent = 'なし';
    $('admin-muted').textContent = st.muted.length ? st.muted.join(', ') : 'なし';
    $('admin-broadcasts').textContent = st.broadcasts.length
      ? st.broadcasts.map((b) => (b.msg ? `${b.n}「${b.msg}」` : b.n)).join(' / ')
      : 'なし';
    if (document.activeElement !== duck) {
      duck.value = st.duck;
      $('admin-duck-val').textContent = st.duck;
    }
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
})();
