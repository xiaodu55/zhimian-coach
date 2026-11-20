#!/usr/bin/env node
/**
 * 演示录屏脚本：自动走一遍「题库 → 拆逻辑 → 模拟练（含连环追问）→ 复盘台 → 弹药库 → 答辩预测」主链路并录屏。
 *
 * 为什么要有这个脚本：
 * 1) 黑客松现场手抖、卡顿、超时是常态；录屏必须**可复现**——同一个脚本每次跑出来的画面完全一致。
 * 2) 第 ⑤ 步（生成复盘）要等模型，10–60 秒不定；脚本用轮询 URL 判断而不是固定 sleep，
 *    快就快、慢就慢，不会出现"录到一半还在转圈"的尴尬画面。
 * 3) 页面文案随时会改：任何一步找不到元素都只打印警告并跳过，绝不让整段录制崩掉。
 *
 * 用法：
 *   node scripts/demo/record-demo.mjs                # 无头录制，产物在 out/
 *   node scripts/demo/record-demo.mjs --dry          # 只打印分镜步骤，不启动浏览器
 *   node scripts/demo/record-demo.mjs --headed       # 有头模式（想自己盯一眼时用）
 *   node scripts/demo/record-demo.mjs --base http://127.0.0.1:8787 --out out/
 *
 * 依赖：playwright-core（浏览器用本机已装的 chromium，见 findChromium）+ 系统 ffmpeg（可选，用于转 mp4）。
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ARGS = process.argv.slice(2);
const argOf = (n, d) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] && !ARGS[i + 1].startsWith('--') ? ARGS[i + 1] : d;
};
const BASE = argOf('base', 'http://127.0.0.1:8787').replace(/\/+$/, '');
const OUT_DIR = path.resolve(argOf('out', 'out'));
const DRY = ARGS.includes('--dry');
const HEADED = ARGS.includes('--headed');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

/** 找本机已安装的 chromium（playwright 缓存目录），与 scripts/test/smoke.mjs 保持同一套找法 */
function findChromium() {
  const explicit = argOf('browser-path', '');
  if (explicit && fs.existsSync(explicit)) return explicit;
  const base = path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || '', '.cache'), 'ms-playwright');
  if (!fs.existsSync(base)) return undefined;
  const dirs = fs
    .readdirSync(base)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const d of dirs) {
    for (const rel of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(base, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 录制节奏：每个动作之间的停顿就是观众的阅读时间，太短看不清、太长像卡住
 * ------------------------------------------------------------------ */
const PACE = { tiny: 350, short: 700, mid: 1200, long: 2000, dwell: 3000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 容错封装：任何一步失败只警告不中断，保证后半段（复盘/弹药库/答辩）也能录到
 * ------------------------------------------------------------------ */
let stepIndex = 0;
let warnCount = 0;

function warn(msg) {
  warnCount += 1;
  console.log(`  ⚠️  [跳过] ${msg}`);
}

/** 尝试点击：元素不存在/不可见/被遮挡都只警告 */
async function tryClick(page, selector, label, { timeout = 4000, optional = true } = {}) {
  const loc = page.locator(selector).first();
  try {
    await loc.waitFor({ state: 'visible', timeout });
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await loc.click({ timeout });
    console.log(`  · ${label}`);
    return true;
  } catch (err) {
    if (!optional) throw err;
    warn(`${label}：${err.message.split('\n')[0]}`);
    return false;
  }
}

/** 等按钮从 disabled 变为可点（材料未就绪的按钮要点会一直等到超时） */
async function waitEnabled(page, selector, timeout = 12000) {
  try {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return Boolean(el && !el.disabled);
      },
      selector,
      { timeout, polling: 300 }
    );
    return true;
  } catch {
    warn(`${selector} 一直处于禁用状态`);
    return false;
  }
}

/** 等待某个选择器出现（不存在就返回 false，不抛） */
async function waitFor(page, selector, timeout = 8000) {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** 把元素滚到画面中间并停留：录制里"滚一下"要让人看清是哪里 */
async function focusOn(page, selector, label, hold = PACE.mid) {
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: 6000 });
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
    await sleep(hold);
    console.log(`  · ${label}`);
    return true;
  } catch (err) {
    warn(`${label}：${err.message.split('\n')[0]}`);
    return false;
  }
}

/**
 * 关掉当前可能存在的弹窗（脚本跑久了页面里可能残留遮罩）。
 * 注意：index.html 里那个 #citation-modal 是全局复用的引用弹窗，
 * 删掉它后面所有「点 chip 看原文」都会失效 —— 所以只隐藏，不移除。
 */
