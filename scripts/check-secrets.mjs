/**
 * 提交前密钥自查：扫描 apps/ 与 scripts/，发现疑似硬编码凭据立即失败。
 * 只匹配“形如真实凭据的值”，避免命中报错文案与注释。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['apps', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.cache']);
const SKIP_FILE_EXT = /\.(zip|png|jpg|jpeg|gif|ico|woff2?|ttf)$/i;

const RULES = [
  { name: '字面量 Bearer token', re: /Bearer\s+(?!\$\{)[A-Za-z0-9_.=-]{16,}/ },
  { name: '密钥字面量赋值', re: /(?:ZHIHU_ACCESS_SECRET|LLM_API_KEY|ACCESS_SECRET|APP_KEY|API_KEY|api_key|apikey)\s*[:=]\s*['"][A-Za-z0-9_./+-]{8,}['"]/ },
  { name: 'sk- 风格密钥', re: /sk-[A-Za-z0-9_-]{16,}/ }
];

function walk(dir, hits) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, hits);
      continue;
    }
    if (SKIP_FILE_EXT.test(entry.name)) continue;
    const lines = fs.readFileSync(full, 'utf-8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const rule of RULES) {
        if (rule.re.test(line)) hits.push(`${full}:${idx + 1}: [${rule.name}] ${line.trim()}`);
      }
    });
  }
}

const hits = [];
for (const root of ROOTS) {
  if (fs.existsSync(root)) walk(root, hits);
}

if (hits.length) {
  console.error(`✗ 发现 ${hits.length} 处疑似硬编码凭据：`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log('OK: No leaked secrets');
