/**
 * M2 录音模块：浏览器本地 MediaRecorder + opus 编码，仅存 IndexedDB，不产生任何上传请求
 */
export class LocalAudioRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
    this.startTime = 0;
  }

  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  async start() {
    if (!LocalAudioRecorder.isSupported()) {
      throw new Error('当前浏览器不支持麦克风录音 API');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.startTime = Date.now();
    this.mediaRecorder.start(500);
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        resolve(null);
        return;
      }
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
        const durationSec = Math.max(1, Math.round((Date.now() - this.startTime) / 1000));
        this.cleanup();
        resolve({ blob, durationSec });
      };
      this.mediaRecorder.stop();
    });
  }

  cleanup() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
