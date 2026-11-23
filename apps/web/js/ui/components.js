import { escapeHtml, renderCitationChip } from './citation.js';

export function renderViewpointCard(card, index = 0) {
  const el = document.createElement('div');
  el.className = 'card';
  el.style.padding = '12px';
  const isMajority = card.stance && card.stance.includes('主流');
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">
      <span class="tag ${isMajority ? 'tag-blue' : 'tag-amber'}">${escapeHtml(card.stance || '观点')}</span>
      <span style="font-size:12px;color:var(--text-muted);">${card.upvotes > 0 ? `👍 ${card.upvotes} · ` : '知乎原答 · '}${escapeHtml(card.author || '知乎答主')}</span>
    </div>
    <p style="margin:0 0 8px;font-weight:600;font-size:14px;">${escapeHtml(card.summary)}</p>
    <div style="font-size:13px;color:var(--text-secondary);background:var(--surface-alt);padding:8px 10px;border-radius:6px;margin-bottom:8px;">
      “${escapeHtml(card.evidenceQuote)}”
    </div>
    <div class="card-footer-slot" style="display:flex;justify-content:space-between;align-items:center;"></div>
  `;
  const slot = el.querySelector('.card-footer-slot');
  slot.appendChild(renderCitationChip({
    id: `S${index + 1}`,
    type: 'zhihu',
    label: `S${index + 1} · 知乎原答`,
    sourceTitle: card.author || '知乎答主',
    locator: card.stance,
    quote: card.evidenceQuote,
    url: card.sourceUrl
  }));
  if (card.sourceUrl) {
    const link = document.createElement('a');
    link.href = card.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.fontSize = '12px';
    link.textContent = '知乎原链接 ↗';
    slot.appendChild(link);
  }
  return el;
}