async function clearModals(page) {
  await page
    .evaluate(() => {
      document.querySelectorAll('.modal-backdrop:not(#citation-modal)').forEach((m) => m.remove());
      const cm = document.getElementById('citation-modal');
      if (cm) cm.setAttribute('hidden', '');
    })
    .catch(() => {});
}

/* ------------------------------------------------------------------ *
 * 分镜定义：dry 模式直接打印这份清单，录制模式按同一份清单执行
 * ------------------------------------------------------------------ */
const STEPS = [
  {
    id: '01',
    title: '题库首屏（#\/bank）',
    wait: '等 .hero-title 出现后停留 3 秒',
    detail: '让评委看清标题「别让“看懂了”变成面试时的“说不清”」与信任标签',
    async run(page) {
      await page.goto(`${BASE}/#/bank`, { waitUntil: 'domcontentloaded' });
      await waitFor(page, '.hero-title', 15000);
      await sleep(PACE.dwell);
    },
  },
  {
    id: '02',
    title: '方向筛选 + 知乎观点摘要（只 hover 不点走）',
    wait: '等 #bank-list .card 渲染完，chip 点击后等列表变化',
    detail: '证明题库是真语料驱动：每张卡都挂着知乎原答摘要',
    async run(page) {
      await waitFor(page, '#bank-list .card', 15000);
      const chips = page.locator('#track-filters button');
      const n = await chips.count();
      for (let i = 0; i < n; i++) {
        const btn = chips.nth(i);
        const label = (await btn.innerText().catch(() => '')).trim();
        if (label.startsWith('全部')) continue;
        if (await btn.isDisabled().catch(() => true)) continue;
        await btn.click({ timeout: 4000 }).catch((e) => warn(`方向 chip 点击失败：${e.message.split('\n')[0]}`));
        console.log(`  · 点方向「${label}」`);
        break;
      }
      await sleep(PACE.long);
      // hover 观点摘要链接：只高亮不点走（点走会把录屏带到站外，视频就断了）
      const quote = page.locator('#bank-list .card-quote').first();
      if (await quote.count()) {
        await quote.scrollIntoViewIfNeeded().catch(() => {});
        await quote.hover({ timeout: 4000 }).catch(() => {});
        console.log('  · hover「知乎观点摘要」链接');
        await sleep(PACE.long);
      } else {
        warn('没有找到「知乎观点摘要」链接（该题可能还没有观点卡）');
      }
    },
  },
  {
    id: '03',
    title: '拆逻辑弹窗 → 进入模拟练',
    wait: '等 .modal-backdrop:not([hidden]) 出现，等按钮「我准备好了，开始作答」',
    detail: '先看 3 个核心得分点再开口，避免对着空白卡壳',
    async run(page) {
      const btn = page.locator('#bank-list .btn-start-coach').first();
      if (!(await btn.count())) {
        warn('题库里没有「先拆逻辑，再开口」按钮');
        return;
      }
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 6000 }).catch((e) => warn(`打开拆逻辑弹窗失败：${e.message.split('\n')[0]}`));
      await waitFor(page, '.modal-backdrop:not([hidden]) .modal-body', 8000);
      await sleep(PACE.long);
      const go = page.locator('.modal-backdrop:not([hidden]) .modal-footer button', { hasText: '我准备好了' }).first();
      if (await go.count()) {
        await go.click({ timeout: 6000 }).catch((e) => warn(`点击「我准备好了」失败：${e.message.split('\n')[0]}`));
        console.log('  · 点「我准备好了，开始作答」');
      } else {
        warn('弹窗里没有「我准备好了，开始作答」按钮');
      }
      await page.waitForURL(/#\/coach/, { timeout: 15000 }).catch(() => warn('没有跳到 #/coach'));
      await sleep(PACE.long);
    },
  },
  {
    id: '04',
    title: '模拟练（#\/coach）：填示例回答 → 字数计数 → 陪练设置',
    wait: '等 #answer-textarea，等 #answer-char-count 出现数字',
    detail: '展示门禁（先答题才解锁）与追问深度/人设可调',
    async run(page) {
      await page.waitForURL(/#\/coach/, { timeout: 15000 }).catch(() => {});
      await waitFor(page, '#answer-textarea', 20000);
      await sleep(PACE.short);
      await tryClick(page, '#btn-fill-sample', '点「试一试：填入一段示例回答」');
      await sleep(PACE.long);
      try {
        const counter = await page.locator('#answer-char-count').innerText({ timeout: 3000 });
        console.log(`  · 字数计数：${counter.trim()}`);
      } catch {
        warn('没有读到字数计数');
      }
      await tryClick(page, '#btn-coach-settings', '打开「⚙️ 陪练设置」');
      await waitFor(page, '#coach-settings-menu', 4000);
      await sleep(PACE.long);
      const depth = await page.locator('#sel-followup-depth').inputValue().catch(() => '');
      const style = await page.locator('#sel-interviewer-style').inputValue().catch(() => '');
      console.log(`  · 当前设置：追问深度=${depth} 面试官人设=${style}`);
      await tryClick(page, '#btn-coach-settings', '收起「⚙️ 陪练设置」');
      await sleep(PACE.short);
    },
  },
  {
    id: '05',
    title: '提交复盘 → 连环追问 → #\/review',
    wait: '轮询 URL 等待 #/review，最长 180 秒；中途出现追问框就再答一轮',
    detail: '这是与普通题库网站最大的区别：不是出题，是**连环追问**',
    async run(page) {
      const deadline = Date.now() + 180000;
      let round = 0;
      let reached = false;
      while (Date.now() < deadline) {
        const onReview = await page.evaluate(() => location.hash.includes('/review'));
        if (onReview) {
          reached = true;
          break;
        }
        // 按钮三种状态：忙碌（模型生成中）/ 可提交 / 门禁置灰（作答框空了）
        const state = await page
          .evaluate(() => {
            const b = document.querySelector('#btn-submit-parse');
            const t = document.querySelector('#answer-textarea');
            if (!b) return 'missing';
            // 先看忙碌标记：模型生成期间按钮是禁用的，但作答框里还留着上一轮文字，
            // 若按文字在不在判断，会被误当成可以提交，从而在生成中途又点一次提交。
            if (b.dataset.busy === '1') return 'busy';
            if (b.disabled) return t && t.value.trim() ? 'busy' : 'empty';
            return 'ready';
          })
          .catch(() => 'missing');
        if (state === 'busy') {
          await sleep(2000);
          continue;
        }
        if (state === 'empty') {
          // 上一轮被追问清空了作答框：补一段示例回答再提交
          await tryClick(page, '#btn-fill-sample', '补填示例回答（上一轮已被追问清空）');
          await sleep(PACE.short);
        } else if (state === 'missing') {
          warn('页面上找不到提交按钮（可能已经跳走了）');
          await sleep(1500);
          continue;
        }
        const clicked = await page
          .locator('#btn-submit-parse')
          .first()
          .click({ timeout: 8000 })
          .then(() => true)
          .catch((e) => {
            warn(`点提交失败：${e.message.split('\n')[0]}`);
            return false;
          });
        if (!clicked) continue;
        console.log(`  · 已提交（第 ${round + 1} 轮），等待模型…`);
        // 等「跳到复盘」或「评委又追问」二者之一，谁先来算谁
        const remain = Math.max(5000, deadline - Date.now());
        const outcome = await page
          .waitForFunction(
            () => {
              if (location.hash.includes('/review')) return 'review';
              const box = document.querySelector('#followup-box');
              if (box && !box.hasAttribute('hidden')) return 'followup';
              return false;
            },
            null,
            { timeout: Math.min(90000, remain), polling: 500 }
          )
          .then((h) => h.jsonValue())
          .catch(() => null);
        if (outcome === 'review') {
          reached = true;
          break;
        }
        if (outcome === 'followup') {
          round += 1;
          const text = await page.locator('#followup-question-text').innerText().catch(() => '');
          console.log(`  · 🔥 评委追问第 ${round} 轮：${text.trim().slice(0, 60)}…`);
          await sleep(PACE.long);
          continue;
        }
        warn('等待复盘超时，继续再等一轮');
      }
      if (reached) console.log('  · 已到达 #/review');
      else warn('180 秒内没有到达 #/review（模型可能不可用），后续复盘画面可能是空状态');
      await sleep(PACE.long);
    },
  },
  {
    id: '06',
    title: '复盘台（#\/review）：三方对照 → 维度分 → 原话级诊断 → 再练一次',
    wait: '等 #findings-list / .dimension-score-wrap 出现',
    detail: '每条诊断都回指你的原话与字符区间，不是空泛评价',
    async run(page) {
      await page.waitForURL(/#\/review/, { timeout: 20000 }).catch(() => warn('当前不在 #/review'));
      await sleep(PACE.long);
      await focusOn(page, '#user-answer-highlighted', '三方对照：你的回答原话 ⇄ 主流观点 ⇄ 少数派观点', PACE.long);
      await focusOn(page, '.dimension-score-wrap', '维度分（四维观点评分）', PACE.long);
      await focusOn(page, '#findings-list', '原话级诊断清单', PACE.long);
      await focusOn(page, '#btn-retry-compare', '「📈 再练一次并对比上次」', PACE.long);
    },
  },
  {
    id: '07',
    title: '弹药库（#\/ledger）：数据安全 → 闪卡抽背 → 快问快答',
    wait: '等 #storage-usage；闪卡区可能为空（没做过复盘就没有卡）',
    detail: '数据全在本机 IndexedDB，一键导出/清空可自证',
    async run(page) {
      await page.goto(`${BASE}/#/ledger`, { waitUntil: 'domcontentloaded' });
      await waitFor(page, '#storage-usage', 15000);
      await sleep(PACE.long);
      await focusOn(page, '#storage-usage', '数据安全工具条：本机占用统计', PACE.long);
      // 抽背模式是开关：已经开着就不要再点一次（否则等于把它关掉）
      const reciteLabel = await page.locator('#btn-recite-toggle').innerText().catch(() => '');
      if (!reciteLabel.includes('已开启')) {
        await tryClick(page, '#btn-recite-toggle', '开「🎴 抽背模式」');
      } else {
        console.log('  · 抽背模式已开启，跳过切换');
      }
      await sleep(PACE.long);
      const card = page.locator('#flashcard-grid .card').first();
      if (await card.count()) {
        const hint = card.locator('text=答案已遮住').first();
        if (await hint.count()) {
          await hint.click({ timeout: 4000 }).catch(() => {});
          console.log('  · 点卡片翻面看标准答案');
        }
        await sleep(PACE.long);
      } else {
        warn('弹药库里还没有闪卡（需要先完成一次复盘并入库）');
      }
      await tryClick(page, '#btn-quick-quiz', '点「🎯 快问快答」');
      await sleep(PACE.short);
      await tryClick(page, '.modal-backdrop:not([hidden]) .modal-footer button:has-text("我讲完了")', '翻面对照：展开标准答案');
      await waitFor(page, '.modal-backdrop:not([hidden]) #quiz-answer', 6000);
      await sleep(PACE.long);
      await page.keyboard.press('Escape').catch(() => {});
      await clearModals(page);
      await sleep(PACE.short);
    },
  },
  {
    id: '08',
    title: '答辩预测（#\/defense）：示例材料 → 评委追问 → 预演小窗',
    wait: '等 #defense-context-guard 的示例材料入口，等追问列表出现',
    detail: '论文/讲稿切片段，追问必须落在片段上，不许编',
    async run(page) {
      await page.goto(`${BASE}/#/defense`, { waitUntil: 'domcontentloaded' });
      await sleep(2000);
      const demo = page.locator('button:has-text("示例材料")').first();
      if (await demo.count()) {
        await demo.click({ timeout: 5000 }).catch((e) => warn(`载入示例材料失败：${e.message.split('\n')[0]}`));
        console.log('  · 载入示例材料');
        await sleep(PACE.long);
      } else {
        warn('没有找到示例材料入口');
      }
      await waitEnabled(page, '#btn-gen-defense', 15000);
      await tryClick(page, '#btn-gen-defense', '点「🎓 开始预演（生成评委追问）」', { timeout: 6000 });
      const hasQuestions = await page
        .waitForFunction(
          () => {
            const list = document.querySelector('#defense-questions-list');
            return Boolean(list && list.textContent.includes('预演这一题'));
          },
          null,
          { timeout: 60000, polling: 500 }
        )
        .then(() => true)
        .catch(() => false);
      if (!hasQuestions) {
        warn('60 秒内没有生成评委追问（模型可能不可用），跳过预演小窗');
        return;
      }
      console.log('  · 已生成评委追问列表');
      await sleep(PACE.long);
      await focusOn(page, '#defense-questions-list', '评委追问 + 知乎类似质疑', PACE.long);
      const rehearse = page.locator('button:has-text("预演这一题")').first();
      if (await rehearse.count()) {
        await rehearse.click({ timeout: 5000 }).catch(() => {});
        console.log('  · 打开「预演这一题（连续追问）」小窗');
        await sleep(PACE.long);
        await page.keyboard.press('Escape').catch(() => {});
        await clearModals(page);
      } else {
        warn('没有找到「预演这一题」按钮');
      }
    },
  },
];

/* ------------------------------------------------------------------ *
 * dry 模式：只打印分镜，不启动浏览器
 * ------------------------------------------------------------------ */
if (DRY) {
  console.log(`\n[演示录屏 · DRY 模式] 不启动浏览器，只打印分镜。`);
  console.log(`目标地址：${BASE}`);
  console.log(`产物目录：${OUT_DIR}`);
  console.log(`浏览器模式：${HEADED ? 'headed（有头）' : 'headless（无头）'}\n`);
  console.log('———————————————————————————————————————————————');
  for (const s of STEPS) {
    console.log(`${s.id}｜${s.title}`);
    console.log(`    等待条件：${s.wait}`);
    console.log(`    画面目的：${s.detail}`);
    console.log('');
  }
  console.log('———————————————————————————————————————————————');
  console.log(`共 ${STEPS.length} 步。去掉 --dry 即开始真实录制。\n`);
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 真实录制
 * ------------------------------------------------------------------ */
const execPath = findChromium();
if (!execPath) {
  console.error('找不到 chromium，可用 --browser-path <路径> 指定');
  process.exit(2);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const rawName = `demo-${stamp}`;

console.log(`\n[演示录屏] 目标 ${BASE}`);
console.log(`[演示录屏] 浏览器 ${execPath}`);
console.log(`[演示录屏] 产物目录 ${OUT_DIR}\n`);

const browser = await chromium.launch({ headless: !HEADED, executablePath: execPath });
// 录像分辨率与视口一致：浏览器缩放视频时画面不会被拉伸变形
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } },
});
const page = await ctx.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message));

