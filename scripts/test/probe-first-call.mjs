// 一次性诊断脚本：全新浏览器 profile 复现"评委第一次提交"路径，打印所有 /api/ 请求与耗时。
// 用法：node scripts/test/probe-first-call.mjs --base <url>
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

/**
 * 拼 hash 路由 URL。
 * 注意：base 里带 query（如 ?k=分享口令）时，不能再拼 "/"，
 * 否则斜杠会被算进 query 值里 → location.search 变成 "?k=口令/" →
 * 服务端收到错口令 → 401 → 前端静默降级（没有追问、没有维度分）。
 */
function routeUrl(hash) {
  return `${BASE}${BASE.includes('?') ? '' : '/'}${hash}`;
}


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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zhimian-probe-'));
const browser = await chromium.launch({ executablePath: findChromium() });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const t0 = Date.now();
page.on('response', async (res) => {
  const u = res.url();
  if (!u.includes('/api/')) return;
  let body = '';
  try { body = (await res.text()).slice(0, 160); } catch { body = '(无法读取)'; }
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${res.status()} ${u.replace(BASE, '')} :: ${body}`);
});
page.on('requestfailed', (r) => console.log(`[FAIL] ${r.url().replace(BASE, '')} :: ${r.failure()?.errorText}`));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 160)); });

console.log('打开', BASE);
await page.goto(`${routeUrl('#/bank')}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.hero-title', { timeout: 60000 });
await page.waitForSelector('#bank-list .card', { timeout: 60000 });
console.log(`首屏就绪 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const env = await page.evaluate(() => ({
  search: location.search,
  href: location.href,
  ss: sessionStorage.getItem('zhimian.share.token'),
  interceptor: String(window.fetch).includes('x-share-token'),
  cookie: document.cookie.slice(0, 80),
}));
console.log('环境:', JSON.stringify(env));

// 进第一题：点题卡上的「先拆逻辑，再开口」→ 弹窗里点「我准备好了，开始作答」
await page.locator('#bank-list .btn-start-coach').first().click({ timeout: 15000 }).catch((e) => console.log('点题卡按钮失败', e.message.slice(0, 60)));
await page.waitForSelector('.modal-backdrop:not([hidden])', { timeout: 15000 }).catch(() => console.log('没有弹窗'));
await page.waitForTimeout(600);
const ready = await page.locator('.modal-backdrop:not([hidden]) .modal-footer button', { hasText: '我准备好了' }).first().click({ timeout: 15000 }).then(() => true).catch((e) => { console.log('点「我准备好了」失败', e.message.slice(0, 60)); return false; });
console.log('进入作答页:', ready);
await page.waitForTimeout(1200);

// 填示例并提交
await page.locator('#btn-fill-sample').first().click({ timeout: 15000 }).catch(() => console.log('没有示例按钮'));
await page.waitForTimeout(800);
const sub = page.locator('#btn-submit-parse').first();
console.log('提交前 disabled =', await sub.isDisabled().catch(() => 'n/a'));
const ts = Date.now();
await sub.click({ timeout: 15000 }).catch((e) => console.log('点击失败', e.message.slice(0, 80)));
console.log(`已提交，用时 ${((Date.now() - ts) / 1000).toFixed(1)}s`);

// 等追问框或跳复盘
const outcome = await page
  .waitForFunction(() => {
    if (location.hash.includes('/review')) return 'review';
    const box = document.querySelector('#followup-box');
    if (box && !box.hasAttribute('hidden')) return 'followup';
    return false;
  }, null, { timeout: 120000, polling: 500 })
  .then((h) => h.jsonValue())
  .catch(() => 'timeout');
console.log('结果:', outcome, `用时 ${((Date.now() - ts) / 1000).toFixed(1)}s`);
if (outcome === 'followup') {
  console.log('追问:', (await page.locator('#followup-question-text').innerText().catch(() => '')).slice(0, 80));
}
await browser.close();
fs.rmSync(profile, { recursive: true, force: true });
