import {
  state,
  refreshLocalCollections,
  setCoachMode,
  setActiveOpportunity,
} from '../state.js';
import { navigate } from '../router.js';
import { humanizeRule } from '../rules/labels.js';
import { escapeHtml } from '../ui/citation.js';
import { dbPut, dbDelete, resetLocalData } from '../db.js';
import { showToast } from '../ui/toast.js';
import { createModal, modalButton } from '../ui/modal.js';
import {
  buildFlashcard,
  buildManualFlashcard,
  renderFlashcardCard,
  getReciteMode,
  setReciteMode,
  loadFlashcards,
  saveFlashcard,
  updateFlashcard,
  removeFlashcard,
  exportAllDataIncludingFlashcards,
  importAllDataIncludingFlashcards,
  estimateStorage,
  formatBytes,
  listRecordingsWithAudio,
  clearRecordingAudio,
  downloadTextFile,
  todayStamp,
} from '../lib/flashcards.js';
import { sanitizeFlashcardData } from '../lib/optimizer.js';
import {
  FLASHCARD_STORE,
  backfillMastery,
  buildMasteryManualMarkdown,
  cardMastery,
  countMastery,
  createMasteryBadge,
  createMasteryControl,
  getFilterWeak,
  masteryColor,
  setFilterWeak,
} from '../lib/mastery.js';

/** 招聘流程轮次（保留原有语义：选到「已挂复盘」会把薄弱项补进优先复习队列） */
const OPP_STATES = ['已投递', '一面', '二面', 'HR面', '已拿Offer', '已挂复盘'];
/** 场次生命周期：决定卡片上"下一步该做什么" */
const SESSION_STATUS = ['待面试', '待复盘', '已复盘'];
const SESSION_MODES = ['线上面试', '现场面试', '论文答辩', '模拟面试'];

/* ---------------- 闪卡文案清洗 ---------------- */

/** 历史闪卡里存过内部规则前缀（形如「命中 规则：R4 · STAR 结构要素不足 3 项」），直接上屏等于让用户读日志 */
const RULE_CODE = /(?:命中\s*规则[:：]?\s*|\bR\d+\b\s*[·:：-]?\s*)/g;
/** 论据是给人一眼扫完的，超过这个长度就截断 */
const SUPPORT_MAX = 40;

/** 优先在标点处收口，避免把数字和单位劈开 */
function clipSentence(text, max = SUPPORT_MAX) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('、'));
  return (cut >= max * 0.6 ? head.slice(0, cut) : head) + '…';
}

/**
 * 单条论据 → 人话。
 * 规则型论据翻译成「⚠️ 缺少量化结果」这种可读标签；用户自己的作答句保留原句，
 * 只剥掉夹带的编号并截短。清洗只发生在渲染副本上，绝不回写本机库。
 */
function humanizeSupport(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^命中\s*规则/.test(text) || /^R\d+\b/.test(text)) {
    const { icon, label } = humanizeRule(text.replace(/^命中\s*规则[:：]?\s*/, ''));
    // 兜底：万一映射表里没有这条规则名，也不能把内部前缀漏到界面上
    return `${icon} ${/命中\s*规则|\bR\d+\b/.test(label) ? '可优化点' : label}`;
  }
  return clipSentence(text.replace(RULE_CODE, ' ').replace(/\s{2,}/g, ' ').trim());
}

/** 渲染用副本：论据翻译成人话，其余正文顺手剥掉可能被模型带出来的编号；回调仍拿原卡 */
function presentableCard(card) {
  const cleanText = (t) =>
    /命中\s*规则|\bR\d+\b/.test(String(t || '')) ? stripRuleCodes(t) : t;
  const base = {
    ...card,
    questionTitle: cleanText(card.questionTitle),
    coreConclusion: cleanText(card.coreConclusion),
    fallback: cleanText(card.fallback),
    supports: (Array.isArray(card.supports) ? card.supports : []).map(humanizeSupport).filter(Boolean),
  };
  // 再走一遍统一清洗：诊断标签不能当论据，"边界是在 X 场景下"这类模板拼接要换成自然话术
  return sanitizeFlashcardData(base, { track: card.track });
}

/** 论据列表改成 1. 2. 3. 的有序形式，比圆点更好对照背诵 */
function markSupportList(cardEl) {
  const list = cardEl.querySelector('ul');
  if (!list) return;
  list.style.listStyle = 'decimal';
  list.style.paddingLeft = '20px';
}

/** 薄弱点归因等长文本：只剥编号，不整句翻译，保住原意 */
const stripRuleCodes = (text) => String(text || '').replace(RULE_CODE, ' ').replace(/\s{2,}/g, ' ').trim();

