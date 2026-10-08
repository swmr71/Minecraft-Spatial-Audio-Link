/**
 * PCM(s16le) を一定のペース（実時間）で 10ms フレームに区切って sink へ渡す。
 * - 到着が揺れても（ネットワーク・ffmpeg）一定間隔で送り出す
 * - 再生開始前に prebufferMs だけ溜め、枯渇したら溜め直す（無音データは送らない）
 * - バッファが上限を超えたら push() が false を返す = 送り手に一時停止を促す（バックプレッシャ）
 */
class PcmFeeder {
  constructor({ sink, sampleRate = 48000, frameMs = 10, prebufferMs = 200, maxBufferMs = 2000, now = () => performance.now() }) {
    this.sink = sink;
    this.frameSamples = Math.round((sampleRate * frameMs) / 1000);
    this.frameBytes = this.frameSamples * 2; // s16le mono
    this.frameMs = frameMs;
    this.prebufferBytes = Math.round((sampleRate * 2 * prebufferMs) / 1000);
    this.maxBufferBytes = Math.round((sampleRate * 2 * maxBufferMs) / 1000);
    this.now = now;
    this.buf = Buffer.alloc(0);
    this.state = 'buffering';
    this.t0 = 0;
    this.sent = 0;
    this.timer = null;
    this.drainWaiters = [];
  }

  /** @returns {boolean} まだ受け入れ余地があるか。false なら onDrain まで送り手を止める */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    return this.buf.length < this.maxBufferBytes;
  }

  /** バッファに余裕ができたときに 1 回だけ呼ばれる。 */
  onDrain(cb) {
    this.drainWaiters.push(cb);
  }

  get bufferedMs() {
    return (this.buf.length / 2 / (this.frameSamples / this.frameMs));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.frameMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.buf = Buffer.alloc(0);
    this.drainWaiters = [];
  }

  tick() {
    if (this.state === 'buffering') {
      if (this.buf.length < this.prebufferBytes) return;
      this.state = 'playing';
      this.t0 = this.now();
      this.sent = 0;
    }

    const due = Math.min(Math.floor((this.now() - this.t0) / this.frameMs) - this.sent, 50);
    for (let i = 0; i < due; i++) {
      if (this.buf.length < this.frameBytes) {
        this.state = 'buffering'; // 枯渇: 溜め直す
        break;
      }
      const frame = new Int16Array(this.frameSamples);
      Buffer.from(frame.buffer).set(this.buf.subarray(0, this.frameBytes));
      this.buf = this.buf.subarray(this.frameBytes);
      this.sent++;
      Promise.resolve(this.sink(frame)).catch((e) => console.error('[audio] sink error:', e.message));
    }

    if (this.drainWaiters.length && this.buf.length < this.maxBufferBytes / 2) {
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      waiters.forEach((cb) => cb());
    }
  }
}

module.exports = { PcmFeeder };
