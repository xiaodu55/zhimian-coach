import { registerRoute, initRouter } from './router.js';
import {
  loadQuestionBank,
  loadBundles,
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
import { importWithRetry } from './lib/http.js';
/**
 * 屏幕模块按需加载。
 * 为什么不用静态 import：静态 import 会让首屏一次性并发 11+ 个模块请求，
 * 云端网关会限流（429 Too Many Requests），表现为首屏骨架屏卡 4~6 秒，
 * 甚至模块图加载失败。改成按需加载后，首屏只请求 app.js + 当前屏两个模块。
 */
const lazyScreen = (file, exportName) => async (root) => {
  // 用带重试的动态 import：网关会限流（429），单个模块偶发被掐掉时重试即可。
  // 必须用 import.meta.url 解析成绝对 URL：
  // 动态 import 的相对路径基准是「发起 import 的那个模块所在目录」，
  // 而 importWithRetry 定义在 js/lib/http.js 里，直接传 './screens/x.js' 会变成 /js/lib/screens/x.js。
  const url = new URL(`./screens/${file}`, import.meta.url).href;
  const mod = await importWithRetry(url, { attempts: 4, backoffMs: 700 });
  return mod[exportName](root);
};

/**
 * 公网分享口令 + 429 退避重试。
 *
 * 两件事都在 fetch 层统一做，避免每个调用点改一遍：
 * 1) 口令注入：后台配置了 PUBLIC_SHARE_TOKEN 时，所有 /api 请求都带 x-share-token。
 *    AI Works 项目广场内嵌 iframe 固定访问裸域名（不带 ?k=），不回退默认口令的话
 *    广场内所有 /api/* 都会 401 退化为离线规则模式；裸扫接口的爬虫不走前端，
 *    没有 x-share-token 头，服务端照样 401 拦截。
 * 2) 429 退避重试：云函数网关对并发请求有速率上限，**冷启动首屏**并发十几个
 *    （模块 + 题库 + 题单 + 离线包 + 健康检查）会被限流打回 429，
 *    表现是首屏空白（实测：/api/bank、/data/*.json 全部 429）。
 *    这里对 429/5xx 自动退避重试，让"被限流"退化成"慢一点"，而不是"打不开"。
 */
function installShareTokenInterceptor() {
  const KEY = 'zhimian.share.token';
  const DEFAULT_PUBLIC_TOKEN = 'zhimian--BqObUY_K7QAxrMB';
  const nativeFetch = window.fetch.bind(window);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const isApi = url.includes('/api/');
    let headers;
    if (isApi) {
      let token = '';
      try {
        const fromUrl = new URLSearchParams(location.search).get('k') || '';
        if (fromUrl) sessionStorage.setItem(KEY, fromUrl);
        token = fromUrl || sessionStorage.getItem(KEY) || DEFAULT_PUBLIC_TOKEN;
      } catch {
        token = DEFAULT_PUBLIC_TOKEN;
      }
      headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
      if (token) headers.set('x-share-token', token);
    }

    const doFetch = () => nativeFetch(input, headers ? { ...init, headers } : init);

    let res;
    // 最多试 6 次：冷启动时限流窗口可能横跨好几秒，
    // 累计退避约 9s，足够穿过网关的突发限流（实测首屏 3s 内就能拿到题库）
    for (let attempt = 0; attempt <= 5; attempt++) {
      res = await doFetch();
      // 429 = 网关限流，5xx = 实例刚起还没热；两种都值得等一下再试
      if (res.status !== 429 && res.status < 500) break;
      if (attempt === 5) break;
      await sleep(600 * (attempt + 1));
    }
    return res;
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

  // 先加载题库并立即渲染首屏（保证 <= 1.5s 可交互）
  await loadQuestionBank();
  await refreshLocalCollections();
  initRouter();

  // 首屏之外的请求延后发起：冷启动时网关对并发请求有速率上限，
  // 把这些"锦上添花"的请求（题单 / 离线兜底包 / 登录态 / 健康探测）挪到首屏之后，
  // 避免它们和题库请求一起被 429 打回。
  setTimeout(() => { loadBundles(); }, 120);
  setTimeout(() => { loadDemoReports(); }, 260);
  // 登录态与健康探测再往后挪：它们只影响状态灯/登录入口，
  // 冷启动时先让题库与题单把配额用上（实测这两个接口更容易撞限流）
  setTimeout(() => {
    loadAuthUser().then(() => renderAuthArea());
    checkBackendHealth();
  }, 1200);

}

bootstrap();
