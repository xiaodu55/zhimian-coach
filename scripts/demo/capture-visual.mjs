#!/usr/bin/env node
/**
 * 视觉验收：桌面端 + 手机端各截几张关键屏，供人工核对排版与层级。
 * 用法：node scripts/demo/capture-visual.mjs [--base http://127.0.0.1:8787]
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, '.tunnel', 'visual');
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

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: findChromium() });

for (const vp of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  const shot = async (name) => {
    const file = path.join(OUT, `${vp.name}-${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`  ${vp.name}-${name}.png`);
  };

  await page.goto(routeUrl('#/bank'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bank-list .card', { timeout: 60000 });
  await sleep(2500);
  await shot('01-bank');

  // 进题 → 拆逻辑 → 陪练室
  await page.locator('#bank-list .btn-start-coach').first().click({ timeout: 15000 });
  await page.waitForSelector('.modal-backdrop:not([hidden])', { timeout: 15000 });
  await sleep(1200);
  await shot('02-logic');
  await page.locator('.modal-backdrop:not([hidden]) .modal-footer button', { hasText: '我准备好了' }).first().click();
  await sleep(1500);
  await shot('03-coach');

  // 复盘台：用「离线演示（预置复盘）」造一份报告再进 #/review
  // （全新浏览器 context 里没有历史作答，直接进 #/review 只会看到空状态守卫）
  await page.goto(routeUrl('#/bank'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bank-list .card', { timeout: 60000 });
  await page.locator('#btn-offline-demo').first().click({ timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => location.hash.includes('/review'), null, { timeout: 30000, polling: 300 }).catch(() => {});
  await page.waitForSelector('#review-summary', { timeout: 30000 }).catch(() => {});
  await sleep(3000);
  await shot('04-review');

  await page.goto(routeUrl('#/ledger'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#storage-usage', { timeout: 60000 });
  await sleep(2500);
  await shot('05-ledger');

  await ctx.close();
}
await browser.close();
console.log(`\n输出目录：${OUT}`);
