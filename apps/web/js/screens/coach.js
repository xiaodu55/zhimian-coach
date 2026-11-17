import {
  state,
  saveResumeAnalysis,
  loadResumeAnalysis,
  restoreLatestResumeAnalysis,
  updateResumeQuestionState,
} from '../state.js';
import { navigate } from '../router.js';
import { escapeHtml } from '../ui/citation.js';
import { renderViewpointCard } from '../ui/components.js';
import { createModal, modalButton } from '../ui/modal.js';
import { LocalAudioRecorder } from '../capture/recorder.js';
import { LiveCaptionEngine, captionsToTranscript } from '../capture/caption.js';
import { listAudioInputs, detectVirtualDevice } from '../capture/devices.js';
import { isSystemAudioSupported, captureSystemAudio } from '../capture/systemAudio.js';
import { saveRecording, downloadTrack, toFormData, trackUrl } from '../capture/recordings.js';
import { mergeTracks, toTranscriptText } from '../capture/align.js';

/** 陪练室两种练法：真题陪练（题库+知乎观点卡）/ 简历陪练（按你的真实经历出题） */
const MODE_KEY = 'zhimian.coach.mode';
const getMode = () => (sessionStorage.getItem(MODE_KEY) === 'resume' ? 'resume' : 'bank');
/** 两种练法各自记住上一次选的题：切回来不用重挑 */
const rememberedQuestions = { bank: null, resume: null };
const setMode = (mode) => sessionStorage.setItem(MODE_KEY, mode);
import { parseTranscriptToQA } from '../capture/transcript.js';
import { runDeterministicRules } from '../rules/diagnose.js';
import { dbPut } from '../db.js';
import { showToast } from '../ui/toast.js';

