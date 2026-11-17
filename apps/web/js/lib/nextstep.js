/**
 * 底部「下一步」主行动条（Sticky Next-Step Bar）：
 * 不让用户抬头找顶部导航 —— 每个页面底部都有一句明确的下一步与主按钮。
 *
 * @param {object} opts
 * @param {string} opts.text      下一步说明
 * @param {Array}  opts.actions   [{label, primary, onClick, ghost}]
 * @param {string} opts.hint      可选小字说明
 */
export function renderNextStepBar({ text, actions = [], hint = '' }) {
  const bar = document.createElement('div');
  bar.className = 'next-step-bar';

  const left = document.createElement('div');
  left.style.minWidth = '0';
  const t = document.createElement('div');
  t.style.cssText = 'font-size:13.5px;font-weight:700;line-height:1.5;';
  t.textContent = text;
  left.appendChild(t);
  if (hint) {
    const h = document.createElement('div');
    h.style.cssText = 'font-size:11.5px;color:var(--text-muted);margin-top:2px;line-height:1.5;';
    h.textContent = hint;
    left.appendChild(h);
  }

  const right = document.createElement('div');
  right.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;';

  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-sm ${a.primary ? 'btn-primary' : a.ghost ? 'btn-ghost' : ''}`.trim();
    btn.textContent = a.label;
    if (a.disabled) btn.disabled = true;
    btn.addEventListener('click', () => a.onClick?.());
    right.appendChild(btn);
  }

  bar.append(left, right);
  return bar;
}

/**
 * 把下一步条挂到页面底部（页面滚动时吸底可见）
 * @param {HTMLElement} host 页面根容器
 */
export function mountNextStepBar(host, opts) {
  if (!host) return null;
  const existing = host.querySelector(':scope > .next-step-bar');
  if (existing) existing.remove();
  const bar = renderNextStepBar(opts);
  host.appendChild(bar);
  return bar;
}

/**
 * 阶段性微文案（aria-live 播报）：模型生成期间告诉用户"现在在做什么"。
 * 用法：const progress = createProgress('正在检索知乎高赞回答结构…'); progress.step('正在提炼 3 个核心考察点…'); progress.done();
 */
export function createProgress(initialText = '') {
  let host = document.querySelector('#live-progress');
  if (!host) {
    host = document.createElement('div');
    host.id = 'live-progress';
    host.className = 'live-progress';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  host.textContent = initialText;
  host.hidden = !initialText;

  return {
    step(text) {
      host.textContent = text;
      host.hidden = !text;
    },
    done() {
      host.textContent = '';
      host.hidden = true;
    },
  };
}
