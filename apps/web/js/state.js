import { dbGetAll, dbPut, dbGet } from './db.js';

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
  /** 题单：把主库真题按方向与难度梯度组织成场景化精选（bundles.json） */
  bundles: [],
  bundleById: new Map(),
  demoSample: null,
  /** 离线演示保底包：预跑的真实复盘报告，断网/模型不可用时也能演完闭环 */
  demoReports: [],
  /** 知乎登录态（未配置 OAuth 时为 null，前端自动隐藏入口） */
  user: null,
  oauthAvailable: false,
  activeQuestion: null,
  /** 用户是否"自己挑过"一道题：题库加载会预填 activeQuestion，但那不算用户的选择。
      跨路由直达下游页面时，用它判断要不要给上下文守卫。 */
  questionPickedByUser: false,
  lastReviewReport: null,
  /** 最近一次「简历陪练」分析结果（录音复盘要做"简历 × 口述"对照，需要跨模块复用） */
  resumeAnalysis: null,
  activeDocument: null,
  weaknesses: [],
  opportunities: [],
  /** 复盘报告历史（台账按场次反查复盘用） */
  sessions: []
};

/** 当前场次上下文（台账 → 陪练室的跨页关联） */
const ACTIVE_OPP_KEY = 'zhimian.active.opportunity';
/** 陪练室模式记忆（真题 / 简历 / 录音） */
export const COACH_MODE_KEY = 'zhimian.coach.mode';

export function setCoachMode(mode) {
  try { sessionStorage.setItem(COACH_MODE_KEY, mode); } catch { /* 隐私模式忽略 */ }
}

/** 台账点「去练习/去复盘」时写入当前场次 */
export function setActiveOpportunity(opp) {
  try {
    sessionStorage.setItem(
      ACTIVE_OPP_KEY,
      JSON.stringify(opp ? { id: opp.id, company: opp.company, role: opp.role || '', stage: opp.stage || '' } : null)
    );
  } catch { /* 忽略 */ }
}

export function getActiveOpportunity() {
  try {
    const raw = sessionStorage.getItem(ACTIVE_OPP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

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

const RESUME_KEY = 'zhimian.resume.analysis';

/**
 * 保存简历解析结果。
 * 落盘顺序：IndexedDB（永久，跨会话）→ sessionStorage（快速读取）→ 内存。
 * 练习状态（哪题练过、哪些 bullet 已覆盖）也写回同一条记录，刷新不丢。
 */
export function saveResumeAnalysis(data) {
  state.resumeAnalysis = data;
  const record = {
    id: data?.id || 'ra_' + Date.now().toString(36),
    filename: data?.filename || '',
    createdAt: data?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    profile: data?.profile || null,
    questions: (data?.questions || []).map((q) => ({
      id: q.id,
      q: q.q,
      why: q.why,
      focus: q.focus,
      difficulty: q.difficulty,
      locator: q.locator,
      bullets: q.bullets || [],
      sources: q.sources || [],
      viewpointCards: q.viewpointCards || [],
      practiced: Boolean(q.practiced),
      coveredBullets: q.coveredBullets || [],
    })),
  };

  // 1) 先同步写 sessionStorage：立刻生效，不被 IndexedDB 的等待拖住
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(record));
  } catch (err) {
    console.warn('简历上下文缓存失败', err);
  }

  // 2) 再异步写 IndexedDB（跨会话持久）；被旧标签页阻塞时降级为"仅本次会话"
  dbPut('resumeAnalyses', record)
    .then(() => {
      record.persisted = true;
      notify();
    })
    .catch((err) => {
      record.persisted = false;
      console.warn('简历解析结果写入 IndexedDB 失败（已降级为会话内保存）', err);
      notify();
    });

  notify();
  return record;
}

/** 更新单题状态（已练 / bullet 勾选），并回写 IndexedDB */
export async function updateResumeQuestionState(questionId, patch) {
  const current = state.resumeAnalysis;
  if (!current) return null;
  const questions = (current.questions || []).map((q) =>
    q.id === questionId ? { ...q, ...patch } : q
  );
  return saveResumeAnalysis({ ...current, questions });
}

/** 历史简历列表（可切换） */
export async function listResumeAnalyses() {
  try {
    const all = await dbGetAll('resumeAnalyses');
    return (all || []).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  } catch (err) {
    console.warn('简历历史读取失败', err);
    return [];
  }
}

export function loadResumeAnalysis() {
  if (state.resumeAnalysis) return state.resumeAnalysis;
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (raw) state.resumeAnalysis = JSON.parse(raw);
  } catch (err) {
    console.warn('简历上下文读取失败', err);
  }
  return state.resumeAnalysis;
}

