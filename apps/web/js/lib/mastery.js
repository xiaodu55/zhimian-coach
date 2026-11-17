/**
 * 闪卡「掌握度」纯逻辑层：生疏 / 熟练 / 随时可讲。
 *
 * 设计取舍（为什么单独一个文件）：
 *   - 掌握度字段就存放在闪卡对象里（IndexedDB 的 'flashcards' 表），
 *     本文件不另建存储，只负责「读 → 归一 → 写回」以及展示用的排序 / 分组 / 统计。
 *   - 老卡没有 mastery 字段时统一按「生疏」处理（还没背熟的直觉），
 *     并在读取后补齐写回，避免每次渲染都靠 if 兜底。
 *   - 复习手册的骨架（标题 / 薄弱点 / 场次台账）复用 lib/flashcards.js 的生成器，
 *     只把闪卡段落换成按掌握度分组的版本，全站只有一套手册格式。
 *   - 全部操作只碰本机 IndexedDB / sessionStorage，不发任何网络请求。
 */
import { dbPut } from '../db.js';
import { buildReviewManualMarkdown } from './flashcards.js';

/** 闪卡表名（与 lib/flashcards.js 的 FLASHCARD_STORE 保持一致） */
export const FLASHCARD_STORE = 'flashcards';

/** 三档掌握度，顺序即冲刺优先级：越靠前越需要背 */
const MASTERY_LEVELS = ['生疏', '熟练', '随时可讲'];

/** 筛选开关的会话级记忆键（刷新后保持，仅当前标签页有效） */
const FILTER_WEAK_KEY = 'zhimian.flashcard.filterWeak';

/** 各档视觉色：描边/文字用实色，徽章底色用同色浅底 */
const MASTERY_COLORS = {
  生疏: { fg: 'var(--red)', bg: 'var(--red-soft)' },
  熟练: { fg: 'var(--green)', bg: 'var(--green-soft)' },
  随时可讲: { fg: 'var(--primary)', bg: 'var(--primary-soft)' },
};

/** 归一化掌握度：非法或缺失一律按「生疏」 */
function normalizeMastery(value) {
  return MASTERY_LEVELS.includes(value) ? value : MASTERY_LEVELS[0];
}

/** 取一张卡的掌握度（老卡缺字段 → 生疏） */
export function cardMastery(card) {
  return normalizeMastery(card && card.mastery);
}

/** 统计各档数量：{ 生疏: n, 熟练: n, 随时可讲: n } */
export function countMastery(cards = []) {
  const counts = { 生疏: 0, 熟练: 0, 随时可讲: 0 };
  for (const c of cards) counts[cardMastery(c)] += 1;
  return counts;
}

/** 按掌握度分组：[{ level, cards }]，生疏组在最前 */
function groupCardsByMastery(cards = []) {
  const groups = MASTERY_LEVELS.map((level) => ({ level, cards: [] }));
  for (const c of cards) groups[MASTERY_LEVELS.indexOf(cardMastery(c))].cards.push(c);
  return groups;
}

/** 该档的实色（描边 / 文字 / 左边框） */
export function masteryColor(level) {
  return MASTERY_COLORS[normalizeMastery(level)].fg;
}

/** 该档的浅色底 */
function masterySoftColor(level) {
  return MASTERY_COLORS[normalizeMastery(level)].bg;
}

/** 「只看生疏」筛选状态（会话级记忆，刷新后保持） */
export function getFilterWeak() {
  try {
    return sessionStorage.getItem(FILTER_WEAK_KEY) === '1';
  } catch {
    return false;
  }
}

