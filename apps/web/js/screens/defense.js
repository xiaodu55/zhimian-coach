import { state } from '../state.js';
import { escapeHtml } from '../ui/citation.js';
import { showToast } from '../ui/toast.js';
import { dbPut, dbGetAll } from '../db.js';
import { chunkDocumentText } from '../retrieval/chunk.js';
import { createModal, modalButton } from '../ui/modal.js';
import { runReview } from '../lib/review.js';

/**
 * 答辩预测：上传答辩材料 → 评委高危追问预演 + 知乎相关讨论（可点进去看）。
 * 与「讲解室」拆开：讲解室解决"读懂资料"，答辩预测解决"站在台上怎么答"。
 */
export function renderDefenseScreen(root) {
  let doc = null;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
      <div>
        <h1 style="margin:0 0 4px;font-size:20px;">答辩预测 · 上传材料 → 预演</h1>
        <div style="font-size:13px;color:var(--text-secondary);">上传答辩要用的东西（论文 / PPT 讲稿 / 技术方案）→ 生成评委高危追问 → 逐题预演（评委连续追问最多 3 轮）→ 拿到整场复盘</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <label class="btn btn-sm">
          📂 上传答辩材料（PDF / MD / TXT）
          <input id="defense-file-input" type="file" accept=".pdf,.md,.txt,.markdown" hidden />
        </label>
        <button id="btn-gen-defense" class="btn btn-primary btn-sm" type="button" disabled>🎓 开始预演（生成评委追问）</button>
      </div>
    </div>

    <div class="grid-2" style="align-items:start;">
      <!-- 左：材料分段 + 评委追问 -->
      <div style="display:flex;flex-direction:column;gap:14px;">
        <section class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;">
            <strong id="defense-doc-title">📄 还没有上传答辩材料</strong>
            <span class="tag tag-green" id="defense-seg-count">0 个片段</span>
          </div>
          <div id="defense-segments" style="display:flex;flex-direction:column;gap:8px;max-height:280px;overflow-y:auto;">
            <div style="color:var(--text-muted);font-size:13px;padding:12px 0;text-align:center;">
              上传论文 / 讲稿 / 技术方案后，这里会按定位符切成可溯源的片段——追问必须落在这些片段上，不许编。
            </div>
          </div>
        </section>

        <section id="defense-questions-card" class="card" hidden>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;">
            <h3 style="margin:0;font-size:15px;">⚔️ 评委高危追问（按严重程度排序）</h3>
            <button id="btn-export-defense-md" class="btn btn-sm" type="button">导出 Markdown</button>
          </div>
          <div id="defense-questions-list" style="display:flex;flex-direction:column;gap:10px;"></div>
        </section>
      </div>

      <!-- 右：知乎相关讨论（可点击） + 薄弱点 -->
      <div style="display:flex;flex-direction:column;gap:14px;">
        <section class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;">
            <h3 style="margin:0;font-size:15px;">🔗 知乎上的相关讨论（点开就能看）</h3>
            <button id="btn-refresh-references" class="btn btn-sm" type="button" disabled>刷新</button>
          </div>
          <div id="defense-references" style="display:flex;flex-direction:column;gap:8px;">
            <div style="color:var(--text-muted);font-size:13px;padding:12px 0;text-align:center;">
              上传材料后自动检索知乎上关于这个主题的质疑 / 对比 / 踩坑讨论。
            </div>
          </div>
        </section>

        <section id="special-questions-card" class="card" hidden style="border-color:var(--primary);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;">
            <h3 style="margin:0;font-size:15px;">🎯 来自复盘盲点的专项追问</h3>
            <span class="tag tag-green" id="special-from-label"></span>
          </div>
          <div id="special-questions-list" style="display:flex;flex-direction:column;gap:10px;"></div>
        </section>

        <section id="defense-risks-card" class="card" hidden>
          <h3 style="margin:0 0 8px;font-size:15px;">⚠️ 材料自身的薄弱处</h3>
          <div id="defense-risks-list" style="display:flex;flex-direction:column;gap:8px;font-size:12.5px;"></div>
        </section>
      </div>
    </div>
  `;
  root.appendChild(wrapper);

  const fileInput = wrapper.querySelector('#defense-file-input');
  const genBtn = wrapper.querySelector('#btn-gen-defense');
  const refreshRefsBtn = wrapper.querySelector('#btn-refresh-references');
  const segBox = wrapper.querySelector('#defense-segments');
  const titleLabel = wrapper.querySelector('#defense-doc-title');
  const segCount = wrapper.querySelector('#defense-seg-count');
  const refsBox = wrapper.querySelector('#defense-references');
  const questionsCard = wrapper.querySelector('#defense-questions-card');
  const questionsList = wrapper.querySelector('#defense-questions-list');
  const risksCard = wrapper.querySelector('#defense-risks-card');
  const risksList = wrapper.querySelector('#defense-risks-list');

  let questions = [];
  let references = [];

  const renderSegments = () => {
    segBox.innerHTML = '';
    titleLabel.textContent = '📄 ' + doc.title;
    segCount.textContent = `${doc.segments.length} 个片段`;
    doc.segments.forEach((seg, idx) => {
      const box = document.createElement('div');
      box.style.cssText = 'padding:8px 10px;border:1px solid var(--border);border-radius:8px;';
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:6px;margin-bottom:4px;">
          <span style="font-weight:600;font-size:12.5px;">${escapeHtml(seg.heading)}</span>
          <span style="font-size:11px;color:var(--text-muted);">${escapeHtml(seg.locator)}</span>
        </div>
        <p style="margin:0;font-size:12.5px;color:var(--text-secondary);line-height:1.6;">${escapeHtml(String(seg.text).slice(0, 260))}</p>
      `;
      segBox.appendChild(box);
    });
  };

  /** 知乎相关讨论：可点击列表 */
  const renderReferences = (items) => {
    refsBox.innerHTML = '';
    if (!items.length) {
      refsBox.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">没有检索到相关讨论（可能是主题太窄，或知乎检索额度用完）。</div>';
      return;
    }
    items.forEach((r, i) => {
      const a = document.createElement('a');
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.cssText = 'display:block;border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:inherit;text-decoration:none;';
      a.innerHTML = `
        <div style="font-size:13px;font-weight:600;color:var(--primary);margin-bottom:3px;">${i + 1}. ${escapeHtml(r.title || '')} ↗</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;">${escapeHtml(String(r.snippet || '').slice(0, 140))}</div>
      `;
      a.addEventListener('mouseenter', () => (a.style.borderColor = 'var(--primary)'));
      a.addEventListener('mouseleave', () => (a.style.borderColor = 'var(--border)'));
      refsBox.appendChild(a);
    });
  };

  const renderRisks = (risks) => {
    risksList.innerHTML = '';
    if (!risks?.length) {
      risksCard.hidden = true;
      return;
    }
    risksCard.hidden = false;
    risks.forEach((r) => {
      const el = document.createElement('div');
      el.style.cssText = 'background:var(--amber-soft);padding:8px 10px;border-radius:8px;';
      el.innerHTML = `<strong style="color:var(--amber);">${escapeHtml(r.title)}</strong><div style="margin-top:2px;color:var(--text-secondary);">${escapeHtml(r.reason)}</div>`;
      risksList.appendChild(el);
    });
  };

  /** 预演小窗：评委主问题 → 连续追问（最多 3 轮）→ 整场复盘 */
  const MAX_FOLLOWUP = 3;
  const openRehearse = (q) => {
    const modal = createModal({
      title: '预演这一题（连续追问）',
      subtitle: q.q,
      width: 780,
    });

    const transcript = []; // {q, a}：每一轮已完成作答
    let pendingQ = q.q;   // 当前待作答的评委问题（主问题 → 追问）
    let followups = 0;
    let finished = false;

    // 评委信息（主问题）
    const info = document.createElement('div');
    info.style.cssText = 'font-size:13px;line-height:1.75;margin-bottom:10px;';
    info.innerHTML = `
      <div style="color:var(--amber);">评委会想验证什么：${escapeHtml(q.why || '')}</div>
      ${q.locator ? `<div style="color:var(--text-muted);font-size:12px;">材料依据：${escapeHtml(q.locator)}</div>` : ''}
      ${
        q.zhihuRef
          ? `<div style="margin-top:6px;font-size:12px;background:var(--primary-soft);padding:8px 10px;border-radius:6px;">
               知乎类似质疑：<a href="${escapeHtml(q.zhihuRef.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(q.zhihuRef.title)}</a>
               <div style="color:var(--text-secondary);margin-top:3px;">${escapeHtml(String(q.zhihuRef.snippet || '').slice(0, 160))}</div>
             </div>`
          : ''
      }`;
    modal.body.appendChild(info);

    const roundBadge = document.createElement('div');
    roundBadge.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:6px;';
    modal.body.appendChild(roundBadge);

    const transcriptBox = document.createElement('div');
    transcriptBox.style.cssText =
      'border:1px solid var(--border);border-radius:8px;padding:8px 10px;max-height:220px;overflow-y:auto;margin-bottom:10px;font-size:13px;line-height:1.7;';
    modal.body.appendChild(transcriptBox);

    const renderTranscript = () => {
      roundBadge.textContent = finished
        ? `共 ${transcript.length} 轮作答（追问已到头，下面是整场复盘）`
        : `第 ${transcript.length + 1} 轮作答 · 最多 ${MAX_FOLLOWUP + 1} 轮（主问题 + ${MAX_FOLLOWUP} 次追问）`;
      transcriptBox.innerHTML = '';
      if (!transcript.length) {
        transcriptBox.innerHTML = '<span style="color:var(--text-muted);">还没作答：先写下你上台时真实会说的话。</span>';
        return;
      }
      transcript.forEach((t, i) => {
        const row = document.createElement('div');
        row.style.cssText = i ? 'margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);' : '';
        const qq = document.createElement('div');
        qq.style.cssText = 'font-weight:600;color:var(--primary);';
        qq.textContent = `面试官：${t.q}`;
        const aa = document.createElement('div');
        aa.style.cssText = 'color:var(--text-secondary);white-space:pre-wrap;';
        aa.textContent = `我：${t.a}`;
        row.append(qq, aa);
        transcriptBox.appendChild(row);
      });
      if (!finished && transcript.length) {
        const pending = document.createElement('div');
        pending.style.cssText = 'margin-top:6px;padding-top:6px;border-top:1px dashed var(--border);color:var(--primary);font-weight:600;';
        pending.textContent = `面试官（待你回答）：${pendingQ}`;
        transcriptBox.appendChild(pending);
      }
      transcriptBox.scrollTop = transcriptBox.scrollHeight;
    };
    renderTranscript();

    const ta = document.createElement('textarea');
    ta.className = 'textarea';
    ta.rows = 5;
    ta.placeholder = '按你上台时真实会说的话写（评委最在意：有没有数据、有没有边界、有没有回退方案）';
    modal.body.appendChild(ta);

    const result = document.createElement('div');
    result.style.cssText = 'margin-top:10px;font-size:13px;';
    modal.body.appendChild(result);

    const buildRaw = () =>
      transcript.map((t) => `面试官：${t.q}\n我：${t.a}`).join('\n\n');

    const runFinalReview = async () => {
      if (!transcript.length) {
        showToast('先作答一轮再出复盘', 'warn');
        return;
      }
      finished = true;
      ta.disabled = true;
      submit.disabled = true;
      submit.textContent = '生成复盘中…';
      finalBtn.disabled = true;
      roundBadge.textContent = '正在汇总整场作答…';
      const question = {
        id: 'defense-' + Date.now(),
        title: q.q,
        context: q.why || '',
        keywords: [],
        skeleton: [],
        viewpointCards: [],
        sources: [],
        source: 'defense',
        locator: q.locator || '',
      };
      // 来源 = 知乎质疑 + 答辩材料片段（后端最多取 4 条，把最相关的放前面）
      const segSources = (doc?.segments || []).slice(0, 4).map((seg) => ({
        summary: `${seg.heading}：${String(seg.text).slice(0, 120)}`,
        snippet: String(seg.text).slice(0, 200),
        evidenceQuote: String(seg.text).slice(0, 200),
        sourceUrl: '',
        author: '答辩材料',
      }));
      const zhihuSource = q.zhihuRef
        ? [
            {
              summary: q.zhihuRef.snippet || '',
              snippet: q.zhihuRef.snippet || '',
              evidenceQuote: q.zhihuRef.snippet || '',
              sourceUrl: q.zhihuRef.url,
              author: '知乎',
            },
          ]
        : [];
      const report = await runReview({
        question,
        raw: buildRaw(),
        sources: [...zhihuSource, ...segSources].slice(0, 4),
      });
      submit.textContent = '已提交';
      renderTranscript();
      renderMini(result, report);
    };

    const submit = modalButton('提交本轮并追问', {
      primary: true,
      onClick: async () => {
        const raw = ta.value.trim();
        if (!raw) {
          showToast('先写下你的回答', 'warn');
          return;
        }
        transcript.push({ q: pendingQ, a: raw });
        ta.value = '';
        submit.disabled = true;
        submit.textContent = '评委思考中…';

        if (followups >= MAX_FOLLOWUP) {
          await runFinalReview();
          return;
        }

        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 45000);
          const res = await fetch('/api/defense/followup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              question: q.q,
              answer: transcript.map((t) => `我：${t.a}`).join('\n'),
              segments: doc?.segments || [],
            }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error?.message || '追问生成失败');

          if (data.exhausted || !data.followup) {
            await runFinalReview();
            return;
          }
          followups++;
          // 追问成为下一轮要回答的"面试官问题"
          pendingQ = data.followup.q;
          renderTranscript();
          showToast(`第 ${followups} 轮追问：${data.followup.q.slice(0, 40)}…`);
        } catch (err) {
          showToast(err.message + '（可直接出复盘）', 'warn', 5000);
          await runFinalReview();
          return;
        } finally {
          submit.disabled = false;
          submit.textContent = '提交本轮并追问';
        }
      },
    });

    const finalBtn = modalButton('直接出复盘', {
      ghost: true,
      onClick: () => runFinalReview(),
    });

    modal.footer.append(modalButton('关闭', { ghost: true, onClick: () => modal.close() }), finalBtn, submit);
  };

  const renderMini = (host, report) => {
    host.innerHTML = '';
    const head = document.createElement('div');
    head.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:6px;';
    head.textContent = report.degraded ? '复盘（规则模式：模型层暂不可用）' : '复盘结果';
    host.appendChild(head);

    const rules = document.createElement('div');
    rules.style.cssText = 'font-size:12.5px;color:var(--text-secondary);margin-bottom:8px;line-height:1.7;';
    rules.textContent = report.ruleFindings.length
      ? `原话级诊断命中 ${report.ruleFindings.length} 条：${report.ruleFindings.map((f) => f.ruleName).join('、')}`
      : '原话级诊断：未命中常见问题（数字 / 边界 / 取舍 / 结构）';
    host.appendChild(rules);

    for (const s of report.llmScores || []) {
      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px;';
      const tone = s.score >= 75 ? 'var(--green)' : s.score >= 55 ? 'var(--amber)' : 'var(--red)';
      card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <span class="tag tag-blue">${escapeHtml(s.dimension || '维度')}</span>
          <strong style="color:${tone};">${s.score}</strong>
        </div><div style="margin-top:4px;line-height:1.65;">${escapeHtml(s.claim || '')}</div>`;
      host.appendChild(card);
    }

    if ((report.improvements || []).length) {
      const ul = document.createElement('ul');
      ul.style.cssText = 'margin:6px 0 0;padding-left:18px;font-size:12.5px;line-height:1.75;';
      for (const im of report.improvements) {
        const li = document.createElement('li');
        li.textContent = im.claim || '';
        ul.appendChild(li);
      }
      host.appendChild(ul);
    }
  };

  // ---- 上传材料 ----
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      showToast('文件超过 20MB 上限', 'error');
      return;
    }
    if (file.name.toLowerCase().endsWith('.pdf')) {
      showToast('正在解析 PDF 文本层与页码定位符…');
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/doc/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message || 'PDF 解析失败');
        doc = {
          id: data.docId,
          title: data.title,
          pages: data.pages,
          segments: data.segments,
          createdAt: new Date().toISOString(),
        };
      } catch (err) {
        showToast('PDF 解析需要 BFF 在线：' + err.message, 'warn', 5000);
        return;
      }
    } else {
      const text = await file.text();
      doc = chunkDocumentText(text, file.name);
    }
    await dbPut('documents', { ...doc, id: 'defense-' + doc.id });
    renderSegments();
    genBtn.disabled = false;
    refreshRefsBtn.disabled = false;
    showToast(`材料已就绪：${doc.segments.length} 个可溯源片段`);
  });

  // ---- 生成追问 + 知乎讨论 ----
  const analyze = async () => {
    if (!doc?.segments?.length) {
      showToast('先上传答辩材料', 'warn');
      return;
    }
    genBtn.disabled = true;
    const origin = genBtn.textContent;
    genBtn.textContent = '检索知乎 + 生成追问中…';

    let data = null;
    try {
      const res = await fetch('/api/defense/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: doc.title, segments: doc.segments }),
      });
      data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '生成失败');
    } catch (err) {
      showToast(err.message, 'error', 5000);
      genBtn.disabled = false;
      genBtn.textContent = origin;
      return;
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = origin;
    }

    questions = (data.predictedQuestions || []).slice().sort((a, b) => {
      const order = { 高: 0, 中: 1, 低: 2 };
      return (order[a.severity] ?? 1) - (order[b.severity] ?? 1);
    });
    references = data.references || [];
    renderReferences(references);
    renderRisks(data.topRisks || []);

    questionsCard.hidden = false;
    questionsList.innerHTML = '';
    if (data.degraded) {
      const warn = document.createElement('div');
      warn.style.cssText = 'font-size:12px;color:var(--amber);margin-bottom:8px;';
      warn.textContent = '⚠ 模型暂不可用：追问按材料结构生成模板问法，知乎讨论照常返回（不伪造外部引用）。';
      questionsList.appendChild(warn);
    }
    questions.forEach((q, idx) => {
      const tone = q.severity === '高' ? 'tag-red' : q.severity === '低' ? 'tag-green' : 'tag-amber';
      const el = document.createElement('div');
      el.style.cssText = 'padding:10px;border:1px solid var(--border);border-radius:8px;';
      el.innerHTML = `
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;">
          <span class="tag ${tone}">${escapeHtml(q.severity || '中')}危</span>
          ${q.locator ? `<span style="font-size:11px;color:var(--text-muted);">依据 ${escapeHtml(q.locator)}</span>` : ''}
        </div>
        <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Q${idx + 1}. ${escapeHtml(q.q)}</div>
        <div style="font-size:12px;color:var(--amber);margin-bottom:6px;">评委会想验证：${escapeHtml(q.why || '')}</div>
        ${
          q.zhihuRef
            ? `<div style="font-size:12px;background:var(--primary-soft);padding:6px 8px;border-radius:6px;margin-bottom:8px;">
                 <a href="${escapeHtml(q.zhihuRef.url)}" target="_blank" rel="noopener noreferrer">知乎类似质疑：${escapeHtml(q.zhihuRef.title)} ↗</a>
               </div>`
            : ''
        }
      `;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = '预演这一题 →';
      btn.addEventListener('click', () => openRehearse(q));
      el.appendChild(btn);
      questionsList.appendChild(el);
    });

    showToast(`已生成 ${questions.length} 条评委追问，附 ${references.length} 条知乎讨论`);
  };

  genBtn.addEventListener('click', analyze);

  refreshRefsBtn.addEventListener('click', async () => {
    if (!doc?.segments?.length) return;
    refreshRefsBtn.disabled = true;
    try {
      const res = await fetch('/api/defense/references', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: doc.title, segments: doc.segments }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '检索失败');
      references = data.items || [];
      renderReferences(references);
      showToast(`已刷新：${references.length} 条知乎讨论`);
    } catch (err) {
      showToast(err.message, 'error', 5000);
    } finally {
      refreshRefsBtn.disabled = false;
    }
  });

  wrapper.querySelector('#btn-export-defense-md').addEventListener('click', () => {
    if (!questions.length) return;
    const md = [
      `# 答辩预演清单 · ${doc?.title || '答辩材料'}`,
      '',
      ...questions.map(
        (q, i) => `## Q${i + 1}. [${q.severity || '中'}] ${q.q}
- **评委会想验证**：${q.why || ''}
- **材料依据**：${q.locator || '—'}
- **知乎类似质疑**：${q.zhihuRef ? `[${q.zhihuRef.title}](${q.zhihuRef.url})` : '暂无'}`
      ),
    ].join('\n');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'defense-rehearsal.md';
    a.click();
    URL.revokeObjectURL(url);
  });

  // ---- 读取复盘台生成的专项追问（跨页上下文不断层） ----
  const loadSpecialQuestions = async () => {
    const card = wrapper.querySelector('#special-questions-card');
    const list = wrapper.querySelector('#special-questions-list');
    let all = [];
    try {
      all = await dbGetAll('specialQuestions').catch(() => []);
    } catch {
      all = [];
    }
    if (!all.length) {
      card.hidden = true;
      return;
    }
    const latest = all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    const items = latest.questions || [];
    if (!items.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    wrapper.querySelector('#special-from-label').textContent = latest.ruleName || '复盘盲区';
    list.innerHTML = '';
    items.forEach((q, i) => {
      const el = document.createElement('div');
      el.style.cssText = 'padding:10px;border:1px solid var(--border);border-radius:8px;';
      el.innerHTML = `
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;">
          <span class="tag ${q.severity === '高' ? 'tag-red' : q.severity === '低' ? 'tag-green' : 'tag-amber'}">${escapeHtml(q.severity || '中')}危</span>
          <span style="font-size:11px;color:var(--text-muted);">${escapeHtml(latest.questionTitle || '')}</span>
        </div>
        <div style="font-weight:600;font-size:14px;margin-bottom:4px;">S${i + 1}. ${escapeHtml(q.q)}</div>
        <div style="font-size:12px;color:var(--amber);margin-bottom:6px;">这一问在验证：${escapeHtml(q.why || '')}</div>
      `;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = '预演这一题 →';
      btn.addEventListener('click', () =>
        openRehearse({
          q: q.q,
          why: q.why || '',
          severity: q.severity || '中',
          locator: latest.questionTitle || '',
          zhihuRef: null,
        })
      );
      el.appendChild(btn);
      list.appendChild(el);
    });
  };
  loadSpecialQuestions();

  // 复用讲解室已解析的文档（同一台机器不必重复上传）
  if (state.activeDocument?.segments?.length) {
    doc = state.activeDocument;
    renderSegments();
    genBtn.disabled = false;
    refreshRefsBtn.disabled = false;
    titleLabel.textContent = '📄 ' + doc.title + '（沿用讲解室的资料）';
  }
}
