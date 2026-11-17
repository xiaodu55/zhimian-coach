/**
 * 闪卡（结构化话术卡片）领域逻辑：提炼 / 渲染 / 抽背状态 / 本机导出与清理。
 *
 * 数据流（说明）：
 *   复盘台（screens/review.js）在拿到一份复盘报告后，调用 buildFlashcard() 把「这次答得最好的一次」
 *   提炼成一张结构化卡片（核心结论 / 支撑论据 / 防杠兜底），再用 saveFlashcard() 写进本机 IndexedDB
 *   的 'flashcards' 表；台账页（screens/ledger.js）只负责读表、展示、抽背与导出，不反向依赖复盘台。
 *   台账页自身也能从最近若干份复盘报告里「预览」提炼结果，用户点「存为闪卡」才真正落库。
 *   全部数据只落本机 IndexedDB，不发任何网络请求。
 */
import { dbGetAll, dbPut, dbDelete, importAllData, exportAllData } from '../db.js';

/** 闪卡表名（db.js 的 STORES 由统一升级负责补齐，这里只按名访问） */
export const FLASHCARD_STORE = 'flashcards';
/** 抽背模式记忆（刷新后保持，仅当前标签页有效） */
export const RECITE_MODE_KEY = 'zhimian.flashcard.recite';

const MAX_SUPPORTS = 3;
const CONCLUSION_MAX = 120;