export function setFilterWeak(on) {
  try {
    sessionStorage.setItem(FILTER_WEAK_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式下忽略 */
  }
  return !!on;
}

/**
 * 把老卡缺失的 mastery 字段补齐并写回本机。
 * 只在字段真的缺失时写一次，避免每次进页面都产生写操作。
 * @returns {Promise<number>} 被补齐的卡片数
 */
export async function backfillMastery(cards = []) {
  let fixed = 0;
  for (const c of cards) {
    if (!c || typeof c !== 'object') continue;
    if (MASTERY_LEVELS.includes(c.mastery)) continue;
    c.mastery = MASTERY_LEVELS[0];
    fixed += 1;
    try {
      await dbPut(FLASHCARD_STORE, c);
    } catch {
      /* 本地库还没建好闪卡表时下次进页面再补 */
    }
  }
  return fixed;
}

/**
 * 闪卡卡片上的掌握度分段控件。
 * 用 <button> 而不是 <select>：抽背模式下点击卡片会翻面，闪卡渲染器对
 * button / input / select 等元素做了豁免，用按钮可以避免「点掌握度顺手翻了卡片」。
 * @param {object} card 当前闪卡（原地更新 mastery）
 * @param {{ onChange?: (card, level) => Promise<boolean|void>|boolean|void }} opts
 *        onChange 返回 false 表示写回失败，控件保持原状
 */
export function createMasteryControl(card, { onChange } = {}) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

  const label = document.createElement('span');
  label.textContent = '掌握度';
  label.style.cssText = 'font-size:12px;color:var(--text-secondary);';
  wrap.appendChild(label);

  const group = document.createElement('div');
  group.style.cssText = 'display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', '掌握度');
  wrap.appendChild(group);

  const buttons = MASTERY_LEVELS.map((level) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = level;
    btn.style.cssText =
      'border:0;border-right:1px solid var(--border);padding:4px 10px;font-size:12px;font-family:inherit;' +
      'cursor:pointer;background:var(--surface);color:var(--text-secondary);white-space:nowrap;';
    btn.addEventListener('click', async () => {
      if (cardMastery(card) === level) return;
      const ok = await onChange?.(card, level);
      if (ok === false) return; // 写回失败：保持原状
      apply(level);
    });
    group.appendChild(btn);
    return btn;
  });
  buttons[buttons.length - 1].style.borderRight = '0';

  // 抽背模式下点卡片会翻面，掌握度这一行不该顺手把答案翻出来
  wrap.addEventListener('click', (e) => e.stopPropagation());

  /** 把控件状态刷成指定档位 */
  const apply = (level) => {
    const lv = normalizeMastery(level);
    const color = masteryColor(lv);
    buttons.forEach((btn, i) => {
      const active = MASTERY_LEVELS[i] === lv;
      btn.style.background = active ? color : 'var(--surface)';
      btn.style.color = active ? '#ffffff' : 'var(--text-secondary)';
      btn.style.fontWeight = active ? '600' : '400';
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  };

  apply(cardMastery(card));
  return { element: wrap, apply };
}

/**
 * 掌握度徽章：放在卡片标题行的标签区，扫一眼就知道这张卡背到什么程度。
 * 与分段控件共用一套配色。
 */
export function createMasteryBadge(card) {
  const badge = document.createElement('span');
  badge.className = 'tag';
  badge.style.cssText = 'font-weight:600;';
  const apply = (level) => {
    const lv = normalizeMastery(level);
    badge.textContent = lv;
    badge.style.color = masteryColor(lv);
    badge.style.background = masterySoftColor(lv);
    badge.style.border = `1px solid ${masteryColor(lv)}`;
  };
  apply(cardMastery(card));
  return { element: badge, apply };
}

/**
 * Markdown 里的换行与多余空白会让列表断行，这里压平。
 * （与 lib/flashcards.js 内部同名函数同语义；那边是模块私有、且本任务不允许改它。）
 */
function mdEscape(text) {
  return String(text || '').replace(/\r?\n/g, ' ').trim();
}

/**
 * 生成带掌握度的面试复习手册 Markdown。
 *
 * 骨架（标题 / 薄弱点 / 场次台账 / 页脚）复用 lib/flashcards.js 的生成器，
 * 只把闪卡那一段替换成「按掌握度分组」的版本：生疏排最前，冲刺期照着生疏那组背。
 */
export function buildMasteryManualMarkdown({ cards = [], weaknesses = [], opportunities = [] } = {}) {
  const base = buildReviewManualMarkdown({ cards: [], weaknesses, opportunities }).split('\n');
  // 闪卡段落的边界：'## 闪卡…' 之后的第一条二级标题（薄弱点）之前
  const cardIdx = base.findIndex((l) => l.startsWith('## 闪卡'));
  const tailIdx = base.findIndex((l, i) => i > cardIdx && l.startsWith('## '));
  if (cardIdx < 0 || tailIdx < 0) {
    throw new Error('复习手册结构已变化，无法插入掌握度分组');
  }

  const cardLines = [];
  cardLines.push(`## 闪卡（${cards.length} 张）`);
  cardLines.push('');
  if (!cards.length) {
    cardLines.push('暂无闪卡。复盘台完成一次复盘后，最佳作答会被提炼成卡片存进本机弹药库。');
    cardLines.push('');
  }
  let index = 0;
  for (const group of groupCardsByMastery(cards)) {
    if (!group.cards.length) continue;
    cardLines.push(`### ${group.level}（${group.cards.length} 张）`);
    cardLines.push('');
    for (const c of group.cards) {
      index += 1;
      cardLines.push(`#### ${index}. ${mdEscape(c.questionTitle)}`);
      cardLines.push('');
      cardLines.push(`- **掌握度**：${cardMastery(c)}`);
      cardLines.push(`- **核心结论（30 秒）**：${mdEscape(c.coreConclusion)}`);
      const supports = Array.isArray(c.supports) ? c.supports : [];
      if (supports.length) {
        cardLines.push('- **支撑论据**：');
        for (const s of supports) cardLines.push(`  - ${mdEscape(s)}`);
      } else {
        cardLines.push('- **支撑论据**：暂无（复盘时补上可核对的数字或事实）');
      }
      cardLines.push(`- **防杠兜底**：${mdEscape(c.fallback)}`);
      const sourceText =
        c.source === 'review' ? `复盘提炼${c.sourceRef ? '（' + mdEscape(c.sourceRef) + '）' : ''}` : '手动新增';
      cardLines.push(`- **来源**：${sourceText}${c.sourceUrl ? `　·　[原始来源](${c.sourceUrl})` : ''}`);
      cardLines.push(`- **掌握状态**：${c.practiced ? '已掌握' : '待攻克'}`);
      cardLines.push('');
    }
  }

  return [...base.slice(0, cardIdx), ...cardLines, ...base.slice(tailIdx)].join('\n');
}
