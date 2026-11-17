import { escapeHtml } from '../ui/citation.js';
import { showToast } from '../ui/toast.js';

/**
 * 跨路由直达的「上下文守卫」：
 * 新用户直接点顶部导航进到下游页面（模拟练 / 看复盘 / 抗压测 / 拆逻辑）时，
 * 不要给空页面或禁用按钮，而是给一张"马上能开始"的推荐卡。
 *
 * @param {object} opts
 * @param {string} opts.title      守卫标题
 * @param {string} opts.hint       说明文字
 * @param {Array}  opts.recent     最近练习记录 [{id, title, at}]
 * @param {Array}  opts.recommend  推荐题 [{id, title, context, track}]
 * @param {Function} opts.onPick   选中题目后的回调 (question)
 * @param {Function} opts.onRender 渲染容器 (container) => void  可选：自定义额外内容
 */
export function renderEmptyContextGuard({ title, hint, recent = [], recommend = [], onPick, onRender }) {
  const wrap = document.createElement('div');
  wrap.className = 'empty-guard';

  const head = document.createElement('div');
  head.innerHTML = `
    <div style="font-size:15px;font-weight:700;margin-bottom:6px;">${escapeHtml(title)}</div>
    <div style="font-size:13px;color:var(--text-secondary);line-height:1.7;">${escapeHtml(hint)}</div>
  `;
  wrap.appendChild(head);

  // 推荐题：直接开始
  if (recommend.length) {
    const q = recommend[0];
    const box = document.createElement('div');
    box.className = 'card';
    box.style.marginTop = '12px';
    box.innerHTML = `
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">
        <span class="tag tag-blue">${escapeHtml(q.track || '高频真题')}</span>
        <span class="tag">${escapeHtml(q.difficulty || '进阶')}</span>
        <span class="tag tag-green">可直接开始</span>
      </div>
      <div style="font-weight:600;font-size:14px;line-height:1.5;margin-bottom:4px;">${escapeHtml(q.title || '')}</div>
      ${q.context ? `<div style="font-size:12.5px;color:var(--text-secondary);line-height:1.7;">${escapeHtml(String(q.context).slice(0, 160))}</div>` : ''}
    `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-sm';
    btn.style.marginTop = '10px';
    btn.textContent = '一键载入并开始 →';
    btn.addEventListener('click', () => onPick?.(q));
    box.appendChild(btn);
    wrap.appendChild(box);
  }

  // 最近记录：恢复上次上下文
  if (recent.length) {
    const box = document.createElement('div');
    box.className = 'card';
    box.style.marginTop = '10px';
    const sel = document.createElement('select');
    sel.className = 'select';
    sel.style.width = '100%';
    sel.innerHTML =
      '<option value="">选择最近练过的题目，恢复上下文…</option>' +
      recent
        .map((r) => `<option value="${escapeHtml(r.id || '')}">${escapeHtml(String(r.title || '').slice(0, 60))}</option>`)
        .join('');
    sel.addEventListener('change', () => {
      const hit = recent.find((r) => r.id === sel.value);
      if (hit) {
        onPick?.(hit);
        showToast('已恢复上次的练习上下文');
      }
    });
    box.appendChild(sel);
    wrap.appendChild(box);
  }

  if (onRender) onRender(wrap);
  return wrap;
}

/**
 * 在页面里挂上上下文守卫：没有 activeQuestion 时用它占位，而不是空页面。
 * @returns {boolean} 是否挂上了守卫
 */
export function mountEmptyContextGuard(container, opts) {
  if (!container) return false;
  container.innerHTML = '';
  container.appendChild(renderEmptyContextGuard(opts));
  return true;
}

/** 从本地 sessions 里取最近练过的题目（作为"最近记录"） */
export function recentQuestionOptions(sessions, limit = 5) {
  const seen = new Set();
  const out = [];
  for (const s of sessions || []) {
    const q = s?.question;
    if (!q?.id || seen.has(q.id)) continue;
    seen.add(q.id);
    out.push({ id: q.id, title: q.title, context: q.context, track: q.track, difficulty: q.difficulty, at: s.createdAt });
    if (out.length >= limit) break;
  }
  return out;
}

/** 推荐题：从题库里挑一道适合热身的（基础难度优先） */
export function recommendWarmupQuestion(bank) {
  const pool = bank || [];
  return pool.find((q) => q.difficulty === '基础') || pool[0] || null;
}
