#!/usr/bin/env node
/**
 * 打印「部署到 AiWorks / CloudBase / 云主机」时要填的环境变量。
 *
 * 用法：node scripts/dev/print-env-for-deploy.mjs
 * 输出分三段：必填 / 建议 / 可选，并标出本地 .env 里缺哪些。
 *
 * ⚠️ 这里会打印真实密钥 —— 只在自己的机器上看，**不要**把输出贴到公开的地方。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const envFile = path.join(ROOT, '.env');

const REQUIRED = [
  { key: 'LLM_BASE_URL', desc: 'OpenAI 兼容端点', example: 'https://api.deepseek.com' },
  { key: 'LLM_API_KEY', desc: '模型密钥', example: 'sk-...' },
  { key: 'LLM_MODEL', desc: '模型名', example: 'deepseek-v4-flash' },
  { key: 'ZHIHU_ACCESS_SECRET', desc: '知乎开放平台令牌（检索 / 回答摘要）', example: '...' },
  { key: 'PUBLIC_SHARE_TOKEN', desc: '公网分享口令：不设 = 任何人可白用你的额度', example: '随机长串' },
];
const OPTIONAL = [
  { key: 'PORT', desc: '监听端口，平台一般会自己注入', example: '8787' },
  { key: 'LLM_MAX_CONCURRENCY', desc: '模型并发上限，默认 3', example: '3' },
  { key: 'CACHE_DIR', desc: '知乎内容缓存目录（容器建议挂卷）', example: '/data/.cache' },
  { key: 'CACHE_PERSIST', desc: '设为 1 才把缓存落盘', example: '1' },
  { key: 'PDF_OCR', desc: 'PDF 兜底解析开关', example: '1' },
  { key: 'ASR_PROVIDER', desc: '云端转写服务；不配则用浏览器识别 + 手动导入', example: 'none' },
];

const env = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
}

console.log('══════════════════════════════════════════════════════');
console.log(' 部署环境变量（复制到平台的「环境变量」输入框，一行一个）');
console.log('══════════════════════════════════════════════════════\n');

console.log('【必填】');
for (const item of REQUIRED) {
  const value = env[item.key];
  const mark = value ? '✓' : '✗ 本地 .env 里没有，需要自己填';
  console.log(`${mark} ${item.key}=${value || '<填入>'}   // ${item.desc}`);
  if (!value) console.log(`      参考值：${item.example}`);
}

console.log('\n【建议】');
for (const item of OPTIONAL) {
  const value = env[item.key];
  console.log(`${value ? '✓' : '·'} ${item.key}=${value || '<可留默认>'}   // ${item.desc}`);
}

console.log('\n【启动与端口】');
console.log('启动命令：npm start            # 等价于 node scripts/dev/start-prod.mjs（缺 dist 会自动编译）');
console.log('端口：      8787              # 平台会注入 PORT 环境变量，读 PORT 即可');
console.log('健康检查：  /api/health       # 返回 ok:true / bankSize / requiresToken / usage');
console.log('体验地址：  https://<平台域名>/?k=<PUBLIC_SHARE_TOKEN>');
console.log('\n⚠️ 上面含真实密钥，别贴到公开的地方。');
