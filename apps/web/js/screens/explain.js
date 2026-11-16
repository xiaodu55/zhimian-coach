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
          📂 上传 Markdown / TXT / 转写稿
          <input id="doc-file-input" type="file" accept=".md,.txt,.markdown" hidden />
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

  wrapper.querySelector('#btn-ask-submit').addEventListener('click', () => {
    const q = askInput.value.trim();
    if (!q) return;
    const hits = searchSegmentsBM25(activeDoc.segments, q, 2);

    if (!hits.length) {
      askResultBox.innerHTML = `
        <div style="color:var(--amber);font-weight:600;margin-bottom:6px;">
          <span class="basis-badge basis-inference">无直接依据 · noEvidence:true</span>
          未在当前文档检索到直接依据
        </div>
        <p style="margin:0 0 8px;font-size:13px;">当前上传材料中未包含与「${escapeHtml(q)}」直接匹配的段落。为防止模型幻觉，系统拒绝生成无锚点猜测。</p>
        <div style="font-size:12px;color:var(--text-secondary);">建议检索词：<code>${escapeHtml(activeDoc.segments[0]?.heading || '核心架构')}</code> / <code>评估基线</code></div>
      `;
      return;
    }

    askResultBox.innerHTML = '';
    hits.forEach((h, i) => {
      const row = document.createElement('div');
      row.style.marginBottom = '10px';
      row.innerHTML = `
        <div style="margin-bottom:4px;">
          <span class="basis-badge basis-direct">原文直述</span>
          <strong>依据片段 #${i + 1}：</strong>
          <span class="chip-slot"></span>
        </div>
        <div style="font-size:13px;color:var(--text-secondary);">${escapeHtml(h.segment.text)}</div>
      `;
      row.querySelector('.chip-slot').appendChild(renderCitationChip({
        id: `S${i + 1}`,
        type: h.segment.type === 'time' ? 'time' : 'doc',
        label: h.segment.locator,
        sourceTitle: activeDoc.title,
        locator: h.segment.locator,
        quote: h.segment.text
      }));
      askResultBox.appendChild(row);
    });
  });

  // F2 答辩预测追问生成（挂知乎真实质疑链接 + 导出 Markdown）
  const defenseCard = wrapper.querySelector('#defense-report-card');
  const defenseList = wrapper.querySelector('#defense-questions-list');
  let generatedDefenseItems = [];

  wrapper.querySelector('#btn-gen-defense').addEventListener('click', () => {
    const zhihuCards = state.bank.flatMap((q) => q.viewpointCards || []).filter((c) => c.stance.includes('分歧'));
    generatedDefenseItems = activeDoc.segments.slice(0, 3).map((seg, idx) => {
      const zCard = zhihuCards[idx % Math.max(1, zhihuCards.length)];
      return {
        q: `针对「${seg.heading}」，如何证明你的设计不是过度工程化，且在极端边界下依然成立？`,
        why: `你的材料在 ${seg.locator} 提出了核心断言，但缺少消融实验与失败降级对比数据。`,
        zhihuRef: zCard
      };
    });

    defenseCard.hidden = false;
    defenseList.innerHTML = '';
    generatedDefenseItems.forEach((item, idx) => {
      const el = document.createElement('div');
      el.style.padding = '10px';
      el.style.border = '1px solid var(--border)';
      el.style.borderRadius = '8px';
      el.innerHTML = `
        <div style="font-weight:600;font-size:14px;margin-bottom:4px;">Q${idx + 1}. ${escapeHtml(item.q)}</div>
        <div style="font-size:12px;color:var(--amber);margin-bottom:6px;">为什么会被问：${escapeHtml(item.why)}</div>
        ${item.zhihuRef ? `
          <div style="font-size:12px;background:var(--primary-soft);padding:6px 8px;border-radius:6px;">
            知乎真实质疑参考：“${escapeHtml(item.zhihuRef.evidenceQuote)}”
            <a href="${escapeHtml(item.zhihuRef.sourceUrl)}" target="_blank" rel="noopener noreferrer" style="margin-left:6px;">查看知乎原答 ↗</a>
          </div>
        ` : ''}
      `;
      defenseList.appendChild(el);
    });
    showToast('已生成高危答辩追问清单（附知乎真实质疑来源）');
  });

  wrapper.querySelector('#btn-export-defense-md').addEventListener('click', () => {
    if (!generatedDefenseItems.length) return;
    const md = [
      `# 预答辩风险评估与追问清单 · ${activeDoc.title}`,
      '',
      ...generatedDefenseItems.map((it, i) =>
        `## Q${i + 1}. ${it.q}
- **触发原因**：${it.why}
- **知乎类似质疑**：${it.zhihuRef ? `${it.zhihuRef.evidenceQuote} (${it.zhihuRef.sourceUrl})` : '暂无'}
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
