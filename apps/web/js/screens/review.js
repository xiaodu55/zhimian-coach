import { state, refreshLocalCollections } from '../state.js';
import { navigate, getCurrentRoute } from '../router.js';
import { escapeHtml, renderCitationChip } from '../ui/citation.js';
import { renderViewpointCard } from '../ui/components.js';
import { dbPut, dbGetAll } from '../db.js';
import { showToast } from '../ui/toast.js';
import { mountEmptyContextGuard, recentQuestionOptions, recommendWarmupQuestion } from '../lib/empty-guard.js';
import { mountNextStepBar, createProgress } from '../lib/nextstep.js';
import { humanizeRule } from '../rules/labels.js';
import { countChars } from '../capture/speechmetrics.js';
import { countEffectiveChars, formatDimensionScore, sanitizeFlashcardData } from '../lib/optimizer.js';

/**
 * 找出"我说的那句"：模型结论里提到的关键名词（术语/数字）如果在用户作答里出现过，
 * 就用那句作答做证据对照的左栏；找不到就退回作答的前两句。
 */
function myStatementFor(answer, claim) {
  const mine = String(answer || '');
  if (!mine) return '';
  const tokens = String(claim || '').match(/[A-Za-z]{2,}|[0-9]+(?:\.[0-9]+)?%?/g) || [];
  const sentences = mine.split(/(?<=[。！？!?\n])/).map((x) => x.trim()).filter(Boolean);
  const hit = sentences.find((sent) => {
    const st = sent.match(/[A-Za-z]{2,}|[0-9]+(?:\.[0-9]+)?%?/g) || [];
    return tokens.some((tk) => st.includes(tk));
  });
  return (hit || sentences.slice(0, 2).join('')).slice(0, 400);
}