/** 冷启动恢复：IndexedDB 里最近一份简历解析（不用每练一题就重新上传） */
export async function restoreLatestResumeAnalysis() {
  if (state.resumeAnalysis) return state.resumeAnalysis;
  // 1) 先看会话缓存（同一标签页刷新仍在）
  const fromSession = loadResumeAnalysis();
  if (fromSession) {
    notify();
    return fromSession;
  }
  // 2) 再看 IndexedDB（跨会话/关标签页仍在）
  const list = await Promise.race([
    listResumeAnalyses(),
    new Promise((resolve) => setTimeout(() => resolve([]), 2000)),
  ]);
  if (!list.length) return null;
  const latest = list[0];
  state.resumeAnalysis = latest;
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(latest));
  } catch {
    /* 忽略 */
  }
  notify();
  return latest;
}

export async function refreshLocalCollections() {
  // 本地库不可用时（升级被阻塞 / store 缺失）不能让首屏卡住：超时即用空列表继续
  const withTimeout = (promise, fallback) =>
    Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(fallback), 1500)),
    ]);
  const [weaknesses, opportunities, sessions] = await withTimeout(
    Promise.all([
      dbGetAll('weaknesses').catch(() => []),
      dbGetAll('opportunities').catch(() => []),
      dbGetAll('sessions').catch(() => []),
    ]),
    [[], [], []]
  );
  state.weaknesses = weaknesses;
  state.opportunities = opportunities;
  state.sessions = sessions;
  const badge = document.getElementById('nav-review-badge');
  if (badge) {
    const pendingCount = state.weaknesses.filter((w) => w.status !== 'mastered').length;
    badge.textContent = String(pendingCount);
    badge.hidden = false; // 空也显示（浅灰 0）：让用户一开始就知道这里能攒东西
    badge.classList.toggle('is-empty', pendingCount === 0);
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
 * 加载题单（bundles）。
 * 题单把 92 道主库真题按方向与难度梯度组织成场景化精选；
 * 「通用软素质专项」额外带 12 道已有逐字校验观点卡的软素质题（extra:true），
 * 它们只在题单里出现，不进主库列表（避免主库被通用软题稀释）。
 */
export async function loadBundles() {
  try {
    const res = await fetch('./data/bundles.json');
    if (!res.ok) return;
    const json = await res.json();
    const bundles = Array.isArray(json.bundles) ? json.bundles : [];
    const extras = Array.isArray(json.extraQuestions) ? json.extraQuestions : [];
    state.bundles = bundles;
    state.bundleById = new Map(bundles.map((b) => [b.id, b]));
    // 专项题并入题库索引（标记 extra），这样它们也能走完整拆逻辑 → 追问 → 复盘链路
    const known = new Set(state.bank.map((q) => q.id));
    for (const q of extras) {
      if (!known.has(q.id)) {
        state.bank.push({ ...q, extra: true });
        known.add(q.id);
      }
    }
  } catch (err) {
    console.error('题单加载失败:', err);
  }
  // 题单是延后加载的（冷启动时和题库请求一起发会被网关限流），
  // 屏幕可能已经渲染完了 —— 广播一个事件让题库页补渲染题单区。
  window.dispatchEvent(new CustomEvent('zhimian:bundles-ready'));
  notify();
}

/** 公网分享口令：URL 里的 ?k= 存进 sessionStorage，所有 /api 请求自动带上 */
const SHARE_TOKEN_KEY = 'zhimian.share.token';
const DEFAULT_PUBLIC_TOKEN = 'zhimian--BqObUY_K7QAxrMB';

export function getShareToken() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('k');
    if (fromUrl) {
      sessionStorage.setItem(SHARE_TOKEN_KEY, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(SHARE_TOKEN_KEY) || DEFAULT_PUBLIC_TOKEN;
  } catch {
    return DEFAULT_PUBLIC_TOKEN;
  }
}

/** 给 fetch 补上分享口令 */
export function withShareToken(init = {}) {
  const token = getShareToken();
  if (!token) return init;
  const headers = new Headers(init.headers || {});
  headers.set('x-share-token', token);
  return { ...init, headers };
}

/**
 * 加载离线演示保底包（静态 JSON，不依赖后端）。
 * 拿不到就安静降级，不影响主流程。
 */
export async function loadDemoReports() {
  try {
    const res = await fetch('/data/demo-reports.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.demoReports = Array.isArray(data?.reports) ? data.reports : [];
  } catch {
    state.demoReports = [];
  }
  return state.demoReports;
}

/**
 * 读取知乎登录态。
 * 401 = 未登录（正常）；501 = 服务端没配 OAuth 凭据 → 前端把登录入口整个隐藏。
 */
export async function loadAuthUser() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (res.status === 501) {
      state.oauthAvailable = false;
      state.user = null;
      notify();
      return null;
    }
    state.oauthAvailable = true;
    if (!res.ok) {
      state.user = null;
      notify();
      return null;
    }
    const data = await res.json();
    state.user = data?.user || null;
  } catch {
    state.user = null;
    state.oauthAvailable = false;
  }
  notify();
  return state.user;
}

