/**
 * M3 实时字幕模块：Web Speech API 逐句落时间戳；断线/不支持时显式回调降级
 */
export class LiveCaptionEngine {
  constructor({ onSentence, onInterim, onError }) {
    this.onSentence = onSentence;
    this.onInterim = onInterim;
    this.onError = onError;
    this.recognition = null;
    this.startTime = 0;
    this.running = false;
  }

  static isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  formatOffset(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  start() {
    if (!LiveCaptionEngine.isSupported()) {
      this.onError?.('当前浏览器不支持原生实时语音识别，已自动切换「手动录入 / 样例导入」模式');
      return false;
    }
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SpeechRec();
    this.recognition.lang = 'zh-CN';
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.startTime = Date.now();
    this.running = true;

    this.recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0].transcript.trim();
        if (!text) continue;
        if (res.isFinal) {
          this.onSentence?.({
            id: 'cap-' + Date.now() + '-' + i,
            timestamp: this.formatOffset(Date.now() - this.startTime),
            text
          });
        } else {
          interim += text;
        }
      }
      this.onInterim?.(interim);
    };

    this.recognition.onerror = (event) => {
      this.running = false;
      this.onError?.(`语音识别服务中断（${event.error || 'network'}），已保留已有字幕并开放手动补录`);
    };

    this.recognition.onend = () => {
      if (this.running) {
        try { this.recognition.start(); } catch (_) {}
      }
    };

    try {
      this.recognition.start();
      return true;
    } catch (err) {
      this.onError?.('无法启动语音识别：' + err.message);
      return false;
    }
  }

  stop() {
    this.running = false;
    if (this.recognition) {
      try { this.recognition.stop(); } catch (_) {}
    }
  }
}
