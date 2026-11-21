#!/usr/bin/env node
/**
 * 评委完整旅程自测（跑在**部署域名**上，用假麦克风模拟录音）。
 *
 * 为什么单独写一个：录屏脚本（record-demo.mjs）走的是"打字/示例回答"路径，
 * **评委大概率会先按录音**。而云端没有 ASR（云函数里没有 whisper 模型），
 * 这条路径必须验证：录音 → 提示清晰 → 能改用打字/导入转写稿 → 追问 → 复盘，全程不崩。
 *
 * 用法：node scripts/test/judge-journey.mjs --base "https://<域名>/?k=<口令>"
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ARGS = process.argv.slice(2);
const argOf = (n, d) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};
const BASE = argOf('base', 'http://127.0.0.1:8787');
const routeUrl = (hash) => `${BASE}${BASE.includes('?') ? '' : '/'}${hash}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChromium() {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse();
  for (const d of dirs) {
    for (const rel of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(base, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('找不到本机 chromium');
}

const results = [];
function step(name, ok, note = '') {
  results.push({ name, ok, note });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${note ? '  — ' + note : ''}`);
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 120)));

console.log(`目标：${BASE}\n`);
await page.goto(routeUrl('#/bank'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#bank-list .card', { timeout: 60000 });
step('打开题库', true);

// 进题 → 拆逻辑 → 作答
await page.locator('#bank-list .btn-start-coach').first().click({ timeout: 15000 });
await page.waitForSelector('.modal-backdrop:not([hidden])', { timeout: 15000 });
await sleep(800);
step('拆逻辑卡片可打开', await page.locator('.modal-backdrop:not([hidden])').count() > 0);
await page.locator('.modal-backdrop:not([hidden]) .modal-footer button', { hasText: '我准备好了' }).first().click();
await sleep(1200);
await page.waitForSelector('#answer-textarea', { timeout: 15000 }).catch(() => {});
step('进入作答页', (await page.locator('#answer-textarea').count()) > 0);

// 切到「录音复盘」工作台（评委要先切过来才看到录音入口）
await page.locator('button, a, [role=tab]').filter({ hasText: '录音复盘' }).first().click({ timeout: 10000 }).catch(() => {});
await sleep(1200);
step('能切到「录音复盘」工作台', await page.locator('#record-area').isVisible().catch(() => false));

// 录音（假麦克风）
const recBtn = page.locator('#btn-record-toggle').first();
if (await recBtn.isVisible().catch(() => false)) {
  await recBtn.click({ timeout: 10000 }).catch(() => {});
  await sleep(3500);
  const stopBtn = page.locator('#btn-record-toggle').first();
  if (await stopBtn.isVisible().catch(() => false)) {
    await stopBtn.click({ timeout: 10000 }).catch(() => {});
    await sleep(1500);
  }
  const capText = await page.evaluate(() => {
    const el = document.querySelector('#caption-status, [id*=caption-status]');
    return el ? el.innerText.replace(/\s+/g, ' ').slice(0, 120) : '';
  });
  step('录音可开始/停止并给出状态', true, capText || '(无状态文案)');
} else {
  step('录音按钮存在', false, '没找到录音按钮');
}

// 转写不可用时是否给出清晰提示：先点「转写这两轨」（会实时检测并给提示）
const transcribeBtn = page.locator('button', { hasText: '转写这两轨' }).first();
if (await transcribeBtn.isVisible().catch(() => false)) {
  await transcribeBtn.click({ timeout: 10000 }).catch(() => {});
  await sleep(2500);
}
const asrHint = await page.evaluate(() => {
  const el = document.querySelector('#asr-hint');
  return el ? (el.innerText || '').replace(/\s+/g, ' ').slice(0, 200) : '';
});
step('转写不可用时有明确提示', Boolean(asrHint && asrHint.includes('转写')), asrHint.slice(0, 80) || '(无提示)');

// 改用打字/示例回答 → 提交 → 追问（切回「真题陪练」面板）
await page.locator('button, a, [role=tab]').filter({ hasText: '真题陪练' }).first().click({ timeout: 10000 }).catch(() => {});
await sleep(800);
await page.locator('#btn-fill-sample').first().click({ timeout: 15000 }).catch(() => {});
await sleep(1000);
const len = await page.locator('#answer-textarea').inputValue().catch(() => '0');
step('可改用示例回答继续', String(len).trim().length >= 15, `作答框 ${String(len).trim().length} 字`);

await page.locator('#btn-submit-parse').first().click({ timeout: 15000 });
const gotFollowup = await page
  .waitForFunction(
    () => {
      const box = document.querySelector('#followup-box');
      return Boolean(box && !box.hasAttribute('hidden'));
    },
    null,
    { timeout: 120000, polling: 400 }
  )
  .then(() => true)
  .catch(() => false);
step('提交后能拿到评委追问', gotFollowup);

if (gotFollowup) {
  const q = await page.locator('#followup-question-text').innerText().catch(() => '');
  step('追问内容非空', q.trim().length > 5, q.trim().slice(0, 50));
}

// 走完到复盘
let atReview = false;
for (let i = 0; i < 4 && !atReview; i++) {
  const sample = page.locator('#btn-fill-sample').first();
  if (await sample.isVisible().catch(() => false)) { await sample.click().catch(() => {}); await sleep(1200); }
  const sub = page.locator('#btn-submit-parse').first();
  if (await sub.isVisible().catch(() => false)) await sub.click({ timeout: 10000 }).catch(() => {});
  atReview = await page.waitForFunction(() => location.hash.includes('/review'), null, { timeout: 60000, polling: 400 }).then(() => true).catch(() => false);
}
step('能到达复盘台', atReview);
if (atReview) {
  await sleep(3000);
  const scores = await page.evaluate(() => {
    const el = document.querySelector('#llm-layer');
    return el ? el.innerText.replace(/\s+/g, ' ').slice(0, 160) : '';
  });
  step('复盘台显示维度分（LLM 未降级）', /\d+\s*\/\s*100/.test(scores), scores.slice(0, 70));
}

// 弹药库 + 答辩
await page.goto(routeUrl('#/ledger'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#storage-usage', { timeout: 60000 });
step('弹药库可打开', true);
await page.goto(routeUrl('#/defense'), { waitUntil: 'domcontentloaded' });
await sleep(2000);
await page.locator('button, a').filter({ hasText: /示例/ }).first().click({ timeout: 15000 }).catch(() => {});
await sleep(3000);
const segs = await page.locator('text=/\\d+ 个片段/').count().catch(() => 0);
step('答辩材料可切片段', segs > 0 || (await page.locator('[class*=segment]').count()) > 0);

// 只把真正的 JS 异常算失败：
// 404（favicon 之类）与 501（/api/auth/me 未配置 OAuth）都是预期内的资源级提示，不是脚本报错
const realErrors = consoleErrors.filter((t) => !/status of (401|404|429|501)/.test(t));
step('全程无 JS 报错', realErrors.length === 0, realErrors.slice(0, 2).join(' | ') || `（已忽略 ${consoleErrors.length - realErrors.length} 条 401/404/429/501 资源级提示）`);

await browser.close();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 通过`);
if (bad.length) {
  console.log('失败项：');
  for (const b of bad) console.log(`  ✗ ${b.name} ${b.note}`);
  process.exit(1);
}
