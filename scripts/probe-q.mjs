import path from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = process.cwd();
const { config } = await import(pathToFileURL(path.join(ROOT, 'apps/bff/src/config.js')).href);

const H = {
  Authorization: `Bearer ${config.zhihuSecret}`,
  'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
};

async function call(label, url, init) {
  const res = await fetch(url, { ...init, headers: { ...H, ...(init?.headers || {}) } });
  const text = await res.text();
  console.log(`\n=== ${label} status=${res.status} len=${text.length}`);
  try {
    const j = JSON.parse(text);
    const body = j.Data ?? j.data ?? j;
    console.log('body keys:', body && typeof body === 'object' ? Object.keys(body) : typeof body);
    const list = body?.Items ?? body?.List ?? body?.Data ?? body?.items ?? body?.list;
    if (Array.isArray(list) && list[0]) {
      console.log('item keys:', Object.keys(list[0]));
      for (const [k, v] of Object.entries(list[0])) {
        console.log(`  ${k}:`, String(v).slice(0, 150).replace(/\n/g, ' '));
      }
    } else {
      console.log('raw head:', text.slice(0, 400));
    }
  } catch { console.log('non-json:', text.slice(0, 300)); }
}

const q = encodeURIComponent('面试 项目 复盘');
await call('question_recommendations',
  `https://developer.zhihu.com/api/v1/user/question_recommendations?Query=${q}&Count=3`);

await call('hot_list',
  `https://developer.zhihu.com/api/v1/content/hot_list?Limit=2`);