/**
 * 检查 BFF 健康状态（显式提示降级，不静默）
 */
export async function checkBackendHealth() {
  const pill = document.getElementById('system-status-pill');
  getShareToken();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    const res = await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    state.health = { checked: true, ...data };
    const caps = data.capabilities || {};
    if (caps.resume === false) {
      if (pill) {
        pill.className = 'status-pill status-degraded';
        pill.textContent = '◐ 后端版本过旧（缺简历出题）';
      }
      setDegraded('当前后端是旧版本实例，没有「简历出题」接口。请在项目目录执行 npm run dev:restart 重启为最新实例。');
      return;
    }
    if (pill) {
      if (data.ok && data.llmConfigured) {
        pill.className = 'status-pill status-online';
        pill.textContent = '● 知乎语料已连接';
        // 把成本看板塞进 hover：今天用了多少次模型/知乎额度，演示前自己心里有数
        const u = data.usage || {};
        const llmCalls = u.llm?.calls ?? 0;
        const zhCalls = u.zhihu?.calls ?? 0;
        pill.title =
          '知乎语料与模型服务均在线' +
          (llmCalls || zhCalls
            ? `｜本次启动以来：模型调用 ${llmCalls} 次、知乎检索 ${zhCalls} 次`
            : '');
      } else if (data.ok && data.zhihuConfigured) {
        pill.className = 'status-pill status-degraded';
        pill.textContent = '◐ 本地离线模式（练习记录正常保存）';
        pill.title = '模型服务未配置：已切换本地确定性规则模式，练习记录照常保存在本机';
        setDegraded(
          '后端模型服务暂未配置，已自动切换「本地确定性规则模式」。' +
            '【仍可用】浏览题库、录音与转写、10 条原话级诊断、历史复盘与弹药库；' +
            '【暂不可用】模型评分与知乎实时检索。'
        );
      } else {
        pill.className = 'status-pill status-degraded';
        pill.textContent = '◐ 本地离线模式（练习记录正常保存）';
        pill.title = '知乎语料暂不可用：本地题库与规则引擎照常工作，练习记录保存在本机';
        setDegraded(
          '知乎语料接口暂不可用，已切换本地题库 + 确定性规则引擎。' +
            '【仍可用】浏览本地题库、录音与转写、10 条原话级诊断、历史复盘与弹药库、数据导出；' +
            '【暂不可用】知乎实时检索与观点卡对照。'
        );
      }
    }
  } catch (_) {
    state.health = { checked: true, ok: false, zhihuConfigured: false, llmConfigured: false, bankSize: state.bank.length };
    if (pill) {
      pill.className = 'status-pill status-degraded';
      pill.textContent = '◐ 本地离线模式（练习记录正常保存）';
      pill.title = '后端未启动：本地题库 + 确定性规则引擎可用，练习记录保存在本机';
    }
    setDegraded(
      '当前为纯静态预览/离线模式（BFF 未启动）。' +
        '【仍可用】浏览本地题库与搜索、录音与转写、10 条确定性规则诊断、查看历史复盘与弹药库台账、数据导出；' +
        '【暂不可用】模型评分、知乎实时检索、简历出题与答辩预测。'
    );
  }
  notify();
}
