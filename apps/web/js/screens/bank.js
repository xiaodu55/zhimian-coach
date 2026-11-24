import { state } from '../state.js';
import { navigate } from '../router.js';
import { escapeHtml } from '../ui/citation.js';
import { runDeterministicRules } from '../rules/diagnose.js';
import { dbPut } from '../db.js';
import { showToast } from '../ui/toast.js';
import { createModal, modalButton } from '../ui/modal.js';
import { chunkDocumentText } from '../retrieval/chunk.js';
import { mountNextStepBar, createProgress } from '../lib/nextstep.js';
import { DOMAINS, DOMAIN_LABEL, domainOf, kindOf, domainCounts, fuzzySuggestions } from '../lib/domains.js';

export function renderBankScreen(root) {
  const tracks = ['全部赛道', ...new Set(state.bank.map((q) => q.track))];
  let selectedTrack = '全部赛道';
  let keyword = '';

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <section class="hero-banner" aria-label="产品定位与一键体验">
      <div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
          <span class="tag tag-blue">知乎真实语料驱动 · 面试与答辩 AI 陪练</span>
        </div>
        <h1 class="hero-title">别让“看懂了”变成面试时的“说不清”</h1>
        <p class="hero-desc">
          基于<strong>知乎真实技术与行业问答</strong>构建实战题库。先通过<strong>互动讲解</strong>吃透底层逻辑，
          再进入<strong>高压连环追问</strong>实战演练，把零散知识锤炼成随时可调用的面试“弹药库”。
        </p>
        <div class="hero-badges" style="display:flex;gap:16px;flex-wrap:wrap;margin:12px 0;color:var(--text-muted);font-size:12.5px;">
          <span>🔒 本地存储，录音与简历零上传</span>
          <span>📚 每条观点可点开知乎原文核对，不编答案</span>
          <span>⚡ 无需注册，打开即练</span>
        </div>
        <div class="hero-actions">
          <button id="btn-quick-demo" class="btn btn-primary hero-main-cta" type="button">免费开始 3 分钟实战演练 →</button>
          <div class="hero-secondary-links" aria-label="其他入口">
            <button id="btn-go-explain" class="hero-text-link" type="button">浏览题库 / 导入项目文档</button>
            <button id="btn-go-defense" class="hero-text-link" type="button">🎓 论文答辩预测</button>
            <button id="btn-offline-demo" class="hero-text-link hero-text-link-muted" type="button">离线演示</button>
          </div>
        </div>
      </div>
    </section>

    <!-- 旧的一键演示入口保留为隐藏按钮（评委用：加载预设带瑕疵回答跑完整闭环） -->
    <button id="btn-quick-demo-legacy" type="button" hidden>30 秒免麦一键体验完整闭环</button>

    <!-- 新用户破冰卡：只第一次显示，可关闭 -->
    <section id="onboarding-card" class="card onboarding-card" style="margin-bottom:18px;display:none;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
        <div>
          <strong style="font-size:15px;">开启你的第一场陪练</strong>
          <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;">选一个入口，30 秒内进入实战；所有记录只存在你自己的浏览器里。</div>
        </div>
        <button id="btn-onboarding-close" class="btn-icon" type="button" aria-label="关闭">✕</button>
      </div>
      <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
        <button id="btn-onboard-warmup" class="btn btn-primary btn-sm" type="button">① 我是来刷高频题的</button>
        <button id="btn-onboard-jd" class="btn btn-sm" type="button">② 我在准备具体面试 / 答辩</button>
      </div>
      <div id="onboard-warmup-panel" style="display:none;margin-top:12px;">
        <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:6px;">选个方向，我给你挑一道 5 分钟热身题：</div>
        <div id="onboard-directions" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
      </div>
      <div id="onboard-jd-panel" style="display:none;margin-top:12px;">
        <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:6px;">
          把 JD 粘贴进来，或把项目 / 论文摘要拖进来 → 生成 3 道只针对它的定制追问题：
        </div>
        <div id="onboard-dropzone" style="border:1px dashed var(--border);border-radius:8px;padding:14px;background:var(--surface-alt);">
          <textarea id="onboard-jd-input" class="textarea" rows="4" placeholder="例：负责 Agent 平台的工具调用与权限治理，要求有 RAG 评测与高并发队列经验…"></textarea>
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center;">
            <label class="btn btn-sm">
              📄 拖入 / 选择文件（PDF / MD / TXT）
              <input id="onboard-jd-file" type="file" accept=".pdf,.md,.txt,.markdown" hidden />
            </label>
            <button id="btn-onboard-jd-generate" class="btn btn-primary btn-sm" type="button">生成 3 道定制题 →</button>
            <span id="onboard-jd-status" style="font-size:12px;color:var(--text-muted);"></span>
          </div>
        </div>
        <div id="onboard-jd-questions" style="display:flex;flex-direction:column;gap:8px;margin-top:10px;"></div>
      </div>

      <!-- 题单：把 92 道真题按方向与难度梯度组织成场景化精选，30 秒定位对口题 -->
      <div style="margin-top:14px;border-top:1px dashed var(--border);padding-top:12px;">
        <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:8px;">
          <strong>③ 按场景挑题单</strong> · 每单都是「基础 → 进阶 → 难」的梯度，答完一单就能看出自己卡在哪
        </div>
        <div id="bundle-chips" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
        <div id="bundle-desc" style="font-size:12px;color:var(--text-muted);margin-top:8px;line-height:1.6;"></div>
      </div>
    </section>

    <!-- 双入口：按方向刷真题 / 定制我的项目答辩 -->
    <div class="card" style="margin-bottom:18px;">
      <div class="mode-switch" role="tablist" aria-label="题库入口" style="margin-bottom:12px;">
        <button type="button" class="btn btn-sm btn-primary" data-bank-tab="preset" role="tab">按方向刷真题</button>
        <button type="button" class="btn btn-sm" data-bank-tab="custom" role="tab">定制我的项目答辩</button>
      </div>

      <div id="bank-tab-preset">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between;">
          <div id="track-filters" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <select id="bank-category-filter" class="select" style="width:auto;padding:4px 8px;font-size:12px;" title="按类别筛选">
              <option value="">全部类别</option>
            </select>
            <select id="bank-difficulty-filter" class="select" style="width:auto;padding:4px 8px;font-size:12px;" title="按难度筛选">
              <option value="">全部难度</option>
              <option value="基础">基础</option>
              <option value="进阶">进阶</option>
              <option value="难">难</option>
            </select>
            <select id="bank-pagesize-filter" class="select" style="width:auto;padding:4px 8px;font-size:12px;" title="每页显示条数">
              <option value="12">每页 12 条</option>
              <option value="24">每页 24 条</option>
              <option value="48">每页 48 条</option>
            </select>
            <div style="min-width:200px;flex:1;max-width:300px;">
              <input id="bank-search-input" class="input" type="search" placeholder="搜索真题、考点词或知乎观点…" />
            </div>
          </div>
        </div>
        <div id="bank-domain-note" style="font-size:11.5px;color:var(--text-muted);margin-top:8px;"></div>
        <div id="bundle-filter-bar" hidden style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px;padding:8px 10px;border:1px solid var(--primary);border-radius:8px;background:var(--primary-soft);font-size:12.5px;"></div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">
          每个方向 chip 后面的数字是这个方向现有的题量；点不开的方向说明还没收录，不用试。
        </div>
      </div>

      <div id="bank-tab-custom" hidden>
        <div class="grid-2" style="align-items:start;">
          <div>
            <strong style="font-size:14px;">粘贴一段项目 / 论文 / 技术方案</strong>
            <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;line-height:1.7;">
              本地切段 → 自动拆出 3–5 个核心技术点 → 按"被问概率"生成专属题单，置顶在真题列表之上。<br/>
              内容只在你自己的浏览器里解析与分段，不上传服务器。
            </div>
            <textarea id="custom-project-input" class="textarea" rows="8" style="margin-top:10px;"
              placeholder="例：负责 Agent 平台的工具调用与权限治理，用 PreToolUse 三级权限拦截高危命令；把 RAG 评测从 LLM 打分改成冻结评测集 + Recall@5 回归，线上误拦截率从 3% 降到 1.2%…"></textarea>
            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center;">
              <label class="btn btn-sm">
                📄 拖入 / 选择文件（PDF / MD / TXT）
                <input id="custom-project-file" type="file" accept=".pdf,.md,.txt,.markdown" hidden />
              </label>
              <button id="btn-custom-generate" class="btn btn-primary btn-sm" type="button">拆出技术点并生成题单 →</button>
              <span id="custom-status" style="font-size:12px;color:var(--text-muted);"></span>
            </div>
          </div>
          <div>
            <strong style="font-size:14px;">拆出的核心技术点</strong>
            <div id="custom-points" style="font-size:13px;color:var(--text-secondary);margin-top:6px;line-height:1.8;">
              还没有解析。粘贴内容后点左边按钮，这里会列出抽出的技术点与生成的定制题。
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="custom-questions-block" hidden style="margin-bottom:18px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;">
        <strong style="font-size:14px;">🎯 为你定制的题单</strong>
        <span class="tag tag-green" id="custom-count">0 道</span>
      </div>
      <div id="custom-questions-list" class="grid-2"></div>
    </div>

    <div id="bank-list" class="grid-2"></div>
    <div id="bank-pager" style="display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap;margin:18px 0 4px;"></div>
  `;
  root.appendChild(wrapper);

  // 主 CTA「免费开始 3 分钟实战演练」：跳过空状态，直接进拆逻辑卡片 → 陪练室深挖 → 复盘
  wrapper.querySelector('#btn-quick-demo').addEventListener('click', () => {
    const pool = state.bank.filter((q) => q.difficulty === '基础');
    const warm = pool[0] || state.bank[0];
    if (!warm) return;
    localStorage.setItem('zhimian.onboard.done', '1');
    onboarding.style.display = 'none';
    openLogicCard(warm);
  });

  // 离线演示：用预置的真实复盘报告走一遍闭环（模型/网络不可用时的保底）
  wrapper.querySelector('#btn-offline-demo').addEventListener('click', async () => {
    const reports = state.demoReports || [];
    if (!reports.length) {
      showToast('预置报告还没加载好，稍等一下再试（或先联网跑一次生成）', 'warn', 4000);
      return;
    }
    const pick = reports[Math.floor(Math.random() * reports.length)];
    const report = { ...pick.report };
    // 规则层是确定性、零成本的，本地补上（预置包里只存了模型层结果）
    report.ruleFindings = runDeterministicRules(pick.answer || '', pick.question || {});
    state.lastReviewReport = report;
    await dbPut('sessions', report);
    showToast('已载入预置复盘报告（离线可演）');
    navigate('/review');
  });

  // 次 CTA「浏览题库 / 导入我的项目文档」：滚到题库列表
  wrapper.querySelector('#btn-go-explain').addEventListener('click', () => {
    listBox?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast('下面就是全部真题；要导入自己的项目文档，去「拆逻辑」页上传');
  });

  // 评委一键体验流（静音免麦，直接加载预设带瑕疵回答跑通规则诊断 + 三方对照）
  wrapper.querySelector('#btn-quick-demo-legacy').addEventListener('click', async () => {
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

  wrapper.querySelector('#btn-go-defense').addEventListener('click', () => navigate('/defense'));

  // ---- 拆逻辑卡片：先看骨架再开口（避免对着空白麦克风卡壳） ----
  const openLogicCard = (q, extra = {}) => {
    const skeleton = (q.skeleton || []).filter((s) => !/^注意避开/.test(String(s)));
    const cautions = (q.skeleton || []).filter((s) => /^注意避开/.test(String(s)));
    const points = (skeleton.length ? skeleton : ['先复述问题，确认听到的是同一件事', '给一个可核对的数字与口径', '讲清你的判断与取舍']).slice(0, 3);

    const modal = createModal({
      title: '先拆逻辑，再开口',
      subtitle: q.q || '',
      width: 640,
    });

    const body = document.createElement('div');
    body.style.cssText = 'font-size:13.5px;line-height:1.75;';
    body.innerHTML = `
      <div style="margin-bottom:10px;">
        <span class="tag tag-blue">考察意图</span>
        <div style="margin-top:4px;color:var(--text-secondary);">${escapeHtml(q.context || extra.context || '（未标注）')}</div>
      </div>
      <div style="margin-bottom:10px;">
        <span class="tag tag-green">3 个核心得分点</span>
        <ul style="margin:6px 0 0;padding-left:18px;">
          ${points.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}
        </ul>
      </div>
      ${
        cautions.length
          ? `<details style="margin-bottom:10px;">
               <summary style="cursor:pointer;font-size:12.5px;color:var(--amber);">避开这 ${cautions.length} 个坑</summary>
               <ul style="margin:6px 0 0;padding-left:18px;color:var(--text-secondary);">
                 ${cautions.map((c) => `<li>${escapeHtml(c.replace(/^注意避开[：:]\s*/, ''))}</li>`).join('')}
               </ul>
             </details>`
          : ''
      }
      ${
        q.viewpointCards?.length
          ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">这一题的评分基准来自 ${q.viewpointCards.length} 张知乎观点卡，作答时会逐句对照。</div>
             <div style="display:flex;flex-direction:column;gap:6px;">
               ${(q.viewpointCards || [])
                 .slice(0, 2)
                 .map(
                   (vc, i) => `<div style="font-size:12.5px;line-height:1.6;">
                      <span class="tag ${vc.stance && vc.stance.includes('主流') ? 'tag-blue' : 'tag-amber'}" style="margin-right:6px;">${escapeHtml(vc.stance || '观点')}</span>
                      ${escapeHtml(String(vc.summary || '').slice(0, 46))}…
                      ${
                        vc.sourceUrl
                          ? `<a href="${escapeHtml(vc.sourceUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--primary);white-space:nowrap;">看原答 ${i + 1} ↗</a>`
                          : ''
                      }
                    </div>`
                 )
                 .join('')}
             </div>`
          : ''
      }
    `;
    modal.body.appendChild(body);

    const go = modalButton('我准备好了，开始作答 →', {
      primary: true,
      onClick: () => {
        state.activeQuestion = { ...q, ...extra, viewpointCards: q.viewpointCards || extra.viewpointCards || [] };
        state.questionPickedByUser = true;
        modal.close();
        navigate('/coach');
      },
    });
    const later = modalButton('先看看别的', { ghost: true, onClick: () => modal.close() });
    modal.footer.append(later, go);
  };

  // ---- 新用户破冰：只第一次出现 ----
  const onboarding = wrapper.querySelector('#onboarding-card');
  const onboardPanel = (id) => {
    wrapper.querySelector('#onboard-warmup-panel').style.display = id === 'warmup' ? 'block' : 'none';
    wrapper.querySelector('#onboard-jd-panel').style.display = id === 'jd' ? 'block' : 'none';
  };
  const showOnboarding = () => {
    if (localStorage.getItem('zhimian.onboard.done')) return;
    onboarding.style.display = 'block';
  };
  wrapper.querySelector('#btn-onboarding-close').addEventListener('click', () => {
    onboarding.style.display = 'none';
    localStorage.setItem('zhimian.onboard.done', '1');
  });
  wrapper.querySelector('#btn-onboard-warmup').addEventListener('click', () => onboardPanel('warmup'));
  wrapper.querySelector('#btn-onboard-jd').addEventListener('click', () => onboardPanel('jd'));

  // 方向 → 高亮一道 5 分钟热身题
  const DIRECTIONS = [
    { key: 'ai', label: '后端 / AI 工程', match: (q) => /AI|Agent|RAG|后端|工程|架构|系统/.test(q.track + q.title) },
    { key: 'product', label: '产品 / 运营', match: (q) => /产品|运营|增长|用户|商业/.test(q.track + q.title) },
    { key: 'general', label: '通用综合', match: () => true },
  ];
  const dirBox = wrapper.querySelector('#onboard-directions');
  DIRECTIONS.forEach((d) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm';
    btn.textContent = d.label;
    btn.addEventListener('click', () => {
      const pool = state.bank.filter(d.match);
      const warm = pool.find((q) => q.difficulty === '基础') || pool[0] || state.bank[0];
      if (!warm) return;
      localStorage.setItem('zhimian.onboard.done', '1');
      onboarding.style.display = 'none';
      showToast(`给你挑了热身题：${warm.title.slice(0, 24)}…`);
      // 高亮 + 滚到该题
      renderList();
      setTimeout(() => {
        const cards = Array.from(listBox.querySelectorAll('.card'));
        const target = cards.find((c) => c.innerText.includes(warm.title.slice(0, 18)));
        if (target) {
          target.style.outline = '2px solid var(--primary)';
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => (target.style.outline = ''), 6000);
        }
      }, 60);
      openLogicCard(warm);
    });
    dirBox.appendChild(btn);
  });

  // JD / 摘要 → 3 道定制追问题
  const jdStatus = wrapper.querySelector('#onboard-jd-status');
  const jdQuestions = wrapper.querySelector('#onboard-jd-questions');
  const jdInput = wrapper.querySelector('#onboard-jd-input');
  wrapper.querySelector('#onboard-jd-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    jdStatus.textContent = '读取 ' + file.name + ' …';
    try {
      const text = file.name.toLowerCase().endsWith('.pdf') ? '' : await file.text();
      if (text) jdInput.value = text.slice(0, 3000);
      else jdStatus.textContent = 'PDF 需要 OCR：请把关键几段粘贴进文本框';
    } catch (err) {
      jdStatus.textContent = '读取失败：' + err.message;
    }
  });
  wrapper.querySelector('#btn-onboard-jd-generate').addEventListener('click', async () => {
    const text = jdInput.value.trim();
    if (text.length < 10) {
      jdStatus.textContent = '至少写 10 个字，或上传文件';
      return;
    }
    jdStatus.textContent = '正在生成定制题…';
    try {
      const res = await fetch('/api/defense/questions-from-jd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '生成失败');
      jdStatus.textContent = data.degraded ? '模型暂不可用：下面是通用模板题' : `已生成 ${data.questions.length} 道定制题`;
      jdQuestions.innerHTML = '';
      (data.questions || []).forEach((q, i) => {
        const el = document.createElement('div');
        el.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;';
        el.innerHTML = `
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
            <span class="tag ${q.severity === '高' ? 'tag-red' : 'tag-amber'}">${escapeHtml(q.severity || '中')}危</span>
          </div>
          <div style="font-weight:600;font-size:13.5px;margin-bottom:4px;">Q${i + 1}. ${escapeHtml(q.q)}</div>
          <div style="font-size:12px;color:var(--amber);margin-bottom:6px;">这一问在验证：${escapeHtml(q.why || '')}</div>
        `;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary btn-sm';
        btn.textContent = '拆逻辑 → 开始练这道 →';
        btn.addEventListener('click', () => {
          localStorage.setItem('zhimian.onboard.done', '1');
          onboarding.style.display = 'none';
          openLogicCard(
            {
              id: 'jd-' + Date.now(),
              title: q.q,
              context: q.why || '',
              track: '定制题（基于你给的 JD）',
              difficulty: '进阶',
              keywords: [],
              expectedLength: [150, 400],
              skeleton: ['先给结论，再给依据', '给一个可核对的数字与口径', '讲清你的判断与取舍与边界'],
              viewpointCards: [],
              sources: [],
              source: 'resume',
            },
            { context: q.why || '' }
          );
        });
        el.appendChild(btn);
        jdQuestions.appendChild(el);
      });
    } catch (err) {
      jdStatus.textContent = '生成失败：' + err.message;
    }
  });

  const trackBox = wrapper.querySelector('#track-filters');
  const listBox = wrapper.querySelector('#bank-list');
  const searchInput = wrapper.querySelector('#bank-search-input');
  const difficultySelect = wrapper.querySelector('#bank-difficulty-filter');
  const categorySelect = wrapper.querySelector('#bank-category-filter');
  const pageSizeSelect = wrapper.querySelector('#bank-pagesize-filter');
  const pagerBox = wrapper.querySelector('#bank-pager');
  const domainNote = wrapper.querySelector('#bank-domain-note');

  // 分页：一屏最多 12 张卡，剩下的翻页看（题库 50+ 道，不翻页会滑很长）
  let page = 1;
  let pageSize = 12;
  const resetPage = () => {
    page = 1;
  };

  // 类别 = 题库自带的 track（面试通用 / 论文答辩…），与"方向"是两层筛选
  const categories = [...new Set(state.bank.map((q) => q.track).filter(Boolean))];
  if (categorySelect) {
    categorySelect.innerHTML =
      '<option value="">全部类别</option>' +
      categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  }

  // 方向维度：优先用题库数据里的 domain（构建脚本产出），缺失时才按关键词兜底
  const DOMAIN_ITEMS = DOMAINS.map((d) => ({ ...d, label: DOMAIN_LABEL[d.key] || d.label }));

  // 定制题单（本地生成，内存 + localStorage 留存）
  const CUSTOM_KEY = 'zhimian.bank.custom';
  let customQuestions = [];
  try {
    customQuestions = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]');
  } catch {
    customQuestions = [];
  }
  const saveCustomQuestions = () => {
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(customQuestions.slice(0, 20)));
    } catch {
      /* 隐私模式忽略 */
    }
  };

  const renderCustomQuestions = () => {
    const block = wrapper.querySelector('#custom-questions-block');
    const list = wrapper.querySelector('#custom-questions-list');
    if (!customQuestions.length) {
      block.hidden = true;
      return;
    }
    block.hidden = false;
    wrapper.querySelector('#custom-count').textContent = `${customQuestions.length} 道`;
    list.innerHTML = '';
    customQuestions.forEach((cq, i) => {
      const card = document.createElement('article');
      card.className = 'card';
      card.style.borderColor = 'var(--primary)';
      const prob = Number(cq.prob) || 0;
      const tone = prob >= 75 ? 'var(--red)' : prob >= 50 ? 'var(--amber)' : 'var(--green)';
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
          <span class="tag tag-green">定制题 ${i + 1}</span>
          <span style="font-size:12px;font-weight:700;color:${tone};">被问概率 ${prob}%</span>
        </div>
        <div style="font-weight:600;font-size:14px;line-height:1.5;margin-bottom:4px;">${escapeHtml(cq.q || '')}</div>
        <div style="font-size:12px;color:var(--amber);margin-bottom:4px;">为什么问：${escapeHtml(cq.why || '')}</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:8px;">来自技术点：${escapeHtml(String(cq.bullet || '').slice(0, 40))}</div>
      `;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = '先拆逻辑，再开口 →';
      btn.addEventListener('click', () =>
        openLogicCard({
          id: 'custom-' + i,
          title: cq.q,
          context: cq.why || '',
          track: '我的项目定制题',
          difficulty: '进阶',
          keywords: [],
          expectedLength: [150, 400],
          skeleton: ['先给结论，再给依据', '给一个可核对的数字与口径', '讲清你的判断与取舍与边界'],
          viewpointCards: [],
          sources: [],
          source: 'resume',
        })
      );
      card.appendChild(btn);
      list.appendChild(card);
    });
  };

  // 定制入口：本地分段 → 拆技术点 → 生成题单
  const customStatus = wrapper.querySelector('#custom-status');
  const customPoints = wrapper.querySelector('#custom-points');
  wrapper.querySelector('#custom-project-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    customStatus.textContent = '读取 ' + file.name + ' …';
    try {
      const text = file.name.toLowerCase().endsWith('.pdf') ? '' : await file.text();
      if (text) {
        wrapper.querySelector('#custom-project-input').value = text.slice(0, 5000);
        customStatus.textContent = '已读入，请点「拆出技术点并生成题单」';
      } else {
        customStatus.textContent = 'PDF 需要 OCR 文本：把关键几段粘贴进文本框';
      }
    } catch (err) {
      customStatus.textContent = '读取失败：' + err.message;
    }
  });

  wrapper.querySelector('#btn-custom-generate').addEventListener('click', async () => {
    const raw = wrapper.querySelector('#custom-project-input').value.trim();
    if (raw.length < 30) {
      customStatus.textContent = '内容太短（至少 30 字），技术点拆不出来';
      return;
    }
    const progress = createProgress('正在本地切段…');
    customStatus.textContent = '正在本地切段…';
    // 本地切段 → 抽出核心技术点：优先带标题的段落，否则按句子打分挑"最像技术主张"的 3–5 句
    const doc = chunkDocumentText(raw, '我的项目');
    const TECH_HINT = /(负责|用|基于|实现|设计|搭建|优化|上线|重构|接入|落地|指标|延迟|吞吐|准确率|召回|P\d{2}|\d+%|\d+ms|[A-Z]{2,})/;
    const points = (() => {
      const titled = doc.segments
        .filter((seg) => seg.heading && seg.heading.length > 4 && !/^\d+$/.test(seg.heading))
        .map((seg) => seg.heading.trim());
      if (titled.length >= 2) return titled.slice(0, 5);
      const sentences = String(raw)
        .split(/(?<=[。！？!?；;\n])/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 12 && x.length <= 120);
      const scored = sentences
        .map((x, i) => ({ x, i, score: (TECH_HINT.test(x) ? 2 : 0) + (/\d/.test(x) ? 1 : 0) }))
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, 5)
        .sort((a, b) => a.i - b.i)
        .map((x) => x.x);
      return scored.length ? scored : sentences.slice(0, 4);
    })();
    progress.step(`正在提炼 ${points.length} 个核心技术点…`);
    customPoints.innerHTML = `<div style="margin-bottom:8px;">${points.map((p, i) => `· ${escapeHtml(p)}`).join('<br/>')}</div>`;

    if (!points.length) {
      progress.done();
      customStatus.textContent = '没拆出技术点，换一段更具体的内容试试';
      return;
    }
    try {
      const res = await fetch('/api/resume/questions-from-bullets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bullets: points.map((p) => ({ bullet: p, question: '' })),
          resumeContext: JSON.stringify({ 项目要点: points }),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '生成失败');
      progress.step('正在按被问概率排序…');
      const qs = (data.candidates || []).slice(0, 5).map((c) => ({
        q: c.q,
        why: c.why,
        bullet: c.bullet,
        prob: c.prob,
      }));
      customQuestions = qs.concat(customQuestions).slice(0, 12);
      saveCustomQuestions();
      renderCustomQuestions();
      progress.done();
      customStatus.textContent = `已生成 ${qs.length} 道定制题（按被问概率排序）`;
      showToast('定制题单已置顶在真题列表之上');
    } catch (err) {
      progress.done();
      customStatus.textContent = '生成失败：' + err.message;
    }
  });

  // Tab 切换
  wrapper.querySelectorAll('[data-bank-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.bankTab;
      wrapper.querySelectorAll('[data-bank-tab]').forEach((b) => {
        b.className = 'btn btn-sm' + (b === btn ? ' btn-primary' : '');
      });
      wrapper.querySelector('#bank-tab-preset').hidden = tab !== 'preset';
      wrapper.querySelector('#bank-tab-custom').hidden = tab !== 'custom';
    });
  });

  let selectedDomain = '';
  /** 当前题单（空 = 看全部主库题） */
  let selectedBundle = '';

  /** 题单 chips：破冰卡里一组，点击即把题库过滤到该题单 */
  const renderBundleChips = () => {
    const box = wrapper.querySelector('#bundle-chips');
    const desc = wrapper.querySelector('#bundle-desc');
    if (!box) return;
    box.innerHTML = '';
    for (const b of state.bundles || []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn-sm bundle-chip${selectedBundle === b.id ? ' btn-primary' : ''}`;
      btn.textContent = `${b.title}（${b.questionIds.length}）`;
      btn.title = b.desc || '';
      btn.addEventListener('click', () => {
        selectedBundle = selectedBundle === b.id ? '' : b.id;
        selectedDomain = '';
        keyword = '';
        if (searchInput) searchInput.value = '';
        resetPage();
        renderBundleChips();
        renderList();
        listBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (desc) {
          const cur = selectedBundle ? state.bundleById.get(selectedBundle) : null;
          desc.textContent = cur ? `${cur.desc} · ${cur.difficultyMix}` : '点任一题单，下面只显示这一单；再点一次取消。';
        }
      });
      box.appendChild(btn);
    }
    if (desc && !desc.textContent) {
      desc.textContent = '点任一题单，下面只显示这一单；再点一次取消。';
    }
  };

  const renderTracks = () => {
    trackBox.innerHTML = '';
    // 方向 chip 的题量只算主库题：专项题默认不在列表里，混进数字会让评委以为多了 12 道
    const mainBank = state.bank.filter((q) => !q.extra);
    const counts = domainCounts(mainBank);
    const all = [{ key: '', label: '全部方向', count: mainBank.length }, ...DOMAIN_ITEMS.map((d) => ({ ...d, count: counts[d.key] || 0 }))];
    all.forEach((d) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn-sm ${selectedDomain === d.key ? 'btn-primary' : ''}`;
      btn.textContent = d.count ? `${d.label} ${d.count}` : `${d.label} 0`;
      btn.title = d.count ? d.hint || d.label : '这个方向暂时没有题，先看看别的';
      // 0 题的方向不给"点了空白"的体验：直接禁用并说明
      btn.disabled = !d.count;
      btn.addEventListener('click', () => {
        selectedDomain = d.key;
        resetPage();
        renderTracks();
        renderList();
      });
      trackBox.appendChild(btn);
    });
  };

  /** 分页器：上一页 / 页码 / 下一页 + 当前范围 */
  const renderPager = (totalCount) => {
    if (!pagerBox) return;
    pagerBox.innerHTML = '';
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    if (page > totalPages) page = totalPages;
    if (totalCount <= pageSize) return; // 一页放得下就不显示分页

    const mkBtn = (label, target, opts = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn btn-sm ${opts.active ? 'btn-primary' : ''}`.trim();
      b.textContent = label;
      if (opts.disabled) b.disabled = true;
      if (!opts.disabled && !opts.active) {
        b.addEventListener('click', () => {
          page = target;
          renderList();
          listBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
      return b;
    };

    pagerBox.appendChild(mkBtn('‹ 上一页', page - 1, { disabled: page <= 1 }));

    // 页码：当前页附近 5 个（首尾始终可达）
    const nums = new Set([1, totalPages]);
    for (let i = page - 2; i <= page + 2; i++) if (i >= 1 && i <= totalPages) nums.add(i);
    const sorted = [...nums].sort((a, b) => a - b);
    let prev = 0;
    for (const n of sorted) {
      if (prev && n - prev > 1) {
        const gap = document.createElement('span');
        gap.textContent = '…';
        gap.style.cssText = 'font-size:12px;color:var(--text-muted);';
        pagerBox.appendChild(gap);
      }
      pagerBox.appendChild(mkBtn(String(n), n, { active: n === page }));
      prev = n;
    }

    pagerBox.appendChild(mkBtn('下一页 ›', page + 1, { disabled: page >= totalPages }));

    const info = document.createElement('span');
    info.style.cssText = 'font-size:12px;color:var(--text-muted);margin-left:6px;';
    const from = (page - 1) * pageSize + 1;
    const to = Math.min(totalCount, page * pageSize);
    info.textContent = `第 ${page}/${totalPages} 页 · 显示 ${from}–${to} 条（共 ${totalCount} 道）`;
    pagerBox.appendChild(info);
  };

  const renderList = () => {
    const diff = difficultySelect?.value || '';
    const category = categorySelect?.value || '';
    const bundle = selectedBundle ? state.bundleById.get(selectedBundle) : null;
    const bundleIds = bundle ? new Set(bundle.questionIds) : null;
    const filtered = state.bank.filter((q) => {
      const kw = keyword.trim().toLowerCase();
      const matchKw = !kw || q.title.toLowerCase().includes(kw) || q.context.toLowerCase().includes(kw);
      const matchDomain = !selectedDomain || domainOf(q) === selectedDomain;
      const matchDiff = !diff || q.difficulty === diff;
      const matchCategory = !category || q.track === category;
      // 题单生效时只显示该题单的题；否则只显示主库题（extra 的专项题只在题单里出现）
      const matchBundle = bundleIds ? bundleIds.has(q.id) : !q.extra;
      return matchKw && matchDomain && matchDiff && matchCategory && matchBundle;
    });

    // 当前题单提示条
    const bar = wrapper.querySelector('#bundle-filter-bar');
    if (bar) {
      if (bundle) {
        bar.hidden = false;
        bar.innerHTML = `<strong>当前题单：${escapeHtml(bundle.title)}</strong>
          <span style="color:var(--text-secondary);">${bundle.questionIds.length} 道 · ${escapeHtml(bundle.difficultyMix || '')}</span>
          <button type="button" class="btn btn-sm" id="btn-clear-bundle">看全部 92 道</button>`;
        bar.querySelector('#btn-clear-bundle').addEventListener('click', () => {
          selectedBundle = '';
          resetPage();
          renderBundleChips();
          renderList();
        });
      } else {
        bar.hidden = true;
        bar.innerHTML = '';
      }
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (page > totalPages) page = totalPages;

    if (domainNote) {
      // 主库与专项题分开报数：专项题只在题单里出现，默认列表不含它们
      const mainTotal = state.bank.filter((q) => !q.extra).length;
      const extraTotal = state.bank.length - mainTotal;
      domainNote.textContent =
        `主库 ${mainTotal} 道知乎高频真题` +
        (extraTotal ? ` + 专项 ${extraTotal} 道` : '') +
        ` · 当前筛出 ${filtered.length} 道` +
        (filtered.length > pageSize ? `（第 ${page}/${totalPages} 页）` : '') +
        ' · 每题都带知乎观点卡对照（来源可点开核对）';
    }

    if (!filtered.length) {
      // 空结果不給空白页：给几条"相关题"，并说清为什么没有
      const suggestions = fuzzySuggestions(state.bank, { keyword, domain: selectedDomain, difficulty: diff }, 4);
      listBox.innerHTML = `<div class="card" style="grid-column:1/-1;">
        <div style="font-weight:600;font-size:14px;margin-bottom:4px;">这个条件下暂时没有题</div>
        <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:10px;">
          ${selectedDomain ? `「${DOMAIN_LABEL[selectedDomain] || selectedDomain}」方向` : '当前筛选'}还没有收录题目，先看看这些相关的：</div>
        <div id="suggest-list" style="display:flex;flex-direction:column;gap:8px;"></div>
      </div>`;
      const sbox = listBox.querySelector('#suggest-list');
      for (const sq of suggestions) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid var(--border);border-radius:8px;padding:8px 10px;';
        row.innerHTML = `<div style="font-size:13px;line-height:1.5;">${escapeHtml(String(sq.title).slice(0, 46))}…</div>
          <span class="tag">${escapeHtml(DOMAIN_LABEL[domainOf(sq)] || '')}</span>`;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm';
        b.textContent = '看这题 →';
        b.addEventListener('click', () => openLogicCard(sq));
        row.appendChild(b);
        sbox.appendChild(row);
      }
      renderPager(0);
      return;
    }

    // 只渲染当前页，避免 50+ 张卡全塞进 DOM 导致页面很长
    const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);

    listBox.innerHTML = '';
    pageItems.forEach((q) => {
      const card = document.createElement('article');
      card.className = 'card question-card';
      card.style.display = 'flex';
      card.style.flexDirection = 'column';
      card.style.justifyContent = 'space-between';
      // 卡片默认只留「主标题 + 考察方向 + 1 条代表性知乎观点摘要」，
      // 难度/考点/来源数量这些细节收进悬停与展开区，卡片才有呼吸感
      const vp = q.viewpointCards?.[0];
      card.innerHTML = `
        <div>
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
            <span class="tag tag-blue">${escapeHtml(DOMAIN_LABEL[domainOf(q)] || domainOf(q))}</span>
            <span class="tag">${escapeHtml(q.track)}</span>
          </div>
          <h3 style="margin:0 0 8px;font-size:16px;line-height:1.5;">${escapeHtml(q.title)}</h3>
          ${
            vp
              ? vp.sourceUrl
                ? `<a class="card-quote" href="${escapeHtml(vp.sourceUrl)}" target="_blank" rel="noopener noreferrer"
                      style="display:block;font-size:12.5px;color:var(--text-secondary);line-height:1.7;padding-left:8px;border-left:2px solid var(--border);text-decoration:none;"
                      title="点击打开这条知乎原答">
                     知乎观点摘要：${escapeHtml(String(vp.summary || '').slice(0, 58))}…
                     <span style="color:var(--primary);white-space:nowrap;">看原答 ↗</span>
                   </a>`
                : `<div class="card-quote" style="font-size:12.5px;color:var(--text-secondary);line-height:1.7;padding-left:8px;border-left:2px solid var(--border);">
                     知乎观点摘要：${escapeHtml(String(vp.summary || '').slice(0, 58))}…
                   </div>`
              : `<div style="font-size:12.5px;color:var(--text-muted);">观点卡待补</div>`
          }
          <details class="card-more" style="margin-top:8px;">
            <summary style="cursor:pointer;font-size:12px;color:var(--text-muted);">展开细节</summary>
            <div style="margin-top:6px;font-size:12px;color:var(--text-secondary);line-height:1.7;">
              <div>难度：${escapeHtml(q.difficulty)} · 考点：${escapeHtml((q.keywords || []).slice(0, 4).join(' / '))}</div>
              <div>考察意图：${escapeHtml(String(q.context || '').slice(0, 120))}</div>
              <div style="color:var(--text-muted);">知乎来源：${q.viewpointCards?.length || 0} 张观点卡${
                vp?.popularity ? ' · ' + escapeHtml(vp.popularity) : ''
              }${vp?.upvotes ? ' · ' + vp.upvotes + ' 赞同' : ''}</div>
              ${
                (q.viewpointCards || []).some((c) => c.sourceUrl)
                  ? `<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:10px;">${(q.viewpointCards || [])
                      .filter((c) => c.sourceUrl)
                      .slice(0, 3)
                      .map(
                        (c, i) =>
                          `<a href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:var(--primary);">看知乎原答 ${i + 1} ↗</a>`
                      )
                      .join('')}</div>`
                  : ''
              }
            </div>
          </details>
        </div>
        <div style="display:flex;justify-content:flex-end;align-items:center;padding-top:10px;margin-top:10px;border-top:1px solid var(--border);">
          <button type="button" class="btn btn-sm card-cta-btn btn-start-coach">先拆逻辑，再开口 →</button>
        </div>
      `;
      card.querySelector('.btn-start-coach').addEventListener('click', () => openLogicCard(q));
      listBox.appendChild(card);
    });

    renderPager(filtered.length);
  };

  searchInput.addEventListener('input', (e) => {
    keyword = e.target.value;
    resetPage();
    renderList();
  });
  difficultySelect?.addEventListener('change', () => {
    resetPage();
    renderList();
  });
  categorySelect?.addEventListener('change', () => {
    resetPage();
    renderList();
  });
  pageSizeSelect?.addEventListener('change', () => {
    pageSize = Number(pageSizeSelect.value) || 12;
    resetPage();
    renderList();
  });

  renderTracks();
  renderBundleChips();
  renderList();
  renderCustomQuestions();
  showOnboarding();

  // 题单是延后加载的：加载完补渲染一次题单区（否则首屏看不到题单入口）
  window.addEventListener('zhimian:bundles-ready', () => {
    renderBundleChips();
    if (selectedBundle) renderList();
  });

  // 底部"下一步"主行动条：选中题 → 去拆逻辑
  // 吸底条会盖住最后一行，补一块等高留白，避免分页器被压在条下面点不到
  const barSpacer = document.createElement('div');
  barSpacer.style.cssText = 'height:72px;';
  root.appendChild(barSpacer);
  mountNextStepBar(root, {
    text: '下一步：去拆逻辑（30 秒看框架）',
    hint: '先看清这题的考察意图与 3 个核心得分点，再开口说 —— 避免一上来就对着空白麦克风卡壳。',
    actions: [
      {
        label: '去拆逻辑 →',
        primary: true,
        onClick: () => {
          const q = state.activeQuestion || state.bank[0];
          if (q) openLogicCard(q);
        },
      },
      {
        label: '直接去模拟练',
        ghost: true,
        onClick: () => {
          const q = state.activeQuestion || state.bank[0];
          if (!q) return;
          state.activeQuestion = q;
          state.questionPickedByUser = true;
          navigate('/coach');
        },
      },
    ],
  });
}
