import {
  state,
  saveResumeAnalysis,
  loadResumeAnalysis,
  restoreLatestResumeAnalysis,
  updateResumeQuestionState,
  getActiveOpportunity,
  setActiveOpportunity,
  refreshLocalCollections,
} from '../state.js';
import { navigate } from '../router.js';
import { escapeHtml, renderCitationChip } from '../ui/citation.js';
import {
  mountEmptyContextGuard,
  recentQuestionOptions,
  recommendWarmupQuestion,
} from '../lib/empty-guard.js';
import { mountNextStepBar, createProgress } from '../lib/nextstep.js';
import { renderViewpointCard } from '../ui/components.js';
// 规则编号只留在代码与日志里，界面一律翻译成人话（「⚠️ 缺少量化结果」）
import { humanizeRule, summarizeFindings } from '../rules/labels.js';
import { getMatchedSampleAnswer, countEffectiveChars } from '../lib/optimizer.js';
import { kindOf } from '../lib/domains.js';
import { createModal, modalButton } from '../ui/modal.js';
import { LocalAudioRecorder } from '../capture/recorder.js';
import { LiveCaptionEngine, captionsToTranscript } from '../capture/caption.js';
import { listAudioInputs, detectVirtualDevice } from '../capture/devices.js';
import { isSystemAudioSupported, captureSystemAudio } from '../capture/systemAudio.js';
import { saveRecording, downloadTrack, toFormData, trackUrl } from '../capture/recordings.js';
import { mergeTracks, toTranscriptText } from '../capture/align.js';

/** 陪练室两种练法：真题陪练（题库+知乎观点卡）/ 简历陪练（按你的真实经历出题） */
const MODE_KEY = 'zhimian.coach.mode';
/** 当前模式：真题 / 简历 / 录音（台账可直接指定「去录音复盘」） */
const getMode = () => {
  const v = sessionStorage.getItem(MODE_KEY);
  return v === 'resume' || v === 'record' ? v : 'bank';
};
/** 两种练法各自记住上一次选的题：切回来不用重挑 */
const rememberedQuestions = { bank: null, resume: null };
/** 简历陪练：当前解析结果 / 选中的要点 / 该要点检索到的知乎知识 */
/** 最后一次录音时长（秒）：用于复盘台的"答题时长与语速雷达" */
let lastAnswerDurationSec = 0;
let resumeRecord = null;
let activeBullet = null;
let bulletKnowledge = [];

/** 把"当前场次"绑定到简历解析结果：记录练过这场面试的岗位 */
async function attachOpportunityToResume(record) {
  const ctx = getActiveOpportunity();
  if (!ctx?.id) return;
  record.opportunityId = ctx.id;
  try {
    const fresh = (await dbGet('opportunities', ctx.id)) || ctx;
    await dbPut('opportunities', { ...fresh, resumeReady: true });
    await refreshLocalCollections();
  } catch (err) {
    console.warn('[coach] 场次回写失败', err);
  }
}

/** 把"当前场次"绑定到复盘报告：状态推进到「已复盘」，台账可反查报告 */
async function attachOpportunityToReport(report) {
  const ctx = getActiveOpportunity();
  if (!ctx?.id) return;
  report.opportunityId = ctx.id;
  try {
    const fresh = (await dbGet('opportunities', ctx.id)) || ctx;
    await dbPut('opportunities', {
      ...fresh,
      status: '已复盘',
      reviewId: report.id,
      resumeReady: Boolean(fresh.resumeReady),
    });
    await refreshLocalCollections();
  } catch (err) {
    console.warn('[coach] 场次回写失败', err);
  }
}

/** 简历定位符（p1¶10）→ 人话：「简历第 1 页」；解析不了就原样返回 */
function locatorLabel(locator) {
  const m = String(locator || '').match(/p(\d+)/i);
  if (!m) return locator ? `简历 ${locator}` : '简历原文';
  return `简历第 ${m[1]} 页`;
}

/** 让出一小段时间：阶段性微文案必须真的被画出来，否则三句话会挤在同一帧里等于没播报 */
function nextPaint() {
  return new Promise((resolve) => setTimeout(resolve, 150));
}

/** 从"为什么问"派生要点（模型没给 bullets 时的兜底） */
function deriveBullets(why) {
  const parts = String(why || '')
    .split(/[；;]|，(?=.{6,})/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 6)
    .slice(0, 3);
  return parts.length ? parts : ['给出一个可核对的数字与口径', '讲清你的判断与取舍', '落到结果与边界条件'];
}
const setMode = (mode) => sessionStorage.setItem(MODE_KEY, mode);
import { parseTranscriptToQA } from '../capture/transcript.js';
import { runDeterministicRules } from '../rules/diagnose.js';
import { runReview } from '../lib/review.js';
import { computeSpeechMetrics } from '../capture/speechmetrics.js';
import { buildDomainLexicon, correctTranscript } from '../capture/hotwords.js';
import { PauseGuard, PAUSE_GUARD_HINT } from '../capture/pauseguard.js';
import { dbPut, dbGet } from '../db.js';
import { showToast } from '../ui/toast.js';