export async function renderReviewScreen(root) {
  // 刷新/换页后 state 里没有报告时，从本地 IndexedDB 取最近一次复盘（数据只在本地）
  let report = state.lastReviewReport;
  if (!report) {
    try {
      const sessions = await dbGetAll('sessions').catch(() => []);
      const usable = sessions
        .filter((x) => x && x.question && (x.ruleFindings || x.llmScores))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      if (usable.length) {
        report = usable[0];
        state.lastReviewReport = report;
      }
    } catch {
      /* 本地库不可用：保持空状态 */
    }
  }

  // 取本地记录是异步的：期间用户可能已经切走页面，这时不要再往 root 里写
  if (getCurrentRoute() !== 'review') return;

  if (!report) {
    // 没有可复盘的记录 → 上下文守卫：给推荐题与最近记录，而不是一张空页面
    root.innerHTML = '<div id="review-empty-guard"></div>';
    const recent = recentQuestionOptions(state.sessions);
    const warm = recommendWarmupQuestion(state.bank);
    mountEmptyContextGuard(root.querySelector('#review-empty-guard'), {
      title: '你还没有可复盘的作答记录',
      hint: '可以直接开始这道高频热身题（系统会带你去模拟练），或者恢复上次练过的题目上下文。',
      recent,
      recommend: warm ? [warm] : [],
      onPick: (q) => {
        state.activeQuestion = q;
        navigate('/coach');
      },
      onRender: (wrap) => {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'btn btn-ghost btn-sm';
        back.style.marginTop = '10px';
        back.textContent = '返回题库首页';
        back.addEventListener('click', () => navigate('/bank'));
        wrap.appendChild(back);
      },
    });
    return;
  }

  const { question, answer, ruleFindings = [], degraded } = report;
  const resumeReview = report.resumeReview || null;
  const majorityCard = question.viewpointCards?.[0];
  const minorityCard = question.viewpointCards?.[1];

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:10px;">
      <div>
        <h1 style="margin:0 0 4px;font-size:20px;">复盘台 · 三方对照与原话级诊断</h1>
        <div style="font-size:13px;color:var(--text-secondary);">题目：${escapeHtml(question.title)}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="btn-mark-weakness" class="btn btn-danger btn-sm" type="button">📌 存入我的弹药库（本地）</button>
        <button id="btn-retry-coach" class="btn btn-sm" type="button">再练一题 →</button>
      </div>
    </div>

    <!-- 答题时长与语速雷达：面试里"讲 45 秒"和"讲 5 分钟"完全不同 -->
    <div id="speech-metrics-box" style="margin-bottom:16px;" hidden></div>

    <!-- 复盘盲区 → 专项追问（写完会给出跳转按钮） -->
    <div id="special-questions-box" class="card" style="margin-bottom:16px;display:none;" hidden></div>

    <!-- 一键生成满分润色版：原话 ⇄ 可背版本的直观对比 -->
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div>
          <strong style="font-size:14px;">✨ 一键生成满分润色版</strong>
          <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;">保留你的事实与数字，补上结论前置、量化基线与边界条件，产出可以直接背的版本。</div>
        </div>
        <button id="btn-polish" class="btn btn-primary btn-sm" type="button">生成润色版 →</button>
      </div>
      <div id="polish-box" style="margin-top:12px;" hidden></div>
    </div>

    ${degraded ? `
      <div class="card" style="background:var(--amber-soft);border-color:#fedf89;margin-bottom:16px;padding:10px 14px;font-size:13px;color:var(--amber);">
        <strong>⚠ 显式降级提示：</strong> 当前展示为「确定性规则层诊断（10 条规则）+ 知乎观点卡对照」。每条诊断均严格回指你的回答原话与字符区间，绝无模型幻觉编造。
      </div>
    ` : ''}

    <!-- M7 三方对照并排视图：你的回答 ⇄ 知乎主流观点 ⇄ 知乎分歧 -->
    <section style="margin-bottom:20px;">
      <h2 style="font-size:15px;margin:0 0 10px;color:var(--text-secondary);">一、三方对照（你的回答 ⇄ 知乎主流观点 ⇄ 知乎分歧）</h2>
      <div class="grid-3">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span class="tag">你的回答原话</span>
            <span style="font-size:12px;color:var(--text-muted);">${countEffectiveChars(answer)} 字</span>
          </div>
          <div id="user-answer-highlighted" style="font-size:14px;white-space:pre-wrap;line-height:1.7;"></div>
        </div>
        <div id="slot-majority"></div>
        <div id="slot-minority"></div>
      </div>
    </section>

    ${
      resumeReview
        ? `
    <section style="margin-bottom:20px;">
      <h2 style="font-size:15px;margin:0 0 10px;color:var(--text-secondary);">二、简历 × 口述对照（这段录音与你简历是否自洽）</h2>
      <div class="card" style="background:var(--primary-soft);border-color:#cfe0ff;">
        <div style="font-size:13.5px;font-weight:600;margin-bottom:8px;">${escapeHtml(resumeReview.verdict || '')}</div>
        <ul style="margin:0 0 8px;padding-left:18px;font-size:13px;line-height:1.75;">
          ${(resumeReview.consistency || [])
            .map(
              (c) => `<li>
                <span class="tag ${c.verdict === '一致' ? 'tag-green' : c.verdict === '不一致' ? 'tag-red' : ''}">${escapeHtml(c.verdict || '')}</span>
                简历「${escapeHtml(c.claim || '')}」／口述「${escapeHtml(c.said || '')}」
                ${c.risk ? `<div style="color:var(--amber);font-size:12px;">风险：${escapeHtml(c.risk)}</div>` : ''}
              </li>`
            )
            .join('')}
        </ul>
        ${
          (resumeReview.risks || []).length
            ? `<div style="font-size:12.5px;color:var(--amber);margin-bottom:6px;">易被击穿处：${escapeHtml(resumeReview.risks.join(' / '))}</div>`
            : ''
        }
        ${
          (resumeReview.followups || []).length
            ? `<div style="font-size:12.5px;">针对这段录音的追问：${escapeHtml(resumeReview.followups.join(' / '))}</div>`
            : ''
        }
      </div>
    </section>`
        : ''
    }

    <!-- M5 确定性诊断列表（可展开看原话/字符区间/规则/改进建议） -->
    <section>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <h2 style="font-size:15px;margin:0;color:var(--text-secondary);">${resumeReview ? '三' : '二'}、可核对原话诊断（命中 ${ruleFindings.length} 条 · 点击展开详情）</h2>
      </div>
      <div id="findings-list"></div>
    </section>

    <!-- AI 观点层：对照知乎来源的四维评分（每条结论必须带可点开的 S 编号） -->
    <section style="margin-top:22px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <h2 style="font-size:15px;margin:0;color:var(--text-secondary);">三、AI 观点层（对照知乎观点卡 · 引用可核对）</h2>
        <span class="tag">${(report.llmScores || []).length} 条结构化结论</span>
      </div>
      <div id="llm-layer"></div>
    </section>
  `;
  root.appendChild(wrapper);

  // 渲染三方对照中的知乎观点卡
  const slotMaj = wrapper.querySelector('#slot-majority');
  const slotMin = wrapper.querySelector('#slot-minority');
  if (majorityCard) slotMaj.appendChild(renderViewpointCard(majorityCard, 0));
  if (minorityCard) {
    slotMin.appendChild(renderViewpointCard(minorityCard, 1));
  } else {
    slotMin.innerHTML = `<div class="card" style="color:var(--text-muted);font-size:13px;">本题暂无补充少数派分歧观点卡。</div>`;
  }

  // 渲染带原话高亮的回答文本
  const answerBox = wrapper.querySelector('#user-answer-highlighted');
  const renderHighlightedAnswer = (targetQuote = null) => {
    if (!targetQuote || !answer.includes(targetQuote)) {
      answerBox.textContent = answer;
      return;
    }
    const idx = answer.indexOf(targetQuote);
    const before = escapeHtml(answer.slice(0, idx));
    const mid = escapeHtml(targetQuote);
    const after = escapeHtml(answer.slice(idx + targetQuote.length));
    answerBox.innerHTML = `${before}<mark class="quote-highlight">${mid}</mark>${after}`;
  };
  renderHighlightedAnswer();

  // 三、AI 观点层（数据来自陪练室提交时 /api/coach/parse 的返回）
  renderLlmLayer(wrapper, report);

  // 答题时长与语速雷达
  (() => {
    const box = wrapper.querySelector('#speech-metrics-box');
    const m = report.speechMetrics;
    if (!box || !m) return;
    box.hidden = false;
    const hasDuration = Number(m.durationSec) > 0;
    const paceTone = m.pace === '适中' ? 'var(--green)' : m.pace === '偏快' ? 'var(--amber)' : 'var(--primary)';
    box.innerHTML = `
      <div class="card" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
        <div style="min-width:190px;">
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:2px;">${hasDuration ? '表达节奏' : '篇幅自检'}</div>
          <div style="font-size:16px;font-weight:700;">${escapeHtml(hasDuration ? m.verdict || '' : `${countEffectiveChars(answer)} 字`)}</div>
          ${
            hasDuration
              ? ''
              : `<div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;">这次是文字作答，没有录音时长可比</div>`
          }
        </div>
        <div style="flex:1;min-width:220px;">
          ${
            hasDuration
              ? `<div style="height:8px;border-radius:999px;background:var(--border);overflow:hidden;">
                   <div style="height:100%;width:${Math.max(2, Math.min(100, Math.round((Number(m.cpm) || 0) / 4)))}%;background:${paceTone};"></div>
                 </div>`
              : ''
          }
          <div style="font-size:12.5px;color:var(--text-secondary);margin-top:6px;line-height:1.7;">${escapeHtml(
            hasDuration ? m.suggestion || '' : String(m.suggestion || '').split('；')[0]
          )}</div>
        </div>
      </div>`;
  })();

  // 渲染诊断列表
  const findingsList = wrapper.querySelector('#findings-list');
  if (!ruleFindings.length) {
    findingsList.innerHTML = `<div class="card" style="color:var(--green);background:var(--green-soft);">🎉 10 条确定性基础规则全部通过！结构清晰、指标有基线。</div>`;
  } else {
    ruleFindings.forEach((f, idx) => {
      const item = document.createElement('div');
      item.className = `finding-item ${f.severity === 'red' ? 'severity-red' : ''}`;
      item.innerHTML = `
        <div class="finding-header">
          <div>
            <span class="tag ${f.severity === 'red' ? 'tag-red' : 'tag-amber'}">${f.severity === 'red' ? '先改这条' : '可优化'}</span>
            <strong style="margin-left:6px;font-size:14px;">${escapeHtml(humanizeRule(f).icon + ' ' + humanizeRule(f).label)}</strong>
          </div>
          <span style="font-size:12px;color:var(--primary);">点击定位原话 ▾</span>
        </div>
        <div class="finding-body" ${idx === 0 ? '' : 'hidden'}>
          <div style="margin-bottom:6px;">
            <strong>命中原话（字符区间 [${f.range?.[0] ?? 0}, ${f.range?.[1] ?? 0}]）：</strong>
            <span style="background:#fff3c4;padding:1px 5px;border-radius:3px;">“${escapeHtml(f.quote)}”</span>
          </div>
          <div><strong>改进建议：</strong>${escapeHtml(f.suggestion)}</div>
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn btn-sm btn-special" data-rule="${escapeHtml(f.ruleName)}">生成专项追问（加入答辩预测）→</button>
          </div>
        </div>
      `;
      item.querySelector('.finding-header').addEventListener('click', () => {
        const body = item.querySelector('.finding-body');
        body.hidden = !body.hidden;
        renderHighlightedAnswer(f.quote);
      });
      findingsList.appendChild(item);
    });
  }

  // ---- 复盘盲区 → 答辩预测：把"没讲透的地方"变成专项刁钻追问 ----
  const specialBox = wrapper.querySelector('#special-questions-box');
  wrapper.querySelectorAll('.btn-special').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ruleName = btn.dataset.rule || '薄弱点';
      btn.disabled = true;
      const origin = btn.textContent;
      btn.textContent = '生成中…';
      try {
        const res = await fetch('/api/defense/special-questions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            questionTitle: question.title,
            attribution: `${humanizeRule({ ruleName }).label}：${findingsForRule(ruleName).suggestion || ''}`,
            answerSnippet: String(report.answer || '').slice(0, 1500),
            track: question.track || '',
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message || '生成失败');
        const questions = data.questions || [];
        await dbPut('specialQuestions', {
          id: 'sq-' + Date.now(),
          source: 'review',
          questionId: question.id,
          questionTitle: question.title,
          ruleName: humanizeRule({ ruleName }).label,
          questions,
          createdAt: new Date().toISOString(),
        });
        if (specialBox) {
          specialBox.hidden = false;
          specialBox.innerHTML = `
            <div style="font-size:13px;font-weight:600;margin-bottom:6px;">已生成 ${questions.length} 条专项追问，已放入「答辩预测」</div>
            ${questions
              .map(
                (q, i) =>
                  `<div style="font-size:12.5px;margin-bottom:4px;">Q${i + 1}（${escapeHtml(q.severity || '中')}）：${escapeHtml(q.q)}</div>`
              )
              .join('')}
            <button type="button" class="btn btn-primary btn-sm" id="btn-goto-defense" style="margin-top:8px;">去答辩预测预演 →</button>
          `;
          specialBox.querySelector('#btn-goto-defense')?.addEventListener('click', () => navigate('/defense'));
        }
        showToast(`已生成 ${questions.length} 条专项追问（来自「${humanizeRule({ ruleName }).label}」）`);
      } catch (err) {
        showToast(err.message, 'error', 5000);
      } finally {
        btn.disabled = false;
        btn.textContent = origin;
      }
    });
  });

  const findingsForRule = (ruleName) => ruleFindings.find((f) => f.ruleName === ruleName) || {};

  // M11 回流：标记薄弱点 -> 弹药库「优先复习」置顶
  wrapper.querySelector('#btn-mark-weakness').addEventListener('click', async () => {
    const existing = await dbGetAll('weaknesses');
    const summaryTags = ruleFindings.map((f) => humanizeRule(f).label).slice(0, 3).join('；') || '待深化知乎分歧应对';
    const weakness = {
      id: 'wk-' + question.id,
      questionId: question.id,
      questionTitle: question.title,
      track: question.track,
      attribution: summaryTags,
      priority: 'pinned',
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    await dbPut('weaknesses', weakness);

    // 顺手把这次作答提炼成结构化闪卡（30 秒结论 + 支撑论据 + 防杠话术），存到弹药库
    let flashcardMsg = '';
    try {
      const mod = await import('../lib/flashcards.js');
      const built = mod.buildFlashcard({ report, question, answer: report.answer });
      // 清洗：诊断标签不能当论据、模板拼接话术要读得通
      const card = sanitizeFlashcardData(built, question, report.answer);
      await dbPut('flashcards', card);
      flashcardMsg = '，并已提炼成一张话术闪卡';
    } catch (err) {
      console.warn('[review] 闪卡提炼跳过：', err?.message || err);
    }

    await refreshLocalCollections();
    showToast(`已安全存入本地浏览器：薄弱点已置顶至「弹药库」（当前共 ${existing.length + 1} 项）${flashcardMsg}`);

    // 首次入库的气泡：告诉用户数据在哪、怎么备份
    if (!localStorage.getItem('zhimian.ammo.hintShown')) {
      localStorage.setItem('zhimian.ammo.hintShown', '1');
      showAmmoHint();
    }
  });

  /** 首次入库提示：本地存储 + 定期导出 JSON 备份 */
  const showAmmoHint = () => {
    const tip = document.createElement('div');
    tip.id = 'ammo-hint';
    tip.style.cssText =
      'position:fixed;top:64px;right:20px;z-index:999;max-width:320px;border:1px solid var(--primary);background:var(--surface);border-radius:10px;padding:12px 14px;font-size:12.5px;line-height:1.7;box-shadow:0 8px 24px rgba(0,0,0,.12);';
    tip.innerHTML = `
      <strong style="display:block;margin-bottom:4px;">已安全存入本地浏览器</strong>
      所有录音、转写稿与话术都不经过服务器，只存在你这台设备的 IndexedDB 里。
      <div style="color:var(--text-muted);margin-top:6px;">建议定期在「弹药库」页一键导出 JSON 备份，避免清缓存后丢失。</div>
      <button type="button" class="btn btn-ghost btn-sm" id="ammo-hint-close" style="margin-top:8px;">知道了</button>
    `;
    document.body.appendChild(tip);
    tip.querySelector('#ammo-hint-close').addEventListener('click', () => tip.remove());
    setTimeout(() => tip.remove(), 12000);
  };

  wrapper.querySelector('#btn-retry-coach').addEventListener('click', () => navigate('/coach'));

  // ---- 一键生成满分润色版：把"我知道哪里不对"变成"我照着这个念就能更好" ----
  (() => {
    const host = wrapper.querySelector('#polish-box');
    if (!host) return;
    const btn = wrapper.querySelector('#btn-polish');
    btn?.addEventListener('click', async () => {
      btn.disabled = true;
      const origin = btn.textContent;
      btn.textContent = '生成中…';
      const progress = createProgress('正在按你的原话改写…');
      try {
        const res = await fetch('/api/coach/polish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: question.title,
            answer: String(answer || ''),
            findings: ruleFindings.map((f) => `${humanizeRule(f).label}：${f.suggestion || ''}`),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message || '生成失败');
        progress.done();
        host.hidden = false;
        host.innerHTML = `
          <div style="font-size:13px;font-weight:700;margin-bottom:6px;">✨ 满分润色版（照着念）
            ${data.degraded ? '<span class="tag tag-amber" style="margin-left:6px;">基础版</span>' : ''}
          </div>
          <div style="font-size:13.5px;line-height:1.85;white-space:pre-wrap;background:var(--primary-soft);border:1px solid var(--primary);border-radius:8px;padding:12px;">
            ${escapeHtml(data.polished || '模型暂不可用，请稍后重试。')}
          </div>
          ${
            (data.notes || []).length
              ? `<div style="font-size:12px;color:var(--text-muted);margin-top:6px;">改了这些：${escapeHtml(data.notes.join('；'))}</div>`
              : ''
          }
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
            <button type="button" class="btn btn-ghost btn-sm" id="btn-polish-save">收进弹药库</button>
          </div>`;
        host.querySelector('#btn-polish-save')?.addEventListener('click', () =>
          wrapper.querySelector('#btn-mark-weakness')?.click()
        );
      } catch (err) {
        progress.done();
        host.hidden = false;
        host.innerHTML = `<div style="color:var(--red);font-size:13px;">润色失败：${escapeHtml(err.message)}</div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = origin;
      }
    });
  })();

  // ---- 底部「下一步」主行动条：标出盲区后要么去抗压测，要么把话术存进弹药库 ----
  mountNextStepBar(root, {
    text: '下一步：把盲区变成专项追问，或把高分话术收进弹药库',
    hint: '抗压测会针对上面的薄弱点生成刁钻追问；收入弹药库会提炼成「结论 + 论据 + 防杠话术」的闪卡，只存在本机。',
    actions: [
      {
        label: '针对薄弱点做抗压测 →',
        primary: true,
        onClick: () => {
          // 把这次复盘的盲区带到答辩预测：那边会据此生成专项追问
          try {
            sessionStorage.setItem(
              'zhimian.pendingDefenseTopic',
              JSON.stringify({
                title: question.title,
                track: question.track || '',
                attribution: ruleFindings.map((f) => humanizeRule(f).label).slice(0, 3).join('；'),
                answerSnippet: String(answer || '').slice(0, 1200),
                createdAt: new Date().toISOString(),
              })
            );
          } catch {
            /* 隐私模式忽略 */
          }
          navigate('/defense');
        },
      },
      {
        label: '把高分话术收入弹药库 →',
        onClick: () => wrapper.querySelector('#btn-mark-weakness')?.click(),
      },
    ],
  });
}

