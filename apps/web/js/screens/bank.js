import { state } from '../state.js';
import { navigate } from '../router.js';
import { escapeHtml } from '../ui/citation.js';
import { renderViewpointCard } from '../ui/components.js';
import { runDeterministicRules } from '../rules/diagnose.js';
import { dbPut } from '../db.js';
import { showToast } from '../ui/toast.js';

export function renderBankScreen(root) {
  const tracks = ['全部赛道', ...new Set(state.bank.map((q) => q.track))];
  let selectedTrack = '全部赛道';
  let keyword = '';

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <section class="hero-banner" aria-label="产品定位与一键体验">
      <div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
          <span class="tag tag-blue">知乎黑客松 S3 · AI × 陪伴与交互</span>
          <span class="tag">每条诊断均锚定知乎多元观点</span>
        </div>
        <h1 class="hero-title">知面陪练：把“答得像不像”变成“每句有出处”</h1>
        <p class="hero-desc">
          闭环覆盖 <strong>读懂资料 → 开口说清 → 被追问压力测试 → 查清楚来源</strong>。
          结合 10 条确定性原话诊断规则与知乎高赞/分歧观点卡，拒绝单一模型口味幻觉。
        </p>
        <div class="hero-actions">
          <button id="btn-quick-demo" class="btn btn-primary" type="button">⚡ 30 秒免麦一键体验完整闭环</button>
          <button id="btn-go-defense" class="btn" type="button">🎓 上传论文 / 预测答辩追问</button>
          <button id="btn-go-explain" class="btn" type="button">📖 文档可溯源详解</button>
        </div>
      </div>
    </section>

    <section class="card" style="margin-bottom:18px;">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between;">
        <div id="track-filters" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
        <div style="min-width:240px;flex:1;max-width:340px;">
          <input id="bank-search-input" class="input" type="search" placeholder="搜索真题、考点词或知乎观点…" />
        </div>
      </div>
    </section>

    <div id="bank-list" class="grid-2"></div>
  `;
  root.appendChild(wrapper);

  // 评委一键体验流（静音免麦，直接加载预设带瑕疵回答跑通规则诊断 + 三方对照）
  wrapper.querySelector('#btn-quick-demo').addEventListener('click', async () => {
    const sample = state.demoSample;
    const q = state.bank.find((item) => item.id === sample?.questionId) || state.bank[0];
    if (!q) return;
    // 只取第一段"我："的回答，遇到下一位"面试官："就截断（否则会把后续对话也当成回答）
    const answerText = (sample?.rawText.split('\n我：')[1] || '').split('\n面试官：')[0]
      || '我们在项目里用了大模型评估，效果提升了 93%，后来发现还可以。';
    const findings = runDeterministicRules(answerText, q);
    const report = {
      id: 'session-demo-' + Date.now(),
      question: q,
      answer: answerText,
      ruleFindings: findings,
      llmScores: null,
      degraded: true,
      createdAt: new Date().toISOString()
    };
    state.activeQuestion = q;
    state.lastReviewReport = report;
    await dbPut('sessions', report);
    showToast('已生成演示复盘报告（命中 ' + findings.length + ' 条原话级诊断）');
    navigate('/review');
  });

  wrapper.querySelector('#btn-go-defense').addEventListener('click', () => navigate('/explain'));
  wrapper.querySelector('#btn-go-explain').addEventListener('click', () => navigate('/explain'));

  const trackBox = wrapper.querySelector('#track-filters');
  const listBox = wrapper.querySelector('#bank-list');
  const searchInput = wrapper.querySelector('#bank-search-input');

  const renderTracks = () => {
    trackBox.innerHTML = '';
    tracks.forEach((t) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn-sm ${selectedTrack === t ? 'btn-primary' : ''}`;
      btn.textContent = t;
      btn.addEventListener('click', () => {
        selectedTrack = t;
        renderTracks();
        renderList();
      });
      trackBox.appendChild(btn);
    });
  };

  const renderList = () => {
    const filtered = state.bank.filter((q) => {
      const matchTrack = selectedTrack === '全部赛道' || q.track === selectedTrack;
      const kw = keyword.trim().toLowerCase();
      const matchKw = !kw || q.title.toLowerCase().includes(kw) || q.context.toLowerCase().includes(kw);
      return matchTrack && matchKw;
    });

    if (!filtered.length) {
      listBox.innerHTML = `<div class="card" style="grid-column:1/-1;text-align:center;color:var(--text-muted);">未找到匹配的真题，请尝试清空筛选条件。</div>`;
      return;
    }

    listBox.innerHTML = '';
    filtered.forEach((q) => {
      const card = document.createElement('article');
      card.className = 'card';
      card.style.display = 'flex';
      card.style.flexDirection = 'column';
      card.style.justifyContent = 'space-between';
      card.innerHTML = `
        <div>
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
            <span class="tag tag-blue">${escapeHtml(q.track)}</span>
            <span class="tag">${escapeHtml(q.difficulty)}</span>
            ${q.viewpointCards?.length
              ? `<span class="tag tag-green">${q.viewpointCards.length} 张知乎观点卡</span>`
              : `<span class="tag tag-amber">观点卡待补（来源已抓取）</span>`}
          </div>
          <h3 style="margin:0 0 8px;font-size:16px;line-height:1.45;">${escapeHtml(q.title)}</h3>
          <p style="margin:0 0 12px;font-size:13px;color:var(--text-secondary);">${escapeHtml(q.context)}</p>
          <div class="vp-preview" style="margin-bottom:12px;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:10px;border-top:1px solid var(--border);">
          <span style="font-size:12px;color:var(--text-muted);">考点：${escapeHtml((q.keywords || []).slice(0, 4).join(' / '))}</span>
          <button type="button" class="btn btn-primary btn-sm btn-start-coach">进入陪练 →</button>
        </div>
      `;
      if (q.viewpointCards?.[0]) {
        card.querySelector('.vp-preview').appendChild(renderViewpointCard(q.viewpointCards[0], 0));
      }
      card.querySelector('.btn-start-coach').addEventListener('click', () => {
        state.activeQuestion = q;
        navigate('/coach');
      });
      listBox.appendChild(card);
    });
  };

  searchInput.addEventListener('input', (e) => {
    keyword = e.target.value;
    renderList();
  });

  renderTracks();
  renderList();
}
