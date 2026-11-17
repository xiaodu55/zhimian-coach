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

/** 招聘流程轮次（保留原有语义：选到「已挂复盘」会触发归因回流） */
const OPP_STATES = ['已投递', '一面', '二面', 'HR面', '已拿Offer', '已挂复盘'];
/** 场次生命周期：决定卡片上"下一步该做什么" */
const SESSION_STATUS = ['待面试', '待复盘', '已复盘'];
const SESSION_MODES = ['线上面试', '现场面试', '论文答辩', '模拟面试'];

export function renderLedgerScreen(root) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
      <div>
        <h1 style="margin:0 0 4px;font-size:20px;">弹药库台账 & 优先复习置顶队列（M11 回流闭环）</h1>
        <div style="font-size:13px;color:var(--text-secondary);">复盘中标记的薄弱点自动置顶；场次按状态给出下一步动作（待面试→练简历，待复盘→传录音，已复盘→看报告）</div>
      </div>
      <button id="btn-add-opp" class="btn btn-primary btn-sm" type="button">+ 新增面试 / 答辩场次</button>
    </div>

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
}