/** 三、AI 观点层渲染：分数卡片 + S 编号引用 chip + 改进话术 */
function renderLlmLayer(wrapper, report) {
  const host = wrapper.querySelector('#llm-layer');
  if (!host) return;
  const scores = report.llmScores || [];
  const improvements = report.improvements || [];

  if (!scores.length) {
    host.innerHTML = `
      <div class="card" style="background:var(--amber-soft);border-color:#fedf89;font-size:13px;color:var(--amber);">
        <strong>本次未取得模型评分（已显式降级为规则模式）。</strong><br/>
        规则层的 ${(report.ruleFindings || []).length} 条原话级诊断照常可用；模型恢复后重新提交即可获得四维观点评分。
      </div>`;
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'grid-2';
  for (const s of scores) {
    const tone = s.score >= 75 ? 'var(--green)' : s.score >= 55 ? 'var(--amber)' : 'var(--red)';
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '14px';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;';
    const left = document.createElement('div');
    left.innerHTML = `<span class="tag tag-blue">${escapeHtml(s.dimension || '维度')}</span>
      <span class="tag" style="margin-left:6px;">${escapeHtml(s.basis || '推断')}</span>`;
    const fmt = formatDimensionScore(s.score);
    const scoreEl = document.createElement('div');
    scoreEl.className = 'dimension-score-wrap';
    const scoreNum = document.createElement('strong');
    scoreNum.style.cssText = `font-size:18px;color:${tone};`;
    scoreNum.textContent = fmt.display;
    const scoreBadge = document.createElement('span');
    scoreBadge.className = `dimension-score-badge ${fmt.className}`;
    scoreBadge.textContent = fmt.badge;
    scoreEl.append(scoreNum, scoreBadge);
    head.append(left, scoreEl);

    const bar = document.createElement('div');
    bar.style.cssText = 'height:4px;border-radius:999px;background:var(--border);overflow:hidden;margin-bottom:10px;';
    const fill = document.createElement('div');
    fill.style.cssText = `height:100%;width:${Math.max(0, Math.min(100, Number(s.score) || 0))}%;background:${tone};`;
    bar.appendChild(fill);

    const claim = document.createElement('p');
    claim.style.cssText = 'margin:0 0 10px;font-size:13.5px;line-height:1.65;';
    claim.textContent = s.claim || '';

    const chips = document.createElement('div');
    chips.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    for (const refId of s.refIds || []) {
      const idx = Number(String(refId).replace(/[^\d]/g, '')) - 1;
      const card = (report.question.viewpointCards || [])[idx];
      chips.appendChild(renderCitationChip({
        id: refId,
        type: 'zhihu',
        label: `${refId} · ${card ? '知乎原答' : '来源缺失'}`,
        sourceTitle: card?.author || '知乎高赞回答',
        locator: card?.stance || '',
        quote: card?.evidenceQuote || '来源原文未随结果返回',
        url: card?.sourceUrl || '',
        // 左栏放"你的说法"，右栏放知乎原话 —— 点开就是对照
        myText: myStatementFor(report.answer, s.claim),
      }));
    }
    card.append(head, bar, claim, chips);
    grid.appendChild(card);
  }
  host.appendChild(grid);

  if (improvements.length) {
    const box = document.createElement('div');
    box.className = 'card';
    box.style.cssText = 'margin-top:12px;padding:14px;';
    const h = document.createElement('strong');
    h.textContent = '照这个改（每条均对齐知乎来源）';
    h.style.cssText = 'display:block;margin-bottom:8px;font-size:13.5px;';
    const ul = document.createElement('ul');
    ul.style.cssText = 'margin:0;padding-left:18px;font-size:13px;line-height:1.75;';
    for (const im of improvements) {
      const li = document.createElement('li');
      li.textContent = im.claim || '';
      for (const refId of im.refIds || []) {
        const idx = Number(String(refId).replace(/[^\d]/g, '')) - 1;
        const vc = (report.question.viewpointCards || [])[idx];
        li.appendChild(document.createTextNode(' '));
        li.appendChild(renderCitationChip({
          id: refId, type: 'zhihu', label: refId,
          sourceTitle: vc?.author || '知乎高赞回答', locator: vc?.stance || '',
          quote: vc?.evidenceQuote || '', url: vc?.sourceUrl || '',
          myText: myStatementFor(report.answer, im.claim),
        }));
      }
      ul.appendChild(li);
    }
    box.append(h, ul);
    host.appendChild(box);
  }

  const note = document.createElement('p');
  note.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:10px;';
  note.textContent = `引用校验：保留 ${scores.length} 条结论，丢弃 ${report.droppedByValidator ?? 0} 条无依据/越界引用结论（来源 ${(report.question.viewpointCards || []).length} 张观点卡）。`;
  host.appendChild(note);
}
