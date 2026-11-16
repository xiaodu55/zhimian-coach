/**
 * 音量监测（解决"录到了但全是静音"这个最危险的失败模式）
 * 实测场景：同时开飞书/腾讯会议时，Windows 一般允许共享麦克风，
 * 但会议软件可能把默认输入切到它的虚拟设备 → 我们拿到的是静音流，且不报错。
 * 所以必须给出：实时音量条 + 连续静音告警 + 当前设备名。
 */
export class AudioMonitor {
  /**
   * @param {MediaStream} stream
   * @param {{onLevel?: (rms:number, db:number)=>void, intervalMs?: number}} [opts]
   */
  constructor(stream, opts = {}) {
    this.stream = stream;
    this.onLevel = opts.onLevel;
    this.intervalMs = opts.intervalMs || 150;
    this.ctx = null;
    this.analyser = null;
    this.buffer = null;
    this.timer = null;
  }

  start() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || !this.stream) return false;
    this.ctx = new AudioCtx();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    src.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);

    this.timer = setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(this.buffer);
      let sum = 0;
      for (let i = 0; i < this.buffer.length; i += 1) sum += this.buffer[i] * this.buffer[i];
      const rms = Math.sqrt(sum / this.buffer.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -100;
      this.onLevel?.(rms, db);
    }, this.intervalMs);
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    try {
      this.ctx?.close();
    } catch {
      /* 忽略 */
    }
    this.ctx = null;
    this.analyser = null;
  }
}

/** 低于 -50dB 视为静音（实测：正常说话峰值通常 > -35dB，底噪在 -60dB 附近） */
export function isSilentLevel(db) {
  return db < -50;
}
