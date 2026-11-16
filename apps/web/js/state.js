import { dbGetAll } from './db.js';

export const state = {
  health: {
    checked: false,
    ok: false,
    zhihuConfigured: false,
    llmConfigured: false,
    bankSize: 0
  },
  degradedReason: null,
  bank: [],
  demoSample: null,
  activeQuestion: null,
  lastReviewReport: null,
  activeDocument: null,
  weaknesses: [],
  opportunities: []
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.error(err); }
  }
}

export function setDegraded(reason) {
  state.degradedReason = reason;
  const banner = document.getElementById('degraded-banner');
  const textEl = document.getElementById('degraded-text');
  if (banner && textEl) {
    if (reason) {
      textEl.textContent = reason;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }
  notify();
}

export async function refreshLocalCollections() {
  state.weaknesses = await dbGetAll('weaknesses');
  state.opportunities = await dbGetAll('opportunities');
  const badge = document.getElementById('nav-review-badge');
  if (badge) {
    const pendingCount = state.weaknesses.filter((w) => w.status !== 'mastered').length;
    badge.textContent = String(pendingCount);
    badge.hidden = pendingCount === 0;
  }
  notify();
}

/**
 * 加载题库（优先同域 /api/bank，失败自动降级读取随站发布的 ./data/question-bank.json）
 */
export async function loadQuestionBank() {
  try {
    const res = await fetch('/api/bank?limit=100');
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length > 0) {
        state.bank = list;
        state.activeQuestion = state.activeQuestion || list[0];
      }
    }
  } catch (_) {
    // 忽略网络异常，继续读取随站本地题库
  }

  try {
    const localRes = await fetch('./data/question-bank.json');
    const localJson = await localRes.json();
    if (!state.bank.length && Array.isArray(localJson.questions)) {
      state.bank = localJson.questions;
      state.activeQuestion = state.activeQuestion || localJson.questions[0];
    }
    state.demoSample = localJson.demoSampleTranscript || null;
  } catch (err) {
    console.error('本地种子题库加载失败:', err);
  }
  notify();
}

/**
 * 检查 BFF 健康状态（显式提示降级，不静默）
 */
export async function checkBackendHealth() {
  const pill = document.getElementById('system-status-pill');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const res = await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.health = { checked: true, ...data };
    if (pill) {
      if (data.ok && data.llmConfigured) {
        pill.className = 'status-pill status-online';
        pill.textContent = '● 在线服务就绪';
      } else {
        pill.className = 'status-pill status-degraded';
        pill.textContent = '◐ 规则模式（模型未配置）';
        setDegraded('后端模型服务暂未配置，系统已自动切换「本地确定性规则模式」，10 条原话级诊断照常可用。');
      }
    }
  } catch (_) {
    state.health = { checked: true, ok: false, zhihuConfigured: false, llmConfigured: false, bankSize: state.bank.length };
    if (pill) {
      pill.className = 'status-pill status-degraded';
      pill.textContent = '◐ 纯前端离线兜底模式';
    }
    setDegraded('当前为纯静态预览/离线模式（BFF 未启动），已自动启用本地题库 + 10 条确定性规则引擎 + 本地 BM25 检索。');
  }
  notify();
}
