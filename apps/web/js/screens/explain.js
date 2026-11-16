import { state, refreshLocalCollections } from '../state.js';
import { chunkDocumentText } from '../retrieval/chunk.js';
import { searchSegmentsBM25 } from '../retrieval/bm25.js';
import { escapeHtml, renderCitationChip } from '../ui/citation.js';
import { dbPut } from '../db.js';
import { showToast } from '../ui/toast.js';

export function renderExplainScreen(root) {
  let activeDoc = state.activeDocument || chunkDocumentText(
    `# 知面陪练架构设计核心摘要

## 1. 为什么采用双轨确定性评测
在 RAG 与 Agent 工程中，单纯依赖 LLM-as-a-Judge 存在打分漂移与同源模型偏好。离线评测集必须冻结内容哈希，并使用 Recall@5、nDCG@10 与 Span 精确率进行回归校验。

## 2. 间接提示词注入的出口闸门（Exit Gating）
外部检索召回的文本属于不可信污点数据（Taint）。由于基座模型无法在上下文内部实现绝对指令隔离，安全防线必须设置在工具调用的出口端，安全组件遵循 fail-closed 原则。

[00:12:30] 视频演示要点：在网络断开或模型超时 20 秒时，前端必须显式提示“已切换规则模式”，绝不允许静默吞掉异常。`,
    '示例技术文档：Agent 评测与纵深防御.md'
  );
  state.activeDocument = activeDoc;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
      <div>
        <h1 style="margin:0 0 4px;font-size:20px;">讲解室 & 答辩预测（F2 / F3 闭环）</h1>
        <div style="font-size:13px;color:var(--text-secondary);">上传文档 / 论文 / 视频转写稿 → 可溯源详解 → 就地追问 → 生成答辩高危追问</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <label class="btn btn-sm">
          📂 上传 PDF / Markdown / TXT / 转写稿
          <input id="doc-file-input" type="file" accept=".pdf,.md,.txt,.markdown" hidden />
        </label>
        <button id="btn-gen-defense" class="btn btn-primary btn-sm" type="button">🎓 生成答辩预测追问（挂知乎质疑）</button>
      </div>
    </div>

    <div class="grid-2" style="align-items:start;">
      <!-- 左侧：分段详解与 Citation 定位 -->
      <section class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <strong id="doc-title-label">📄 ${escapeHtml(activeDoc.title)}</strong>
          <span class="tag tag-green">共 ${activeDoc.segments.length} 个可溯源片段</span>
        </div>
        <div id="segments-container" style="display:flex;flex-direction:column;gap:10px;max-height:540px;overflow-y:auto;"></div>
      </section>

      <!-- 右侧：就地追问（防编造严格模式）+ 答辩预测提问清单 -->
      <div style="display:flex;flex-direction:column;gap:14px;">
        <section class="card">
          <h3 style="margin:0 0 8px;font-size:15px;">🔍 就地追问（严格溯源 · 查不到就说查不到）</h3>
          <div style="display:flex;gap:8px;margin-bottom:10px;">
            <input id="ask-input" class="input" type="text" placeholder="针对左侧资料提问，例如：为什么安全组件要 fail-closed？" />
            <button id="btn-ask-submit" class="btn btn-primary" type="button" style="white-space:nowrap;">检索并回答</button>
          </div>
          <div id="ask-result-box" style="font-size:14px;background:var(--surface-alt);padding:12px;border-radius:8px;min-height:90px;">
            <span style="color:var(--text-muted);">输入问题后，系统将优先执行文档内 BM25 检索，每条结论强制附带依据强度标签与引用 chip。</span>
          </div>
        </section>

        <section id="defense-report-card" class="card" hidden>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <h3 style="margin:0;font-size:15px;">⚔️ 预答辩高危追问预测（关联知乎真实质疑）</h3>
            <button id="btn-export-defense-md" class="btn btn-sm" type="button">导出 Markdown 报告</button>
          </div>
          <div id="defense-questions-list" style="display:flex;flex-direction:column;gap:10px;"></div>
        </section>
      </div>
    </div>
  `;
  root.appendChild(wrapper);

  const segContainer = wrapper.querySelector('#segments-container');
  const titleLabel = wrapper.querySelector('#doc-title-label');

  const renderSegments = () => {
    titleLabel.textContent = '📄 ' + activeDoc.title;
    segContainer.innerHTML = '';
    activeDoc.segments.forEach((seg, idx) => {
      const box = document.createElement('div');
      box.style.padding = '10px 12px';
      box.style.border = '1px solid var(--border)';
      box.style.borderRadius = '8px';
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;">
          <span style="font-weight:600;font-size:13px;">${escapeHtml(seg.heading)}</span>
          <div class="seg-actions" style="display:flex;gap:6px;align-items:center;"></div>
        </div>
        <p style="margin:0;font-size:13px;color:var(--text-secondary);line-height:1.65;">${escapeHtml(seg.text)}</p>
      `;
      const act = box.querySelector('.seg-actions');
      act.appendChild(renderCitationChip({
        id: `S${idx + 1}`,
        type: seg.type === 'time' ? 'time' : 'doc',
        label: seg.locator,
        sourceTitle: activeDoc.title,
        locator: seg.locator,
        quote: seg.text
      }));

      const weakBtn = document.createElement('button');
      weakBtn.type = 'button';
      weakBtn.className = 'btn btn-ghost btn-sm';
      weakBtn.textContent = '这个我没懂';
      weakBtn.addEventListener('click', async () => {
        await dbPut('weaknesses', {
          id: 'wk-doc-' + seg.id,
          questionId: 'q-defense-paper-04',
          questionTitle: `【资料盲区】${activeDoc.title} · ${seg.heading}`,
          track: '学术答辩 / 毕设',
          attribution: `原文定位 ${seg.locator} 未吃透`,
          priority: 'pinned',
          status: 'pending',
          createdAt: new Date().toISOString()
        });
        await refreshLocalCollections();
        showToast('已将该难点存入「弹药库台账 · 优先复习」');
      });
      act.appendChild(weakBtn);
      segContainer.appendChild(box);
    });
  };
  renderSegments();

  // 上传本地文档解析（零落盘，直接前端分段 + 存 IndexedDB）
  wrapper.querySelector('#doc-file-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      showToast('文件超过 20MB 上限', 'error');
      return;
    }

    // PDF：必须有文本层 + 需要页码定位符 → 交给 BFF 逐页解析（服务端零落盘，只回分段）
    if (file.name.toLowerCase().endsWith('.pdf')) {
      showToast('正在解析 PDF 文本层与页码定位符…');
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/doc/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) {
          showToast(data?.error?.message || 'PDF 解析失败', 'error', 6000);
          return;
        }
        activeDoc = {
          id: data.docId,
          title: data.title,
          pages: data.pages,
          segments: data.segments,
          createdAt: new Date().toISOString(),
        };
        state.activeDocument = activeDoc;
        await dbPut('documents', activeDoc);
        renderSegments();
        showToast(`PDF 解析成功：${data.pages} 页 / ${data.segments.length} 个定位片段（p页码¶段号）`);
      } catch (err) {
        showToast('PDF 解析需要 BFF 在线：' + err.message, 'warn', 5000);
      }
      return;
    }

    // MD / TXT：本地切块，零上传
    const text = await file.text();
    activeDoc = chunkDocumentText(text, file.name);
    state.activeDocument = activeDoc;
    await dbPut('documents', activeDoc);
    renderSegments();
    showToast(`解析成功：共切分 ${activeDoc.segments.length} 个带定位符片段`);
  });

  // 就地追问（§8.3 & §14 A8：检索无果时显式返回 noEvidence，绝不编造）
  const askInput = wrapper.querySelector('#ask-input');
  const askResultBox = wrapper.querySelector('#ask-result-box');

  const askBtn = wrapper.querySelector('#btn-ask-submit');
  const BASIS_CLASS = { '原文直述': 'basis-direct', '外部佐证': 'basis-external', '推断': 'basis-inference' };

  askBtn.addEventListener('click', async () => {
    const q = askInput.value.trim();
    if (!q) return;

    // 第一跳：文档内 BM25 精准召回（本地、零成本、隐私）
    const hits = searchSegmentsBM25(activeDoc.segments, q, 3);

    // BM25 阈值兜底：低分命中基本是噪声（实测无关问题也能命中 1 段），
    // 与其花一次模型调用去问"材料里有没有"，不如就地判定无依据（省额度、也不给模型编的机会）。
    if (hits.length && hits[0].score < 0.35) hits.length = 0;

    if (!hits.length) {
      askResultBox.innerHTML = `
        <div style="color:var(--amber);font-weight:600;margin-bottom:6px;">
          <span class="basis-badge basis-inference">无直接依据 · noEvidence:true</span>
          未在当前文档检索到直接依据
        </div>
        <p style="margin:0 0 8px;font-size:13px;">当前材料中未包含与「${escapeHtml(q)}」直接匹配的段落。为防止模型幻觉，系统拒绝生成无锚点猜测。</p>
        <div style="font-size:12px;color:var(--text-secondary);">建议检索词：<code>${escapeHtml(activeDoc.segments[0]?.heading || '核心架构')}</code> / <code>评估基线</code></div>
      `;
      return;
    }

    askResultBox.innerHTML = `<span style="color:var(--text-muted);font-size:13px;">已定位 ${hits.length} 个片段，正在让模型只在片段范围内作答（严格溯源）…</span>`;
    askBtn.disabled = true;
    const originLabel = askBtn.textContent;
    askBtn.textContent = '生成中…';

    try {
      const res = await fetch('/api/explain/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          segments: hits.map((h) => ({ text: h.segment.text, locator: h.segment.locator, heading: h.segment.heading })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data?.error?.message || '追问失败'), data?.error || {});

      askResultBox.innerHTML = '';

      if (data.degraded) {
        const warn = document.createElement('div');
        warn.style.cssText = 'font-size:12px;color:var(--amber);margin-bottom:8px;';
        warn.textContent = '⚠ 模型暂不可用：已降级为「原文摘录」模式（零幻觉），未生成任何推断性结论。';
        askResultBox.appendChild(warn);
      }

      if (data.noEvidence || !(data.claims || []).length) {
        const box = document.createElement('div');
        box.innerHTML = `
          <div style="color:var(--amber);font-weight:600;margin-bottom:6px;">
            <span class="basis-badge basis-inference">未检索到直接依据</span>
            模型判断材料里不足以回答这个问题
          </div>
          <p style="margin:0;font-size:13px;color:var(--text-secondary);">系统没有编造答案。建议换一种问法，或补充更相关的材料后再问。</p>`;
        askResultBox.appendChild(box);
      } else {
        (data.claims || []).forEach((claim, i) => {
          const row = document.createElement('div');
          row.style.cssText = i ? 'margin-top:10px;padding-top:10px;border-top:1px dashed var(--border);' : '';

          const head = document.createElement('div');
          head.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;';
          const badge = document.createElement('span');
          badge.className = `basis-badge ${BASIS_CLASS[claim.basis] || 'basis-inference'}`;
          badge.textContent = claim.basis || '推断';
          head.appendChild(badge);

          for (const refId of claim.refIds || []) {
            const idx = Number(String(refId).replace(/[^\d]/g, '')) - 1;
            const seg = hits[idx]?.segment;
            head.appendChild(renderCitationChip({
              id: refId,
              type: seg?.type === 'time' ? 'time' : 'doc',
              label: seg?.locator || refId,
              sourceTitle: activeDoc.title,
              locator: seg?.locator || '',
              quote: seg?.text || '',
            }));
          }

          const body = document.createElement('div');
          body.style.cssText = 'font-size:13px;line-height:1.7;color:var(--text-primary);';
          body.textContent = claim.claim || '';

          row.append(head, body);
          if (claim.inferenceReason) {
            const note = document.createElement('div');
            note.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:4px;';
            note.textContent = `推断依据：${claim.inferenceReason}`;
            row.appendChild(note);
          }
          askResultBox.appendChild(row);
        });

        const foot = document.createElement('div');
        foot.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:10px;';
        foot.textContent = `引用校验：保留 ${(data.claims || []).length} 条，丢弃 ${data.droppedByValidator ?? 0} 条无依据/越界引用结论。`;
        askResultBox.appendChild(foot);
      }
    } catch (err) {
      askResultBox.innerHTML = `<div style="color:var(--red);font-size:13px;">${escapeHtml(err.message)}</div>`;
    } finally {
      askBtn.disabled = false;
      askBtn.textContent = originLabel;
    }
  });

  // F2 答辩预测追问生成（挂知乎真实质疑链接 + 导出 Markdown）
  const defenseCard = wrapper.querySelector('#defense-report-card');
  const defenseList = wrapper.querySelector('#defense-questions-list');
  let generatedDefenseItems = [];

  const genBtn = wrapper.querySelector('#btn-gen-defense');

  genBtn.addEventListener('click', async () => {
    if (!activeDoc?.segments?.length) {
      showToast('先上传并解析文档，再生成答辩追问', 'warn');
      return;
    }
    genBtn.disabled = true;
    const originLabel = genBtn.textContent;
    genBtn.textContent = '检索知乎真实质疑中…';

    let data = null;
    try {
      const res = await fetch('/api/defense/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: activeDoc.title, segments: activeDoc.segments }),
      });
      data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '检索失败');
    } catch (err) {
      showToast(err.message, 'error', 5000);
      genBtn.disabled = false;
      genBtn.textContent = originLabel;
      return;
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = originLabel;
    }

    generatedDefenseItems = (data.predictedQuestions || []).map((item) => ({
      q: item.q,
      why: item.why,
      zhihuRef: item.zhihuRef || null,
    }));

    defenseCard.hidden = false;
    defenseList.innerHTML = '';

    if (data.degraded) {
      const warn = document.createElement('div');
      warn.style.cssText = 'font-size:12px;color:var(--amber);margin-bottom:8px;';
      warn.textContent = '⚠ 知乎质疑检索不可用（额度或网络）：预测问题照常生成，但不会伪造外部引用。';
      defenseList.appendChild(warn);
    }

    if ((data.topRisks || []).length) {
      const riskBox = document.createElement('div');
      riskBox.style.cssText = 'font-size:12px;background:var(--amber-soft);padding:8px 10px;border-radius:8px;margin-bottom:8px;color:var(--amber);';
      riskBox.innerHTML = data.topRisks
        .map((r) => `· ${escapeHtml(r.title)}：${escapeHtml(r.reason)}`)
        .join('<br/>');
      defenseList.appendChild(riskBox);
    }

    generatedDefenseItems.forEach((item, idx) => {
      const el = document.createElement('div');
      el.style.cssText = 'padding:10px;border:1px solid var(--border);border-radius:8px;';
      el.innerHTML = `
        <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Q${idx + 1}. ${escapeHtml(item.q)}</div>
        <div style="font-size:12px;color:var(--amber);margin-bottom:6px;">为什么会被问：${escapeHtml(item.why)}</div>
        ${
          item.zhihuRef
            ? `<div style="font-size:12px;background:var(--primary-soft);padding:6px 8px;border-radius:6px;">
                 知乎真实质疑：「${escapeHtml(item.zhihuRef.title)}」
                 <div style="color:var(--text-secondary);margin-top:2px;">${escapeHtml((item.zhihuRef.snippet || '').slice(0, 70))}…</div>
                 <a href="${escapeHtml(item.zhihuRef.url)}" target="_blank" rel="noopener noreferrer" style="margin-top:4px;display:inline-block;">查看知乎原文 ↗</a>
               </div>`
            : `<div style="font-size:12px;color:var(--text-muted);">本条暂无可核对的知乎质疑来源。</div>`
        }
      `;
      defenseList.appendChild(el);
    });

    showToast(`已生成 ${generatedDefenseItems.length} 条答辩追问${data.degraded ? '（质疑降级）' : '（含知乎真实质疑）'}`);
  });

  wrapper.querySelector('#btn-export-defense-md').addEventListener('click', () => {
    if (!generatedDefenseItems.length) return;
    const md = [
      `# 预答辩风险评估与追问清单 · ${activeDoc.title}`,
      '',
      ...generatedDefenseItems.map((it, i) =>
        `## Q${i + 1}. ${it.q}
- **触发原因**：${it.why}
- **知乎类似质疑**：${it.zhihuRef ? `${it.zhihuRef.title} ${it.zhihuRef.url}` : '暂无'}
`
      )
    ].join('\n');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pre-defense-report.md';
    a.click();
    URL.revokeObjectURL(url);
  });
}
