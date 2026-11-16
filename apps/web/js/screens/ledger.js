import { state, refreshLocalCollections } from '../state.js';
import { navigate } from '../router.js';
import { escapeHtml } from '../ui/citation.js';
import { dbPut, dbDelete } from '../db.js';
import { showToast } from '../ui/toast.js';

const OPP_STATES = ['已投递', '一面', '二面', 'HR面', '已拿Offer', '已挂复盘'];

export function renderLedgerScreen(root) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
      <div>
        <h1 style="margin:0 0 4px;font-size:20px;">弹药库台账 & 优先复习置顶队列（M11 回流闭环）</h1>
        <div style="font-size:13px;color:var(--text-secondary);">复盘中标记的薄弱点自动置顶；支持一键生成针对性练习题</div>
      </div>
      <button id="btn-add-opp" class="btn btn-primary btn-sm" type="button">+ 新增面试 / 答辩场次</button>
    </div>

    <div class="grid-2" style="align-items:start;">
      <!-- 左侧：优先复习队列 -->
      <section class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h2 style="margin:0;font-size:16px;">🔥 优先复习置顶队列（薄弱点弹药库）</h2>
          <span class="tag tag-red">${state.weaknesses.length} 项待攻克</span>
        </div>
        <div id="weakness-list" style="display:flex;flex-direction:column;gap:10px;"></div>
      </section>

      <!-- 右侧：机会与答辩场次状态机 -->
      <section class="card">
        <h2 style="margin:0 0 12px;font-size:16px;">📋 面试 / 答辩场次追踪（标记「已挂」自动归因回流）</h2>
        <div id="opp-list" style="display:flex;flex-direction:column;gap:10px;"></div>
      </section>
    </div>
  `;
  root.appendChild(wrapper);

  const weakBox = wrapper.querySelector('#weakness-list');
  const oppBox = wrapper.querySelector('#opp-list');

  const renderWeaknesses = () => {
    if (!state.weaknesses.length) {
      weakBox.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:16px 0;text-align:center;">暂无待复习薄弱点。在复盘台点击「标记薄弱点」或讲解室点击「这个我没懂」会自动置顶至此。</div>`;
      return;
    }
    weakBox.innerHTML = '';
    state.weaknesses.forEach((w) => {
      const el = document.createElement('div');
      el.style.padding = '12px';
      el.style.border = '1px solid #fecdca';
      el.style.background = '#fffbfa';
      el.style.borderRadius = '8px';
      el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span class="tag tag-red">置顶优先复习</span>
          <span style="font-size:12px;color:var(--text-muted);">${escapeHtml(w.track || '综合')}</span>
        </div>
        <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${escapeHtml(w.questionTitle)}</div>
        <div style="font-size:12px;color:var(--amber);margin-bottom:10px;">归因：${escapeHtml(w.attribution)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button type="button" class="btn btn-sm btn-remove-wk">已掌握移除</button>
          <button type="button" class="btn btn-primary btn-sm btn-practice-wk">立即针对练习 →</button>
        </div>
      `;
      el.querySelector('.btn-remove-wk').addEventListener('click', async () => {
        await dbDelete('weaknesses', w.id);
        await refreshLocalCollections();
        renderWeaknesses();
        showToast('已标记为掌握');
      });
      el.querySelector('.btn-practice-wk').addEventListener('click', () => {
        const targetQ = state.bank.find((q) => q.id === w.questionId) || state.bank[0];
        if (targetQ) state.activeQuestion = targetQ;
        navigate('/coach');
      });
      weakBox.appendChild(el);
    });
  };

  const renderOpps = async () => {
    if (!state.opportunities.length) {
      const seedOpp = {
        id: 'opp-seed-1',
        company: 'AI Agent 核心研发岗（模拟样例）',
        stage: '二面',
        note: '重点考察 RAG 确定性评测与高并发队列'
      };
      await dbPut('opportunities', seedOpp);
      await refreshLocalCollections();
    }
    oppBox.innerHTML = '';
    state.opportunities.forEach((opp) => {
      const el = document.createElement('div');
      el.style.padding = '12px';
      el.style.border = '1px solid var(--border)';
      el.style.borderRadius = '8px';
      el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">
          <strong style="font-size:14px;">${escapeHtml(opp.company)}</strong>
          <select class="select stage-select" style="width:auto;padding:4px 8px;font-size:12px;">
            ${OPP_STATES.map((s) => `<option value="${s}" ${opp.stage === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <div style="font-size:12px;color:var(--text-secondary);">${escapeHtml(opp.note || '')}</div>
      `;
      el.querySelector('.stage-select').addEventListener('change', async (e) => {
        const newStage = e.target.value;
        opp.stage = newStage;
        await dbPut('opportunities', opp);
        if (newStage === '已挂复盘') {
          const fallbackQ = state.bank[0];
          await dbPut('weaknesses', {
            id: 'wk-opp-' + opp.id,
            questionId: fallbackQ?.id || 'q-rag-eval-01',
            questionTitle: `【复盘归因】${opp.company} 失利薄弱项`,
            track: fallbackQ?.track || 'AI Agent & RAG',
            attribution: '场次标记为「已挂复盘」，自动触发高频真题强化',
            priority: 'pinned',
            status: 'pending'
          });
          await refreshLocalCollections();
          renderWeaknesses();
          showToast('已自动将归因薄弱项置顶至左侧「优先复习」队列', 'warn');
        }
      });
      oppBox.appendChild(el);
    });
  };

  wrapper.querySelector('#btn-add-opp').addEventListener('click', async () => {
    const name = window.prompt('请输入公司/岗位或答辩场次名称：', '字节跳动 · AI Infra 实习一面');
    if (!name) return;
    await dbPut('opportunities', {
      id: 'opp-' + Date.now(),
      company: name.trim(),
      stage: '一面',
      note: '待完成赛前模拟陪练'
    });
    await refreshLocalCollections();
    renderOpps();
  });

  renderWeaknesses();
  renderOpps();
}
