/**
 * 探针：验证知乎开放平台返回结构（只打印键名与样例，不打印任何凭据）。
 * 用法：node scripts/probe-zhihu.mjs "面试 复盘"
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { config } = await import(pathToFileURL(path.join(ROOT, 'apps/bff/src/config.js')).href);

const q = process.argv[2] || '面试 复盘';
console.log('secret configured:', Boolean(config.zhihuSecret));

const url = new URL('https://developer.zhihu.com/api/v1/content/zhihu_search');
url.searchParams.set('Query', q);
url.searchParams.set('Count', '3');

const res = await fetch(url, {
  headers: {
    Authorization: `Bearer ${config.zhihuSecret}`,
    'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
  },
});
const text = await res.text();
console.log('status:', res.status, 'len:', text.length);
let json;
try { json = JSON.parse(text); } catch { console.log('non-json:', text.slice(0, 200)); process.exit(0); }
console.log('top keys:', Object.keys(json));
const body = json.Data ?? json.data ?? json;
console.log('body keys:', body && typeof body === 'object' ? Object.keys(body) : typeof body);
const list = body?.Items ?? body?.List ?? body?.items ?? body?.list ?? [];
console.log('items:', Array.isArray(list) ? list.length : 'not-array');
if (Array.isArray(list) && list[0]) {
  console.log('item keys:', Object.keys(list[0]));
  const it = list[0];
  const pick = (k) => (it[k] === undefined ? undefined : String(it[k]).slice(0, 160));
  for (const k of Object.keys(it)) console.log(`  ${k}:`, pick(k));
}
