#!/usr/bin/env node
/**
 * 前端冒烟测试：6 条主链路各走一遍，任何一条挂了都算红。
 *
 * 为什么要有：后端有 11 条单测，但**前端零测试** —— 上一次「练习提交路径 report 未定义」
 * 就是纯前端 bug，测出来之前一直没人发现。这里用真实浏览器跑关键交互，
 * 覆盖「点了没反应 / 报错 / 页面空白」这类最容易在评审现场翻车的问题。
 *
 * 用法：node scripts/test/smoke.mjs [--base http://127.0.0.1:8787] [--headed]
 * 依赖：playwright-core（浏览器用本机已装的 chromium，见 --browser-path）
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

/**
 * 拼 hash 路由 URL。
 * 注意：base 里带 query（如 ?k=分享口令）时，不能再拼 "/"，
 * 否则斜杠会被算进 query 值里 → location.search 变成 "?k=口令/" →
 * 服务端收到错口令 → 401 → 前端静默降级（没有追问、没有维度分）。
 */
function routeUrl(hash) {
  return `${BASE}${BASE.includes('?') ? '' : '/'}${hash}`;
}

const HEADED = ARGS.includes('--headed');

/** 找本机已安装的 chromium（playwright 缓存目录） */
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
    for (const rel of [
      'chrome-win/chrome.exe',
      'chrome-win64/chrome.exe',
      'chrome-linux/chrome',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const p = path.join(base, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

const results = [];
let failed = 0;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    failed += 1;
    results.push({ name, ok: false, ms: Date.now() - t0, error: err.message });
    console.error(`  ✗ ${name}: ${err.message}`);
  } finally {
    // 清理可能残留的弹窗：否则一处失败会连锁挡住后面的步骤
    await page
      .evaluate(() => {
        document.querySelectorAll('.modal-backdrop:not(#citation-modal)').forEach((m) => m.remove());
        document.getElementById('citation-modal')?.setAttribute('hidden', '');
      })
      .catch(() => {});
  }
}

const execPath = findChromium();
if (!execPath) {
  console.error('找不到 chromium，可用 --browser-path 指定');
  process.exit(2);
}

const browser = await chromium.launch({ headless: !HEADED, executablePath: execPath });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

console.log(`[smoke] 目标 ${BASE}｜浏览器 ${execPath}\n`);

await step('首页加载：hero + 题库列表有卡', async () => {
  await page.goto(`${routeUrl('#/bank')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.hero-title', { timeout: 15000 });
  await page.waitForSelector('#bank-list .card', { timeout: 15000 });
  const n = await page.locator('#bank-list .card').count();
  if (n < 1) throw new Error('题库没有渲染出任何卡片');
});

await step('筛选与分页：选方向后仍有结果，分页器可见', async () => {
  const chips = page.locator('#track-filters button');
  const count = await chips.count();
  if (count < 2) throw new Error('方向筛选按钮不足');
  // 点第一个非"全部方向"且未禁用的 chip
  for (let i = 0; i < count; i++) {
    const btn = chips.nth(i);
    if (await btn.isDisabled()) continue;
    const label = (await btn.innerText()).trim();
    if (label.startsWith('全部')) continue;
    await btn.click();
    break;
  }
  await page.waitForTimeout(400);
  const cards = await page.locator('#bank-list .card').count();
  const empty = await page.locator('#bank-list').innerText();
  if (cards === 0 && !empty.includes('暂时没有题')) {
    throw new Error('筛选后既没有卡片也没有空状态提示');
  }
});

await step('题单：可选中场景题单并过滤题库，可一键回到全部', async () => {
  await page.goto(`${routeUrl('#/bank')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bundle-chips', { timeout: 15000 });
  const chips = page.locator('#bundle-chips button');
  const n = await chips.count();
  if (n < 3) throw new Error(`题单数量不足（${n}）`);
  const label = (await chips.first().innerText()).trim();
  await chips.first().click();
  await page.waitForTimeout(500);
  const bar = page.locator('#bundle-filter-bar');
  if (!(await bar.isVisible())) throw new Error('选中题单后没有出现当前题单提示条');
  const barText = await bar.innerText();
  if (!barText.includes('当前题单')) throw new Error('题单提示条没有说明当前题单');
  const cards = await page.locator('#bank-list .card').count();
  if (cards === 0) throw new Error(`题单「${label}」过滤后一道题都没有`);
  // 回到全部
  await bar.locator('button').click();
  await page.waitForTimeout(400);
  if (await bar.isVisible()) throw new Error('点击「看全部」后题单提示条没有消失');
});

await step('拆逻辑卡片：能打开且有得分点', async () => {
  await page.goto(`${routeUrl('#/bank')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bank-list .btn-start-coach', { timeout: 15000 });
  // 挑一张**带知乎原文链接**的题（没有观点卡的题本来就没有链接，不该算失败）
  const idx = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#bank-list .card'));
    const i = cards.findIndex((c) => c.querySelector('a[href*="zhihu.com"]'));
    return i >= 0 ? i : 0;
  });
  await page.locator('#bank-list .btn-start-coach').nth(idx).click();
  await page.waitForSelector('.modal-backdrop:not([hidden])', { timeout: 8000 });
  const text = await page.locator('.modal-backdrop:not([hidden]) .modal-body').innerText();
  if (!text.includes('核心得分点')) throw new Error('拆逻辑卡片缺少得分点');
  const hasLink = await page.locator('.modal-backdrop:not([hidden]) a[href*="zhihu.com"]').count();
  const hasCards = text.includes('张知乎观点卡');
  if (hasLink === 0 && hasCards) throw new Error('这道题有观点卡，但拆逻辑卡片里没有知乎原文链接');
  await page.keyboard.press('Escape');
});

await step('陪练室：门禁生效（空框主按钮禁用）', async () => {
  await page.goto(`${routeUrl('#/coach')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#answer-textarea', { timeout: 15000 });
  await page.waitForTimeout(600);
  const btn = page.locator('#btn-submit-parse');
  if (!(await btn.isDisabled())) throw new Error('空回答时提交按钮没有禁用');
  const label = await btn.innerText();
  if (!label.includes('至少')) throw new Error(`禁用态文案不清晰：${label}`);
});

await step('陪练室：填入示例后按钮解锁且字数正确', async () => {
  // 页面是异步渲染的（题库加载 → 渲染陪练室），等它彻底稳定
  await page.waitForSelector('#answer-textarea', { timeout: 15000 });
  await page.waitForTimeout(1500);
  const fill = page.locator('#btn-fill-sample');
  await fill.waitFor({ state: 'visible', timeout: 8000 });
  try {
    await fill.click({ timeout: 15000 });
  } catch (err) {
    // 诊断：元素是否稳定、是否被别的元素盖住
    const box1 = await fill.boundingBox();
    await page.waitForTimeout(300);
    const box2 = await fill.boundingBox();
    const hit = await page.evaluate(() => {
      const el = document.querySelector('#btn-fill-sample');
      if (!el) return '元素不存在';
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top) return '无命中元素';
      const modal = top.closest('.modal-backdrop');
      const info = `${top.tagName}#${top.id || ''}`;
      if (modal) {
        const title = modal.querySelector('h3');
        return `${info} | 弹窗标题="${(title?.innerText || '').slice(0, 20)}" hidden=${modal.hasAttribute('hidden')} 弹窗数=${document.querySelectorAll('.modal-backdrop').length}`;
      }
      return info;
    });
    throw new Error(`${err.message.split('\n')[0]}｜稳定=${JSON.stringify(box1) === JSON.stringify(box2)}｜命中=${hit}`);
  }
  await page.waitForTimeout(300);
  const counter = await page.locator('#answer-char-count').innerText();
  const m = counter.match(/(\d+)/);
  if (!m || Number(m[1]) < 15) throw new Error(`字数计数不对：${counter}`);
  if (await page.locator('#btn-submit-parse').isDisabled()) throw new Error('填入后按钮仍禁用');
});

await step('复盘台：有报告时展示维度分与改进话术', async () => {
  await page.goto(`${routeUrl('#/review')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const text = await page.locator('#screen-root').innerText();
  if (text.includes('暂无待复盘') || text.includes('还没有可复盘的作答记录')) {
    // 没有报告是允许的状态（守卫兜底），但守卫必须给出可点入口
    const guard = await page.locator('.empty-guard').count();
    if (guard === 0) throw new Error('既没有报告也没有空状态守卫');
    return;
  }
  if (!text.includes('/ 100 分') && !text.includes('未取得模型评分')) {
    throw new Error('维度分既没有刻度（"38 / 100 分"），也没有明确说明为什么没有');
  }
});

await step('弹药库：数据工具条在，闪卡区存在', async () => {
  await page.goto(`${routeUrl('#/ledger')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#storage-usage', { timeout: 15000 });
  await page.waitForTimeout(1200);
  for (const id of ['btn-export-bundle', 'btn-export-manual', 'btn-import-restore', 'btn-clean-audio']) {
    if ((await page.locator('#' + id).count()) === 0) throw new Error(`工具条缺少 ${id}`);
  }
});

await step('答辩预测：空材料时有守卫与示例入口', async () => {
  await page.goto(`${routeUrl('#/defense')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const guard = await page.locator('.empty-guard').count();
  if (guard === 0) throw new Error('没有材料时缺少上下文守卫');
});

await step('全程无 JS 报错', async () => {
  const real = consoleErrors.filter((e) => !/favicon|net::ERR_|Failed to load resource/i.test(e));
  if (real.length) throw new Error(real.slice(0, 3).join(' | '));
});

await browser.close();

console.log('\n—————————————————————————————');
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name} ${r.ms}ms`);
console.log(`—————————————————————————————\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