export function renderCoachScreen(root) {
  const question = state.activeQuestion || state.bank[0];
  if (question) rememberedQuestions[question.source === 'resume' ? 'resume' : 'bank'] = question;
  if (!question) {
    root.innerHTML = `<div class="card">题库加载中，请稍候…</div>`;
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
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
      <div class="mode-switch" role="tablist" aria-label="陪练方式">
        <button type="button" class="btn btn-sm" data-coach-mode="bank" role="tab">📚 真题陪练</button>
        <button type="button" class="btn btn-sm" data-coach-mode="resume" role="tab">🧾 简历陪练</button>
        <button type="button" class="btn btn-sm" data-coach-mode="record" role="tab">🎙 录音复盘</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <span class="tag ${question.source === 'resume' ? 'tag-green' : 'tag-blue'}">${escapeHtml(question.source === 'resume' ? '简历题' : question.track)}</span>
        <span class="tag">连续追问上限 3 轮</span>
        <button id="btn-switch-q" class="btn btn-sm" type="button">换一题</button>
        <button id="btn-fill-sample" class="btn btn-sm" type="button">填入演示回答样例</button>
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
              4) 转写 → 生成复盘报告（规则层逐题诊断 + 可回指原话）
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
            解析简历 → 抽取项目/技能/缺口 → 生成 6–10 道针对性面试题（每题挂简历定位符 + 真实知乎面经）。
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
          <h2 style="margin:0 0 8px;font-size:18px;">${escapeHtml(question.title)}</h2>
          <p style="margin:0 0 12px;font-size:13px;color:var(--text-secondary);">${escapeHtml(question.context)}</p>

          <div id="followup-box" class="card" style="background:var(--amber-soft);border-color:#fedf89;margin-bottom:12px;" hidden>
            <div style="font-size:12px;font-weight:700;color:var(--amber);margin-bottom:4px;">🔥 面试官深度追问（第 <span id="followup-round-num">1</span>/3 轮 · 取自知乎分歧观点）</div>
            <div id="followup-question-text" style="font-weight:600;font-size:14px;"></div>
          </div>

          <details>
            <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--primary);">查看参考答题骨架（提示）</summary>
            <ul style="margin:8px 0 0;padding-left:18px;font-size:13px;color:var(--text-secondary);">
              ${(question.skeleton || []).map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
            </ul>
          </details>
        </section>

        <section>
          <h3 style="margin:0 0 8px;font-size:14px;color:var(--text-secondary);">锚定知乎多元观点卡（评分基准）</h3>
          <div id="coach-vp-list" style="display:flex;flex-direction:column;gap:10px;"></div>
        </section>
        </div>
      </div>

      <!-- 右侧：按模式切换「练习区」与「录音复盘区」 -->
      <div style="display:flex;flex-direction:column;gap:14px;">
        <!-- 练习区：真题陪练 / 简历陪练 -->
        <div id="practice-area" style="display:flex;flex-direction:column;gap:14px;">
          <section class="card">
            <div id="current-question-strip" style="font-size:12.5px;color:var(--text-secondary);background:var(--surface-alt);border-radius:8px;padding:8px 10px;margin-bottom:8px;">
              ${question.source === 'resume' ? '当前题目' : '当前题目（真题）'}：${escapeHtml(question.title)}
              ${question.source === 'resume' ? `<div style="color:var(--text-muted);margin-top:2px;">简历题 · 定位 ${escapeHtml(question.locator || '')}${question.zhihuRef ? ' · 面经参考挂在左栏' : ''}</div>` : ''}
            </div>

          <label for="answer-textarea" style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;">
            作答文本 / 导入会议转写稿（支持「面试官：/ 我：」标签切分）：
          </label>
          <textarea id="answer-textarea" class="textarea" rows="7" placeholder="可直接在此输入回答，或点击上方「开始录音」自动落字幕，或粘贴带「面试官：/ 我：」的复盘转写稿…"></textarea>

          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap;gap:8px;">
            <button id="btn-trigger-followup" class="btn btn-sm" type="button">触发追问（压力测试）</button>
            <button id="btn-submit-parse" class="btn btn-primary" type="button">结束并生成复盘诊断 →</button>
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

  const resumeStatus = wrapper.querySelector('#resume-status');
  const resumeProfile = wrapper.querySelector('#resume-profile');
  const resumeQuestions = wrapper.querySelector('#resume-questions');

  const vpBox = wrapper.querySelector('#coach-vp-list');
  if ((question.viewpointCards || []).length) {
    (question.viewpointCards || []).forEach((vc, idx) => vpBox.appendChild(renderViewpointCard(vc, idx)));
  } else if (question.source === 'resume') {
    vpBox.innerHTML = `<div class="card" style="font-size:12.5px;color:var(--text-muted);">
      简历题不依赖知乎观点卡：本次只跑「规则层 10 条原话诊断」+ 面经参考，不做观点契合度评分（避免拿无关观点硬套）。
      ${question.zhihuRef ? `参考面经：<a href="${escapeHtml(question.zhihuRef.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(question.zhihuRef.title)}</a>` : ''}
    </div>`;
  }

  const textarea = wrapper.querySelector('#answer-textarea');
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
    } catch (err) {
      deviceHint.textContent = '设备枚举失败：' + err.message;
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
  wrapper.querySelector('#btn-captions-to-text').addEventListener('click', () => {
    if (!captions.length) {
      showToast('还没有字幕：先录音，或直接粘贴会议转写稿', 'warn');
      return;
    }
    const recordBox = wrapper.querySelector('#record-transcript');
    if (recordBox) recordBox.value = captionsToTranscript(captions);
    const unknown = captions.filter((c) => !c.speaker || c.speaker === 'unknown').length;
    showToast(
      unknown
        ? `已整理 ${captions.length} 句，其中 ${unknown} 句未标注说话人（点徽标可改）`
        : `已整理 ${captions.length} 句，说话人标签完整`
    );
  });

  // ---- 简历模式：解析简历 → 抽取档案 → 出题 ----
  const renderResumeResult = (data) => {
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
      const warn = document.createElement('div');
      warn.style.cssText = 'font-size:12px;color:var(--amber);margin-top:8px;';
      warn.textContent = '⚠ ' + (data.degradedReason || '模型不可用：已降级为通用追问框架');
      resumeProfile.appendChild(warn);
    }

    renderResumeQuestionList(data);
  };

  /**
   * 题目列表：每题带 bullets（可勾选）+ 练习状态；练过的题仍然保留在列表里。
   * 勾选与"已练"标记都会写回 IndexedDB，刷新/换会话不丢。
   */
  const renderResumeQuestionList = (record) => {
    const deriveBullets = (why) => {
      const parts = String(why || '')
        .split(/[；;]|，(?=.{6,})/)
        .map((x) => x.trim())
        .filter((x) => x.length >= 6)
        .slice(0, 3);
      return parts.length ? parts : ['给出一个可核对的数字与口径', '讲清你的判断与取舍', '落到结果与边界条件'];
    };
    const questions = (record?.questions || []).map((q) => ({
      ...q,
      bullets: q.bullets?.length ? q.bullets : deriveBullets(q.why),
      coveredBullets: q.coveredBullets || [],
      practiced: Boolean(q.practiced),
    }));
    const practiced = questions.filter((q) => q.practiced).length;

    resumeQuestions.style.display = 'flex';
    resumeQuestions.innerHTML = '';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);';
    head.innerHTML = `<span>共 ${questions.length} 道题 · 已练 ${practiced} 道${record?.filename ? ' · ' + escapeHtml(record.filename) : ''}</span>`;
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn btn-ghost btn-sm';
    again.textContent = '重新出题';
    again.addEventListener('click', () => wrapper.querySelector('#btn-resume-refresh').click());

    const wizardBtn = document.createElement('button');
    wizardBtn.type = 'button';
    wizardBtn.className = 'btn btn-primary btn-sm';
    wizardBtn.textContent = '选择要点 → 出题';
    wizardBtn.addEventListener('click', () => openBulletWizard(record));

    head.append(wizardBtn, again);
    resumeQuestions.appendChild(head);

    questions.forEach((q, idx) => {
      const item = document.createElement('div');
      item.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;font-size:13px;';

      const tags = document.createElement('div');
      tags.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;';
      const focusTag = document.createElement('span');
      focusTag.className = 'tag tag-blue';
      focusTag.textContent = q.focus || '追问';
      const diffTag = document.createElement('span');
      diffTag.className = 'tag';
      diffTag.textContent = q.difficulty || '进阶';
      const locTag = document.createElement('span');
      locTag.style.cssText = 'font-size:11px;color:var(--text-muted);';
      locTag.textContent = '定位：' + (q.locator || '');
      tags.append(focusTag, diffTag, locTag);
      if (q.practiced) {
        const done = document.createElement('span');
        done.className = 'tag tag-green';
        done.textContent = '已练';
        tags.appendChild(done);
      }

      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600;margin-bottom:4px;';
      title.textContent = `Q${idx + 1}. ${q.q}`;

      const why = document.createElement('div');
      why.style.cssText = 'font-size:12px;color:var(--amber);margin-bottom:6px;';
      why.textContent = '为什么问：' + (q.why || '');

      item.append(tags, title, why);

      // bullets：可勾选的覆盖点
      if (q.bullets.length) {
        const bl = document.createElement('div');
        bl.style.cssText = 'margin:4px 0 8px;';
        q.bullets.forEach((b, bi) => {
          const row = document.createElement('label');
          row.style.cssText = 'display:flex;gap:6px;align-items:flex-start;font-size:12.5px;cursor:pointer;margin-bottom:2px;';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = q.coveredBullets.includes(b);
          cb.style.cssText = 'margin-top:3px;';
          cb.addEventListener('change', async () => {
            const next = cb.checked
              ? [...new Set([...q.coveredBullets, b])]
              : q.coveredBullets.filter((x) => x !== b);
            await updateResumeQuestionState(q.id, { coveredBullets: next });
            showToast(cb.checked ? '已勾选覆盖点' : '已取消勾选');
          });
          const txt = document.createElement('span');
          txt.textContent = b;
          row.append(cb, txt);
          bl.appendChild(row);
        });
        item.appendChild(bl);
      }

      const foot = document.createElement('div');
      foot.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;';
      if (q.zhihuRef || (q.sources || []).length) {
        const ref = document.createElement('div');
        ref.style.cssText = 'font-size:12px;color:var(--text-secondary);';
        const first = q.zhihuRef || q.sources[0];
        ref.innerHTML = `真实面经：<a href="${escapeHtml(first.url || '')}" target="_blank" rel="noopener noreferrer">${escapeHtml(first.title || '查看')}</a>`;
        foot.appendChild(ref);
      } else {
        foot.appendChild(document.createElement('span'));
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = q.practiced ? '再练这题 →' : '练这题 →';
      btn.addEventListener('click', async () => {
        await updateResumeQuestionState(q.id, { practiced: true });
        state.activeQuestion = {
          id: q.id,
          title: q.q,
          context: q.why,
          keywords: (record?.profile?.skills || []).slice(0, 6),
          expectedLength: [150, 400],
          skeleton: q.bullets?.length ? q.bullets : ['先复述问题', '给一个可核对数字', '讲清你的判断与取舍', '落到结果与边界'],
          viewpointCards: q.viewpointCards || [],
          sources: q.sources || [],
          source: 'resume',
          locator: q.locator,
          zhihuRef: q.zhihuRef || null,
        };
        showToast('已切到这道简历题，往下写你的回答');
        root.innerHTML = '';
        renderCoachScreen(root);
      });
      foot.appendChild(btn);
      item.appendChild(foot);

      resumeQuestions.appendChild(item);
    });
  };

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
          openCandidateModal(record, data.candidates || []);
        } catch (err) {
          nextBtn.disabled = false;
          nextBtn.textContent = '生成候选题目 →';
          showToast(err.message, 'error', 6000);
        }
      },
    });
    modal.footer.append(cancelBtn, nextBtn);
  };

  /** 第二步：候选题目滑窗 */
  const openCandidateModal = (record, candidates) => {
    const modal = createModal({
      title: '② 选一道题去练',
      subtitle: candidates.length ? '这些题来自你勾选的要点，选哪道就练哪道' : '没有候选题',
      width: 780,
    });
    const { cards, sources } = collectRefs(record);

    if (!candidates.length) {
      modal.body.append(el('p', 'hint', '这次没生成候选题：可以在下面的题目列表里直接挑一道练。'));
    }

    candidates.forEach((c) => {
      const item = document.createElement('div');
      item.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;';
      item.innerHTML = `
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;">
          <span class="tag tag-blue">${escapeHtml(c.focus || '追问')}</span>
          <span class="tag">${escapeHtml(c.difficulty || '进阶')}</span>
          <span style="font-size:11px;color:var(--text-muted);">来自要点：${escapeHtml((c.bullet || '').slice(0, 28))}</span>
        </div>
        <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${escapeHtml(c.q)}</div>
        <div style="font-size:12px;color:var(--amber);">为什么问：${escapeHtml(c.why || '')}</div>
      `;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary btn-sm';
      btn.style.marginTop = '8px';
      btn.textContent = '练这道 →';
      btn.addEventListener('click', () => {
        modal.close();
        state.activeQuestion = {
          id: c.id,
          title: c.q,
          context: c.why || '',
          keywords: (record?.profile?.skills || []).slice(0, 6),
          expectedLength: [150, 400],
          skeleton: [c.bullet, '给一个可核对的数字与口径', '讲清你的判断与取舍', '落到结果与边界'].filter(Boolean),
          viewpointCards: cards,
          sources,
          source: 'resume',
          locator: '',
        };
        showToast('已切到这道题，往下写你的回答');
        root.innerHTML = '';
        renderCoachScreen(root);
      });
      item.appendChild(btn);
      modal.body.appendChild(item);
    });

    const closeBtn = modalButton('关闭', { ghost: true, onClick: () => modal.close() });
    modal.footer.appendChild(closeBtn);
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
        resumeStatus.textContent = `解析完成（${engine}，质量 ${data.quality?.score ?? '?'}），正在按简历出题…`;
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
      const saved = await saveResumeAnalysis(data2);
      if (saved && saved.persisted === false) {
        resumeStatus.textContent =
          '题目已生成，但本地库被旧标签页占用，只保存在本次会话：关闭旧标签页或点顶部「重置」后重新上传即可长期保存';
      }
      resumeStatus.textContent = data2.cached
        ? `命中缓存：${data2.questions.length} 道题（本次未调用模型）`
        : `已生成 ${data2.questions.length} 道题（${engine} 解析 · 接地丢弃 ${data2.droppedByGrounding}）`;
      renderResumeResult(saved || data2);
      showToast('简历解析完成：题目已保存到本机，随时回来练（不用重复上传）');
      openBulletWizard(saved || data2);
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
    showToast('正在本机转写（faster-whisper，录音越长越慢）…');
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
      showToast(`转写完成：${segments.length} 段 / ${data.duration?.toFixed?.(0) || '?'} 秒（引擎 ${data.engine}）`);
    } catch (err) {
      showToast(err.message + '（可用云端 ASR 或导出后跑 node scripts/asr/local-transcribe.mjs）', 'error', 7000);
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
      degradedReason: '录音复盘未绑定题目来源：只跑规则层诊断',
      createdAt: new Date().toISOString(),
    };
    state.lastReviewReport = report;
    await dbPut('sessions', report);
    navigate('/review');
    showToast(`已生成录音复盘报告：${qaPairs.length} 组问答，命中 ${ruleFindings.length} 条诊断`);
  });

  wrapper.querySelector('#btn-import-from-record').addEventListener('click', () => {
    const text = (recordTranscript.value || '').trim();
    if (!text) {
      showToast('「录音复盘」里还没有转写稿', 'warn');
      return;
    }
    textarea.value = text;
    showToast('已把转写稿带入作答框');
  });

  // ---- 冷启动恢复：不用每次都重新上传简历 ----
  (async () => {
    const restored = await restoreLatestResumeAnalysis();
    if (restored && (restored.questions || []).length) {
      resumeStatus.textContent = `已恢复上次的简历解析（${restored.filename || '简历'}，${restored.questions.length} 道题）`;
      renderResumeQuestionList(restored);
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
      asrHint.textContent = '检查 ASR 服务…';
      try {
        const status = await fetch('/api/asr/status').then((r) => r.json());
        if (!status.available) {
          asrHint.innerHTML = `⚠ 云端 ASR 未配置。两条本地路线：<br/>① 点「导出两条音轨」→ 终端运行 <code>node scripts/asr/local-transcribe.mjs mic.webm system.webm</code>（本机 faster-whisper）→ 把 transcript.txt 粘到下面作答框；<br/>② 导入飞书妙记 / 腾讯会议 AI 笔记的转写稿。`;
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
        asrHint.textContent = `✅ 已合并 ${merged.length} 句（我 ${merged.filter((r) => r.speaker === 'me').length} / 面试官 ${merged.filter((r) => r.speaker === 'interviewer').length}），可直接点「结束并生成复盘诊断」。`;
      } catch (err) {
        asrHint.textContent = '⚠ 转写失败：' + err.message + '（可导出音轨用本地脚本）';
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

  // 填入样例
  wrapper.querySelector('#btn-fill-sample').addEventListener('click', () => {
    if (state.demoSample?.rawText) {
      textarea.value = state.demoSample.rawText;
      showToast('已填入带说话人标签的样例转写稿');
    }
  });

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
        isRecording = true;
        recordBtn.textContent = '⏹ 停止录音';
        recordBtn.className = 'btn btn-danger btn-sm';
        captionStatusEl.textContent = '● 正在本地录音（Opus 编码），实时字幕识别中…';

        captionEngine = new LiveCaptionEngine({
          onSentence: (sent) => {
            captions.push(sent);
            renderCaptions();
          },
          onInterim: (txt) => renderCaptions(txt),
          onError: (msg) => {
            captionStatusEl.textContent = '⚠ ' + msg;
            showToast(msg, 'warn', 4500);
          }
        });
        captionEngine.start();
      } catch (err) {
        showToast('无法访问麦克风：' + err.message + '（可直接下方输入或导入转写稿）', 'warn', 4500);
      }
    } else {
      isRecording = false;
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
        captionStatusEl.textContent = `✅ 录音完成（${result.durationSec} 秒，${result.systemBlob ? '双轨' : '单轨'}），只存在本机 IndexedDB，未产生任何上传请求。`;
      }
    }
  });

  // 追问生成（M8：单题最多 3 轮，取自观点卡分歧）
  wrapper.querySelector('#btn-trigger-followup').addEventListener('click', () => {
    if (followupRound >= 3) {
      showToast('已达到单题最大追问轮次（3 轮），请结束并查看诊断报告', 'warn');
      return;
    }
    followupRound++;
    const minorityCard = question.viewpointCards?.[1] || question.viewpointCards?.[0];
    activeFollowupFocus = (question.keywords || []).slice(0, 2).join(' ');
    const fqText = minorityCard
      ? `知乎上有答主提出质疑：“${minorityCard.evidenceQuote}”——针对这一点，你的具体边界条件和取舍依据是什么？`
      : '如果线上数据分布发生漂移，你的这套指标如何保证不失真？';

    wrapper.querySelector('#followup-box').hidden = false;
    wrapper.querySelector('#followup-round-num').textContent = String(followupRound);
    wrapper.querySelector('#followup-question-text').textContent = fqText;
    showToast(`已生成第 ${followupRound} 轮深度追问`);
  });

  // 提交解析（M4 + M5 + M6 降级双轨）
  wrapper.querySelector('#btn-submit-parse').addEventListener('click', async (ev) => {
    const raw = textarea.value.trim();
    if (!raw) {
      showToast('请先录音、输入回答或导入样例转写稿', 'warn');
      return;
    }
    const submitBtn = ev.currentTarget;
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = '模型生成中（最多 25 秒）…';

    const qaPairs = parseTranscriptToQA(raw, question.title);
    const targetAnswer = qaPairs.map((p) => p.answer).join('\n\n');
    const ruleFindings = runDeterministicRules(targetAnswer, {
      ...question,
      followupFocus: activeFollowupFocus
    });

    let llmResult = null;
    let degraded = false;

    // 简历题且没有面经来源（模型降级时会出现）→ 不请求观点层，直接规则层
    if (question.source === 'resume' && !(question.viewpointCards || []).length) {
      degraded = true;
      const reportResume = {
        id: 'session-' + Date.now(),
        question,
        answer: targetAnswer,
        ruleFindings,
        llmScores: null,
        improvements: null,
        degraded,
        degradedReason: '本题没有可核对的面经来源：只跑规则层',
        createdAt: new Date().toISOString(),
      };
      state.activeQuestion = question;
      state.lastReviewReport = reportResume;
      await dbPut('sessions', reportResume);
      navigate('/review');
      showToast(`已生成复盘：命中 ${ruleFindings.length} 条原话级诊断（无面经来源，未跑观点层）`);
      return;
    }

    try {
      const ctrl = new AbortController();
      // 实测：DeepSeek 结构化输出 10–16s，8s 超时会把成功请求 abort 掉（曾导致误降级）
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch('/api/coach/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(question.source === 'resume'
            ? {
                question: question.title,
                sources: (question.viewpointCards || []).map((c) => ({
                  summary: c.summary,
                  snippet: c.evidenceQuote,
                  evidenceQuote: c.evidenceQuote,
                  sourceUrl: c.sourceUrl,
                  author: c.author,
                })),
              }
            : { questionId: question.id }),
          answer: targetAnswer,
          transcript: raw,
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        llmResult = await res.json();
        degraded = !!llmResult.degraded;
      } else {
        degraded = true;
      }
    } catch (_) {
      degraded = true;
    }

    const report = {
      id: 'session-' + Date.now(),
      question,
      qaPairs,
      answer: targetAnswer,
      ruleFindings,
      llmScores: llmResult?.llmScores || null,
      improvements: llmResult?.improvements || null,
      degraded,
      createdAt: new Date().toISOString()
    };

    state.lastReviewReport = report;
    await dbPut('sessions', report);
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;

    if (degraded) {
      showToast('模型暂不可用，已切换规则模式并完成原话级诊断', 'warn', 3800);
    } else {
      showToast('复盘解析完成');
    }
    navigate('/review');
  });
}
