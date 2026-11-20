import { registerRoute, initRouter } from './router.js';
import {
  loadQuestionBank,
  checkBackendHealth,
  refreshLocalCollections,
  setDegraded,
  loadDemoReports,
  loadAuthUser,
  state,
  subscribe,
} from './state.js';
import { exportAllData, importAllData, resetLocalData } from './db.js';
import { initCitationModal } from './ui/citation.js';
import { showToast } from './ui/toast.js';
/**
 * 屏幕模块按需加载。
 * 为什么不用静态 import：静态 import 会让首屏一次性并发 11+ 个模块请求，
 * 云端网关会限流（429 Too Many Requests），表现为首屏骨架屏卡 4~6 秒，
 * 甚至模块图加载失败。改成按需加载后，首屏只请求 app.js + 当前屏两个模块。
 */
const lazyScreen = (file, exportName) => async (root) => {
  const mod = await import(`./screens/${file}`);
  return mod[exportName](root);
};

/**
 * 公网分享口令：后台配置了 PUBLIC_SHARE_TOKEN 时，所有 /api 请求都要带 x-share-token。
 * 这里统一在 fetch 层注入，避免每个调用点都改一遍；没配置口令时完全无感。
 */
function installShareTokenInterceptor() {
  const KEY = 'zhimian.share.token';
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/api/')) return nativeFetch(input, init);
    let token = '';
    try {
      token = sessionStorage.getItem(KEY) || new URLSearchParams(location.search).get('k') || '';
      if (token) sessionStorage.setItem(KEY, token);
    } catch {
      /* 隐私模式忽略 */
    }
    if (!token) return nativeFetch(input, init);
    const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
    headers.set('x-share-token', token);
    return nativeFetch(input, { ...init, headers });
  };
}

/** 顶栏登录区：没配 OAuth 就不显示；有登录就显示昵称与退出 */
function renderAuthArea() {
  const host = document.getElementById('auth-area');
  if (!host) return;
  host.innerHTML = '';
  if (!state.oauthAvailable) return; // 服务端没配凭据 → 入口整个隐藏，不给评委一个点不动的按钮
  if (state.user) {
    const tag = document.createElement('span');
    tag.className = 'tag tag-green';
    tag.textContent = `知乎 · ${state.user.name}`;
    const out = document.createElement('a');
    out.className = 'btn btn-ghost btn-sm';
    out.href = '/api/auth/logout';
    out.textContent = '退出';
    host.append(tag, out);
    return;
  }
  const login = document.createElement('a');
  login.className = 'btn btn-sm';
  login.href = '/api/auth/zhihu/start';
  login.textContent = '用知乎账号登录';
  host.appendChild(login);
}

async function bootstrap() {
  installShareTokenInterceptor();
  initCitationModal();
  subscribe(renderAuthArea);

  // 关闭降级横幅按钮
  document.getElementById('btn-dismiss-banner')?.addEventListener('click', () => {
    setDegraded(null);
  });

  // 导出本地 IndexedDB 备份
  document.getElementById('btn-export-data')?.addEventListener('click', async () => {
    const dump = await exportAllData();
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zhimian-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('本地备份 JSON 已导出');
  });

  // 导入本地备份
  document.getElementById('input-import-data')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      await importAllData(JSON.parse(text));
      await refreshLocalCollections();
      showToast('本地备份恢复成功');
    } catch (err) {
      showToast('导入失败：' + err.message, 'error');
    }
  });

  // 重置本地数据（本地库升级被旧标签页阻塞时，先清库再刷新）
  document.getElementById('btn-reset-data')?.addEventListener('click', async () => {
    if (!window.confirm('将清空本机 IndexedDB 里的录音、转写稿、薄弱点与简历解析记录（无法恢复），确定吗？')) return;
    await resetLocalData();
    showToast('本地数据已清空，正在刷新…');
    setTimeout(() => location.reload(), 600);
  });

  // 注册 6 个核心页面路由
  registerRoute('bank', lazyScreen('bank.js', 'renderBankScreen'));
  registerRoute('coach', lazyScreen('coach.js', 'renderCoachScreen'));
  registerRoute('review', lazyScreen('review.js', 'renderReviewScreen'));
  registerRoute('explain', lazyScreen('explain.js', 'renderExplainScreen'));
  registerRoute('defense', lazyScreen('defense.js', 'renderDefenseScreen'));
  registerRoute('ledger', lazyScreen('ledger.js', 'renderLedgerScreen'));

  // 先加载本地种子题库并立即渲染首屏（保证 <= 1.5s 可交互）
  await loadQuestionBank();
  await loadDemoReports();
  await refreshLocalCollections();
  await loadAuthUser();
  renderAuthArea();
  initRouter();

  // 异步探测 BFF 健康状态（显式降级提示）
  checkBackendHealth();
}

bootstrap();
