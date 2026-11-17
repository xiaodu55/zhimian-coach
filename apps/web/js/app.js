import { registerRoute, initRouter } from './router.js';
import { loadQuestionBank, checkBackendHealth, refreshLocalCollections, setDegraded } from './state.js';
import { exportAllData, importAllData, resetLocalData } from './db.js';
import { initCitationModal } from './ui/citation.js';
import { showToast } from './ui/toast.js';
import { renderBankScreen } from './screens/bank.js';
import { renderCoachScreen } from './screens/coach.js';
import { renderReviewScreen } from './screens/review.js';
import { renderExplainScreen } from './screens/explain.js';
import { renderLedgerScreen } from './screens/ledger.js';

async function bootstrap() {
  initCitationModal();

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

  // 注册 5 个核心页面路由
  registerRoute('bank', renderBankScreen);
  registerRoute('coach', renderCoachScreen);
  registerRoute('review', renderReviewScreen);
  registerRoute('explain', renderExplainScreen);
  registerRoute('ledger', renderLedgerScreen);

  // 先加载本地种子题库并立即渲染首屏（保证 <= 1.5s 可交互）
  await loadQuestionBank();
  await refreshLocalCollections();
  initRouter();

  // 异步探测 BFF 健康状态（显式降级提示）
  checkBackendHealth();
}

bootstrap();
