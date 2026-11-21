#!/usr/bin/env node
/**
 * 从**部署域名**截产品界面图（计划书用图）。
 *
 * 为什么不用本地截：计划书里的图要能证明"评委点开链接看到的就是这个样子"，
 * 本机截图和线上不一致（域名、数据、审核状态都不一样），评审一眼能看出来。
 *
 * 用法：node scripts/demo/capture-screenshots.mjs --base "https://<域名>/?k=<口令>"
 * 输出：docs/screenshots/*.png
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'docs', 'screenshots');

const ARGS = process.argv.slice(2);
const argOf = (n, d) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};
const BASE = argOf('base', 'http://127.0.0.1:8787');
/** base 带 query 时拼 hash 路由不能再加 "/"，否则斜杠会落进 query 值里 → 口令失效 */
const routeUrl = (hash) => `${BASE}${BASE.includes('?') ? '' : '/'}${hash}`;

function findChromium() {
  const explicit = argOf('browser-path', '');
  if (explicit && fs.existsSync(explicit)) return explicit;
  const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!fs.existsSync(base)) return undefined;
  const dirs = fs
    .readdirSync(base)
    .filter((d) => d.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const d of dirs) {
    for (const rel of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(base, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: findChromium() });
// 用持久 profile：里面已经有演示闪卡，弹药库那格不会是空的
const profile = path.join(ROOT, '.tunnel', 'demo-profile');
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1.5,
  storageState: fs.existsSync(path.join(profile, 'Default')) ? undefined : undefined,
});
const page = await ctx.newPage();
const shots = [];

async function shot(name, note) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push(`${name}.png  ${note}`);
  console.log(`  · ${name}.png  ${note}`);
}

console.log(`目标：${BASE}`);
await page.goto(routeUrl('#/bank'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#bank-list .card', { timeout: 60000 });
await sleep(2500);
await shot('01-选题库首页', '首屏：方向 chip 带题量、每张卡挂知乎观点摘要');

// 拆逻辑卡片
await page.locator('#bank-list .btn-start-coach').first().click({ timeout: 15000 });
await page.waitForSelector('.modal-backdrop:not([hidden])', { timeout: 15000 });
await sleep(1200);
await shot('02-拆逻辑卡片', '拆逻辑：考察意图 + 3 个核心得分点 + 知乎原文溯源');
await page.locator('.modal-backdrop:not([hidden]) .modal-footer button', { hasText: '我准备好了' }).first().click();
await sleep(1500);

// 连续追问：填示例 → 提交 → 等追问框
await page.locator('#btn-fill-sample').first().click({ timeout: 15000 }).catch(() => {});
await sleep(1000);
await page.locator('#btn-submit-parse').first().click({ timeout: 15000 });
await page
  .waitForFunction(
    () => {
      const box = document.querySelector('#followup-box');
      return Boolean(box && !box.hasAttribute('hidden'));
    },
    null,
    { timeout: 120000, polling: 400 }
  )
  .catch(() => console.log('  ! 没等到追问框'));
await sleep(1200);
await shot('03-连续追问', '评委顺着你的回答往下追（温和引导 / 压力挑战两种人设）');

// 复盘台：再答一轮 → 出复盘（追问深度是 2，所以要答满两轮才会跳复盘；
// 这里带重试，避免偶发"按钮还禁用"导致截到陪练室而不是复盘台）
let atReview = false;
for (let i = 0; i < 4 && !atReview; i++) {
  const sample = page.locator('#btn-fill-sample').first();
  if (await sample.isVisible().catch(() => false)) {
    await sample.click({ timeout: 15000 }).catch(() => {});
    await sleep(1500);
  }
  const sub = page.locator('#btn-submit-parse').first();
  if (await sub.isVisible().catch(() => false)) {
    await sub.click({ timeout: 15000 }).catch(() => {});
  }
  atReview = await page
    .waitForFunction(() => location.hash.includes('/review'), null, { timeout: 60000, polling: 400 })
    .then(() => true)
    .catch(() => false);
  if (!atReview) console.log(`  · 还没到复盘页，再试一轮（第 ${i + 1} 次）`);
}
if (!atReview) console.log('  ! 没到复盘页');
await sleep(3500);
await shot('04-复盘台', '逐句回指原话 + 维度分带刻度 + 知乎原话对照');
// 往下滚一点，把"AI 观点层"四维分也拍进去
await page.evaluate(() => window.scrollBy(0, 620));
await sleep(1200);
await shot('04b-复盘台-维度分', 'AI 观点层：四维评分，每条结论挂知乎原文角标');
await page.evaluate(() => window.scrollTo(0, 0));

// 弹药库
await page.goto(routeUrl('#/ledger'), { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#storage-usage', { timeout: 60000 });
await sleep(2500);
// 把刚才那次复盘提炼的闪卡真的存进本机（否则截到的是"0 张"空状态）
const saveBtn = page.locator('button', { hasText: '存为闪卡' }).first();
if (await saveBtn.isVisible().catch(() => false)) {
  await saveBtn.click({ timeout: 15000 }).catch(() => {});
  await sleep(2500);
  console.log('  · 已把复盘提炼的闪卡存入本机');
}
await shot('05-弹药库', '最佳作答提炼成闪卡（结论 / 论据 / 防杠话术）+ 掌握度 + 快问快答');

// 答辩预测
await page.goto(routeUrl('#/defense'), { waitUntil: 'domcontentloaded' });
await sleep(2500);
const sampleBtn = page.locator('button, a').filter({ hasText: /示例/ }).first();
await sampleBtn.click({ timeout: 15000 }).catch((e) => console.log('  ! 示例材料按钮没点上：' + e.message.slice(0, 60)));
await sleep(3500);
await shot('06-答辩预测', '答辩材料切片段 + 评委追问 + 知乎上的相关讨论');

await browser.close();
console.log(`\n共 ${shots.length} 张，输出到 ${OUT}`);
