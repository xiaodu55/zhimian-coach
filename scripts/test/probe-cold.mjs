// 一次性诊断：冷启动首屏为什么白屏（记录失败请求 / 错误响应 / 控制台错误）
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const base = process.argv[2] || 'https://b3z5z9ztm5qo.aiworks.site/?k=zhimian--BqObUY_K7QAxrMB';
function findChromium() {
  const dir = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const dirs = fs.readdirSync(dir).filter((d) => d.startsWith('chromium-')).sort().reverse();
  for (const d of dirs) {
    for (const rel of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(dir, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('找不到 chromium');
}

const browser = await chromium.launch({ executablePath: findChromium() });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const failed = [];
const bad = [];
const errs = [];
page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url().replace(base, '')}`));
page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url().replace(base, '')}`); });
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });

const t0 = Date.now();
await page.goto(base + '#/bank', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#bank-list .card', { timeout: 45000 }).catch(() => {});
const info = await page.evaluate(() => ({
  cards: document.querySelectorAll('#bank-list .card').length,
  hero: !!document.querySelector('.hero-title'),
  bundles: document.querySelectorAll('#bundle-chips button').length,
}));
console.log('耗时', Math.round((Date.now() - t0) / 1000) + 's', info);
console.log('失败请求:', failed.slice(0, 12));
console.log('错误响应:', bad.slice(0, 12));
console.log('控制台错误:', errs.slice(0, 6));
await browser.close();