const t0 = Date.now();
for (const s of STEPS) {
  stepIndex += 1;
  console.log(`\n—— ${s.id}/${STEPS.length} ${s.title} ————————————————`);
  const st = Date.now();
  try {
    await s.run(page);
  } catch (err) {
    warn(`${s.title} 整体失败：${err.message.split('\n')[0]}`);
  }
  console.log(`  （用时 ${((Date.now() - st) / 1000).toFixed(1)}s）`);
}

// 留一段 1.5 秒的收尾静帧：让视频结尾不是"戛然而止"
await sleep(1500);

const video = page.video();
await ctx.close(); // 关闭 context 后视频文件才会落盘写完
await browser.close();

const rawPath = video ? await video.path() : undefined;
let webmPath = rawPath;
if (rawPath) {
  const target = path.join(OUT_DIR, `${rawName}.webm`);
  try {
    fs.renameSync(rawPath, target);
    webmPath = target;
  } catch {
    webmPath = rawPath; // 跨设备改名失败就保留原名
  }
}

const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log('\n———————————————————————————————————————————————');
console.log(`录屏完成，用时 ${totalSec}s，跳过 ${warnCount} 处。`);
if (webmPath) console.log(`webm：${webmPath}`);
if (consoleErrors.length) console.log(`页面报错（不影响录制，但值得看一眼）：\n  - ${consoleErrors.slice(0, 3).join('\n  - ')}`);