/** 截断并压平空白，避免把长段落塞进卡片标题位 */
function trimText(text, max = CONCLUSION_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** 取首句作为兜底：去句末标点、去掉开头的「我」 */
function firstSentence(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const seg = raw.split(/[。！？!?\n；;]/).find((s) => s.trim().length > 0) || raw;
  return seg.replace(/^我[，,、]?/, '').trim();
}

/** 含数字的句子：面试里能站得住脚的论据一定是可核对的数字 */
function numericSentences(text) {
  return String(text || '')
    .split(/[。！？!?\n；;]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6 && /\d/.test(s));
}

/** 作答里的第一个数字（带单位），用来填防杠话术；跳过 P99 / QPS 这类标识符里的数字 */
function firstMetric(text) {
  const m = String(text || '').match(/(^|[^A-Za-z0-9])(\d+(?:\.\d+)?\s*(?:%|倍|ms|s|秒|万|亿|人|次|条|天|小时|分钟)?)/);
  return m ? m[2].trim() : '';
}

/**
 * 提炼核心结论：优先用模型给的改进话术，其次用最高分维度的 claim，
 * 都没有（规则模式降级）时退化为用户作答首句。
 */
function pickCoreConclusion(report, answer) {
  const improvements = Array.isArray(report?.improvements) ? report.improvements : [];
  for (const im of improvements) {
    if (im && im.claim) return trimText(im.claim);
  }
  const scores = (Array.isArray(report?.llmScores) ? report.llmScores : [])
    .filter((s) => s && s.claim)
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  if (scores[0]) return trimText(scores[0].claim);
  return trimText(firstSentence(answer), 80);
}

/**
 * 支撑论据 = 命中的规则名 + 作答里可核对的数字句，总共最多 3 条。
 * 数字句才是真正撑得住结论的东西，所以先给它留位置，再让规则名补位。
 */
function pickSupports(findings, answer) {
  const out = [];
  const rules = (Array.isArray(findings) ? findings : [])
    .map((f) => f && f.ruleName)
    .filter(Boolean);
  const numbers = numericSentences(answer);
  if (rules.length) out.push(`命中规则：${rules[0]}`);
  for (const s of numbers) {
    if (out.length >= MAX_SUPPORTS) break;
    out.push(trimText(s, 90));
  }
  for (const r of rules.slice(1)) {
    if (out.length >= MAX_SUPPORTS) break;
    out.push(`命中规则：${r}`);
  }
  return out.slice(0, MAX_SUPPORTS);
}

/**
 * 防杠兜底话术：面试官追问「你这数字在什么条件下成立」时的标准应答。
 * 有数字就把数字填进去；没有数字也必须是一句能直接念、且不说假话的话。
 */
export function buildFallback({ answer = '', question = null } = {}) {
  const metric = firstMetric(answer);
  const scope = question && question.track ? `在 ${question.track} 这个场景下` : '在这次实验的规模与流量条件下';
  const data = metric
    ? `这一点我的数据是 ${metric}`
    : '这一点我的数据我暂时只能给出手工验证的结论，还没有统一口径的统计';
  const degrade = '我会退化成只保留可验证的那部分结论，先小范围试跑再决定是否上线';
  return `${data}，边界是${scope}测出来的；如果条件不成立，${degrade}。`;
}

/**
 * 从一份复盘报告（或一次纯作答）提炼出一张闪卡。
 * @param {object} p
 * @param {object|null} p.report 复盘报告（含 question / answer / ruleFindings / llmScores / improvements）
 * @param {object|null} p.question 题目（没有报告时也要给，闪卡需要题干）
 * @param {string} p.answer 用户作答原文
 */
export function buildFlashcard({ report = null, question = null, answer = '' } = {}) {
  const q = question || report?.question || {};
  const text = answer || report?.answer || '';
  const now = new Date().toISOString();
  const cards = Array.isArray(q.viewpointCards) ? q.viewpointCards : [];
  return {
    id: 'fc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    questionId: q.id || '',
    questionTitle: q.title || '（未命名题目）',
    track: q.track || '综合',
    coreConclusion: pickCoreConclusion(report, text) || '（本次没有可用结论，请补充自己的核心观点）',
    supports: pickSupports(report?.ruleFindings, text),
    fallback: buildFallback({ answer: text, question: q }),
    source: report ? 'review' : 'manual',
    sourceRef: report?.id || '',
    sourceUrl: cards[0]?.sourceUrl || '',
    createdAt: now,
    updatedAt: now,
    practiced: false,
  };
}

/** 手动新建闪卡（没有复盘来源时用） */
export function buildManualFlashcard({ questionTitle = '', track = '综合', coreConclusion = '', supports = [], fallback = '' } = {}) {
  const now = new Date().toISOString();
  return {
    id: 'fc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    questionId: '',
    questionTitle: trimText(questionTitle, 80) || '（手动新增）',
    track: track || '综合',
    coreConclusion: trimText(coreConclusion) || '（还没写核心结论）',
    supports: (Array.isArray(supports) ? supports : []).map((s) => trimText(s, 90)).filter(Boolean).slice(0, MAX_SUPPORTS),
    fallback: trimText(fallback) || buildFallback({ answer: '' }),
    source: 'manual',
    sourceRef: '',
    sourceUrl: '',
    createdAt: now,
    updatedAt: now,
    practiced: false,
  };
}

/* ---------------- 本机持久化 ---------------- */

/** 读全部闪卡（store 尚未建立时返回空数组，不阻塞页面） */
export async function loadFlashcards() {
  try {
    const list = await dbGetAll(FLASHCARD_STORE);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 写一张闪卡；store 不存在（本地库还没升级）时返回 null，由调用方提示用户 */
export async function saveFlashcard(card) {
  try {
    const res = await dbPut(FLASHCARD_STORE, card);
    return res || null;
  } catch {
    return null;
  }
}

/** 更新闪卡（如勾选「已掌握」） */
export async function updateFlashcard(card, patch) {
  return saveFlashcard({ ...card, ...patch, updatedAt: new Date().toISOString() });
}

export async function removeFlashcard(id) {
  try {
    await dbDelete(FLASHCARD_STORE, id);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 抽背模式 ---------------- */

export function getReciteMode() {
  try {
    return sessionStorage.getItem(RECITE_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setReciteMode(on) {
  try {
    sessionStorage.setItem(RECITE_MODE_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式下忽略 */
  }
  return !!on;
}

/* ---------------- 导出 / 导入 ---------------- */

/**
 * 一键导出全量数据包：在 db.js 的 exportAllData 基础上确保闪卡与简历解析都在里面
 * （db.js 那份的导出列表不含简历解析，漏掉会让换机丢东西）。
 */
export async function exportAllDataIncludingFlashcards() {
  const dump = await exportAllData();
  for (const name of ['resumeAnalyses', FLASHCARD_STORE]) {
    if (Array.isArray(dump.stores[name])) continue;
    try {
      dump.stores[name] = await dbGetAll(name);
    } catch {
      dump.stores[name] = [];
    }
  }
  return dump;
}

/**
 * 导入恢复：db.js 的 importAllData 负责它认识的表（含 flashcards），
 * 这里再核对一遍闪卡是否真的落库，好把结果如实告诉用户。
 */
export async function importAllDataIncludingFlashcards(dump) {
  if (!dump || !dump.stores) throw new Error('无效的备份文件格式');
  await importAllData(dump);
  const cards = Array.isArray(dump.stores[FLASHCARD_STORE]) ? dump.stores[FLASHCARD_STORE] : [];
  const restored = await loadFlashcards();
  const ids = new Set(restored.map((c) => c.id));
  const hit = cards.filter((c) => c && c.id && ids.has(c.id)).length;
  return { flashcardsInFile: cards.length, flashcardsRestored: hit };
}

/* ---------------- 存储占用与音频清理 ---------------- */

/** 本机 IndexedDB 已用体积；浏览器不支持时返回 null */
export async function estimateStorage() {
  try {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return null;
    const est = await navigator.storage.estimate();
    return {
      usage: Number(est.usage) || 0,
      quota: Number(est.quota) || 0,
    };
  } catch {
    return null;
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '不可用';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * 列出还保存着原始音频的录音（清理前先给用户看清楚要删什么）。
 */
export async function listRecordingsWithAudio() {
  let list = [];
  try {
    list = await dbGetAll('recordings');
  } catch {
    list = [];
  }
  return list.filter((r) => r && (r.micBlob || r.blob || r.systemBlob || r.audioBlob));
}

/**
 * 清理原始音频，只留文字稿：把录音记录里的音频 Blob 置空，
 * 保留 captions / durationSec / deviceLabel 等文字信息。不可撤销。
 */
export async function clearRecordingAudio() {
  let list = [];
  try {
    list = await dbGetAll('recordings');
  } catch {
    list = [];
  }
  let cleared = 0;
  for (const rec of list) {
    if (!rec || !rec.id) continue;
    const hadAudio = Boolean(rec.micBlob || rec.blob || rec.systemBlob || rec.audioBlob);
    const next = { ...rec, micBlob: null, blob: null, systemBlob: null, audioBlob: null, hasSystemTrack: false };
    try {
      await dbPut('recordings', next);
      if (hadAudio) cleared += 1;
    } catch {
      /* 单条失败不阻断整体清理 */
    }
  }
  return { total: list.length, cleared };
}

/* ---------------- 复习手册（Markdown） ---------------- */

function mdEscape(text) {
  return String(text || '').replace(/\r?\n/g, ' ').trim();
}

/**
 * 生成「面试复习手册」Markdown：闪卡 → 薄弱点 → 场次台账。
 */
export function buildReviewManualMarkdown({ cards = [], weaknesses = [], opportunities = [] } = {}) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const lines = [];
  lines.push('# 面试复习手册');
  lines.push('');
  lines.push(`> 导出时间：${now.toLocaleString('zh-CN')}　·　来源：本机浏览器 IndexedDB（未上传任何数据）`);
  lines.push('');

  lines.push(`## 闪卡（${cards.length} 张）`);
  lines.push('');
  if (!cards.length) {
    lines.push('暂无闪卡。复盘台完成一次复盘后，最佳作答会被提炼成卡片存进本机弹药库。');
    lines.push('');
  }
  cards.forEach((c, i) => {
    lines.push(`### ${i + 1}. ${mdEscape(c.questionTitle)}`);
    lines.push('');
    lines.push(`- **核心结论（30 秒）**：${mdEscape(c.coreConclusion)}`);
    const supports = Array.isArray(c.supports) ? c.supports : [];
    if (supports.length) {
      lines.push('- **支撑论据**：');
      for (const s of supports) lines.push(`  - ${mdEscape(s)}`);
    } else {
      lines.push('- **支撑论据**：暂无（复盘时补上可核对的数字或事实）');
    }
    lines.push(`- **防杠兜底**：${mdEscape(c.fallback)}`);
    const sourceText = c.source === 'review' ? `复盘提炼${c.sourceRef ? '（' + mdEscape(c.sourceRef) + '）' : ''}` : '手动新增';
    lines.push(`- **来源**：${sourceText}${c.sourceUrl ? `　·　[原始来源](${c.sourceUrl})` : ''}`);
    lines.push(`- **掌握状态**：${c.practiced ? '已掌握' : '待攻克'}`);
    lines.push('');
  });

  lines.push(`## 薄弱点（${weaknesses.length} 项）`);
  lines.push('');
  if (!weaknesses.length) {
    lines.push('暂无待复习薄弱点。');
  } else {
    for (const w of weaknesses) {
      lines.push(`- [${w.status === 'mastered' ? 'x' : ' '}] ${mdEscape(w.questionTitle)}${w.track ? `（${mdEscape(w.track)}）` : ''}`);
      if (w.attribution) lines.push(`  - 归因：${mdEscape(w.attribution)}`);
    }
  }
  lines.push('');

  lines.push(`## 场次台账（${opportunities.length} 条）`);
  lines.push('');
  if (!opportunities.length) {
    lines.push('暂无场次记录。');
  } else {
    for (const o of opportunities) {
      const parts = [mdEscape(o.company || '未命名场次'), o.role ? mdEscape(o.role) : '', o.stage ? mdEscape(o.stage) : '', o.status ? mdEscape(o.status) : ''].filter(Boolean);
      lines.push(`- ${parts.join(' · ')}${o.scheduledAt ? `　·　${mdEscape(o.scheduledAt)}` : ''}`);
      if (o.note) lines.push(`  - 备注：${mdEscape(o.note)}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('本手册由「知面陪练」台账页在本机生成，文件不会离开你的电脑。');
  lines.push('');
  return lines.join('\n');
}

/** 触发浏览器下载（Blob + a.click()，不经过任何服务端） */
export function downloadTextFile(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

/** 今天日期（YYYY-MM-DD），用于文件名 */
export function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------------- 渲染 ---------------- */

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/**
 * 渲染一张闪卡。
 * @param {object} card 闪卡数据
 * @param {object} opts
 * @param {boolean} opts.recite 抽背模式：默认遮住答案，点卡片翻面
 * @param {boolean} opts.preview 预览卡（还没入库）
 * @param {Function} opts.onTogglePracticed (card, checked) => void
 * @param {Function} opts.onSave (card) => void
 * @param {Function} opts.onDelete (card) => void
 */
export function renderFlashcardCard(card, opts = {}) {
  const { recite = false, preview = false, onTogglePracticed, onSave, onDelete } = opts;
  const root = el('div', 'display:flex;flex-direction:column;gap:10px;padding:14px;border-left:3px solid ' + (recite ? 'var(--primary)' : 'var(--border)'));
  root.className = 'card';

  /* 头部：题干（可折叠）+ 来源标签 + 已掌握勾选 */
  const head = el('div', 'display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;');
  const left = el('div', 'flex:1;min-width:220px;');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor:pointer;font-weight:600;font-size:14px;line-height:1.55;';
  summary.textContent = card.questionTitle || '（未命名题目）';
  const meta = el('div', 'font-size:11.5px;color:var(--text-muted);margin-top:4px;', [card.track || '综合', card.questionId || ''].filter(Boolean).join(' · '));
  details.append(summary, meta);
  left.append(details);
  head.append(left);

  const right = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');
  const srcTag = el('span', '', card.source === 'review' ? '复盘提炼' : '手动新增');
  srcTag.className = 'tag ' + (card.source === 'review' ? 'tag-blue' : '');
  right.append(srcTag);
  if (preview) {
    const p = el('span', '', '预览 · 未入库');
    p.className = 'tag tag-amber';
    right.append(p);
  }
  const label = el('label', 'display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-secondary);cursor:pointer;');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!card.practiced;
  cb.addEventListener('change', () => {
    if (onTogglePracticed) onTogglePracticed(card, cb.checked);
  });
  label.append(cb, document.createTextNode('已掌握'));
  right.append(label);
  head.append(right);
  root.append(head);

  /* 答案区（抽背模式下默认遮住） */
  const body = el('div', 'display:flex;flex-direction:column;gap:8px;');
  const concl = el('div', 'font-size:13.5px;line-height:1.7;');
  concl.innerHTML = '<strong style="color:var(--primary);">核心结论：</strong>';
  concl.append(document.createTextNode(card.coreConclusion || '—'));
  body.append(concl);

  const supports = Array.isArray(card.supports) ? card.supports : [];
  const supBox = el('div', 'font-size:13px;line-height:1.7;');
  supBox.innerHTML = '<strong style="color:var(--primary);">支撑论据：</strong>';
  if (supports.length) {
    const ul = document.createElement('ul');
    ul.style.cssText = 'margin:4px 0 0;padding-left:18px;';
    for (const s of supports) {
      const li = document.createElement('li');
      li.textContent = s;
      ul.append(li);
    }
    supBox.append(ul);
  } else {
    supBox.append(document.createTextNode('暂无（复盘时补上可核对的数字或事实）'));
  }
  body.append(supBox);

  const fb = el('div', 'font-size:13px;line-height:1.7;padding:8px 10px;border-radius:6px;background:var(--surface-alt);');
  fb.innerHTML = '<strong style="color:var(--primary);">防杠兜底：</strong>';
  fb.append(document.createTextNode(card.fallback || '—'));
  body.append(fb);

  const hint = el('div', 'font-size:12.5px;color:var(--text-muted);padding:10px;border:1px dashed var(--border);border-radius:6px;text-align:center;', '🙈 答案已遮住 · 点击卡片翻面');
  root.append(body, hint);

  let flipped = false;
  const applyFlip = () => {
    // 内联 display 会盖掉 [hidden] 的 UA 样式，这里直接改 display，别用 hidden 属性
    if (!recite) {
      body.style.display = 'flex';
      hint.style.display = 'none';
      return;
    }
    body.style.display = flipped ? 'flex' : 'none';
    hint.style.display = flipped ? 'none' : 'block';
  };
  applyFlip();

  root.addEventListener('click', (e) => {
    if (!recite) return;
    if (e.target.closest('button,input,select,textarea,summary,a,label')) return;
    flipped = !flipped;
    applyFlip();
  });

  /* 操作区 */
  const actions = el('div', 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;');
  if (preview && onSave) {
    const save = el('button', '', '存为闪卡');
    save.type = 'button';
    save.className = 'btn btn-primary btn-sm';
    save.addEventListener('click', () => onSave(card));
    actions.append(save);
  }
  if (!preview && onDelete) {
    const del = el('button', '', '删除');
    del.type = 'button';
    del.className = 'btn btn-sm';
    del.addEventListener('click', () => onDelete(card));
    actions.append(del);
  }
  if (actions.childElementCount) root.append(actions);

  return root;
}
