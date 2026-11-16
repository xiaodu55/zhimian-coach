import path from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = process.cwd();
const { config } = await import(pathToFileURL(path.join(ROOT, 'apps/bff/src/config.js')).href);
const H = {
  Authorization: `Bearer ${config.zhihuSecret}`,
  'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
};
const QU = 'https://www.zhihu.com/question/2104925918871529406';

// 1) 回答摘要
let res = await fetch(
  `https://developer.zhihu.com/api/v1/content/question_answers?QuestionUrl=${encodeURIComponent(QU)}&Offset=0&Limit=5`,
  { headers: H }
);
let txt = await res.text();
console.log('=== answers status', res.status, 'len', txt.length);
let j = JSON.parse(txt);
let body = j.Data ?? j.data ?? j;
console.log('body keys', Object.keys(body));
const list = body.Items ?? body.List ?? [];
console.log('items', list.length);
if (list[0]) { console.log('item keys', Object.keys(list[0])); for (const [k,v] of Object.entries(list[0])) console.log(' ', k, ':', String(v).slice(0,160).replace(/\n/g,' ')); }

// 2) 直答
res = await fetch('https://developer.zhihu.com/v1/chat/completions', {
  method: 'POST',
  headers: { ...H, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'zhida',
    messages: [
      { role: 'user', content: '一句话说明：面试回答里"没有量化数据"为什么会失分？' },
    ],
    stream: false,
  }),
});
txt = await res.text();
console.log('\n=== zhida status', res.status, 'len', txt.length);
console.log(txt.slice(0, 800));
