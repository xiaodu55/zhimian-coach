/**
 * M2 录音模块：本地 MediaRecorder + opus，仅存 IndexedDB，不上传。
 *
 * 支持：
 *  - 指定输入设备（deviceId）：避免会议软件把默认输入切走导致录到静音
 *  - 实时音量回调（onLevel）+ 连续静音告警（onSilence）
 *  - 可选第二轨（系统声音 = 面试官那一路），单独录成 systemBlob，用于"说话人天然分离"
 */
import { AudioMonitor, isSilentLevel } from './audioMonitor.js';

export class LocalAudioRecorder {
  constructor(opts = {}) {
    this.onLevel = opts.onLevel;
    this.onSilence = opts.onSilence;
    this.silenceMs = opts.silenceMs || 4000;

    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
    this.startTime = 0;

    this.systemStream = null;
    this.systemRecorder = null;
    this.systemChunks = [];

    this.monitor = null;
    this.silentSince = 0;
    this.silenceNotified = false;
  }

  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  static pickMime() {
    return MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  }

  /**
   * @param {{deviceId?: string, systemStream?: MediaStream|null}} [opts]
   */
  async start(opts = {}) {
    if (!LocalAudioRecorder.isSupported()) throw new Error('当前浏览器不支持麦克风录音 API');

    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
      },
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: LocalAudioRecorder.pickMime() });
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };

    // 第二轨：系统声音（面试官）
    if (opts.systemStream) {
      this.systemStream = opts.systemStream;
      this.systemChunks = [];
      this.systemRecorder = new MediaRecorder(this.systemStream, { mimeType: LocalAudioRecorder.pickMime() });
      this.systemRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.systemChunks.push(e.data);
      };
      this.systemRecorder.start(500);
    }

    this.startTime = Date.now();
    this.mediaRecorder.start(500);

    // 音量监测 + 连续静音告警
    this.silentSince = 0;
    this.silenceNotified = false;
    this.monitor = new AudioMonitor(this.stream, {
      onLevel: (rms, db) => {
        this.onLevel?.(rms, db);
        if (isSilentLevel(db)) {
          if (!this.silentSince) this.silentSince = Date.now();
          if (!this.silenceNotified && Date.now() - this.silentSince > this.silenceMs) {
            this.silenceNotified = true;
            this.onSilence?.(
              `已经 ${Math.round(this.silenceMs / 1000)} 秒没有采集到声音：可能被会议软件（飞书/腾讯会议）占用，` +
                '或默认输入被切换。请检查设备选择，或改用「上传会议录制」路线。'
            );
          }
        } else {
          this.silentSince = 0;
          this.silenceNotified = false;
        }
      },
    });
    this.monitor.start();
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        resolve(null);
        return;
      }
      const finish = () => {
        const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
        const systemBlob = this.systemChunks.length
          ? new Blob(this.systemChunks, { type: this.systemRecorder?.mimeType || 'audio/webm' })
          : null;
        const durationSec = Math.max(1, Math.round((Date.now() - this.startTime) / 1000));
        this.cleanup();
        resolve({ blob, systemBlob, durationSec });
      };

      this.mediaRecorder.onstop = finish;
      this.mediaRecorder.stop();
      if (this.systemRecorder && this.systemRecorder.state !== 'inactive') this.systemRecorder.stop();
    });
  }

  cleanup() {
    this.monitor?.stop();
    this.monitor = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.systemStream?.getTracks().forEach((t) => t.stop());
    this.systemStream = null;
    this.mediaRecorder = null;
    this.systemRecorder = null;
  }
}