/* ---- ffmpeg 转 mp4：多数平台只吃 mp4，webm 直接上传会失败 ---- */
function hasFfmpeg() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}

if (webmPath) {
  const mp4Path = path.join(OUT_DIR, `${rawName}.mp4`);
  if (!hasFfmpeg()) {
    console.log('\n未检测到 ffmpeg，只保留 webm。手动转码命令：');
    console.log(`  ffmpeg -i "${webmPath}" -c:v libx264 -pix_fmt yuv420p -preset medium -crf 23 -movflags +faststart "${mp4Path}"`);
  } else {
    const args = ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '23', '-movflags', '+faststart', mp4Path];
    const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(mp4Path)) {
      console.log(`mp4 ：${mp4Path}`);
    } else {
      console.log('\nffmpeg 转码失败（可手动重试）：');
      console.log(`  ffmpeg -i "${webmPath}" -c:v libx264 -pix_fmt yuv420p -preset medium -crf 23 -movflags +faststart "${mp4Path}"`);
    }
  }
  console.log(`\n时长建议：${totalSec}s 属于「${Number(totalSec) > 210 ? '完整版（3–5 分钟）' : '偏短'}」，`);
  console.log('剪辑时按 docs/演示视频脚本.md 的时间轴裁剪到 3–5 分钟（完整版）或 90 秒（精简版）。');
}
console.log('———————————————————————————————————————————————\n');
process.exit(0);
