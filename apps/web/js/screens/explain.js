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
        <h1 style="margin:0 0 4px;font-size:20px;">讲解室 · 文档与视频的详解总结</h1>
        <div style="font-size:13px;color:var(--text-secondary);">上传文档 / 论文 / 转写稿，或粘贴视频链接 → 可溯源详解总结 → 就地追问（查不到就说查不到）</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <label class="btn btn-sm">
          📂 上传 PDF / Markdown / TXT / 转写稿
          <input id="doc-file-input" type="file" accept=".pdf,.md,.txt,.markdown" hidden />
        </label>
        <input id="video-link-input" class="input" type="url" placeholder="视频链接（B 站 / YouTube / 公开课…）" style="width:260px;" />
        <button id="btn-parse-link" class="btn btn-sm" type="button">解析视频链接</button>
        <button id="btn-gen-summary" class="btn btn-primary btn-sm" type="button">📝 生成详解总结</button>
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
        <section id="summary-card" class="card">
          <h3 style="margin:0 0 8px;font-size:15px;">📝 详解总结（一句话概括 · 关键论点 · 材料自身的薄弱处）</h3>
          <div id="summary-box" style="font-size:13.5px;line-height:1.75;">
            <span style="color:var(--text-muted);">上传资料或解析视频链接后，点「生成详解总结」。每条结论都会标出它来自哪一段（S 编号可点击回看原文）。</span>
          </div>
        </section>

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

  // ---- 视频链接解析：抓标题/简介/字幕轨（尽力而为） ----
  const linkInput = wrapper.querySelector('#video-link-input');
  const linkBtn = wrapper.querySelector('#btn-parse-link');
  const summaryBox = wrapper.querySelector('#summary-box');

  const renderSummary = (data, refs) => {
    summaryBox.innerHTML = '';
    if (data.degraded) {
      const warn = document.createElement('div');
      warn.style.cssText = 'font-size:12px;color:var(--amber);margin-bottom:8px;';
      warn.textContent = '⚠ 模型暂不可用：已降级为原文摘录模式（零幻觉）。';
      summaryBox.appendChild(warn);
    }
    if (data.summary) {
      const head = document.createElement('div');
      head.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:8px;line-height:1.7;';
      head.textContent = data.summary;
      summaryBox.appendChild(head);
    }
    const block = (title, items, tone) => {
      if (!items?.length) return;
      const wrap = document.createElement('div');
      wrap.style.marginTop = '10px';
      const h = document.createElement('div');
      h.style.cssText = `font-size:12.5px;font-weight:700;color:${tone};margin-bottom:4px;`;
      h.textContent = title;
      wrap.appendChild(h);
      for (const it of items) {
        const row = document.createElement('div');
        row.style.cssText = 'font-size:13px;line-height:1.7;margin-bottom:5px;';
        row.textContent = '· ' + it.text;
        for (const refId of it.refIds || []) {
          const idx = Number(String(refId).replace(/[^\d]/g, '')) - 1;
          const seg = refs?.[idx];
          row.appendChild(
            renderCitationChip({
              id: refId,
              type: seg?.type === 'time' ? 'time' : 'doc',
              label: seg?.locator || refId,
              sourceTitle: activeDoc.title,
              locator: seg?.locator || '',
              quote: seg?.text || '',
            })
          );
        }
        wrap.appendChild(row);
      }
      summaryBox.appendChild(wrap);
    };
    block('关键论点', data.keyPoints, 'var(--primary)');
    block('材料自身的薄弱处', data.gaps, 'var(--amber)');
  };

  linkBtn.addEventListener('click', async () => {
    const url = linkInput.value.trim();
    if (!url) {
      showToast('先粘贴视频链接', 'warn');
      return;
    }
    linkBtn.disabled = true;
    const origin = linkBtn.textContent;
    linkBtn.textContent = '解析中…';
    try {
      const res = await fetch('/api/explain/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '链接解析失败');

      // 有字幕 → 直接切成片段，进入正常详解流程；没有 → 只登记链接与简介
      if (data.hasTranscript && data.transcript) {
        activeDoc = chunkDocumentText(data.transcript, `视频：${data.title || url}`);
        state.activeDocument = activeDoc;
        await dbPut('documents', activeDoc);
        renderSegments();
      }
      summaryBox.innerHTML = '';
      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:10px;';
      const shownTitle = data.title && data.title !== data.url ? data.title : '未能读取到页面标题（该站点可能需要登录或由 JS 渲染）';
      card.innerHTML = `
        <div style="font-weight:600;font-size:13.5px;margin-bottom:4px;">${escapeHtml(shownTitle)}</div>
        ${data.description ? `<div style="font-size:12.5px;color:var(--text-secondary);line-height:1.7;margin-bottom:6px;">${escapeHtml(String(data.description).slice(0, 400))}</div>` : ''}
        <a href="${escapeHtml(data.url)}" target="_blank" rel="noopener noreferrer" style="font-size:12px;">打开原视频 ↗</a>
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">${escapeHtml(data.note || '')}</div>
      `;
      summaryBox.appendChild(card);
      showToast(data.hasTranscript ? '已抓到字幕，正在生成详解总结…' : '链接已登记（未抓到字幕，可粘贴字幕/转写稿上传）');
      if (data.hasTranscript) summaryBtn.click();
    } catch (err) {
      showToast(err.message, 'error', 5000);
    } finally {
      linkBtn.disabled = false;
      linkBtn.textContent = origin;
    }
  });

  // ---- 详解总结 ----
  const summaryBtn = wrapper.querySelector('#btn-gen-summary');
  summaryBtn.addEventListener('click', async () => {
    if (!activeDoc?.segments?.length) {
      showToast('先上传资料或解析视频链接', 'warn');
      return;
    }
    summaryBtn.disabled = true;
    const origin = summaryBtn.textContent;
    summaryBtn.textContent = '生成中…';
    summaryBox.innerHTML = '<span style="color:var(--text-muted);font-size:13px;">正在通读材料并生成详解总结…</span>';
    try {
      const res = await fetch('/api/explain/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: activeDoc.title, segments: activeDoc.segments }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '总结生成失败');
      renderSummary(data, activeDoc.segments);
    } catch (err) {
      summaryBox.innerHTML = `<div style="color:var(--red);font-size:13px;">${escapeHtml(err.message)}</div>`;
    } finally {
      summaryBtn.disabled = false;
      summaryBtn.textContent = origin;
    }
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
}
