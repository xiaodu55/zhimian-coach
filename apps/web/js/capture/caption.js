/**
 * M3 实时字幕：Web Speech API 逐句落时间戳 + 说话人（我 / 面试官）判定。
 *
 * 重要限制（必须知道）：Web Speech 只能吃浏览器的默认输入，**不能指定 MediaStream**。
 * 因此"双轨分别识别"做不到；这里的说话人判定是**推断 + 人工可纠正**：
 *   1) 手动模式（推荐）：录音时点「我说话 / 面试官说话」，后续句子就按这个归人，绝对准确；
 *   2) 自动模式：按问句特征 / 人称词 / 上一句说话人推断，可能不准 —— 每句都能点一下改。
 * 真正的"天然分离"靠录音双轨（麦克风=我，系统音频=面试官），见 recorder/systemAudio。
 */

const INTERVIEWER_CUES = /(吗|呢|什么|为什么|怎么|如何|介绍|说说|讲讲|聊|请说明|能不能|是否|哪些|多久|多少|有没有|先|那么|追问)/;
const ME_CUES = /(我(?:做过|负责|参与|当时|觉得|认为|们|是|会|能)|我的|我们|然后我|后来我)/;

/** 推断一句是谁说的 */
export function inferSpeaker(text, lastSpeaker = 'unknown') {
  const t = String(text || '').trim();
  if (!t) return lastSpeaker;
  if (/[?？]\s*$/.test(t)) return 'interviewer';
  if (INTERVIEWER_CUES.test(t) && t.length <= 50 && !ME_CUES.test(t)) return 'interviewer';
  if (ME_CUES.test(t)) return 'me';
  return lastSpeaker === 'unknown' ? 'unknown' : lastSpeaker;
}

export class LiveCaptionEngine {
  constructor({ onSentence, onInterim, onError } = {}) {
    this.onSentence = onSentence;
    this.onInterim = onInterim;
    this.onError = onError;
    this.recognition = null;
    this.startTime = 0;
    this.running = false;
    /** 'auto' | 'me' | 'interviewer'：手动指定时忽略推断，直到切回 auto */
    this.speakerMode = 'auto';
    this.lastSpeaker = 'unknown';
  }

  static isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /** @param {'auto'|'me'|'interviewer'} mode */
  setSpeakerMode(mode) {
    this.speakerMode = mode;
    if (mode !== 'auto') this.lastSpeaker = mode;
  }

  formatOffset(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(totalSec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  start() {
    if (!LiveCaptionEngine.isSupported()) {
      this.onError?.('当前浏览器不支持原生实时语音识别，请改用「手动录入 / 导入会议转写稿」路线');
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
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const text = res[0].transcript.trim();
        if (!text) continue;
        if (res.isFinal) {
          const speaker = this.speakerMode === 'auto' ? inferSpeaker(text, this.lastSpeaker) : this.speakerMode;
          this.lastSpeaker = speaker;
          this.onSentence?.({
            id: `cap-${Date.now()}-${i}`,
            timestamp: this.formatOffset(Date.now() - this.startTime),
            text,
            speaker, // 'me' | 'interviewer' | 'unknown'
            speakerAuto: this.speakerMode === 'auto',
          });
        } else {
          interim += text;
        }
      }
      this.onInterim?.(interim);
    };

    this.recognition.onerror = (event) => {
      this.running = false;
      const map = {
        'not-allowed': '麦克风权限被拒绝',
        'no-speech': '没听到声音（检查设备或会议软件是否占用了麦克风）',
        network: '识别服务不可用（Chrome 走 Google，国内不稳；建议 Edge，或改用导入转写稿）',
      };
      this.onError?.(map[event.error] || `语音识别中断（${event.error || 'unknown'}），已保留已有字幕`);
    };

    this.recognition.onend = () => {
      if (this.running) {
        try {
          this.recognition.start();
        } catch {
          /* 忽略重启失败 */
        }
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
    try {
      this.recognition?.stop();
    } catch {
      /* 忽略 */
    }
  }
}

/** 把带说话人标签的字幕拼成可解析的转写稿（供第五章「解析并生成复盘」直接吃） */
export function captionsToTranscript(captions) {
  const label = { me: '我', interviewer: '面试官', unknown: '（未标注）' };
  return captions.map((c) => `${label[c.speaker] || '（未标注）'}：${c.text}`).join('\n');
}
