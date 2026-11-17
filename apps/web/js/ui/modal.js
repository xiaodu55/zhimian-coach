/**
 * 通用弹窗（滑窗）组件：复用 index.html 里 citation 弹窗的样式类（.modal-backdrop / .modal-card / .modal-header / .modal-body）。
 * 用途：简历要点选择 → 候选题目选择的两步向导。
 */

export function createModal({ title, subtitle = '', width = 720 }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const card = document.createElement('div');
  card.className = 'modal-card';
  card.style.width = `min(${width}px, 94vw)`;
  card.style.maxWidth = '94vw';

  const header = document.createElement('div');
  header.className = 'modal-header';
  const titleEl = document.createElement('h3');
  titleEl.textContent = title;
  header.appendChild(titleEl);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-icon';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.textContent = '✕';
  header.appendChild(closeBtn);

  const subEl = document.createElement('div');
  if (subtitle) {
    subEl.style.cssText = 'font-size:12.5px;color:var(--text-muted);padding:0 16px 8px;';
    subEl.textContent = subtitle;
  }

  const body = document.createElement('div');
  body.className = 'modal-body';
  body.style.cssText = 'max-height:min(64vh, 560px);overflow:auto;';

  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.style.cssText = 'border-top:1px solid var(--border);padding:12px 16px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';

  card.append(header, subEl, body, footer);
  backdrop.appendChild(card);

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);

  return {
    el: backdrop,
    body,
    footer,
    close,
    setTitle: (t) => {
      titleEl.textContent = t;
    },
    setSubtitle: (t) => {
      subEl.textContent = t;
      subEl.style.display = t ? '' : 'none';
    },
  };
}

/** 弹窗底部按钮 */
export function modalButton(label, { primary = false, ghost = false, onClick } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn ${primary ? 'btn-primary' : ghost ? 'btn-ghost' : ''}`.trim();
  btn.textContent = label;
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}
