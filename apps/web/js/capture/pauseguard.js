/**
 * 思考停顿保护（PauseGuard）
 *
 * 背景：实时字幕在用户沉默思考时，最容易出的问题是"把停顿当成说完"——
 * 引擎在一段静音后自动断句并提交，用户还没想好就被当成答完了。
 *
 * 这里的做法：静音达到阈值（默认 5 秒）时**不做任何自动提交**，只把状态切到
 * 'thinking' 并回调 onFlush({reason:'silence'}) 通知上层，由上层决定是提示用户
 * 还是别的处理；同时给出一句明确提示：
 *     「还在思考？按空格继续说，按 Enter 发送」
 * 空格恢复收音，Enter 才真正发送。
 *
 * 之所以做成独立类而不是塞进 LiveCaptionEngine：提交时机属于上层业务
 * （coach.js），字幕引擎只负责"听到了什么"，两者不该互相持有。
 */

export const PAUSE_GUARD_HINT = '还在思考？按空格继续说，按 Enter 发送';

/**
 * 状态机：
 *   idle      —— 还没开始收音
 *   listening —— 正在收音（最后一次 noteSpeech 距今 < silenceMs）
 *   thinking  —— 静音超时，等用户决定：空格继续 / Enter 发送
 *   paused    —— 用户主动暂停
 *   sent      —— 用户按 Enter 提交
 */
export class PauseGuard {
  /**
   * @param {object} opts
   * @param {number} opts.silenceMs  判定"持续静音"的阈值，默认 5000ms
   * @param {Function} opts.onFlush   状态变更通知：(info:{reason:'silence'|'send',...}) => void
   * @param {Function} opts.onHint    提示语回调：(hint:string) => void
   * @param {Function} opts.onStateChange 状态回调：(state:string, prev:string) => void
   * @param {Function} opts.now       时间源（便于测试）
   * @param {number} opts.intervalMs  tick 定时器间隔，默认 400ms
   */
  constructor({ silenceMs = 5000, onFlush, onHint, onStateChange, now = () => Date.now(), intervalMs = 400 } = {}) {
    this.silenceMs = Math.max(500, Number(silenceMs) || 5000);
    this.onFlush = onFlush;
    this.onHint = onHint;
    this.onStateChange = onStateChange;
    this.now = now;
    this.intervalMs = Math.max(100, Number(intervalMs) || 400);
    this.state = 'idle';
    // 用 null 而不是 0 表示"还没说过话"：时间源可能返回 0（测试用的假时钟）
    this.lastSpeechAt = null;
    this.timer = null;
  }

  /** 当前是否在等用户决定（上层用它来决定要不要显示提示条） */
  get isAwaitingUser() {
    return this.state === 'thinking';
  }

  /** 距离最后一次说话过去了多久（ms） */
  get silenceElapsed() {
    if (this.lastSpeechAt === null) return 0;
    return Math.max(0, this.now() - this.lastSpeechAt);
  }

  _setState(next) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.onStateChange?.(next, prev);
  }

  /** 检测到说话时调用：重置静音计时并回到收音状态 */
  noteSpeech() {
    this.lastSpeechAt = this.now();
    this._setState('listening');
  }

  /**
   * 定时检查：连续静音达到阈值时**不自动断句提交**，
   * 只切到 thinking 并通知上层（reason:'silence'）。
   * @returns {boolean} 本次 tick 是否触发了静音提示
   */
  tick() {
    if (this.state !== 'listening') return false;
    if (this.silenceElapsed < this.silenceMs) return false;
    this._setState('thinking');
    this.onHint?.(PAUSE_GUARD_HINT);
    this.onFlush?.({
      reason: 'silence',
      silentMs: this.silenceElapsed,
      hint: PAUSE_GUARD_HINT,
    });
    return true;
  }

  /**
   * 空格键：开始 / 暂停 / 继续。
   * 在 thinking 状态下调用 = 用户"我还在想，继续说"，恢复收音。
   * @returns {string} 新状态
   */
  toggle() {
    if (this.state === 'thinking' || this.state === 'paused') {
      this.lastSpeechAt = this.now();
      this._setState('listening');
      return this.state;
    }
    if (this.state === 'listening') {
      this._setState('paused');
      return this.state;
    }
    this.lastSpeechAt = this.now();
    this._setState('listening');
    return this.state;
  }

  /**
   * Enter 键：用户确认发送。
   * @returns {string} 新状态
   */
  submit() {
    const prev = this.state;
    this._setState('sent');
    this.onFlush?.({ reason: 'send', previous: prev, hint: PAUSE_GUARD_HINT });
    return this.state;
  }

  /** 键盘事件映射：空格 → toggle，Enter → submit */
  handleKey(key) {
    if (key === ' ' || key === 'Space' || key === 'Spacebar') return this.toggle();
    if (key === 'Enter') return this.submit();
    return this.state;
  }

  /** 启动内部定时器（tick 驱动） */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /** 停止定时器 */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 回到初始状态（一场录制结束后调用） */
  reset() {
    this.stop();
    this.lastSpeechAt = null;
    this._setState('idle');
  }
}