export function renderLedgerScreen(root) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <!-- 数据只在本地，但没必要用一整张卡来强调：压成一行工具条，把首屏让给复习队列 -->
    <div
      style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 12px;margin-bottom:16px;background:var(--surface-alt);border-radius:8px;min-height:44px;"
    >
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-muted);">
        <span aria-hidden="true">🔐</span>
        <span id="storage-usage">正在统计本机占用…</span>
      </span>
      <span aria-hidden="true" style="color:var(--text-muted);font-size:12px;">·</span>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto;">
        <button id="btn-export-bundle" class="btn btn-ghost btn-sm" type="button" title="含场次、复盘报告、薄弱点、简历解析与话术闪卡，可用于换机迁移">导出 JSON</button>
        <button id="btn-export-manual" class="btn btn-ghost btn-sm" type="button" title="闪卡 + 薄弱点 + 场次台账，整理成可直接打印背诵的 Markdown">导出复习手册 .md</button>
        <button id="btn-import-restore" class="btn btn-ghost btn-sm" type="button" title="从之前导出的全量 JSON 恢复本机数据">导入恢复</button>
        <button id="btn-clean-audio" class="btn btn-ghost btn-sm" type="button" title="删除录音的原始音频，字幕与转写稿全部保留">清理音频</button>
        <button id="btn-reset-local" class="btn btn-ghost btn-sm" type="button" title="清空本机全部数据（换机或排查本地库异常时用）">重置本机</button>
        <input id="input-import-restore" type="file" accept="application/json,.json" hidden />
      </div>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
      <div>
        <h1 style="margin:0 0 4px;font-size:20px;">弹药库台账 · 优先复习与话术闪卡</h1>
        <div style="font-size:13px;color:var(--text-secondary);">复盘中标记的薄弱点自动置顶；场次按状态给出下一步动作（待面试→练简历，待复盘→传录音，已复盘→看报告）</div>
      </div>
      <button id="btn-add-opp" class="btn btn-primary btn-sm" type="button">+ 新增面试 / 答辩场次</button>
    </div>

    <!-- 话术闪卡区：结构化话术卡片库 -->
    <section class="card" style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
        <h2 style="margin:0;font-size:16px;">🗂 我的话术闪卡</h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span id="flashcard-count" class="tag">0 张</span>
          <button id="btn-recite-toggle" class="btn btn-sm" type="button">🎴 考前速览 / 抽背模式</button>
          <button id="btn-add-flashcard" class="btn btn-sm" type="button">+ 手动新增闪卡</button>
        <button id="btn-quick-quiz" class="btn btn-primary btn-sm" type="button">🎯 快问快答（抽一张练）</button>
        </div>
      </div>
      <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.7;margin-bottom:12px;">
        复盘台会把每次作答里最好的那一版提炼成闪卡存进「弹药库」（核心结论 / 支撑论据 / 防杠兜底），只存在本机 IndexedDB。
        抽背模式下卡片默认遮住答案，点一下翻面；模式记在本次标签页，刷新后仍然生效。
      </div>
      <!-- 掌握度统计 + 只看生疏的筛选：与抽背模式互不冲突，一个决定"看哪些卡"，一个决定"答案要不要遮" -->
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface-alt);">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text);cursor:pointer;user-select:none;">
          <input type="checkbox" id="flashcard-filter-weak" style="width:16px;height:16px;accent-color:var(--red);cursor:pointer;" />
          <span>只看生疏的</span>
        </label>
        <span id="flashcard-stats" style="font-size:12.5px;color:var(--text-secondary);"></span>
      </div>
      <div id="flashcard-grid" class="grid-2" style="align-items:start;"></div>
      <div id="flashcard-preview" style="margin-top:14px;"></div>
    </section>

    <div class="grid-2" style="align-items:start;">
      <!-- 左侧：优先复习队列 -->
      <section class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h2 style="margin:0;font-size:16px;">🔥 优先复习置顶队列（薄弱点弹药库）</h2>
          <span class="tag tag-red">${state.weaknesses.length} 项待攻克</span>
        </div>
        <div id="weakness-list" style="display:flex;flex-direction:column;gap:10px;"></div>
      </section>

      <!-- 右侧：机会与答辩场次状态机 -->
      <section class="card">
        <h2 style="margin:0 0 12px;font-size:16px;">📋 面试 / 答辩场次追踪（标记「已挂」自动补进复习队列）</h2>
        <div id="opp-list" style="display:flex;flex-direction:column;gap:10px;"></div>
      </section>
    </div>
  `;
  root.appendChild(wrapper);

  const weakBox = wrapper.querySelector('#weakness-list');
  const oppBox = wrapper.querySelector('#opp-list');
  const fcGrid = wrapper.querySelector('#flashcard-grid');
  const fcPreview = wrapper.querySelector('#flashcard-preview');
  const fcCount = wrapper.querySelector('#flashcard-count');
  const fcStats = wrapper.querySelector('#flashcard-stats');
  const storageUsage = wrapper.querySelector('#storage-usage');

  /* ================= 数据安全工具条 ================= */

  /** 统计本机 IndexedDB 占用；浏览器不支持时显示"不可用" */
  const refreshStorageUsage = async () => {
    const est = await estimateStorage();
    if (!est) {
      storageUsage.textContent = '本机占用：不可用';
      storageUsage.title = '当前浏览器不支持存储统计，不影响导出与清理';
      return;
    }
    storageUsage.textContent = `本地已用 ${formatBytes(est.usage)}`;
    // 配额属于补充信息，放 title 里，避免工具条被撑成两行
    storageUsage.title = est.quota
      ? `本机配额 ${formatBytes(est.quota)}；含录音、转写稿、简历与闪卡`
      : '含录音、转写稿、简历与闪卡';
  };

  wrapper.querySelector('#btn-export-bundle').addEventListener('click', async () => {
    const dump = await exportAllDataIncludingFlashcards();
    const name = downloadTextFile(
      `zhimian-数据包-${todayStamp()}.json`,
      JSON.stringify(dump, null, 2),
      'application/json'
    );
    const counts = Object.entries(dump.stores)
      .map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : 0}`)
      .join(' · ');
    showToast(`已导出 ${name}（${counts}）`);
  });

  wrapper.querySelector('#btn-export-manual').addEventListener('click', async () => {
    const cards = await loadFlashcards();
    // 导出的手册按掌握度分组：生疏排最前，冲刺期照着生疏那组背
    const md = buildMasteryManualMarkdown({
      cards,
      weaknesses: state.weaknesses,
      opportunities: state.opportunities,
    });
    const counts = countMastery(cards);
    const name = downloadTextFile(`面试复习手册-${todayStamp()}.md`, md, 'text/markdown;charset=utf-8');
    showToast(
      `已导出 ${name}（闪卡 ${cards.length} 张：生疏 ${counts['生疏']} · 熟练 ${counts['熟练']} · 随时可讲 ${counts['随时可讲']}）`
    );
  });

  wrapper.querySelector('#btn-import-restore').addEventListener('click', () => {
    wrapper.querySelector('#input-import-restore').click();
  });

  wrapper.querySelector('#input-import-restore').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const res = await importAllDataIncludingFlashcards(JSON.parse(text));
      await refreshLocalCollections();
      await reloadFlashcards();
      // 导入会改变本机占用，工具条上的数字要跟着刷新
      await refreshStorageUsage();
      showToast(
        `导入恢复完成（闪卡 ${res.flashcardsRestored}/${res.flashcardsInFile} 张）`,
        res.flashcardsInFile && !res.flashcardsRestored ? 'warn' : 'info'
      );
    } catch (err) {
      showToast('导入失败：' + err.message, 'error');
    }
  });

  // 顶栏的"重置"收进工具条：排障入口不能丢，但也不该占顶栏
  wrapper.querySelector('#btn-reset-local').addEventListener('click', async () => {
    const modal = createModal({
      title: '重置本机数据',
      subtitle: '会清空录音、转写稿、薄弱点、闪卡、场次与简历解析记录，无法撤销',
      width: 480,
    });
    const tip = document.createElement('div');
    tip.style.cssText = 'font-size:13px;line-height:1.8;color:var(--text-secondary);';
    tip.textContent = '只在"换电脑"或"本地库异常（页面卡在骨架屏）"时使用。建议先点上面的「导出 JSON」备份。';
    modal.body.appendChild(tip);
    const input = wrapper.querySelector('#btn-reset-local');
    modal.footer.append(
      modalButton('取消', { ghost: true, onClick: () => modal.close() }),
      modalButton('确认重置', {
        primary: true,
        onClick: async () => {
          modal.close();
          await resetLocalData();
          showToast('本地数据已清空，正在刷新…');
          setTimeout(() => location.reload(), 600);
        },
      })
    );
    input.blur?.();
  });

  // 快问快答：优先抽生疏卡，其次随机
  wrapper.querySelector('#btn-quick-quiz').addEventListener('click', () => {
    if (!flashcards.length) {
      showToast('还没有闪卡：先在复盘台点「存入我的弹药库」', 'warn');
      return;
    }
    const weak = flashcards.filter((c) => cardMastery(c) === '生疏');
    const pool = weak.length ? weak : flashcards;
    const card = pool[Math.floor(Math.random() * pool.length)];
    openQuickQuiz(card);
  });

  wrapper.querySelector('#btn-clean-audio').addEventListener('click', async () => {
    // 先数一遍有多少条录音还带音频，让用户知道自己要删掉什么
    const pending = await listRecordingsWithAudio();
    const modal = createModal({
      title: '清理原始音频，只留文字稿',
      subtitle: '此操作不可撤销：音频一旦删除只能重新录，字幕、转写稿与时长信息全部保留',
      width: 520,
    });
    const body = document.createElement('div');
    body.style.cssText = 'font-size:13.5px;line-height:1.8;';
    body.textContent = pending.length
      ? `本机共 ${pending.length} 条录音仍保存着原始音频（麦克风轨与系统轨），清理后会释放对应存储空间；文字稿与字幕一条都不会丢。`
      : '本机已经没有保存原始音频的录音了（可能已经清理过），无需操作。';
    modal.body.appendChild(body);

    if (pending.length) {
      const confirmBtn = modalButton(`确认清理 ${pending.length} 条录音的音频`, {
        primary: true,
        onClick: async () => {
          confirmBtn.disabled = true;
          const res = await clearRecordingAudio();
          await refreshStorageUsage();
          modal.close();
          showToast(
            res.cleared
              ? `已清理 ${res.cleared} 条录音的原始音频（共 ${res.total} 条），文字稿全部保留`
              : '没有找到可清理的原始音频（可能已经清理过）'
          );
        },
      });
      const cancel = modalButton('取消', { ghost: true, onClick: () => modal.close() });
      modal.footer.append(cancel, confirmBtn);
    } else {
      const close = modalButton('知道了', { primary: true, onClick: () => modal.close() });
      modal.footer.append(close);
    }
  });

  /* ================= 闪卡区 ================= */

  /** 本机已存闪卡（不在 state 里，避免改动共享 state 模块） */
  let flashcards = [];
  let recite = getReciteMode();
  /** 「只看生疏的」突击模式：记在 sessionStorage，刷新后保持 */
  let filterWeak = getFilterWeak();

  const weakToggle = wrapper.querySelector('#flashcard-filter-weak');
  weakToggle.checked = filterWeak;

  /** 只刷计数与统计行，不重建卡片（避免抽背模式下翻开的卡片被重置） */
  const renderFlashcardMeta = () => {
    const counts = countMastery(flashcards);
    const visible = filterWeak ? flashcards.filter((c) => cardMastery(c) === '生疏').length : flashcards.length;
    fcStats.textContent =
      `共 ${flashcards.length} 张 · 生疏 ${counts['生疏']} 张 · 熟练 ${counts['熟练']} 张 · 随时可讲 ${counts['随时可讲']} 张`;
    fcCount.textContent = filterWeak ? `${visible} / ${flashcards.length} 张` : `${flashcards.length} 张`;
  };

  /** 写回掌握度：只写本机 IndexedDB，不发任何网络请求 */
  const persistMastery = async (card, level) => {
    const next = { ...card, mastery: level, updatedAt: new Date().toISOString() };
    try {
      const res = await dbPut(FLASHCARD_STORE, next);
      if (!res) {
        showToast('掌握度未能写入本机：本地库尚未建立闪卡表，请刷新页面重试', 'warn', 4500);
        return false;
      }
      return true;
    } catch (err) {
      showToast('掌握度保存失败：' + (err?.message || '本机存储不可用'), 'error');
      return false;
    }
  };

  /**
   * 快问快答：把闪卡变成能做题的复习器。
   * 抽一张卡 → 只看题干与"必须覆盖的要点" → 自己讲 → 翻面对照 → 自评（讲清 / 还卡壳），
   * 自评结果直接回写掌握度：卡壳的卡留在「生疏」里，下次还会被抽到。
   */
  const openQuickQuiz = (rawCard) => {
    // 用清洗后的副本：诊断标签不能当"必须覆盖的要点"念给用户听
    const card = presentableCard(rawCard);
    const modal = createModal({
      title: '快问快答',
      subtitle: '按抽背顺序讲一遍，再对照你的标准答案',
      width: 620,
    });
    const body = document.createElement('div');
    const points = (card.supports || []).slice(0, 3);

    body.innerHTML = `
      <div style="font-size:14px;font-weight:600;line-height:1.6;margin-bottom:8px;">${escapeHtml(card.questionTitle || '')}</div>
      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px;">
        必须覆盖 ${points.length} 个要点（先自己讲，别急着看）：</div>
      <ul style="margin:0 0 12px;padding-left:18px;font-size:13px;line-height:1.8;color:var(--text-secondary);">
        ${points.map((p) => `<li>${escapeHtml(String(p).slice(0, 40))}…</li>`).join('')}
      </ul>
      <div id="quiz-answer" hidden style="border-top:1px dashed var(--border);padding-top:10px;">
        <div style="font-size:12.5px;font-weight:700;color:var(--primary);margin-bottom:4px;">你的标准答案</div>
        <div style="font-size:13px;line-height:1.75;">${escapeHtml(card.coreConclusion || '')}</div>
        ${(card.supports || []).length ? `<div style="font-size:12.5px;color:var(--text-secondary);margin-top:6px;">支撑：${card.supports.map((x) => escapeHtml(String(x).slice(0, 28))).join('；')}</div>` : ''}
        ${card.fallback ? `<div style="font-size:12.5px;color:var(--amber);margin-top:6px;">防杠兜底：${escapeHtml(String(card.fallback).slice(0, 80))}</div>` : ''}
      </div>
    `;
    modal.body.appendChild(body);

    const revealBtn = modalButton('我讲完了，看标准答案', {
      primary: true,
      onClick: () => {
        body.querySelector('#quiz-answer').hidden = false;
        revealBtn.textContent = '已展开';
        revealBtn.disabled = true;
        selfBox.style.display = 'flex';
      },
    });
    const selfBox = document.createElement('div');
    selfBox.style.cssText = 'display:none;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center;';
    selfBox.innerHTML = '<span style="font-size:12.5px;color:var(--text-secondary);">讲清楚了吗？</span>';
    const good = modalButton('讲清楚了 ✓', {
      onClick: async () => {
        const ok = await persistMastery(card, cardMastery(card) === '生疏' ? '熟练' : '随时可讲');
        if (!ok) return;
        card.mastery = cardMastery(card);
        card.practiced = true;
        await dbPut(FLASHCARD_STORE, card);
        modal.close();
        renderFlashcards();
        showToast('已记为「' + card.mastery + '」');
      },
    });
    const bad = modalButton('还卡壳 ✗', {
      onClick: async () => {
        const ok = await persistMastery(card, '生疏');
        if (!ok) return;
        card.mastery = '生疏';
        await dbPut(FLASHCARD_STORE, card);
        modal.close();
        renderFlashcards();
        showToast('已留在「生疏」里，下次还会抽到这张');
      },
    });
    selfBox.append(good, bad);
    modal.body.appendChild(selfBox);
    modal.footer.append(modalButton('关闭', { ghost: true, onClick: () => modal.close() }), revealBtn);
  };

  /** 突击模式下没有生疏卡时的提示 */
  const renderFlashcardEmptyState = () => {
    fcGrid.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:16px 0;text-align:center;grid-column:1/-1;">当前没有生疏的闪卡 —— 全部卡片都已标记为熟练或随时可讲。取消上方「只看生疏的」可以看全部。</div>`;
  };

  /**
   * 卡片左边框 = 掌握度颜色，一眼扫出哪几张还没背熟。
   * 抽背模式的「答案已遮住」提示已经承担了模式信号，这里可以放心复用边框。
   */
  const applyMasteryBorder = (cardEl, level) => {
    cardEl.style.borderLeftColor = masteryColor(level);
  };

  const renderFlashcards = () => {
    fcGrid.innerHTML = '';
    renderFlashcardMeta();
    if (!flashcards.length) {
      fcGrid.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:16px 0;text-align:center;grid-column:1/-1;">还没有话术闪卡。完成一次复盘后，下面的「最近复盘提炼预览」里点「存为闪卡」即可入库，或点右上角「+ 手动新增闪卡」。</div>`;
      return;
    }
    const visible = filterWeak ? flashcards.filter((c) => cardMastery(c) === '生疏') : flashcards;
    if (!visible.length) {
      renderFlashcardEmptyState();
      return;
    }
    for (const card of visible) {
      let cardEl = null;
      const badge = createMasteryBadge(card);
      const control = createMasteryControl(card, {
        onChange: async (c, level) => {
          const ok = await persistMastery(c, level);
          if (!ok) return false;
          c.mastery = level;
          // 徽章、边框一起跟着掌握度走，扫一眼就能分出哪几张还没背熟
          badge.apply(level);
          if (cardEl) applyMasteryBorder(cardEl, level);
          renderFlashcardMeta();
          // 突击模式下刚被改成「熟练」的卡要立刻离开视野
          if (filterWeak && level !== '生疏' && cardEl?.parentNode) {
            cardEl.remove();
            if (!fcGrid.querySelector('.card')) renderFlashcardEmptyState();
          }
          return true;
        },
      });
      // 传给渲染器的是清洗后的展示副本；回调仍用原卡，保证 practiced / mastery 状态写回同一对象
      cardEl = renderFlashcardCard(presentableCard(card), {
        recite,
        onTogglePracticed: async (_displayed, checked) => {
          await updateFlashcard(card, { practiced: checked });
          card.practiced = checked;
          showToast(checked ? '已标记为「已掌握」' : '已取消「已掌握」标记');
        },
        onDelete: async () => {
          if (!window.confirm(`删除这张闪卡「${card.questionTitle}」？删除后无法恢复。`)) return;
          await removeFlashcard(card.id);
          await reloadFlashcards();
          showToast('已删除闪卡');
        },
      });
      markSupportList(cardEl);
      applyMasteryBorder(cardEl, cardMastery(card));
      // 徽章插到标题行的标签区（"复盘提炼 / 手动新增" 旁边）
      const head = cardEl.firstElementChild;
      const tagRow = head.lastElementChild;
      tagRow.insertBefore(badge.element, tagRow.firstChild);
      // 掌握度控件放在标题之下：抽背模式遮住的是答案区，这一行始终可见
      cardEl.insertBefore(control.element, head.nextSibling);
      fcGrid.appendChild(cardEl);
    }
  };

  const reloadFlashcards = async () => {
    flashcards = await loadFlashcards();
    // 老卡没有 mastery 字段：统一按「生疏」补齐并写回本机
    await backfillMastery(flashcards);
    renderFlashcards();
    renderPreviews();
  };

  weakToggle.addEventListener('change', () => {
    filterWeak = setFilterWeak(weakToggle.checked);
    renderFlashcards();
    showToast(filterWeak ? '已进入「只看生疏的」突击模式' : '已恢复显示全部闪卡');
  });

  /** 从最近几份复盘报告提炼预览（不落库，用户确认后才写入） */
  const buildPreviews = () => {
    const reports = (state.sessions || [])
      .filter((s) => s && s.question && (s.answer || '').trim())
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, 3);
    // 已经存过的同一份复盘不再重复预览，避免用户误以为要存两张
    const savedRefs = new Set(flashcards.map((c) => c.sourceRef).filter(Boolean));
    return reports
      .filter((r) => !savedRefs.has(r.id))
      .map((r) => buildFlashcard({ report: r, question: r.question, answer: r.answer }));
  };

  const renderPreviews = () => {
    fcPreview.innerHTML = '';
    const previews = buildPreviews();
    if (!previews.length) {
      fcPreview.innerHTML = `<div style="font-size:12.5px;color:var(--text-muted);padding:10px 0;">本机还没有复盘报告可用于提炼。先去陪练室答一题、到复盘台生成报告，这里会自动出现可存为闪卡的预览。</div>`;
      return;
    }
    const head = document.createElement('div');
    head.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:8px;';
    head.textContent = '最近复盘提炼预览（未入库，确认后才写入本机）';
    fcPreview.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'grid-2';
    grid.style.alignItems = 'start';
    for (const card of previews) {
      // 预览也是给用户看的，同样走一遍人话清洗；存库时存的就是清洗后的版本
      const cardEl = renderFlashcardCard(presentableCard(card), {
        recite,
        preview: true,
        onSave: async (c) => {
          // 新提炼的卡默认「生疏」：刚整理出来的话术本来就还没背熟
          const saved = await saveFlashcard({ ...c, mastery: '生疏' });
          if (!saved) {
            showToast('闪卡未能写入本机：本地库尚未建立闪卡表，请刷新页面重试', 'warn', 4500);
            return;
          }
          await reloadFlashcards();
          showToast('已存入弹药库：可在上方闪卡网格中抽背');
        },
      });
      markSupportList(cardEl);
      grid.appendChild(cardEl);
    }
    fcPreview.appendChild(grid);
  };

  const reciteBtn = wrapper.querySelector('#btn-recite-toggle');
  const syncReciteBtn = () => {
    reciteBtn.className = recite ? 'btn btn-primary btn-sm' : 'btn btn-sm';
    reciteBtn.textContent = recite ? '🎴 抽背模式已开启（点此退出）' : '🎴 考前速览 / 抽背模式';
  };
  reciteBtn.addEventListener('click', () => {
    recite = setReciteMode(!recite);
    syncReciteBtn();
    renderFlashcards();
    renderPreviews();
    showToast(recite ? '已进入抽背模式：卡片只显示题干，点一下翻面' : '已退出抽背模式：显示完整答案');
  });
  syncReciteBtn();

  /** 手动新增闪卡：题干 / 核心结论 / 支撑论据 / 防杠兜底 */
  wrapper.querySelector('#btn-add-flashcard').addEventListener('click', () => {
    const modal = createModal({
      title: '手动新增话术闪卡',
      subtitle: '把脑子里那句最好的话直接存下来：一句核心结论 + 可核对的论据 + 一句防杠兜底',
      width: 560,
    });
    const form = document.createElement('div');
    form.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    const field = (label, node, placeholder = '') => {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-secondary);';
      const lb = document.createElement('span');
      lb.textContent = label;
      if (placeholder) node.placeholder = placeholder;
      wrap.append(lb, node);
      form.appendChild(wrap);
      return node;
    };

    const title = field('题干 *', document.createElement('input'), '例如：讲清楚你的 RAG 检索优化');
    title.className = 'input';
    title.type = 'text';
    const conclusion = field('30 秒核心结论 *', document.createElement('textarea'), '一句话说清你的立场与依据');
    conclusion.className = 'textarea';
    conclusion.rows = 3;
    const supports = field('支撑论据（每行一条，最多 3 条）', document.createElement('textarea'), '例如：线上召回率从 62% 提升到 81%\n例如：P99 延迟从 800ms 降到 320ms');
    supports.className = 'textarea';
    supports.rows = 3;
    const fallback = field(
      '防杠兜底话术',
      document.createElement('textarea'),
      '留空则自动生成："这一点我的数据是 X，边界是 Y，如果条件不成立我会退化成 Z"'
    );
    fallback.className = 'textarea';
    fallback.rows = 2;

    modal.body.appendChild(form);

    const submit = modalButton('存入弹药库', {
      primary: true,
      onClick: async () => {
        const t = title.value.trim();
        const c = conclusion.value.trim();
        if (!t || !c) {
          showToast('题干与核心结论都要填', 'warn');
          if (!t) title.focus();
          else conclusion.focus();
          return;
        }
        const card = buildManualFlashcard({
          questionTitle: t,
          coreConclusion: c,
          supports: supports.value.split('\n').map((s) => s.trim()).filter(Boolean),
          fallback: fallback.value.trim(),
        });
        // 手动新增的卡同样默认「生疏」
        const saved = await saveFlashcard({ ...card, mastery: '生疏' });
        if (!saved) {
          showToast('闪卡未能写入本机：本地库尚未建立闪卡表，请刷新页面重试', 'warn', 4500);
          return;
        }
        await reloadFlashcards();
        modal.close();
        showToast('已存入弹药库');
      },
    });
    const cancel = modalButton('取消', { ghost: true, onClick: () => modal.close() });
    modal.footer.append(cancel, submit);
  });

  const renderWeaknesses = () => {
    if (!state.weaknesses.length) {
      weakBox.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:16px 0;text-align:center;">暂无待复习薄弱点。在复盘台点击「标记薄弱点」或讲解室点击「这个我没懂」会自动置顶至此。</div>`;
      return;
    }
    weakBox.innerHTML = '';
    state.weaknesses.forEach((w) => {
      const el = document.createElement('div');
      el.style.padding = '12px';
      el.style.border = '1px solid #fecdca';
      el.style.background = '#fffbfa';
      el.style.borderRadius = '8px';
      el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span class="tag tag-red">置顶优先复习</span>
          <span style="font-size:12px;color:var(--text-muted);">${escapeHtml(w.track || '综合')}</span>
        </div>
        <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${escapeHtml(w.questionTitle)}</div>
        <div style="font-size:12px;color:var(--amber);margin-bottom:10px;">原因：${escapeHtml(stripRuleCodes(w.attribution) || '待补充')}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button type="button" class="btn btn-sm btn-remove-wk">已掌握移除</button>
          <button type="button" class="btn btn-primary btn-sm btn-practice-wk">立即针对练习 →</button>
        </div>
      `;
      el.querySelector('.btn-remove-wk').addEventListener('click', async () => {
        await dbDelete('weaknesses', w.id);
        await refreshLocalCollections();
        renderWeaknesses();
        showToast('已标记为掌握');
      });
      el.querySelector('.btn-practice-wk').addEventListener('click', () => {
        const targetQ = state.bank.find((q) => q.id === w.questionId) || state.bank[0];
        if (targetQ) state.activeQuestion = targetQ;
        navigate('/coach');
      });
      weakBox.appendChild(el);
    });
  };

  /** 场次 → 关联的复盘报告（复盘报告里存了 opportunityId） */
  const linkedReview = (opp) => state.sessions.find((s) => s.opportunityId === opp.id) || null;

  /** 状态 → 下一步该做什么 */
  const nextAction = (opp, review) => {
    if (opp.status === '待复盘') {
      return {
        text: '上传录音或会议纪要，生成这场面试的复盘（复盘结果会自动回到这条场次）',
        primary: '上传录音 / 纪要复盘 →',
        action: 'record',
      };
    }
    if (opp.status === '已复盘') {
      return {
        text: review
          ? `已复盘：这次找出 ${(review.ruleFindings || []).length} 处可改进点${(review.improvements || []).length ? ' · ' + review.improvements.length + ' 条改进话术' : ''}`
          : '已复盘（报告未在本机找到，可能换了浏览器）',
        primary: '查看复盘报告 →',
        action: 'view-review',
      };
    }
    return {
      text: opp.resumeReady
        ? '简历已按这家公司练过，面试前再把要点过一遍'
        : '上传简历，按这家公司的岗位出题练一遍（练过的题会留在本机）',
      primary: opp.resumeReady ? '再练一次 →' : '上传简历练习 →',
      action: 'resume',
    };
  };

  const openSession = (opp, action) => {
    if (action === 'resume') {
      setCoachMode('resume');
      setActiveOpportunity(opp);
      navigate('/coach');
      return;
    }
    if (action === 'record') {
      setCoachMode('record');
      setActiveOpportunity(opp);
      navigate('/coach');
      return;
    }
    if (action === 'view-review') {
      const review = linkedReview(opp);
      if (!review) {
        showToast('本机没找到这场面试的复盘报告', 'warn');
        return;
      }
      state.lastReviewReport = review;
      navigate('/review');
    }
  };

  const renderOpps = async () => {
    if (!state.opportunities.length) {
      const seedOpp = {
        id: 'opp-seed-1',
        company: 'AI Agent 核心研发岗（模拟样例）',
        stage: '二面',
        status: '待面试',
        note: '重点考察 RAG 确定性评测与高并发队列',
        createdAt: new Date().toISOString(),
      };
      await dbPut('opportunities', seedOpp);
      await refreshLocalCollections();
    }
    oppBox.innerHTML = '';
    state.opportunities.forEach((opp) => {
      const status = SESSION_STATUS.includes(opp.status) ? opp.status : '待面试';
      const review = linkedReview(opp);
      const plan = nextAction({ ...opp, status }, review);

      const el = document.createElement('div');
      el.style.cssText = 'padding:12px;border:1px solid var(--border);border-radius:8px;';
      el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
          <div style="min-width:0;">
            <strong style="font-size:14px;">${escapeHtml(opp.company || '未命名场次')}</strong>
            ${opp.role ? `<span style="font-size:12px;color:var(--text-muted);margin-left:6px;">${escapeHtml(opp.role)}</span>` : ''}
            <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;">
              ${opp.scheduledAt ? escapeHtml(opp.scheduledAt) : '时间待定'}${opp.mode ? ' · ' + escapeHtml(opp.mode) : ''}
              ${opp.reviewId ? ' · 已有复盘报告' : ''}${opp.resumeReady ? ' · 简历已备' : ''}
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <select class="select stage-select" style="width:auto;padding:4px 8px;font-size:12px;" title="轮次">
              ${OPP_STATES.map((s) => `<option value="${s}" ${opp.stage === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
            <select class="select status-select" style="width:auto;padding:4px 8px;font-size:12px;" title="场次状态">
              ${SESSION_STATUS.map((s) => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
        </div>
        ${opp.note ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">${escapeHtml(opp.note)}</div>` : ''}
        <div class="session-next" style="font-size:12.5px;line-height:1.6;padding:8px 10px;border-radius:6px;background:var(--surface-alt);margin-bottom:8px;">
          <strong style="color:var(--primary);">下一步：</strong>${escapeHtml(plan.text)}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm btn-opp-del">删除</button>
          ${status === '待面试' ? '<button type="button" class="btn btn-sm btn-opp-done">标记已面试（待复盘）</button>' : ''}
          <button type="button" class="btn btn-primary btn-sm btn-opp-next">${escapeHtml(plan.primary)}</button>
        </div>
      `;

      el.querySelector('.stage-select').addEventListener('change', async (e) => {
        const newStage = e.target.value;
        opp.stage = newStage;
        await dbPut('opportunities', opp);
        if (newStage === '已挂复盘') {
          const fallbackQ = state.bank[0];
          await dbPut('weaknesses', {
            id: 'wk-opp-' + opp.id,
            questionId: fallbackQ?.id || 'q-rag-eval-01',
            questionTitle: `【复盘发现】${opp.company} 失利薄弱项`,
            track: fallbackQ?.track || 'AI Agent & RAG',
            attribution: '场次标记为「已挂复盘」，自动触发高频真题强化',
            priority: 'pinned',
            status: 'pending',
          });
          await refreshLocalCollections();
          renderWeaknesses();
          showToast('已自动把这场面试的薄弱项置顶到左侧「优先复习」队列', 'warn');
        }
      });

      el.querySelector('.status-select').addEventListener('change', async (e) => {
        opp.status = e.target.value;
        await dbPut('opportunities', opp);
        await refreshLocalCollections();
        renderOpps();
        showToast(`场次状态已更新为「${opp.status}」`);
      });

      el.querySelector('.btn-opp-next').addEventListener('click', () => openSession(opp, plan.action));

      el.querySelector('.btn-opp-done')?.addEventListener('click', async () => {
        opp.status = '待复盘';
        await dbPut('opportunities', opp);
        await refreshLocalCollections();
        renderOpps();
        showToast('已标记为「待复盘」：现在可以上传录音或会议纪要了');
      });

      el.querySelector('.btn-opp-del').addEventListener('click', async () => {
        if (!window.confirm(`删除场次「${opp.company}」？关联的复盘报告不会被删除。`)) return;
        await dbDelete('opportunities', opp.id);
        await refreshLocalCollections();
        renderOpps();
        showToast('已删除场次');
      });

      oppBox.appendChild(el);
    });
  };

  /** 新增场次：正经表单（公司/岗位/轮次/时间/形式/备注） */
  const openAddSession = () => {
    const modal = createModal({
      title: '新增面试 / 答辩场次',
      subtitle: '创建后会给出"下一步该做什么"，并把这场面试和复盘室的录音、复盘报告串起来',
      width: 560,
    });

    const form = document.createElement('div');
    form.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    const field = (label, node) => {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-secondary);';
      const lb = document.createElement('span');
      lb.textContent = label;
      wrap.append(lb, node);
      form.appendChild(wrap);
      return node;
    };

    const company = document.createElement('input');
    company.className = 'input';
    company.type = 'text';
    company.placeholder = '例如：字节跳动 · AI Infra 实习';
    field('公司 / 项目 *', company);

    const role = document.createElement('input');
    role.className = 'input';
    role.type = 'text';
    role.placeholder = '例如：Agent 平台研发 / 硕士开题答辩';
    field('岗位 / 答辩主题', role);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;';
    const stage = document.createElement('select');
    stage.className = 'select';
    stage.innerHTML = OPP_STATES.map((s) => `<option value="${s}"${s === '一面' ? ' selected' : ''}>${s}</option>`).join('');
    const status = document.createElement('select');
    status.className = 'select';
    status.innerHTML = SESSION_STATUS.map((s) => `<option value="${s}"${s === '待面试' ? ' selected' : ''}>${s}</option>`).join('');
    const when = document.createElement('input');
    when.className = 'input';
    when.type = 'date';
    fieldWrap(row, '轮次', stage);
    fieldWrap(row, '状态', status);
    fieldWrap(row, '场次日期', when);
    form.appendChild(row);

    const mode = document.createElement('select');
    mode.className = 'select';
    mode.innerHTML = SESSION_MODES.map((m) => `<option value="${m}">${m}</option>`).join('');
    field('形式', mode);

    const note = document.createElement('textarea');
    note.className = 'textarea';
    note.rows = 3;
    note.placeholder = '例如：重点考察 RAG 确定性评测与高并发队列；需要准备 Agent 权限模型的取舍';
    field('备注', note);

    modal.body.appendChild(form);

    const submit = modalButton('创建场次', {
      primary: true,
      onClick: async () => {
        const name = company.value.trim();
        if (!name) {
          showToast('请填写公司 / 项目名称', 'warn');
          company.focus();
          return;
        }
        const opp = {
          id: 'opp-' + Date.now(),
          company: name,
          role: role.value.trim(),
          stage: stage.value,
          status: status.value,
          scheduledAt: when.value || '',
          mode: mode.value,
          note: note.value.trim(),
          resumeReady: false,
          reviewId: '',
          createdAt: new Date().toISOString(),
        };
        await dbPut('opportunities', opp);
        await refreshLocalCollections();
        modal.close();
        renderOpps();
        showToast(`已创建场次「${name}」：下一步 = ${nextAction(opp, null).primary}`);
      },
    });
    const cancel = modalButton('取消', { ghost: true, onClick: () => modal.close() });
    modal.footer.append(cancel, submit);
  };

  /** 在一行里放 label + 控件 */
  function fieldWrap(row, label, node) {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-secondary);flex:1;min-width:120px;';
    const lb = document.createElement('span');
    lb.textContent = label;
    wrap.append(lb, node);
    row.appendChild(wrap);
  }

  wrapper.querySelector('#btn-add-opp').addEventListener('click', openAddSession);

  renderWeaknesses();
  renderOpps();
  reloadFlashcards();
  refreshStorageUsage();
}