export function renderCoachScreen(root) {
  // 跨路由直达：用户可能跳过了第 1 步（题库）直接点导航进陪练室。
  // 这时既没有 activeQuestion，也没有"上次选过的题"，就不能拿兜底题冒充用户的选择
  // （否则 rememberedQuestions 被污染，守卫永远不再出现）。
  const pickedQuestion = state.activeQuestion;
  const rememberedQuestion =
    (getMode() === 'resume' ? rememberedQuestions.resume : rememberedQuestions.bank) || null;
  if (pickedQuestion) {
    rememberedQuestions[pickedQuestion.source === 'resume' ? 'resume' : 'bank'] = pickedQuestion;
  }
  const warmup = recommendWarmupQuestion(state.bank);
  const question = pickedQuestion || rememberedQuestion || warmup || state.bank[0] || null;
  // 题库加载会预填 activeQuestion，但那不是"用户挑的题" → 用 questionPickedByUser 判断
  const needsContextGuard = !state.questionPickedByUser && !rememberedQuestion;

  /** 守卫给回来的可能是一道完整题，也可能只是"最近记录"里的摘要：统一还原成可练习的完整题 */
  const resolveQuestionById = (id) => {
    if (!id) return null;
    const fromBank = state.bank.find((q) => q.id === id);
    if (fromBank) return fromBank;
    for (const s of state.sessions || []) {
      if (s?.question?.id === id) return s.question;
    }
    return null;
  };
  /** 载入题目 → 进入真正的练习状态（重渲染本页） */
  const loadQuestionFromOption = (opt) => {
    if (!opt) return;
    const resolved = opt.skeleton || opt.viewpointCards ? opt : resolveQuestionById(opt.id);
    if (!resolved) {
      showToast('这道题的上下文已经不在本机了，换一道试试', 'warn');
      return;
    }
    state.activeQuestion = resolved;
    state.questionPickedByUser = true;
    root.innerHTML = '';
    renderCoachScreen(root);
  };

  if (!question) {
    root.innerHTML = `<div class="card">题库加载中，请稍候…</div>`;
    const guardHost = document.createElement('div');
    guardHost.style.marginTop = '12px';
    root.appendChild(guardHost);
    mountEmptyContextGuard(guardHost, {
      title: '你还没有选定当前练习题目',
      hint: '可以直接开始这道高频热身题，也可以恢复上次的练习上下文',
      recent: recentQuestionOptions(state.sessions),
      recommend: warmup ? [warmup] : [],
      onPick: (opt) => loadQuestionFromOption(opt),
    });
    return;
  }

  let isRecording = false;
  let captions = [];
  let audioUrl = null;
  let followupRound = 0;
  let activeFollowupFocus = '';
  let recorder = null;
  let captionEngine = null;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div id="opp-banner" hidden style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border:1px solid var(--primary);border-radius:8px;background:var(--primary-soft);margin-bottom:12px;font-size:13px;">
      <span>🎯 当前场次：<strong id="opp-banner-name"></strong><span style="color:var(--text-muted);margin-left:8px;">（简历练习与复盘都会挂到这场次上）</span></span>
      <button id="btn-opp-clear" class="btn btn-ghost btn-sm" type="button">清除场次</button>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
      <div class="mode-switch" role="tablist" aria-label="陪练方式">
        <button type="button" class="btn btn-sm" data-coach-mode="bank" role="tab">📚 真题陪练</button>
        <button type="button" class="btn btn-sm" data-coach-mode="resume" role="tab">🧾 简历陪练</button>
        <button type="button" class="btn btn-sm" data-coach-mode="record" role="tab">🎙 录音复盘</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <!-- 追问深度与人设不是每题都调，收进设置浮层：默认只占一个按钮的位置 -->
        <div style="position:relative;">
          <button id="btn-coach-settings" class="btn btn-sm" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="coach-settings-menu">⚙️ 陪练设置</button>
          <div id="coach-settings-menu" role="dialog" aria-label="陪练设置" style="display:none;position:absolute;right:0;top:calc(100% + 6px);z-index:40;width:270px;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--surface-alt);box-shadow:0 10px 28px rgba(16,24,40,.14);flex-direction:column;gap:10px;">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-secondary);" title="追问深度：每轮往下钻几层，3 = 会连追到你的隐含前提">
              追问深度
              <select id="sel-followup-depth" class="select" style="width:100%;padding:4px 6px;font-size:12.5px;">
                <option value="1">1 轮 · 广度确认</option>
                <option value="2">2 轮 · 深挖一层</option>
                <option value="3">3 轮 · 追到前提</option>
              </select>
            </label>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-secondary);" title="面试官人设：温和引导型顺思路，压力挑战型直接质疑方案缺陷">
              面试官人设
              <select id="sel-interviewer-style" class="select" style="width:100%;padding:4px 6px;font-size:12.5px;">
                <option value="tough">压力挑战型</option>
                <option value="gentle">温和引导型</option>
              </select>
            </label>
            <div style="font-size:12px;color:var(--text-muted);line-height:1.65;border-top:1px solid var(--border);padding-top:8px;">
              改完立即生效，下一轮追问就用新设置；本机会记住你的选择。
            </div>
          </div>
        </div>
        <button id="btn-switch-q" class="btn btn-sm" type="button">换一题</button>
      </div>
    </div>

    <div class="grid-2" style="align-items:start;">
      <!-- 左侧：练法切换（简历陪练 / 真题陪练） -->
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div id="panel-record" style="display:none;flex-direction:column;gap:14px;">
          <section class="card">
            <strong>🎙 录音复盘：把一场对话变成可核对的复盘</strong>
            <div style="font-size:12.5px;color:var(--text-secondary);margin-top:6px;line-height:1.8;">
              1) 选输入设备（同时开飞书/腾讯会议也不会失效，右侧有音量与静音告警）<br/>
              2) 开始录音 → 实时字幕逐句落时间戳，说话人可一键切换/纠正<br/>
              3) 可选：同时录系统声音（面试官那一路），双轨各自成文件<br/>
              4) 转写 → 生成复盘报告（逐题原话诊断 + 可回指原话）
            </div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:8px;">
              录音与转写只存在你自己的浏览器里，服务端零落盘。扫描版/图片型材料请走「简历陪练」的 PDF OCR 兜底。
            </div>
          </section>
        </div>

        <div id="panel-resume" style="display:none;flex-direction:column;gap:14px;">
        <!-- 简历陪练：上传简历 → 按真实经历出题（题目接地到简历定位符） -->
        <section class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div>
          <strong>🧾 简历陪练：按你的真实经历出题</strong>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
            解析简历 → 抽出项目、技能与缺口 → 生成 6–10 道针对性面试题（每题标明出自简历第几页，并挂真实知乎面经）。
            扫描版 PDF 会自动走 OCR 兜底。
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <label class="btn btn-sm">
            📄 上传简历（PDF / MD / TXT）
            <input id="resume-file-input" type="file" accept=".pdf,.md,.markdown,.txt" hidden />
          </label>
          <button id="btn-resume-refresh" class="btn btn-ghost btn-sm" type="button" title="忽略缓存，重新花 40–50 秒出题">重新出题</button>
          <span id="resume-status" style="font-size:12px;color:var(--text-muted);"></span>
        </div>
      </div>
      <div id="resume-profile" style="display:none;margin-top:12px;"></div>
      <div id="resume-questions" style="display:none;margin-top:12px;display:none;flex-direction:column;gap:8px;"></div>
    </section>

        </div>

        <div id="panel-bank" style="flex-direction:column;gap:14px;">
        <section class="card">
          <h2 style="margin:0 0 8px;font-size:18px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            ${escapeHtml(question.title)}
            <span class="tag ${String(question.source || '').startsWith('resume') ? 'tag-green' : 'tag-blue'}" style="font-size:11px;font-weight:500;">${escapeHtml(String(question.source || '').startsWith('resume') ? '简历题' : question.track || '真题')}</span>
          </h2>
          <p style="margin:0 0 12px;font-size:13px;color:var(--text-secondary);">${escapeHtml(question.context)}</p>

          <div id="followup-box" class="card" style="background:var(--amber-soft);border-color:#fedf89;margin-bottom:12px;" hidden>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;font-weight:700;color:var(--amber);margin-bottom:4px;">
              <span>🔥 面试官深度追问（第 <span id="followup-round-num">1</span> 轮<span id="followup-style-label"></span>）</span>
              <span id="followup-mode-badge" class="tag" style="display:none;font-weight:600;background:#fff;border:1px solid #fedf89;color:var(--amber);">基础追问模式</span>
            </div>
            <div id="followup-question-text" style="font-weight:600;font-size:14px;"></div>
            <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
              <button id="btn-followup-explain" class="btn btn-ghost btn-sm" type="button">看不懂，看解析</button>
              <button id="btn-followup-skip" class="btn btn-ghost btn-sm" type="button">跳过这轮，直接出复盘</button>
            </div>
          </div>

          <details>
            <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--primary);">
              查看参考答题骨架（提示）<span class="tag tag-green" style="margin-left:6px;">知乎原文溯源</span>
            </summary>
            <ul style="margin:8px 0 0;padding-left:18px;font-size:13px;color:var(--text-secondary);" id="coach-skeleton-list">
              ${(question.skeleton || []).map((s, i) => `<li data-skeleton-idx="${i}">${escapeHtml(s)}</li>`).join('')}
            </ul>
          </details>
        </section>

        <section>
          <h3 style="margin:0 0 8px;font-size:14px;color:var(--text-secondary);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            评分基准 · 知乎观点原文
            <span style="font-size:11.5px;color:var(--text-muted);font-weight:400;">先自己答，卡壳了再偷看</span>
          </h3>
          <div id="coach-vp-list" style="display:flex;flex-direction:column;gap:10px;"></div>
        </section>
        </div>
      </div>

      <!-- 右侧：按模式切换「练习区」与「录音复盘区」 -->
      <div style="display:flex;flex-direction:column;gap:14px;">
        <!-- 练习区：真题陪练 / 简历陪练 -->
        <div id="practice-area" style="display:flex;flex-direction:column;gap:14px;">
          <!-- 跨路由直达守卫：没有"当前题目"上下文时，这里给出可点击的引导而不是空白 -->
          <div id="coach-context-guard"></div>
          <section class="card" id="bullet-context-card" hidden>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
              <strong>🎯 当前要点</strong>
              <span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <span class="tag tag-green" id="bullet-locator"></span>
                <button id="btn-bullet-candidates" class="btn btn-sm" type="button">这题会怎么被问 →</button>
              </span>
            </div>
            <div id="bullet-context-text" style="font-size:13.5px;font-weight:600;margin:6px 0 4px;line-height:1.6;"></div>
            <div id="bullet-knowledge" style="font-size:12.5px;color:var(--text-secondary);line-height:1.7;"></div>
          </section>
          <section class="card">
            <div id="current-question-strip" style="font-size:12.5px;color:var(--text-secondary);background:var(--surface-alt);border-radius:8px;padding:8px 10px;margin-bottom:8px;">
              ${question.source === 'resume-bullet' ? '当前要点' : question.source === 'resume' ? '当前题目' : '当前题目（真题）'}：${escapeHtml(question.title)}
              ${question.source === 'resume' ? `<div style="color:var(--text-muted);margin-top:2px;">简历题 · 出自${escapeHtml(locatorLabel(question.locator))}${question.zhihuRef ? ' · 面经参考挂在左栏' : ''}</div>` : ''}
            </div>

          <label for="answer-textarea" style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;">
            作答文本 / 导入会议转写稿（支持「面试官：/ 我：」标签切分）：
          </label>
          <div id="sample-fill-hint" style="display:flex;justify-content:flex-end;margin:0 0 6px;">
            <button id="btn-fill-sample" class="btn btn-ghost btn-sm" type="button" style="font-size:12px;font-weight:400;color:var(--text-muted);padding:2px 8px;background:var(--surface-alt);border:1px dashed var(--border);">
              试一试：填入一段示例回答
            </button>
          </div>
          <textarea id="answer-textarea" class="textarea" rows="7" placeholder="可直接在此输入回答，或点击上方「开始录音」自动落字幕，或粘贴带「面试官：/ 我：」的复盘转写稿…"></textarea>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
            <span style="font-size:11.5px;color:var(--text-muted);">小提示：先给结论，再给一个可核对的数字与口径。</span>
            <span id="answer-char-count" style="font-size:11.5px;color:var(--text-muted);">0 字（至少 15 字）</span>
          </div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap;gap:8px;">
              <button id="btn-trigger-followup" class="btn btn-sm" type="button">触发追问（压力测试）</button>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button id="btn-import-from-record" class="btn btn-ghost btn-sm" type="button">从「录音复盘」带入转写稿</button>
                <button id="btn-submit-parse" class="btn btn-primary" type="button">结束并生成复盘诊断 →</button>
              </div>
            </div>
          </section>
        </div>

        <!-- 录音复盘区：独立的录音工作台 -->
        <div id="record-area" style="display:none;flex-direction:column;gap:14px;">
          <section class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
              <strong>🎙️ 录音复盘工作台</strong>
              <div style="display:flex;gap:8px;">
                <button id="btn-record-toggle" class="btn btn-primary btn-sm" type="button">开始录音</button>
              </div>
            </div>

          <div id="caption-status" style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
            录音文件仅保存在本机浏览器 IndexedDB，绝不上传服务器。
          </div>

          <!-- 设备、双轨与说话人控制 -->
          <div id="capture-config" style="display:grid;gap:8px;margin-bottom:10px;font-size:12.5px;">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <label for="mic-select" style="color:var(--text-secondary);">输入设备</label>
              <select id="mic-select" class="input" style="max-width:280px;padding:4px 6px;"></select>
              <button id="btn-refresh-mic" class="btn btn-ghost btn-sm" type="button">刷新</button>
              <label style="display:flex;gap:6px;align-items:center;color:var(--text-secondary);cursor:pointer;">
                <input id="chk-system-audio" type="checkbox" /> 同时录系统声音（面试官那一路）
              </label>
            </div>
            <div id="device-hint" style="color:var(--text-muted);line-height:1.6;"></div>
            <div id="silence-warning" style="display:none;color:var(--red);font-size:12.5px;line-height:1.6;"></div>
            <div style="display:flex;gap:8px;align-items:center;">
              <span style="color:var(--text-muted);">音量</span>
              <div style="flex:1;height:6px;background:var(--border);border-radius:999px;overflow:hidden;">
                <div id="volume-fill" style="height:100%;width:0%;background:var(--green);transition:width .12s;"></div>
              </div>
              <span id="volume-db" style="color:var(--text-muted);min-width:52px;text-align:right;">-100 dB</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <span style="color:var(--text-muted);">当前说话人</span>
              <button id="btn-spk-auto" class="btn btn-primary btn-sm" type="button">自动判断</button>
              <button id="btn-spk-me" class="btn btn-ghost btn-sm" type="button">我说</button>
              <button id="btn-spk-interviewer" class="btn btn-ghost btn-sm" type="button">面试官说</button>
              <button id="btn-captions-to-text" class="btn btn-ghost btn-sm" type="button">字幕整理成转写稿 →</button>
            </div>
          </div>

          <div id="audio-playback-box" style="margin-bottom:10px;" hidden>
            <audio id="audio-player" controls style="width:100%;height:36px;"></audio>
          </div>

          <!-- 双轨（我 / 面试官）：可分别回放、导出、转写 -->
          <div id="rec-tracks" style="display:none;margin-bottom:10px;font-size:12.5px;"></div>
          <div id="rec-actions" style="display:none;gap:8px;flex-wrap:wrap;margin-bottom:8px;"></div>
          <div id="asr-hint" style="display:none;color:var(--text-muted);font-size:12px;line-height:1.65;margin-bottom:8px;"></div>

          <div id="caption-list" style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:6px;margin-bottom:10px;background:var(--bg);" hidden></div>


            <label for="record-transcript" style="display:block;font-size:13px;font-weight:600;margin:6px 0;">
              转写稿（可粘贴，或导入飞书妙记 / 腾讯会议 AI 笔记导出的文本）：
            </label>
            <textarea id="record-transcript" class="textarea" rows="8" placeholder="面试官：… / 我：… （带说话人标签的转写稿可自动切分 Q&amp;A）"></textarea>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap;gap:8px;">
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <label class="btn btn-ghost btn-sm">
                  📄 导入会议转写稿文件
                  <input id="record-transcript-file" type="file" accept=".txt,.md,.markdown" hidden />
                </label>
                <label class="btn btn-ghost btn-sm">
                  🎧 上传我的录音（自动转写）
                  <input id="record-audio-file" type="file" accept="audio/*,.webm,.m4a,.mp3,.wav" hidden />
                </label>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button id="btn-audio-vs-resume" class="btn btn-sm" type="button">按简历对照这段录音</button>
                <button id="btn-record-review" class="btn btn-primary" type="button">生成录音复盘报告 →</button>
              </div>
            </div>
            <div id="audio-review-result" style="display:none;margin-top:10px;font-size:12.5px;"></div>
          </section>
        </div>
      </div>
  `;
  root.appendChild(wrapper);

  // 跨路由直达守卫：没有"当前题目"上下文（既没选过题、也没上次记录）时，
  // 练习区顶部给出可点击的引导，而不是让用户对着一个空页面发呆。
  const guardHost = wrapper.querySelector('#coach-context-guard');
  if (guardHost) {
    if (needsContextGuard) {
      mountEmptyContextGuard(guardHost, {
        title: '你还没有选定当前练习题目',
        hint: '可以直接开始这道高频热身题，也可以恢复上次的练习上下文',
        recent: recentQuestionOptions(state.sessions),
        recommend: warmup ? [warmup] : [],
        onPick: (opt) => loadQuestionFromOption(opt),
      });
    } else {
      guardHost.style.display = 'none';
    }
  }

  // 当前场次横幅（台账 → 陪练室的跨页关联）
  const oppCtx = getActiveOpportunity();
  const oppBanner = wrapper.querySelector('#opp-banner');
  if (oppCtx?.id) {
    oppBanner.hidden = false;
    wrapper.querySelector('#opp-banner-name').textContent = [
      oppCtx.company,
      oppCtx.role,
      oppCtx.stage,
    ]
      .filter(Boolean)
      .join(' · ');
    wrapper.querySelector('#btn-opp-clear').addEventListener('click', () => {
      setActiveOpportunity(null);
      root.innerHTML = '';
      renderCoachScreen(root);
    });
  }

  const resumeStatus = wrapper.querySelector('#resume-status');
  const resumeProfile = wrapper.querySelector('#resume-profile');
  const resumeQuestions = wrapper.querySelector('#resume-questions');

  // 简历要点模式：右侧显示当前要点 + 实时检索到的知乎知识
  const bulletCard = wrapper.querySelector('#bullet-context-card');
  if (question.source === 'resume-bullet') {
    bulletCard.hidden = false;
    if (!activeBullet || activeBullet.text !== question.title) {
      activeBullet = {
        text: question.title,
        why: question.context || '',
        locator: question.locator || '',
        parentQ: question.title,
      };
    }
    wrapper.querySelector('#bullet-locator').textContent = locatorLabel(question.locator);
    wrapper.querySelector('#bullet-context-text').textContent = question.title;
    wrapper.querySelector('#btn-bullet-candidates').addEventListener('click', () => {
      openCandidateModal({ bullets: [activeBullet], record: resumeRecord, title: '可能被问到的题 · 按被问概率排序' });
    });
    renderBulletKnowledge();
    if (!bulletKnowledge.length) loadBulletKnowledge(activeBullet);
  }

  // 观点卡默认折叠：边答边看得见"标准答案"，人就只会照着念。
  // 一次只揭晓一条，答完（提交或触发追问）后才全部摊开——那时藏着已经没有意义。
  const vpBox = wrapper.querySelector('#coach-vp-list');
  const vpCards = question.viewpointCards || [];
  const REVEAL_KEY = 'zhimian.coach.revealed';
  // 键里只存"揭晓了几条"，另用一个伴生键记住属于哪道题：换题后不该白送新题的观点
  const REVEAL_QID_KEY = REVEAL_KEY + '.qid';
  const revealBelongsToThisQuestion = sessionStorage.getItem(REVEAL_QID_KEY) === String(question.id);
  let revealedVp = revealBelongsToThisQuestion
    ? Math.max(0, Math.min(Number(sessionStorage.getItem(REVEAL_KEY)) || 0, vpCards.length))
    : 0;
  const persistRevealedVp = () => {
    sessionStorage.setItem(REVEAL_KEY, String(revealedVp));
    sessionStorage.setItem(REVEAL_QID_KEY, String(question.id));
  };

  const renderViewpoints = () => {
    vpBox.innerHTML = '';
    if (!vpCards.length) {
      if (question.source === 'resume') {
        vpBox.innerHTML = `<div class="card" style="font-size:12.5px;color:var(--text-muted);">
          简历题不按知乎观点打分：这场只做逐句原话诊断 + 面经参考，避免拿无关观点硬套。
          ${question.zhihuRef ? `参考面经：<a href="${escapeHtml(question.zhihuRef.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(question.zhihuRef.title)}</a>` : ''}
        </div>`;
      }
      return;
    }
    vpCards.slice(0, revealedVp).forEach((vc, idx) => vpBox.appendChild(renderViewpointCard(vc, idx)));

    if (revealedVp >= vpCards.length) {
      const done = document.createElement('div');
      done.style.cssText = 'font-size:12px;color:var(--text-muted);padding:2px 2px 0;';
      done.textContent = `已揭晓全部 ${vpCards.length} 条观点 · 现在可以对照它们检查自己的答案`;
      vpBox.appendChild(done);
      return;
    }

    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'btn btn-sm';
    bar.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;text-align:left;' +
      'background:var(--surface-alt);color:var(--text-secondary);border:1px dashed var(--border);' +
      'padding:10px 12px;font-size:12.5px;line-height:1.6;';
    bar.innerHTML =
      revealedVp === 0
        ? `<span>🔒 评分基准已隐藏（避免照着念）· 思考卡壳？点此偷看 1 条提示</span><span style="color:var(--text-muted);flex:none;">0 / ${vpCards.length}</span>`
        : `<span>再看一条观点提示</span><span style="color:var(--text-muted);flex:none;">已看 ${revealedVp} / ${vpCards.length} · 还剩 ${vpCards.length - revealedVp} 条</span>`;
    bar.addEventListener('click', () => {
      revealedVp += 1;
      persistRevealedVp();
      renderViewpoints();
    });
    vpBox.appendChild(bar);
  };
  renderViewpoints();

  /** 已经答完（提交/触发追问）：全部摊开，并把进度对齐到 sessionStorage */
  const revealAllViewpoints = () => {
    if (revealedVp >= vpCards.length) return;
    revealedVp = vpCards.length;
    persistRevealedVp();
    renderViewpoints();
  };

  const textarea = wrapper.querySelector('#answer-textarea');
  // 样例填充只在作答框为空时露出来：开始写就自动让位，避免"点一下就有答案"的诱导
  const sampleHint = wrapper.querySelector('#sample-fill-hint');
  const updateSampleHint = () => {
    if (!sampleHint) return;
    sampleHint.style.display = textarea.value.trim() ? 'none' : 'flex';
  };
  updateSampleHint();
  textarea.addEventListener('input', updateSampleHint);
  const captionListEl = wrapper.querySelector('#caption-list');
  const captionStatusEl = wrapper.querySelector('#caption-status');
  const recordBtn = wrapper.querySelector('#btn-record-toggle');
  const micSelect = wrapper.querySelector('#mic-select');
  const refreshMicBtn = wrapper.querySelector('#btn-refresh-mic');
  const systemAudioChk = wrapper.querySelector('#chk-system-audio');
  const deviceHint = wrapper.querySelector('#device-hint');
  const silenceWarning = wrapper.querySelector('#silence-warning');
  const volumeFill = wrapper.querySelector('#volume-fill');
  const volumeDb = wrapper.querySelector('#volume-db');
  const spkAutoBtn = wrapper.querySelector('#btn-spk-auto');
  const spkMeBtn = wrapper.querySelector('#btn-spk-me');
  const spkInterviewerBtn = wrapper.querySelector('#btn-spk-interviewer');
  const audioBox = wrapper.querySelector('#audio-playback-box');
  const audioPlayer = wrapper.querySelector('#audio-player');
  const recTracks = wrapper.querySelector('#rec-tracks');
  const recActions = wrapper.querySelector('#rec-actions');
  const asrHint = wrapper.querySelector('#asr-hint');

  const renderCaptions = (interim = '') => {
    if (!captions.length && !interim) {
      captionListEl.hidden = true;
      return;
    }
    captionListEl.hidden = false;
    captionListEl.innerHTML = '';
    captions.forEach((cap) => {
      const row = document.createElement('div');
      row.className = 'caption-line';
      const label = cap.speaker === 'me' ? '我' : cap.speaker === 'interviewer' ? '面试官' : '未标注';
      const tone = cap.speaker === 'me' ? 'background:var(--primary-soft);color:var(--primary);'
        : cap.speaker === 'interviewer' ? 'background:var(--amber-soft);color:var(--amber);'
        : 'background:var(--surface-alt);color:var(--text-muted);';
      row.innerHTML = `
        <span class="caption-ts">${escapeHtml(cap.timestamp)}</span>
        <button type="button" class="spk-badge" title="点击切换：我 / 面试官 / 未标注（自动判断可能不准，以你点选为准）"
          style="border:0;border-radius:999px;padding:1px 8px;font-size:11px;cursor:pointer;${tone}">${label}</button>
        <div class="caption-text" contenteditable="true" title="点击可就地编辑字幕并保留时间戳">${escapeHtml(cap.text)}</div>
      `;
      row.querySelector('.spk-badge').addEventListener('click', () => {
        const order = ['me', 'interviewer', 'unknown'];
        const next = order[(order.indexOf(cap.speaker || 'unknown') + 1) % order.length];
        cap.speaker = next;
        cap.speakerAuto = false;
        renderCaptions();
      });
      row.querySelector('.caption-text').addEventListener('input', (e) => {
        cap.text = e.target.textContent;
      });
      captionListEl.appendChild(row);
    });
    if (interim) {
      const row = document.createElement('div');
      row.className = 'caption-line';
      row.style.opacity = '0.65';
      row.innerHTML = `<span class="caption-ts">识别中</span><div class="caption-text">${escapeHtml(interim)}…</div>`;
      captionListEl.appendChild(row);
    }
  };

  // ---- 设备枚举：默认输入被会议软件切走是最常见的"录到静音"原因 ----
  const loadMicDevices = async (requestPermission = false) => {
    try {
      const devices = await listAudioInputs({ requestPermission });
      const current = micSelect.value;
      micSelect.innerHTML = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = '系统默认输入';
      micSelect.appendChild(def);
      for (const d of devices) {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label;
        micSelect.appendChild(opt);
      }
      if (current) micSelect.value = current;

      const selected = devices.find((d) => d.deviceId === micSelect.value);
      const virtualHit = devices.filter((d) => detectVirtualDevice(d.label));
      deviceHint.innerHTML = [
        virtualHit.length
          ? `⚠ 检测到疑似会议/虚拟设备：${virtualHit.map((d) => escapeHtml(d.label)).join('、')}。` +
            '若录音一直是静音，多半是默认输入被会议软件切到了这类设备。'
          : '提示：同时开飞书/腾讯会议时，Windows 一般允许共享麦克风；但会议软件可能改写默认输入。',
        selected ? `当前选择：${escapeHtml(selected.label)}` : '',
        isSystemAudioSupported()
          ? '双轨说明：勾选「同时录系统声音」后会弹共享选择器，务必勾上"分享音频"，这样面试官的声音单独成轨。'
          : '当前环境不支持采集系统声音（移动端/桌面壳），请用单麦克风 + 手动标注说话人。',
      ].filter(Boolean).join('<br/>');
    } catch {
      deviceHint.textContent = '读不到麦克风列表：检查一下浏览器的麦克风权限，再点「刷新」。';
    }
  };
  refreshMicBtn.addEventListener('click', () => loadMicDevices(true));
  loadMicDevices(false);
  if (!isSystemAudioSupported()) {
    systemAudioChk.disabled = true;
    systemAudioChk.parentElement.style.opacity = '0.5';
  }

  // ---- 说话人模式：手动优先，自动可纠 ----
  const setSpeakerMode = (mode) => {
    captionEngine?.setSpeakerMode(mode);
    const map = { auto: spkAutoBtn, me: spkMeBtn, interviewer: spkInterviewerBtn };
    for (const [k, btn] of Object.entries(map)) {
      btn.className = `btn btn-sm ${k === mode ? 'btn-primary' : 'btn-ghost'}`;
    }
    captionStatusEl.dataset.speakerMode = mode;
    if (mode === 'me') showToast('已切换为「我说」：后续字幕都记为你');
    if (mode === 'interviewer') showToast('已切换为「面试官说」：后续字幕都记为面试官');
    if (mode === 'auto') showToast('已切换为自动判断（按问句/人称推断，可点徽标纠正）');
  };
  spkAutoBtn.addEventListener('click', () => setSpeakerMode('auto'));
  spkMeBtn.addEventListener('click', () => setSpeakerMode('me'));
  spkInterviewerBtn.addEventListener('click', () => setSpeakerMode('interviewer'));

  // ---- 字幕 → 带说话人标签的转写稿（直接喂给「解析并生成复盘」）----
  /** 专有名词热词纠错：识别错的技术词先改过来，避免 AI 误判"你答错了" */
  const applyHotwordFix = (raw) => {
    const text = String(raw || '');
    if (!text.trim()) return text;
    const lexicon = buildDomainLexicon({
      title: question.title,
      context: question.context,
      keywords: question.keywords,
      skeleton: question.skeleton,
    });
    const out = correctTranscript(text, lexicon);
    if (out.changes.length) {
      showToast(`已自动纠正 ${out.changes.length} 处专有名词，可在作答框里再改`, 'warn', 5000);
    }
    return out.text;
  };

  wrapper.querySelector('#btn-captions-to-text').addEventListener('click', () => {
    if (!captions.length) {
      showToast('还没有字幕：先录音，或直接粘贴会议转写稿', 'warn');
      return;
    }
    const recordBox = wrapper.querySelector('#record-transcript');
    if (recordBox) recordBox.value = applyHotwordFix(captionsToTranscript(captions));
    const unknown = captions.filter((c) => !c.speaker || c.speaker === 'unknown').length;
    showToast(
      unknown
        ? `已整理 ${captions.length} 句，其中 ${unknown} 句未标注说话人（点徽标可改）`
        : `已整理 ${captions.length} 句，说话人标签完整`
    );
  });

  // ---- 简历模式：解析简历 → 抽取档案 → 出题 ----
  const renderResumeResult = (data) => {
    resumeRecord = data;
    resumeProfile.style.display = 'block';
    resumeProfile.innerHTML = '';

    const head = document.createElement('div');
    head.innerHTML = `<div style="font-size:13px;font-weight:600;margin-bottom:6px;">画像</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">${escapeHtml(data.profile?.headline || '')}</div>`;
    resumeProfile.appendChild(head);

    if ((data.profile?.skills || []).length) {
      const chips = document.createElement('div');
      chips.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;';
      for (const sk of data.profile.skills) {
        const t = document.createElement('span');
        t.className = 'tag tag-blue';
        t.textContent = sk;
        chips.appendChild(t);
      }
      resumeProfile.appendChild(chips);
    }

    for (const p of data.profile?.projects || []) {
      const box = document.createElement('div');
      box.style.cssText = 'border-left:2px solid var(--primary);padding-left:8px;margin-bottom:8px;font-size:12.5px;';
      box.innerHTML = `<strong>${escapeHtml(p.name)}</strong>
        <span style="color:var(--text-muted);">（${escapeHtml(p.role || '角色未写明')}）</span>
        ${(p.tech || []).length ? `<div style="color:var(--text-secondary);">技术：${escapeHtml(p.tech.join(' / '))}</div>` : ''}
        ${(p.metrics || []).length ? `<div style="color:var(--green);">量化：${escapeHtml(p.metrics.join(' / '))}</div>` : ''}`;
      resumeProfile.appendChild(box);
    }

    if ((data.profile?.gaps || []).length) {
      const gaps = document.createElement('div');
      gaps.style.cssText = 'font-size:12.5px;color:var(--amber);background:var(--amber-soft);padding:8px 10px;border-radius:8px;';
      gaps.innerHTML = '⚠ 简历缺口（评委会盯着问）：<br/>' + data.profile.gaps.map((g) => '· ' + escapeHtml(g)).join('<br/>');
      resumeProfile.appendChild(gaps);
    }

    if (data.degraded) {
      // 不打印技术原因：用户只需要知道"这轮用的是基础题库"，以及接下来还能做什么
      const warn = document.createElement('div');
      warn.style.cssText =
        'display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--text-secondary);' +
        'background:var(--surface-alt);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-top:8px;';
      warn.innerHTML =
        '<span class="tag tag-amber">基础出题模式</span><span>题目照常可用，只是追问会更贴近通用题库；你可以先练，稍后再点「重新出题」。</span>';
      resumeProfile.appendChild(warn);
    }

    renderResumeBullets(data);
  };

  /**
   * 简历要点（紧凑列表）：解析后只铺开"简历里抽出的要点"，不再一屏拉长题卡。
   * 点一条要点 → 右侧练习区切到该要点 + 检索知乎知识 + 弹出按被问概率排序的候选题。
   */
  const renderResumeBullets = (record) => {
    const bullets = flatBullets(record);
    resumeQuestions.style.display = 'flex';
    resumeQuestions.innerHTML = '';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);flex-wrap:wrap;';
    head.innerHTML = `<span>简历要点 · 共 ${bullets.length} 条${record?.filename ? ' · ' + escapeHtml(record.filename) : ''}</span>`;

    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn btn-ghost btn-sm';
    again.textContent = '重新出题';
    again.addEventListener('click', () => wrapper.querySelector('#btn-resume-refresh').click());

    const multiBtn = document.createElement('button');
    multiBtn.type = 'button';
    multiBtn.className = 'btn btn-primary btn-sm';
    multiBtn.textContent = '为勾选要点出题 →';
    multiBtn.addEventListener('click', () => openBulletWizard(record));

    head.append(multiBtn, again);
    resumeQuestions.appendChild(head);

    const list = document.createElement('div');
    list.id = 'resume-bullets';
    list.style.cssText = 'display:flex;flex-direction:column;gap:2px;max-height:360px;overflow:auto;margin-top:6px;';
    bullets.forEach((b, bi) => {
      const row = document.createElement('div');
      row.className = 'bullet-row' + (activeBullet && activeBullet.text === b.text ? ' selected' : '');
      row.title = `第 ${bi + 1} 条 · ${locatorLabel(b.locator)}`;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = b.covered;
      cb.style.cssText = 'margin-top:3px;';
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', async () => {
        const next = cb.checked
          ? [...new Set([...(b.coveredAll || []), b.text])]
          : (b.coveredAll || []).filter((x) => x !== b.text);
        await updateResumeQuestionState(b.qid, { coveredBullets: next });
      });

      const loc = document.createElement('span');
      loc.className = 'bullet-loc';
      loc.textContent = String(bi + 1);
      const txt = document.createElement('span');
      txt.className = 'bullet-text';
      txt.textContent = b.text;

      row.append(cb, loc, txt);
      row.addEventListener('click', () => selectBullet(b));
      list.appendChild(row);
    });
    resumeQuestions.appendChild(list);
  };

  /** 还没选要点时，右侧给一句引导（避免对着真题面板发呆） */
  function showBulletHint() {
    // 已经选过要点（或不在简历模式）就别覆盖右侧内容
    if (activeBullet || getMode() !== 'resume') return;
    const card = document.querySelector('#bullet-context-card');
    if (!card) return;
    card.hidden = false;
    const loc = document.querySelector('#bullet-locator');
    const txt = document.querySelector('#bullet-context-text');
    const kb = document.querySelector('#bullet-knowledge');
    if (loc) loc.textContent = '待选';
    if (txt) txt.textContent = '从左侧「简历要点」里点一条，这里会显示该要点与实时检索到的知乎知识。';
    if (kb) kb.innerHTML = '<span style="color:var(--text-muted)">选完要点后，这里会自动检索相关面经与观点。</span>';
  }

  /** 简历解析结果 → 扁平要点列表 */
  function flatBullets(record) {
    const out = [];
    for (const q of record?.questions || []) {
      const bullets = q.bullets?.length ? q.bullets : deriveBullets(q.why);
      for (const b of bullets) {
        out.push({
          text: b,
          why: q.why || '',
          locator: q.locator || '',
          focus: q.focus || '',
          difficulty: q.difficulty || '',
          parentQ: q.q || '',
          qid: q.id,
          covered: (q.coveredBullets || []).includes(b),
          coveredAll: q.coveredBullets || [],
          sources: q.sources || [],
          ref: q.zhihuRef || null,
        });
      }
    }
    return out;
  }

  /** 点要点：右侧切到该要点 + 检索知乎知识 + 弹出候选题窗口 */
  function selectBullet(b) {
    if (!b) return;
    activeBullet = b;
    bulletKnowledge = [];
    state.activeQuestion = {
      id: 'bullet-' + (b.qid || '') + '-' + b.text.slice(0, 8),
      title: b.text,
      context: b.why || '',
      keywords: (resumeRecord?.profile?.skills || []).slice(0, 6),
      expectedLength: [150, 400],
      skeleton: [b.text, '给一个可核对的数字与口径', '讲清你的判断与取舍', '落到结果与边界条件'],
      viewpointCards: [],
      sources: [],
      source: 'resume-bullet',
      locator: b.locator,
      zhihuRef: b.ref || null,
    };
    root.innerHTML = '';
    renderCoachScreen(root);
    openCandidateModal({ bullets: [b], record: resumeRecord, title: '可能被问到的题 · 按被问概率排序' });
  }

  /** 检索该要点相关的知乎面经（右侧"检索到的知识"） */
  async function loadBulletKnowledge(b) {
    const box = document.querySelector('#bullet-knowledge');
    if (!box || !b) return;
    box.innerHTML = '<span style="color:var(--text-muted)">正在检索知乎相关面经…</span>';
    try {
      const res = await fetch('/api/zhihu/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: String(b.text).slice(0, 40), scope: 'zhihu', count: 4 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '检索失败');
      bulletKnowledge = (data.results || []).slice(0, 4);
    } catch {
      bulletKnowledge = [];
      const el = document.querySelector('#bullet-knowledge');
      if (el) {
        el.innerHTML = '<span style="color:var(--amber)">知乎参考暂时没取到，不影响作答与诊断：可以直接按自己的思路讲。</span>';
      }
      return;
    }
    renderBulletKnowledge();
  }

  function renderBulletKnowledge() {
    const box = document.querySelector('#bullet-knowledge');
    if (!box) return;
    if (!bulletKnowledge.length) {
      box.innerHTML = '<span style="color:var(--text-muted)">暂无可引用的检索结果。</span>';
      return;
    }
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
    bulletKnowledge.forEach((k, i) => {
      const row = document.createElement('a');
      row.href = k.url || '#';
      row.target = '_blank';
      row.rel = 'noopener noreferrer';
      row.style.cssText = 'display:block;font-size:12.5px;line-height:1.6;color:var(--text-secondary);';
      row.innerHTML = `<strong style="color:var(--primary)">${i + 1}. ${escapeHtml(k.title || '')}</strong><br/><span style="color:var(--text-muted)">${escapeHtml(String(k.snippet || '').slice(0, 120))}</span>`;
      wrap.appendChild(row);
    });
    box.innerHTML = '';
    box.appendChild(wrap);
  }

  /** 候选题窗口：按"被问到的概率"降序；点「练习」开小窗作答 */
  async function openCandidateModal({ bullets, record, title = '② 选一道题去练' }) {
    const list = (bullets || []).filter(Boolean);
    if (!list.length) return;
    const modal = createModal({
      title,
      subtitle: '按"被问到的概率"从高到低排序；点「练习」在弹窗里直接作答',
      width: 780,
    });
    const closeBtn = modalButton('关闭', { ghost: true, onClick: () => modal.close() });
    modal.footer.appendChild(closeBtn);

    const notice = document.createElement('div');
    notice.style.cssText = 'font-size:12.5px;color:var(--text-muted);margin-bottom:8px;';
    const startedAt = Date.now();
    const tick = setInterval(() => {
      notice.textContent = `正在按要点生成候选题并估算被问概率…（${Math.round((Date.now() - startedAt) / 1000)}s）`;
    }, 1000);
    modal.body.appendChild(notice);

    // 先用本地模板兜底把窗口填满，模型结果到了再替换 —— 窗口永远不是空的
    const templateCandidates = list.flatMap((b) => [
      {
        id: 'tpl-1',
        bullet: b.text,
        q: `请具体讲讲「${String(b.text || '').slice(0, 34)}」：你的角色、一个可核对的数字、以及一次取舍。`,
        why: '按要点直接追问（模板题，模型结果生成后会自动替换）',
        focus: '项目深挖',
        difficulty: '进阶',
        prob: 60,
      },
    ]);
    const renderCandidates = (candidates, { pending = false } = {}) => {
      modal.body.innerHTML = '';
      if (pending) modal.body.appendChild(notice);
      candidates.forEach((c, i) => {
      const prob = Math.max(0, Math.min(100, Number(c.prob) || 0));
      const tone = prob >= 75 ? 'var(--red)' : prob >= 50 ? 'var(--amber)' : 'var(--green)';
      const item = document.createElement('div');
      item.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;';
      item.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
          <span style="font-size:11px;color:var(--text-muted);">第 ${i + 1} 可能 · ${escapeHtml(c.focus || '追问')} · ${escapeHtml(c.difficulty || '进阶')}</span>
          <span style="font-size:12px;font-weight:700;color:${tone};">被问概率 ${prob}%</span>
        </div>
        <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${escapeHtml(c.q || '')}</div>
        <div style="font-size:12px;color:var(--amber);margin-bottom:4px;">为什么问：${escapeHtml(c.why || '')}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">来自要点：${escapeHtml(String(c.bullet || '').slice(0, 46))}</div>
        <div style="height:4px;border-radius:999px;background:var(--border);overflow:hidden;margin-bottom:8px;">
          <div style="height:100%;width:${prob}%;background:${tone};"></div>
        </div>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = '练习 →';
      btn.addEventListener('click', () => {
        modal.close();
        openPracticeModal({ candidate: c, bullet: list[0], record });
      });
      item.appendChild(btn);
      modal.body.appendChild(item);
      });
    };

    renderCandidates(templateCandidates, { pending: true });

    let candidates = [];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 70000);
      const res = await fetch('/api/resume/questions-from-bullets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bullets: list.map((b) => ({ bullet: b.text, question: b.parentQ || '' })),
          resumeContext: JSON.stringify({
            画像: record?.profile?.headline || '',
            技能: (record?.profile?.skills || []).slice(0, 12),
            项目: (record?.profile?.projects || []).map((p) => ({
              名称: p.name,
              角色: p.role,
              主张: (p.claims || []).map((x) => x.text).slice(0, 4),
            })),
          }),
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '生成候选题失败');
      candidates = data.candidates || [];
    } catch {
      clearInterval(tick);
      notice.textContent = '这次没能让模型出题：下面是按你的要点直接生成的备选题，可以先挑一道练。';
      notice.style.color = 'var(--amber)';
      return;
    }
    clearInterval(tick);

    if (!candidates.length) {
      notice.textContent = '模型这次没给出候选题，下面是按要点直接生成的模板题。';
      notice.style.color = 'var(--amber)';
      return;
    }
    renderCandidates(candidates);
  }

  /** 练习小窗：题面 + 要点 + 检索到的知识 + 作答 + 复盘 */
  function openPracticeModal({ candidate, bullet, record }) {
    const modal = createModal({
      title: '练习这道题',
      subtitle: candidate?.q || bullet?.text || '',
      width: 720,
    });

    const knowledge = bulletKnowledge.slice(0, 3);
    const info = document.createElement('div');
    info.style.cssText = 'font-size:13px;line-height:1.75;margin-bottom:10px;';
    info.innerHTML = `
      <div style="color:var(--amber);">为什么问：${escapeHtml(candidate?.why || '')}</div>
      <div style="color:var(--text-muted);font-size:12px;">要点：${escapeHtml(bullet?.text || '')}</div>
      ${knowledge.length
        ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:6px;">检索到的知识：${knowledge
            .map((k) => `<a href="${escapeHtml(k.url || '')}" target="_blank" rel="noopener noreferrer">${escapeHtml(k.title || '')}</a>`)
            .join('、')}</div>`
        : '<div style="font-size:12px;color:var(--text-muted);margin-top:6px;">这一步暂时没找到相关的知乎内容，不影响先按自己的思路答</div>'}`;
    modal.body.appendChild(info);

    const ta = document.createElement('textarea');
    ta.className = 'textarea';
    ta.rows = 6;
    ta.placeholder = '按面试口吻写下你的回答（会逐条对照要点与你自己的原话做诊断）';
    modal.body.appendChild(ta);

    const result = document.createElement('div');
    result.style.cssText = 'margin-top:10px;font-size:13px;';
    modal.body.appendChild(result);

    const submit = modalButton('提交并复盘', {
      primary: true,
      onClick: async () => {
        const raw = ta.value.trim();
        if (!raw) {
          showToast('先写下你的回答', 'warn');
          return;
        }
        submit.disabled = true;
        submit.textContent = '模型生成中（最多 25 秒）…';
        const question = {
          id: candidate?.id || 'bullet-practice',
          title: candidate?.q || bullet?.text || '',
          context: candidate?.why || '',
          keywords: (record?.profile?.skills || []).slice(0, 6),
          skeleton: [bullet?.text].filter(Boolean),
          viewpointCards: [],
          sources: [],
          source: 'resume-bullet',
          locator: bullet?.locator || '',
        };
        const report = await runReview({
          question,
          raw,
          sources: knowledge.map((k) => ({
            summary: k.snippet,
            snippet: k.snippet,
            evidenceQuote: k.snippet,
            sourceUrl: k.url,
            author: '',
          })),
        });
        submit.disabled = false;
        submit.textContent = '提交并复盘';
        renderMiniReview(result, report);
      },
    });

    const closeBtn = modalButton('关闭', { ghost: true, onClick: () => modal.close() });
    modal.footer.append(closeBtn, submit);
  }

  /** 小窗内的复盘结果（紧凑版） */
  function renderMiniReview(host, report) {
    host.innerHTML = '';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:600;margin-bottom:6px;';
    head.innerHTML = report.degraded
      ? '<span>复盘结果</span><span class="tag tag-amber" style="font-weight:600;">基础模式</span>'
      : '<span>复盘结果</span>';
    host.appendChild(head);

    const rules = document.createElement('div');
    rules.style.cssText = 'font-size:12.5px;color:var(--text-secondary);margin-bottom:8px;line-height:1.7;';
    const findings = report.ruleFindings || [];
    const findingLabels = findings
      .slice(0, 5)
      .map((f) => {
        const { icon, label } = humanizeRule(f);
        return `${icon} ${label}`;
      });
    rules.textContent = findingLabels.length
      ? `找到 ${findings.length} 处可改进：${findingLabels.join('、')}`
      : '这一版没发现明显可优化点：数字、边界与取舍都交代得比较清楚。';
    host.appendChild(rules);

    for (const s of report.llmScores || []) {
      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:6px;';
      const tone = s.score >= 75 ? 'var(--green)' : s.score >= 55 ? 'var(--amber)' : 'var(--red)';
      card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <span class="tag tag-blue">${escapeHtml(s.dimension || '维度')}</span>
          <strong style="color:${tone};">${s.score}</strong>
        </div><div style="margin-top:4px;line-height:1.65;">${escapeHtml(s.claim || '')}</div>`;
      host.appendChild(card);
    }

    if ((report.improvements || []).length) {
      const ul = document.createElement('ul');
      ul.style.cssText = 'margin:6px 0 0;padding-left:18px;font-size:12.5px;line-height:1.75;';
      for (const im of report.improvements) {
        const li = document.createElement('li');
        li.textContent = im.claim || '';
        ul.appendChild(li);
      }
      host.appendChild(ul);
    }
  }

  /**
   * 两步向导：
   *   ① 滑窗一：勾选要点（来自每道题的 bullets）
   *   ② 滑窗二：列出这些要点对应的"可能被问到的题"，挑一道去练
   */
  const collectRefs = (record) => {
    const cards = [];
    const sources = [];
    for (const q of record?.questions || []) {
      for (const c of q.viewpointCards || []) {
        if (c.sourceUrl && !cards.some((x) => x.sourceUrl === c.sourceUrl)) cards.push(c);
      }
      for (const s of q.sources || []) {
        if (s.url && !sources.some((x) => x.url === s.url)) sources.push(s);
      }
    }
    return { cards, sources };
  };

  const openBulletWizard = (record) => {
    const questions = record?.questions || [];
    if (!questions.length) {
      showToast('还没有可勾选的要点：先上传简历或重新出题', 'warn');
      return;
    }
    const selected = new Map(); // bullet -> 所属题目

    const modal = createModal({
      title: '① 选择要练的要点',
      subtitle: '勾选你想练的要点（来自每道面试题的必备覆盖点），下一步会给出对应的候选题目',
      width: 780,
    });

    const counter = document.createElement('div');
    counter.style.cssText = 'font-size:12.5px;color:var(--text-muted);margin-bottom:8px;';
    const renderCounter = () => {
      counter.textContent = `已选 ${selected.size} 个要点`;
    };
    renderCounter();
    modal.body.appendChild(counter);

    questions.forEach((q, qi) => {
      const group = document.createElement('div');
      group.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;';
      const head = document.createElement('div');
      head.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:6px;';
      head.textContent = `Q${qi + 1} · ${q.q}`;
      group.appendChild(head);

      const bullets = q.bullets?.length ? q.bullets : [q.why || ''].filter(Boolean);
      if (!bullets.length) return;
      for (const b of bullets) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;gap:8px;align-items:flex-start;cursor:pointer;font-size:13px;padding:3px 0;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.style.cssText = 'margin-top:3px;';
        cb.addEventListener('change', () => {
          if (cb.checked) selected.set(b, q.q);
          else selected.delete(b);
          renderCounter();
        });
        const txt = document.createElement('span');
        txt.textContent = b;
        row.append(cb, txt);
        group.appendChild(row);
      }
      modal.body.appendChild(group);
    });

    const cancelBtn = modalButton('取消', { ghost: true, onClick: () => modal.close() });
    const nextBtn = modalButton('生成候选题目 →', {
      primary: true,
      onClick: async () => {
        if (!selected.size) {
          showToast('先勾选至少一个要点', 'warn');
          return;
        }
        nextBtn.disabled = true;
        nextBtn.textContent = '生成中…';
        const bullets = [...selected.entries()].map(([bullet, question]) => ({ bullet, question }));
        try {
          const res = await fetch('/api/resume/questions-from-bullets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bullets,
              resumeContext: JSON.stringify({
                画像: record?.profile?.headline || '',
                技能: (record?.profile?.skills || []).slice(0, 12),
                项目: (record?.profile?.projects || []).map((p) => ({
                  名称: p.name,
                  角色: p.role,
                  主张: (p.claims || []).map((x) => x.text).slice(0, 4),
                })),
              }),
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error?.message || '生成候选题目失败');
          modal.close();
          openCandidateModal({
            bullets: [...selected.entries()].map(([bullet, question]) => ({ text: bullet, parentQ: question })),
            record,
          });
        } catch (err) {
          nextBtn.disabled = false;
          nextBtn.textContent = '生成候选题目 →';
          showToast(err.message, 'error', 6000);
        }
      },
    });
    modal.footer.append(cancelBtn, nextBtn);
  };

  // 重新出题：忽略缓存（同一份简历改成 force 才会再花 40–50 秒）
  let lastResumePayload = null;
  wrapper.querySelector('#btn-resume-refresh').addEventListener('click', async () => {
    if (!lastResumePayload) {
      showToast('先上传一次简历，再重新出题', 'warn');
      return;
    }
    resumeStatus.textContent = '忽略缓存，重新出题（约 40–50 秒）…';
    try {
      const res = await fetch('/api/resume/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...lastResumePayload, force: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '出题失败');
      resumeStatus.textContent = `已重新生成 ${data.questions.length} 道题（未用缓存）`;
      renderResumeResult(data);
    } catch (err) {
      resumeStatus.textContent = '失败';
      showToast(err.message, 'error', 6000);
    }
  });

  wrapper.querySelector('#resume-file-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      showToast('文件超过 20MB', 'error');
      return;
    }
    resumeStatus.textContent = '解析简历中…';
    try {
      let segments = [];
      let engine = 'local';
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/doc/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message || 'PDF 解析失败');
        segments = data.segments;
        engine = data.engine || 'pdf';
        resumeStatus.textContent = `简历已读入（${engine}），正在按你的经历出题…`;
      } else {
        const text = await file.text();
        segments = chunkDocumentText(text, file.name).segments;
        resumeStatus.textContent = '解析完成，正在按简历出题…';
      }

      lastResumePayload = {
        filename: file.name,
        segments: segments.map((s) => ({ locator: s.locator, heading: s.heading, text: s.text })),
      };
      const res2 = await fetch('/api/resume/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastResumePayload),
      });
      const data2 = await res2.json();
      if (!res2.ok) {
        const hint =
          res2.status === 404
            ? '（后端实例过旧或未运行：在项目目录执行 npm run dev:restart）'
            : res2.status === 501
              ? '（模型未配置或不可用）'
              : '（检查后端是否在运行：/api/health）';
        throw new Error((data2?.error?.message || '出题失败') + hint);
      }
      await attachOpportunityToResume(data2);
      const saved = await saveResumeAnalysis(data2);
      if (saved && saved.persisted === false) {
        resumeStatus.textContent =
          '题目已生成，但本地库被旧标签页占用，只保存在本次会话：关闭旧标签页或点顶部「重置」后重新上传即可长期保存';
      }
      resumeStatus.textContent = data2.cached
        ? `沿用上次的解析结果：${data2.questions.length} 道题（本次没再调用模型）`
        : `已生成 ${data2.questions.length} 道题（按简历原文对齐，已滤掉对不上原文的 ${data2.droppedByGrounding} 条）`;
      renderResumeResult(saved || data2);
      showToast('简历解析完成：点左侧任意一条要点即可练（结果已存本机，不用重复上传）');
    } catch (err) {
      resumeStatus.textContent = '失败';
      showToast(err.message, 'error', 6000);
    }
  });

  // ---- 两种练法切换（sessionStorage 记忆，刷新不丢） ----
  const panelBank = wrapper.querySelector('#panel-bank');
  const panelResume = wrapper.querySelector('#panel-resume');
  const panelRecord = wrapper.querySelector('#panel-record');
  const practiceArea = wrapper.querySelector('#practice-area');
  const recordArea = wrapper.querySelector('#record-area');
  const modeButtons = Array.from(wrapper.querySelectorAll('[data-coach-mode]'));

  const applyMode = (mode) => {
    setMode(mode);
    const isResume = mode === 'resume';
    const isRecord = mode === 'record';
    panelBank.style.display = isRecord || isResume ? 'none' : 'flex';
    panelResume.style.display = isResume ? 'flex' : 'none';
    panelRecord.style.display = isRecord ? 'flex' : 'none';
    practiceArea.style.display = isRecord ? 'none' : 'flex';
    recordArea.style.display = isRecord ? 'flex' : 'none';
    for (const btn of modeButtons) {
      const active = btn.dataset.coachMode === mode;
      btn.className = `btn btn-sm ${active ? 'btn-primary' : ''}`;
      btn.setAttribute('aria-selected', String(active));
    }
  };
  const switchMode = (mode) => {
    if (mode === 'record') {
      // 录音复盘与题目无关：只切界面，保留当前题
      applyMode(mode);
      return;
    }
    const currentSource = question.source === 'resume' ? 'resume' : 'bank';
    if (mode === currentSource) {
      applyMode(mode);
      return;
    }
    const next = rememberedQuestions[mode] || (mode === 'bank' ? state.bank[0] : null);
    setMode(mode);
    if (next) {
      state.activeQuestion = next;
      root.innerHTML = '';
      renderCoachScreen(root);
    } else {
      // 简历模式还没有题：只切面板，右侧提示先上传简历
      applyMode(mode);
    }
  };
  for (const btn of modeButtons) {
    btn.addEventListener('click', () => switchMode(btn.dataset.coachMode));
  }
  applyMode(question.source === 'resume' ? 'resume' : getMode());

  // ---- 录音复盘区：导入转写稿 / 上传录音转写 / 简历对照 / 生成复盘报告 ----
  const recordTranscript = wrapper.querySelector('#record-transcript');
  const audioReviewBox = wrapper.querySelector('#audio-review-result');
  let audioReview = null;      // 简历 × 口述 对照结果
  let lastTranscriptSource = '';  // 'local-asr' | 'import' | 'manual'

  const fmtTime = (sec) => {
    const t = Math.max(0, Math.round(Number(sec) || 0));
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };

  wrapper.querySelector('#record-audio-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    recordTranscript.value = '';
    showToast('正在本机转写，录音越长越慢…');
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const res = await fetch('/api/asr/local-transcribe', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '转写失败');
      const segments = data.segments || [];
      if (!segments.length) {
        showToast('没识别到语音：检查录音音量，或换更清晰的录音', 'warn', 6000);
        return;
      }
      recordTranscript.value = segments.map((seg) => `[${fmtTime(seg.start)}] ${seg.text}`).join('\n');
      lastTranscriptSource = 'local-asr';
      audioReview = null;
      if (audioReviewBox) audioReviewBox.style.display = 'none';
      showToast(`转写完成：${segments.length} 段 / 约 ${data.duration?.toFixed?.(0) || '?'} 秒（只在本机处理）`);
    } catch {
      showToast('这段录音没能自动转写：换一段更清晰的录音，或把会议文字稿粘贴进来', 'error', 6000);
    }
  });

  // 简历 × 录音 对照
  wrapper.querySelector('#btn-audio-vs-resume').addEventListener('click', async () => {
    const transcript = (recordTranscript.value || '').trim();
    if (!transcript) {
      showToast('先录音或上传音频生��转写稿', 'warn');
      return;
    }
    const resume = loadResumeAnalysis();
    if (!resume?.profile) {
      showToast('还没有简历上下文：先到「简历陪练」上传简历', 'warn', 5000);
      return;
    }
    const btn = wrapper.querySelector('#btn-audio-vs-resume');
    btn.disabled = true;
    btn.textContent = '对照中…';
    try {
      const res = await fetch('/api/review/resume-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript,
          resumeContext: {
            headline: resume.profile?.headline || '',
            skills: resume.profile?.skills || [],
            projects: resume.profile?.projects || [],
            gaps: resume.profile?.gaps || [],
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || '对照失败');
      audioReview = data;
      audioReviewBox.style.display = 'block';
      audioReviewBox.innerHTML = `
        <div style="font-size:13px;font-weight:600;margin-bottom:6px;">简历 × 口述对照：${escapeHtml(data.verdict || '')}</div>
        <ul style="margin:0 0 8px;padding-left:18px;">
          ${(data.consistency || [])
            .map(
              (c) => `<li><strong>${escapeHtml(c.verdict)}</strong>：简历「${escapeHtml(c.claim)}」／口述「${escapeHtml(c.said)}」${
                c.risk ? `<br/><span style="color:var(--amber);">风险：${escapeHtml(c.risk)}</span>` : ''
              }</li>`
            )
            .join('')}
        </ul>
        ${
          (data.risks || []).length
            ? `<div style="color:var(--amber);font-size:12.5px;margin-bottom:6px;">易被击穿处：${escapeHtml(data.risks.join(' / '))}</div>`
            : ''
        }
        ${
          (data.followups || []).length
            ? `<div style="font-size:12.5px;">针对这段录音的追问：${escapeHtml(data.followups.join(' / '))}</div>`
            : ''
        }`;
      showToast('已完成简历 × 口述对照');
    } catch (err) {
      showToast(err.message, 'error', 6000);
    } finally {
      btn.disabled = false;
      btn.textContent = '按简历对照这段录音';
    }
  });


  wrapper.querySelector('#record-transcript-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    recordTranscript.value = text;
    lastTranscriptSource = 'import';
    audioReview = null;
    if (audioReviewBox) audioReviewBox.style.display = 'none';
    showToast(`已导入转写稿（${text.length} 字）`);
  });

  wrapper.querySelector('#btn-record-review').addEventListener('click', async () => {
    const raw = (recordTranscript.value || '').trim();
    if (!raw) {
      showToast('先录音生成字幕，或导入/粘贴会议转写稿', 'warn');
      return;
    }
    const qaPairs = parseTranscriptToQA(raw, '本次录音复盘');
    if (!qaPairs.length) {
      showToast('没切出问答对：转写稿需要带「面试官：/ 我：」标签，或至少有一问一答', 'warn', 5000);
      return;
    }
    const answer = qaPairs.map((p) => `问：${p.question}\n答：${p.answer}`).join('\n\n');
    const ruleFindings = qaPairs.flatMap((pair, i) =>
      runDeterministicRules(pair.answer, { keywords: [], expectedLength: [30, 500], pairIndex: i })
    );

    const report = {
      id: 'session-' + Date.now(),
      resumeReview: audioReview,
      transcriptSource: lastTranscriptSource,
      question: {
        id: 'record-review',
        title: `录音复盘 · ${qaPairs.length} 组问答`,
        context: '来源：本机录音 / 会议转写稿（未绑定具体真题，因此不跑观点层评分）',
        keywords: [],
        expectedLength: [30, 500],
        skeleton: [],
        viewpointCards: [],
        source: 'record',
      },
      answer,
      ruleFindings,
      llmScores: null,
      improvements: null,
      degraded: true,
      degradedReason: '录音复盘未绑定具体题目：只做逐题原话诊断',
      createdAt: new Date().toISOString(),
    };
    state.lastReviewReport = report;
    // 先绑定场次再落库：报告里要带上 opportunityId，台账才能反查
    await attachOpportunityToReport(report);
    await dbPut('sessions', report);
    navigate('/review');
    showToast(
      `已生成录音复盘：${qaPairs.length} 组问答，${
        summarizeFindings(ruleFindings, 3).join('、') || '没发现明显可优化点'
      }`,
      'info',
      5000
    );
  });

  wrapper.querySelector('#btn-import-from-record').addEventListener('click', () => {
    const text = (recordTranscript.value || '').trim();
    if (!text) {
      showToast('「录音复盘」里还没有转写稿', 'warn');
      return;
    }
    textarea.value = text;
    updateSampleHint();
    syncSubmitGate?.();
    showToast('已把转写稿带入作答框');
  });

  // ---- 冷启动恢复：不用每次都重新上传简历 ----
  (async () => {
    const restored = await restoreLatestResumeAnalysis();
    if (restored && (restored.questions || []).length) {
      resumeStatus.textContent = `已恢复上次的简历解析（${restored.filename || '简历'}，${restored.questions.length} 道题）`;
      resumeRecord = restored;
      renderResumeBullets(restored);
      showBulletHint();
    }
  })();

  // ---- 双轨回放 / 导出 / 转写 ----
  let lastTracks = null;

  const renderTracks = (result) => {
    lastTracks = { mic: result.blob, system: result.systemBlob || null };
    recTracks.style.display = 'block';
    recTracks.innerHTML = '';

    const rows = [
      { key: 'mic', label: '🎤 我（麦克风轨）', blob: lastTracks.mic },
      { key: 'system', label: '🔊 面试官（系统音频轨）', blob: lastTracks.system },
    ];
    for (const row of rows) {
      if (!row.blob) continue;
      const box = document.createElement('div');
      box.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;';
      const label = document.createElement('span');
      label.style.cssText = 'min-width:170px;color:var(--text-secondary);';
      label.textContent = row.label;
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.style.cssText = 'flex:1;height:32px;';
      audio.src = trackUrl(row.blob);
      box.append(label, audio);
      recTracks.appendChild(box);
    }
    if (!lastTracks.system) {
      const note = document.createElement('div');
      note.style.cssText = 'color:var(--text-muted);';
      note.textContent = '本次是单轨录音（未勾选系统声音）：说话人只能靠字幕徽标或「我说/面试官说」手工标注。';
      recTracks.appendChild(note);
    }

    recActions.style.display = 'flex';
    recActions.innerHTML = '';

    const transcribeBtn = document.createElement('button');
    transcribeBtn.type = 'button';
    transcribeBtn.className = 'btn btn-primary btn-sm';
    transcribeBtn.textContent = '转写这两轨（→ 带说话人的转写稿）';
    transcribeBtn.addEventListener('click', async () => {
      transcribeBtn.disabled = true;
      transcribeBtn.textContent = '转写中…';
      asrHint.style.display = 'block';
      asrHint.textContent = '正在检查转写服务…';
      try {
        const status = await fetch('/api/asr/status').then((r) => r.json());
        if (!status.available) {
          asrHint.innerHTML = `这台设备还没开通自动转写，不影响复盘：<br/>① 点「导出两条音轨」，用你电脑上的转写工具生成文字稿，再粘贴到下面；<br/>② 或者直接导入飞书妙记 / 腾讯会议 AI 笔记的转写稿（最省事）。`;
          return;
        }
        asrHint.textContent = '云端转写中（两轨分别转写，再按时间轴合并）…';
        const runOne = async (blob, track, name) => {
          const res = await fetch('/api/asr/transcribe', { method: 'POST', body: toFormData(blob, name, track) });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error?.message || '转写失败');
          return data.segments || [];
        };
        const micSegments = await runOne(lastTracks.mic, 'mic', 'mic.webm');
        const sysSegments = lastTracks.system ? await runOne(lastTracks.system, 'system', 'system.webm') : [];
        const merged = mergeTracks(micSegments, sysSegments);
        textarea.value = toTranscriptText(merged);
        updateSampleHint();
        asrHint.textContent = `✅ 已合并 ${merged.length} 句（我 ${merged.filter((r) => r.speaker === 'me').length} / 面试官 ${merged.filter((r) => r.speaker === 'interviewer').length}），可直接点「结束并生成复盘诊断」。`;
      } catch {
        asrHint.textContent = '⚠ 这次没转成，可以点「导出两条音轨」自己转写，再把文字稿粘到下面作答框。';
      } finally {
        transcribeBtn.disabled = false;
        transcribeBtn.textContent = '转写这两轨（→ 带说话人的转写稿）';
      }
    });

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn btn-ghost btn-sm';
    exportBtn.textContent = '导出两条音轨';
    exportBtn.addEventListener('click', () => {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadTrack(lastTracks.mic, `mic-${stamp}.webm`);
      if (lastTracks.system) downloadTrack(lastTracks.system, `system-${stamp}.webm`);
      showToast('已导出到下载目录（本地文件，未上传）');
    });

    recActions.append(transcribeBtn, exportBtn);
  };

  // 换一题
  wrapper.querySelector('#btn-switch-q').addEventListener('click', () => {
    const idx = state.bank.findIndex((item) => item.id === question.id);
    const next = state.bank[(idx + 1) % state.bank.length];
    state.activeQuestion = next;
    root.innerHTML = '';
    renderCoachScreen(root);
  });

  // 样例填充按钮（放在作答框上方，空框时才显示，见 updateSampleHint）
  wrapper.querySelector('#btn-fill-sample').addEventListener('click', () => {
    // 按当前题目的领域挑示范回答：通用题不该填出一堆技术指标
    const sample = getMatchedSampleAnswer(question);
    textarea.value = sample;
    updateSampleHint();
    syncSubmitGate();
    textarea.focus();
    showToast('已填入一段贴合这道题的示例回答，改成你自己的经历再用');
  });

  // ---- 作答门禁：有效字数不足时主按钮置灰，并给出还差多少 ----
  const submitBtn = wrapper.querySelector('#btn-submit-parse');
  const MIN_EFFECTIVE = 15;
  const submitLabel = submitBtn.textContent;
  submitBtn.dataset.gated = '1';
  const syncSubmitGate = () => {
    const count = countEffectiveChars(textarea.value);
    const counter = wrapper.querySelector('#answer-char-count');
    if (counter) counter.textContent = `${count} 字${count < MIN_EFFECTIVE ? `（至少 ${MIN_EFFECTIVE} 字）` : ''}`;
    const ready = count >= MIN_EFFECTIVE;
    // 复盘生成中/追问等待时不要解除禁用：只在非忙碌状态控制
    if (submitBtn.dataset.busy === '1') return;
    submitBtn.disabled = !ready;
    submitBtn.textContent = ready ? submitLabel : `请先输入或录制回答（至少 ${MIN_EFFECTIVE} 字）`;
  };
  textarea.addEventListener('input', syncSubmitGate);
  syncSubmitGate();

  // ---- 思考停顿保护：静音 5 秒不自动断句，空格继续说 / Enter 发送 ----
  let pauseGuard = null;
  const startPauseGuard = () => {
    pauseGuard?.reset?.();
    pauseGuard = new PauseGuard({
      silenceMs: 5000,
      onHint: (hint) => {
        captionStatusEl.textContent = `⏸ ${hint}`;
        silenceWarning.textContent = `⏸ ${hint}`;
        silenceWarning.style.display = 'block';
      },
      onFlush: (info) => {
        if (info?.reason === 'silence') {
          captionStatusEl.textContent = `⏸ ${info.hint}`;
        }
      },
    });
    return pauseGuard;
  };
  const stopPauseGuard = () => {
    pauseGuard?.reset?.();
    pauseGuard = null;
  };
  // 录音中：空格 = 继续说，Enter = 结束并把字幕填进作答框
  const onRecordKey = (e) => {
    if (!isRecording || !pauseGuard) return;
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      const next = pauseGuard.handleKey(' ');
      if (next === 'listening') {
        try {
          captionEngine?.recognition?.start?.();
        } catch {
          /* 已在识别中 */
        }
        captionStatusEl.textContent = '● 继续说…';
        silenceWarning.style.display = 'none';
      }
    } else if (e.key === 'Enter' && pauseGuard.isAwaitingUser) {
      e.preventDefault();
      pauseGuard.handleKey('Enter');
      recordBtn.click();
      const box = wrapper.querySelector('#answer-textarea');
      if (box && captions.length) box.value = applyHotwordFix(captionsToTranscript(captions));
    }
  };
  document.addEventListener('keydown', onRecordKey);

  // 录音控制 (M2 + M3)
  recordBtn.addEventListener('click', async () => {
    if (!isRecording) {
      try {
        // 二轨（可选）：系统声音 = 面试官那一路
        let systemStream = null;
        if (systemAudioChk.checked) {
          try {
            const captured = await captureSystemAudio();
            systemStream = captured.stream;
          } catch (err) {
            showToast(err.message, 'warn', 6000);
          }
        }

        recorder = new LocalAudioRecorder({
          onLevel: (_rms, db) => {
            const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
            volumeFill.style.width = `${pct}%`;
            volumeFill.style.background = db > -35 ? 'var(--green)' : db > -55 ? 'var(--amber)' : 'var(--red)';
            volumeDb.textContent = `${Math.round(db)} dB`;
            if (db > -50) silenceWarning.style.display = 'none';
          },
          onSilence: (msg) => {
            showToast(msg, 'warn', 8000);
            silenceWarning.textContent = '⚠ ' + msg;
            silenceWarning.style.display = 'block';
            captionStatusEl.textContent = '⚠ 检测到持续静音，检查设备后重试（或改用「导入会议转写稿」）';
          },
        });

        await recorder.start({ deviceId: micSelect.value || undefined, systemStream });
        startPauseGuard();
        isRecording = true;
        recordBtn.textContent = '⏹ 停止录音';
        recordBtn.className = 'btn btn-danger btn-sm';
        captionStatusEl.textContent = '● 正在本地录音（Opus 编码），实时字幕识别中…';

        captionEngine = new LiveCaptionEngine({
          pauseGuard,
          onSentence: (sent) => {
            captions.push(sent);
            renderCaptions();
          },
          onInterim: (txt) => renderCaptions(txt),
          onError: (msg) => {
            // 「没听到声音」多半是用户在想，不是设备坏了 → 交给停顿保护，等用户决定
            if (/没听到声音|no-speech/i.test(msg)) {
              pauseGuard?.noteSpeech();
              pauseGuard?.tick();
              captionStatusEl.textContent = `⏸ ${PAUSE_GUARD_HINT}`;
              showToast(PAUSE_GUARD_HINT, 'warn', 6000);
              return;
            }
            captionStatusEl.textContent = '⚠ ' + msg;
            showToast(msg, 'warn', 4500);
          }
        });
        captionEngine.start();
      } catch {
        showToast('没能打开麦克风：检查一下浏览器权限，或直接在下面输入 / 导入转写稿', 'warn', 4500);
      }
    } else {
      isRecording = false;
      stopPauseGuard();
      document.removeEventListener('keydown', onRecordKey);
      recordBtn.textContent = '开始录音';
      recordBtn.className = 'btn btn-primary btn-sm';
      captionEngine?.stop();
      const result = await recorder.stop();
      if (result?.blob) {
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        audioUrl = URL.createObjectURL(result.blob);
        audioPlayer.src = audioUrl;
        audioBox.hidden = false;

        const deviceLabel = micSelect.options[micSelect.selectedIndex]?.textContent || '系统默认输入';
        await saveRecording({
          id: 'rec-' + Date.now(),
          questionId: question.id,
          micBlob: result.blob,
          systemBlob: result.systemBlob || null,
          durationSec: result.durationSec,
          captions,
          deviceLabel,
        });

        renderTracks(result);
        lastAnswerDurationSec = result.durationSec;
        captionStatusEl.textContent = `✅ 录音完成（${result.durationSec} 秒，${result.systemBlob ? '双轨' : '单轨'}），只存在本机 IndexedDB，未产生任何上传请求。`;
      }
    }
  });

  // ---- 陪练设置浮层：默认收起，点外面 / Esc 关闭（不占顶部工具栏版面） ----
  const settingsBtn = wrapper.querySelector('#btn-coach-settings');
  const settingsMenu = wrapper.querySelector('#coach-settings-menu');
  const openSettings = () => {
    settingsMenu.style.display = 'flex';
    settingsBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onSettingsOutside, true);
    document.addEventListener('keydown', onSettingsKeydown, true);
  };
  const closeSettings = () => {
    if (settingsMenu.style.display === 'none') return;
    settingsMenu.style.display = 'none';
    settingsBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onSettingsOutside, true);
    document.removeEventListener('keydown', onSettingsKeydown, true);
  };
  function onSettingsOutside(ev) {
    if (settingsMenu.contains(ev.target) || settingsBtn.contains(ev.target)) return;
    closeSettings();
  }
  function onSettingsKeydown(ev) {
    if (ev.key !== 'Escape') return;
    closeSettings();
    settingsBtn.focus();
  }
  settingsBtn.addEventListener('click', () => {
    if (settingsMenu.style.display === 'none') openSettings();
    else closeSettings();
  });

  // ---- 追问深度 / 面试官人设（本地记忆，切换后下一轮提交生效） ----
  const DEPTH_KEY = 'zhimian.coach.depth';
  const STYLE_KEY = 'zhimian.coach.style';
  const depthSelect = wrapper.querySelector('#sel-followup-depth');
  const styleSelect = wrapper.querySelector('#sel-interviewer-style');
  const readNum = (k, d) => {
    const v = Number(localStorage.getItem(k));
    return Number.isFinite(v) && v >= 1 && v <= 3 ? v : d;
  };
  let followupDepth = readNum(DEPTH_KEY, 2);
  // 默认「温和引导型」：新手第一次被怼容易劝退，冲刺期再手动切到压力挑战
  let interviewerStyle = localStorage.getItem(STYLE_KEY) === 'tough' ? 'tough' : 'gentle';
  depthSelect.value = String(followupDepth);
  styleSelect.value = interviewerStyle;
  depthSelect.addEventListener('change', () => {
    followupDepth = Number(depthSelect.value) || 2;
    localStorage.setItem(DEPTH_KEY, String(followupDepth));
    showToast(`追问深度：${followupDepth} 轮`);
  });
  styleSelect.addEventListener('change', () => {
    interviewerStyle = styleSelect.value === 'gentle' ? 'gentle' : 'tough';
    localStorage.setItem(STYLE_KEY, interviewerStyle);
    showToast(`面试官人设：${interviewerStyle === 'gentle' ? '温和引导型' : '压力挑战型'}`);
  });

  // 参考答题骨架上挂可点击的知乎溯源 chip（抗 AI 幻觉的关键说服力）
  (() => {
    const list = wrapper.querySelector('#coach-skeleton-list');
    if (!list) return;
    const cards = (question.viewpointCards || []).slice(0, 3);
    const skeleton = question.skeleton || [];
    cards.forEach((vc, i) => {
      const li = list.querySelector(`[data-skeleton-idx="${i}"]`);
      if (!li) return;
      li.appendChild(
        renderCitationChip({
          id: `S${i + 1}`,
          type: 'zhihu',
          label: `知乎原文溯源 ${i + 1}`,
          sourceTitle: vc.author || '知乎答主',
          locator: vc.stance || '',
          quote: vc.evidenceQuote || '',
          url: vc.sourceUrl || '',
          // 左栏是这条骨架要点、右栏是知乎原话：点开就是"该怎么说 vs 别人怎么说"的对照
          myText: skeleton[i] || '',
        })
      );
    });
  })();

  // 追问若来自观点卡分歧，就在追问框里挂一个角标：
  // 左栏是用户上一轮的说法，右栏是知乎该视角的原话 —— 一眼看出"我说的"和"别人说的"差在哪
  const attachFollowupCitation = (vc) => {
    if (!vc) return;
    const box = wrapper.querySelector('#followup-question-text');
    if (!box) return;
    const prev = String(roundAnswers[roundAnswers.length - 1] || textarea.value || '').trim();
    box.appendChild(
      renderCitationChip({
        id: 'S-F',
        type: 'zhihu',
        label: '知乎原文溯源',
        sourceTitle: vc.author || '知乎答主',
        locator: vc.stance || '',
        quote: vc.evidenceQuote || '',
        url: vc.sourceUrl || '',
        myText: prev.slice(0, 400),
      })
    );
  };

  // 追问生成（单题最多 3 轮，取自观点卡分歧）
  wrapper.querySelector('#btn-trigger-followup').addEventListener('click', () => {
    if (followupRound >= 3) {
      showToast('已达到单题最大追问轮次（3 轮），请结束并查看诊断报告', 'warn');
      return;
    }
    // 已经进到追问环节，说明主问题答过了：观点卡没必要再藏着
    revealAllViewpoints();
    followupRound++;
    const minorityCard = question.viewpointCards?.[1] || question.viewpointCards?.[0];
    activeFollowupFocus = (question.keywords || []).slice(0, 2).join(' ');
    const fqText = minorityCard
      ? `知乎上有答主提出质疑：“${minorityCard.evidenceQuote}”——针对这一点，你的具体边界条件和取舍依据是什么？`
      : '如果线上数据分布发生漂移，你的这套指标如何保证不失真？';

    wrapper.querySelector('#followup-box').hidden = false;
    wrapper.querySelector('#followup-round-num').textContent = String(followupRound);
    const textBox = wrapper.querySelector('#followup-question-text');
    textBox.textContent = fqText;
    attachFollowupCitation(minorityCard);
    showToast(`已生成第 ${followupRound} 轮深度追问`);
  });

  // ---- 深挖轮次：主问题 → 评委追问（最多 followupDepth 轮）→ 整场复盘 ----
  let deepRound = 0;              // 已提出的追问轮次
  const askedFollowups = [];      // 历次追问原文（顺序）
  const roundAnswers = [];        // 历次作答原文
  let skipFollowup = false;       // 用户选择"跳过这轮"
  // 模型层不可用时用固定追问模板兜底：界面上只说"基础追问模式"，不打印技术原因
  let followupModeDegraded = false;
  const setFollowupModeBadge = (degraded) => {
    followupModeDegraded = Boolean(degraded);
    const badge = wrapper.querySelector('#followup-mode-badge');
    if (badge) badge.style.display = followupModeDegraded ? 'inline-flex' : 'none';
  };

  const showFollowupBox = (text, round) => {
    const box = wrapper.querySelector('#followup-box');
    if (!box) return;
    box.hidden = false;
    wrapper.querySelector('#followup-round-num').textContent = String(round);
    setFollowupModeBadge(followupModeDegraded);
    const textBox = wrapper.querySelector('#followup-question-text');
    textBox.textContent = text;
    const label = wrapper.querySelector('#followup-style-label');
    if (label) label.textContent = ' · ' + (interviewerStyle === 'gentle' ? '温和引导型' : '压力挑战型');
    activeFollowupFocus = text;
    // 深挖轮次的追问同样来自观点分歧，挂上角标才能看出"评委在质疑哪句话"
    attachFollowupCitation(question.viewpointCards?.[1] || question.viewpointCards?.[0]);
  };

  // 多轮问答拼成「面试官：/ 我：」转写稿：模型看到的是完整现场
  const buildTranscript = (finalAnswer) => {
    const qs = [question.title, ...askedFollowups];
    const as = [...roundAnswers, finalAnswer];
    const lines = [];
    for (let i = 0; i < as.length; i++) {
      lines.push(`面试官：${qs[i] || question.title}`);
      lines.push(`我：${as[i]}`);
    }
    return lines.join('\n');
  };

  wrapper.querySelector('#btn-followup-explain')?.addEventListener('click', () => {
    const skeleton = (question.skeleton || []).slice(0, 4).join('\n');
    textarea.value = skeleton ? `（我看解析后重答）\n${skeleton}` : '（我看解析后重答）';
    updateSampleHint();
    textarea.focus();
    showToast('已把参考答题骨架填进作答框，照着改写再答一次');
  });

  wrapper.querySelector('#btn-followup-skip')?.addEventListener('click', () => {
    skipFollowup = true;
    showToast('已跳过追问，直接生成复盘');
    wrapper.querySelector('#btn-submit-parse').click();
  });

  // 提交解析（M4 + M5 + M6 降级双轨 + 深挖轮次）
  wrapper.querySelector('#btn-submit-parse').addEventListener('click', async (ev) => {
    const raw = textarea.value.trim();
    if (!raw) {
      showToast('请先录音、输入回答或导入样例转写稿', 'warn');
      return;
    }
    // 提交即代表这一题已经答完：评分类观点卡不再需要藏
    revealAllViewpoints();
    const submitBtn = ev.currentTarget;
    const originalLabel = submitLabel;
    submitBtn.dataset.busy = '1';
    submitBtn.disabled = true;
    submitBtn.textContent = '模型生成中（最多 25 秒）…';

    // 阶段性微文案：长耗时的模型调用期间必须告诉用户"现在在做什么"
    const progress = createProgress('正在检索知乎真实回答结构…');

    const transcript = buildTranscript(raw);
    let review;
    try {
      review = await runReview({
        question,
        raw: transcript,
        followupFocus: activeFollowupFocus,
        interviewerStyle,
        followupDepth,
        questionKind: kindOf(question),
        onStage: (text) => {
          if (text) progress.step(text);
        },
      });
    } catch (err) {
      // 模型层异常时也要收尾：微文案必须消失、按钮必须可点，否则页面会卡在"生成中"
      progress.done();
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
      showToast(err.message || '生成复盘失败，请重试', 'error', 6000);
      return;
    }
    const { qaPairs, answer: targetAnswer, ruleFindings, llmScores, improvements, degraded, followups } = review;
    // 本轮如果走了固定模板兜底，追问框标题旁只挂「基础追问模式」徽章，不打印技术原因
    setFollowupModeBadge(degraded);
    roundAnswers.push(raw);

    // 让 live region 把上一句播报出去再切下一句（否则阶段文案会挤在同一帧里看不到过程）
    await nextPaint();
    // 核心考察点：优先用题库给的骨架，题库没给就用追问焦点兜底
    const corePoints = (question.skeleton || []).slice(0, 3);
    const speechMetrics = computeSpeechMetrics({
      durationSec: lastAnswerDurationSec,
      text: roundAnswers.join('\n'),
      expectedLength: question.expectedLength || [120, 400],
    });

    // 深挖模式：评委还有下一问 → 先追问，别急着出复盘
    const nextFollowups = followups || [];
    if (!skipFollowup && nextFollowups.length && deepRound < followupDepth) {
      deepRound++;
      const fq = nextFollowups[0];
      askedFollowups.push(fq);
      showFollowupBox(fq, deepRound);
      textarea.value = '';
      updateSampleHint();
      submitBtn.dataset.busy = '';
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
      syncSubmitGate();
      progress.done();
      showToast(`评委追问了第 ${deepRound}/${followupDepth} 轮，接着答（再点提交）`);
      return;
    }

    const report = {
      id: 'session-' + Date.now(),
      question,
      qaPairs,
      answer: targetAnswer,
      transcript,
      rounds: roundAnswers.length,
      followupDepth,
      interviewerStyle,
      speechMetrics: computeSpeechMetrics({
        durationSec: lastAnswerDurationSec,
        text: roundAnswers.join('\n'),
        expectedLength: question.expectedLength || [120, 400],
      }),
      ruleFindings,
      llmScores: llmScores || null,
      improvements: improvements || null,
      degraded,
      createdAt: new Date().toISOString(),
    };

    state.lastReviewReport = report;
    await dbPut('sessions', report);
    // 刷新本地集合：让"最近记录"（跨路由守卫的下拉）能立刻看到这次作答
    await refreshLocalCollections();
    submitBtn.dataset.busy = '';
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
    progress.done();

    if (degraded) {
      showToast('模型服务正忙，本轮先用基础模式完成了逐句诊断', 'warn', 3800);
    } else {
      showToast(`复盘解析完成（${roundAnswers.length} 轮作答）`);
    }
    navigate('/review');
  });

  // ---- 底部「下一步」主行动条：作答完成、追问结束后就该出复盘诊断 ----
  // 吸底常驻，用户不用抬头找顶部导航就能知道下一步做什么。
  const hasQuestion = Boolean(state.activeQuestion);
  const nextStepBar = mountNextStepBar(root, {
    text: hasQuestion
      ? '下一步：先写下你的回答，再结束并生成复盘诊断'
      : '下一步：先载入一道题，开始这一轮练习',
    hint: '复盘会逐条回指你的原话，并对照知乎原话给出可核对的改进话术（只存在本机浏览器）。',
    actions: [
      hasQuestion
        ? {
            label: '结束并生成复盘诊断 →',
            primary: true,
            onClick: () => {
              const submit = wrapper.querySelector('#btn-submit-parse');
              if (!submit) return;
              if (submit.disabled) {
                showToast('正在生成中，稍等一下', 'warn');
                return;
              }
              submit.click();
            },
          }
        : {
            // 没有"当前题目"时，这一步是先把题选上（守卫里的推荐卡也做同一件事）
            label: '一键载入热身题 →',
            primary: true,
            onClick: () => {
              if (!warmup) {
                showToast('题库还在加载中，请稍候再试', 'warn');
                return;
              }
              loadQuestionFromOption(warmup);
            },
          },
    ],
  });
  // 只改文案、不重挂整条 bar：避免每次输入都把吸底条从 DOM 里摘下来再插回去（会闪）
  const nextStepText = nextStepBar?.firstElementChild?.firstElementChild || null;
  if (hasQuestion) {
    textarea.addEventListener('input', () => {
      if (!nextStepText) return;
      nextStepText.textContent = textarea.value.trim()
        ? '下一步：结束并生成复盘诊断'
        : '下一步：先写下你的回答，再结束并生成复盘诊断';
    });
  }
}
