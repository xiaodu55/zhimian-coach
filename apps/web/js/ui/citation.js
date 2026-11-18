/**
 * 统一引用结构渲染（§2 Citation / S 编号 & §11 三种 chip 样式）
 */
export function renderCitationChip(citation) {
  const type = citation.type || 'doc'; // 'zhihu' | 'doc' | 'time'
  const cls = type === 'zhihu' ? 'citation-zhihu' : type === 'time' ? 'citation-time' : 'citation-doc';
  const prefix = type === 'zhihu' ? '知乎' : type === 'time' ? '⏱' : '📄';
  const label = citation.label || citation.id || 'S1';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `citation-chip ${cls}`;
  btn.textContent = `${prefix} ${label}`;
  btn.title = '点击核对引用原文片段';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCitationModal(citation);
  });
  return btn;
}

/**
 * 证据抽屉：左边你的口述/论点，右边知乎答主的原话要点 —— 直观看到"高手怎么讲同一个概念"。
 * 传入 myText 时展示对照；没有就退化成原来的纯引用片段视图。
 */
export function openCitationModal(citation) {
  const modal = document.getElementById('citation-modal');
  const titleEl = document.getElementById('citation-modal-title');
  const bodyEl = document.getElementById('citation-modal-body');
  if (!modal || !bodyEl) return;

  const myText = String(citation.myText || '').trim();
  const quote = String(citation.quote || '').trim();

  titleEl.textContent = `证据对照 · ${citation.label || citation.id || '引用片段'}`;

  const meta = `
    <div style="margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
      <span class="tag tag-blue">${escapeHtml(citation.sourceTitle || '本地文档 / 知乎观点卡')}</span>
      ${citation.locator ? `<span class="tag">定位符：${escapeHtml(citation.locator)}</span>` : ''}
    </div>`;

  const linkHtml = citation.url
    ? `<p style="margin-top:12px;"><a href="${escapeHtml(citation.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">前往原始知乎页面核对 ↗</a></p>`
    : '';

  if (myText) {
    // 逐句对照：把你的句子与原话句子并排，能一眼看出差异
    const mine = myText.split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
    const theirs = quote.split(/(?<=[。！？!?])/).map((x) => x.trim()).filter(Boolean);
    const rows = Math.max(mine.length, theirs.length);
    let body = `<div class="evidence-compare">`;
    body += `<div>
        <div style="font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:6px;">你的说法</div>
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px;background:var(--surface-alt);">
          ${mine.map((s) => `<p style="margin:0 0 6px;font-size:13px;line-height:1.7;">${escapeHtml(s)}</p>`).join('')}
        </div>
      </div>
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--primary);margin-bottom:6px;">知乎原话要点</div>
        <div style="border:1px solid var(--primary);border-radius:8px;padding:10px;background:var(--primary-soft);">
          ${theirs.map((s) => `<p style="margin:0 0 6px;font-size:13px;line-height:1.7;">${escapeHtml(s)}</p>`).join('')}
        </div>
      </div>`;
    body += `</div>`;
    bodyEl.innerHTML = meta + body + linkHtml;
    modal.hidden = false;
    return;
  }

  bodyEl.innerHTML = `
    ${meta}
    <blockquote style="margin:12px 0;padding:12px;background:var(--surface-alt);border-left:3px solid var(--primary);border-radius:4px;white-space:pre-wrap;">${escapeHtml(quote || '暂无原文摘要')}</blockquote>
    ${linkHtml}
  `;
  modal.hidden = false;
}

export function initCitationModal() {
  const modal = document.getElementById('citation-modal');
  const closeBtn = document.getElementById('btn-close-citation');
  if (!modal) return;
  closeBtn?.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
