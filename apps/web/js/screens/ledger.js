import {
  state,
  refreshLocalCollections,
  setCoachMode,
  setActiveOpportunity,
} from '../state.js';
import { navigate } from '../router.js';
import { escapeHtml } from '../ui/citation.js';
import { dbPut, dbDelete } from '../db.js';
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
  buildReviewManualMarkdown,
  downloadTextFile,
  todayStamp,
} from '../lib/flashcards.js';

/** 招聘流程轮次（保留原有语义：选到「已挂复盘」会触发归因回流） */
const OPP_STATES = ['已投递', '一面', '二面', 'HR面', '已拿Offer', '已挂复盘'];
/** 场次生命周期：决定卡片上"下一步该做什么" */
const SESSION_STATUS = ['待面试', '待复盘', '已复盘'];
const SESSION_MODES = ['线上面试', '现场面试', '论文答辩', '模拟面试'];

export function renderLedgerScreen(root) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <!-- 数据安全三件套：固定在页面最上方，自证数据全在用户手上 -->
    <section class="card" style="margin-bottom:16px;border-left:3px solid var(--primary);">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
        <div>
          <h2 style="margin:0 0 4px;font-size:16px;">🔐 数据安全三件套（数据只在本机，零上传）</h2>
          <div style="font-size:12.5px;color:var(--text-secondary);">录音、转写稿、简历、闪卡、台账全部只存浏览器 IndexedDB；导出后由你自己决定给谁看</div>
        </div>
        <button id="btn-import-restore" class="btn btn-sm" type="button">📥 导入恢复（全量 JSON）</button>
        <input id="input-import-restore" type="file" accept="application/json,.json" hidden />
      </div>
      <div class="grid-3" style="align-items:stretch;">
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;gap:8px;">
          <strong style="font-size:13.5px;">① 一键导出全量数据包（.json）</strong>
          <span style="font-size:12px;color:var(--text-secondary);line-height:1.6;">含场次、复盘报告、薄弱点、简历解析与话术闪卡，可用于换机迁移</span>
          <button id="btn-export-bundle" class="btn btn-primary btn-sm" type="button" style="align-self:flex-start;">导出全量 .json</button>
        </div>
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;gap:8px;">
          <strong style="font-size:13.5px;">② 一键导出面试复习手册（.md）</strong>
          <span style="font-size:12px;color:var(--text-secondary);line-height:1.6;">闪卡 + 薄弱点 + 场次台账，整理成可直接打印背诵的 Markdown</span>
          <button id="btn-export-manual" class="btn btn-primary btn-sm" type="button" style="align-self:flex-start;">导出复习手册 .md</button>
        </div>
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px;display:flex;flex-direction:column;gap:8px;">
          <strong style="font-size:13.5px;">③ 存储占用与清理</strong>
          <span id="storage-usage" style="font-size:12px;color:var(--text-secondary);line-height:1.6;">正在统计本机占用…</span>
          <button id="btn-clean-audio" class="btn btn-sm" type="button" style="align-self:flex-start;">🧹 清理原始音频，只留文字稿</button>
        </div>
      </div>
    </section>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
      <div>
        <h1 style="margin:0 0 4px;font-size:20px;">弹药库台账 & 优先复习置顶队列（M11 回流闭环）</h1>
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
        </div>
      </div>
      <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.7;margin-bottom:12px;">
        复盘台会把每次作答里最好的那一版提炼成闪卡存进「弹药库」（核心结论 / 支撑论据 / 防杠兜底），只存在本机 IndexedDB。
        抽背模式下卡片默认遮住答案，点一下翻面；模式记在本次标签页，刷新后仍然生效。
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
        <h2 style="margin:0 0 12px;font-size:16px;">📋 面试 / 答辩场次追踪（标记「已挂」自动归因回流）</h2>
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
  const storageUsage = wrapper.querySelector('#storage-usage');

  /* ================= 数据安全三件套 ================= */

  /** 统计本机 IndexedDB 占用；浏览器不支持时显示"不可用" */
  const refreshStorageUsage = async () => {
    const est = await estimateStorage();
    if (!est) {
      storageUsage.textContent = '本机占用：不可用（当前浏览器不支持 storage.estimate）';
      return;
    }
    const quotaText = est.quota ? ` / 配额 ${formatBytes(est.quota)}` : '';
    storageUsage.textContent = `本机占用：${formatBytes(est.usage)}${quotaText}（含录音、转写稿、简历与闪卡）`;
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
    const md = buildReviewManualMarkdown({
      cards,
      weaknesses: state.weaknesses,
      opportunities: state.opportunities,
    });
    const name = downloadTextFile(`面试复习手册-${todayStamp()}.md`, md, 'text/markdown;charset=utf-8');
    showToast(`已导出 ${name}（闪卡 ${cards.length} 张 · 薄弱点 ${state.weaknesses.length} 项 · 场次 ${state.opportunities.length} 条）`);
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
      showToast(
        `导入恢复完成（闪卡 ${res.flashcardsRestored}/${res.flashcardsInFile} 张）`,
        res.flashcardsInFile && !res.flashcardsRestored ? 'warn' : 'info'
      );
    } catch (err) {
      showToast('导入失败：' + err.message, 'error');
    }
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

  const renderFlashcards = () => {
    fcGrid.innerHTML = '';
    fcCount.textContent = `${flashcards.length} 张`;
    if (!flashcards.length) {
      fcGrid.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:16px 0;text-align:center;grid-column:1/-1;">还没有话术闪卡。完成一次复盘后，下面的「最近复盘提炼预览」里点「存为闪卡」即可入库，或点右上角「+ 手动新增闪卡」。</div>`;
      return;
    }
    for (const card of flashcards) {
      fcGrid.appendChild(
        renderFlashcardCard(card, {
          recite,
          onTogglePracticed: async (c, checked) => {
            await updateFlashcard(c, { practiced: checked });
            c.practiced = checked;
            showToast(checked ? '已标记为「已掌握」' : '已取消「已掌握」标记');
          },
          onDelete: async (c) => {
            if (!window.confirm(`删除这张闪卡「${c.questionTitle}」？删除后无法恢复。`)) return;
            await removeFlashcard(c.id);
            await reloadFlashcards();
            showToast('已删除闪卡');
          },
        })
      );
    }
  };

  const reloadFlashcards = async () => {
    flashcards = await loadFlashcards();
    renderFlashcards();
    renderPreviews();
  };

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
      grid.appendChild(
        renderFlashcardCard(card, {
          recite,
          preview: true,
          onSave: async (c) => {
            const saved = await saveFlashcard(c);
            if (!saved) {
              showToast('闪卡未能写入本机：本地库尚未建立闪卡表，请刷新页面重试', 'warn', 4500);
              return;
            }
            await reloadFlashcards();
            showToast('已存入弹药库：可在上方闪卡网格中抽背');
          },
        })
      );
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
        const saved = await saveFlashcard(card);
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
        <div style="font-size:12px;color:var(--amber);margin-bottom:10px;">归因：${escapeHtml(w.attribution)}</div>
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
          ? `已复盘：命中 ${(review.ruleFindings || []).length} 条原话级诊断${(review.improvements || []).length ? ' · ' + review.improvements.length + ' 条改进话术' : ''}`
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
            questionTitle: `【复盘归因】${opp.company} 失利薄弱项`,
            track: fallbackQ?.track || 'AI Agent & RAG',
            attribution: '场次标记为「已挂复盘」，自动触发高频真题强化',
            priority: 'pinned',
            status: 'pending',
          });
          await refreshLocalCollections();
          renderWeaknesses();
          showToast('已自动将归因薄弱项置顶至左侧「优先复习」队列', 'warn');
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
