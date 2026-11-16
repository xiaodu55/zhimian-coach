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

export function openCitationModal(citation) {
  const modal = document.getElementById('citation-modal');
  const titleEl = document.getElementById('citation-modal-title');
  const bodyEl = document.getElementById('citation-modal-body');
  if (!modal || !bodyEl) return;

  titleEl.textContent = `来源核验 · ${citation.label || citation.id || '引用片段'}`;
  const linkHtml = citation.url
    ? `<p style="margin-top:12px;"><a href="${escapeHtml(citation.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">前往原始知乎页面核对 ↗</a></p>`
    : '';

  bodyEl.innerHTML = `
    <div style="margin-bottom:8px;">
      <span class="tag tag-blue">${escapeHtml(citation.sourceTitle || '本地文档 / 知乎观点卡')}</span>
      ${citation.locator ? `<span class="tag" style="margin-left:6px;">定位符：${escapeHtml(citation.locator)}</span>` : ''}
    </div>
    <blockquote style="margin:12px 0;padding:12px;background:var(--surface-alt);border-left:3px solid var(--primary);border-radius:4px;white-space:pre-wrap;">${escapeHtml(citation.quote || '暂无原文摘要')}</blockquote>
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
