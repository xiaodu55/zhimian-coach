#!/usr/bin/env node
/**
 * 生成官方 AI Works / CloudBase 交付包（可重复执行，密钥轮换后重跑即可）。
 *
 * 流程严格按官方 Skill 的顺序：
 *   ① 隔离副本（仓库源码不动）
 *   ② 密钥固化：把 .env 的值写成源码常量（官方要求先取得用户明确授权 —— 密钥会明文进 ZIP）
 *   ③ 官方只读探测器 → deploy-plan.json
 *   ④ 校验计划 → 生成运行时输入 → 生成部署描述符
 *   ⑤ settle_agent → 打包 ZIP → 校验交付物
 *
 * 打包必须在 Linux 文件系统上做（scf_bootstrap 需要 0755，Windows/DrvFs 设不了），
 * 所以第 ⑤ 步借 WSL2 跑；没有 WSL 时会明确报错并提示改走 CloudBase 控制台。
 *
 * 用法：
 *   node scripts/deploy/build-delivery.mjs            # 生成并输出 ZIP 路径
 *   node scripts/deploy/build-delivery.mjs --token abc # 指定分享口令（默认随机生成）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 交付副本放在系统临时目录：仓库内部会被 cpSync 判定为"复制到自身子目录"而拒绝
const WORK = path.join(os.tmpdir(), 'zhimian-delivery');
const HELPER = path.join(ROOT, '.tunnel', 'helper', 'zhihu-ai-works-deploy-helper');
const OUT_ZIP = path.join(WORK, 'zhimian-delivery.zip');

const ARGS = process.argv.slice(2);
const argOf = (n, d) => {
  const i = ARGS.indexOf(`--${n}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

function log(msg) {
  console.log(`[delivery] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    console.error(`[delivery] 命令失败：${cmd} ${args.join(' ')}`);
    process.exit(res.status ?? 1);
  }
}

if (!fs.existsSync(HELPER)) {
  console.error(
    '[delivery] 没找到官方部署助手。请先下载并解压到 .tunnel/helper/zhihu-ai-works-deploy-helper：\n' +
      '  curl -L -o .tunnel/aiworks-helper.zip "https://zhstatic.zhihu.com/skill/application/d6c1-260923/zhihu-ai-works-deploy-helper_v1.2.0.zip"\n' +
      '  （地址来自知乎 AI Works 页面）'
  );
  process.exit(2);
}

// ---------- ① 隔离副本 ----------
log('① 复制隔离副本（仓库源码不受影响）');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const IGNORE = new Set(['node_modules', '.git', '.tunnel', 'out', '.cache', 'dist', '.archive', 'skill']);
fs.cpSync(ROOT, WORK, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src);
    if (!rel) return true;
    const first = rel.split(path.sep)[0];
    if (IGNORE.has(first)) return false;
    if (rel.endsWith('.log')) return false;
    return true;
  },
});

// ---------- ② 密钥固化（需用户已授权） ----------
const env = {};
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
}
const shareToken = argOf('token', env.PUBLIC_SHARE_TOKEN || `zhimian-${crypto.randomBytes(12).toString('base64url')}`);
env.PUBLIC_SHARE_TOKEN = shareToken;

const ALLOWED_ENV = new Set(['PORT', 'HOST', 'HOSTNAME', 'NITRO_HOST', 'NITRO_PORT']);
const FALLBACKS = {
  NODE_ENV: 'production',
  LLM_MAX_CONCURRENCY: '3',
  CACHE_TTL_HOURS: '24',
  ASR_PROVIDER: 'none',
  ASR_BASE_URL: '',
  ASR_API_KEY: '',
  ASR_MODEL: '',
  OAUTH_APP_ID: '',
  OAUTH_APP_KEY: '',
  OAUTH_APP_SECRET: '',
  OAUTH_REDIRECT_URI: '',
  OAUTH_TOKEN_URL: 'https://www.zhihu.com/api/v4/oauth/token',
  OAUTH_ME_URL: 'https://api.zhihu.com/v4/me',
  TIKA_URL: '',
  MINERU_URL: '',
  PDF_OCR: '0',
};

// 固化成"常量表"而不是内联字面量：
// 内联会把 (process.env.PDF_OCR || '1') === '1' 变成 ("0" || '1') === '1'，
// TypeScript 会报 TS2367/TS2872（类型恒真/恒假）→ 平台构建直接失败。
// 用 Record<string, string> 的常量表，类型仍是 string，所有比较都合法。
const bffSrc = path.join(WORK, 'apps', 'bff', 'src');
const frozenValues = {};
let frozen = 0;
const touched = new Map();

for (const file of walk(bffSrc)) {
  if (!/\.(ts|js)$/.test(file)) continue;
  const original = fs.readFileSync(file, 'utf8');
  let text = original;
  for (const key of new Set([...text.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]))) {
    if (ALLOWED_ENV.has(key)) continue;
    frozenValues[key] = env[key] ?? FALLBACKS[key] ?? '';
    text = text.replaceAll(`process.env.${key}`, `FROZEN_ENV.${key}`);
    frozen += 1;
  }
  if (text === original) continue;
  // 补 import（相对本文件的路径）
  const depth = path.relative(path.dirname(file), path.join(bffSrc, 'lib', 'frozen-env.js')).split(path.sep).join('/');
  const importPath = depth.startsWith('.') ? depth : './' + depth;
  text = `import { FROZEN_ENV } from '${importPath.endsWith('.js') ? importPath : importPath + '.js'}';\n` + text;
  fs.writeFileSync(file, text, 'utf-8');
  touched.set(file, true);
}

// 常量表本身
fs.writeFileSync(
  path.join(bffSrc, 'lib', 'frozen-env.ts'),
  `/**
 * 交付副本专用：运行时变量已固化为常量。
 * 云函数运行时只注入 PORT/HOST 等变量，密钥必须随源码走（明文），这是官方部署契约的要求。
 * 不要把本文件里的值提交回主仓库。
 */
export const FROZEN_ENV: Record<string, string> = ${JSON.stringify(frozenValues, null, 2)};
`,
  'utf-8'
);
log(`② 密钥固化完成（${frozen} 处读取 → ${Object.keys(frozenValues).length} 个常量，${touched.size} 个文件）`);

// 交付包不含 .env / .env.example（官方要求排除）
for (const f of ['.env', '.env.example']) {
  const p = path.join(WORK, f);
  if (fs.existsSync(p)) fs.rmSync(p);
}

// ---------- ③ HTML 页面证据（后端静态托管 HTML，需要 Agent 审查） ----------
fs.mkdirSync(path.join(WORK, '_tmp'), { recursive: true });
const indexTs = path.join(WORK, 'apps', 'bff', 'src', 'index.ts');
const indexLines = fs.readFileSync(indexTs, 'utf8').split('\n');
const serveIdx = indexLines.findIndex((l) => l.includes('serveStatic') && l.includes('app.use'));
const htmlPages = [
  {
    Path: 'apps/web/index.html',
    Reason:
      "入口注册的静态托管中间件 app.use('/*', serveStatic({ root: relativeWebRoot })) 把 apps/web 目录（含 index.html）作为 HTTP 响应返回，所有前端路由都由该文件承载",
    Evidence: [
      { File: 'apps/bff/src/index.ts', Line: serveIdx + 1, Text: indexLines[serveIdx].trim() },
      { File: 'apps/bff/src/index.ts', Line: serveIdx, Text: indexLines[serveIdx - 1].trim() },
    ],
  },
];
fs.writeFileSync(
  path.join(WORK, '_tmp', 'backend-html-pages.json'),
  JSON.stringify(htmlPages, null, 2),
  'utf-8'
);

// ---------- ④⑤⑥ 官方探测 + 生成 + 打包（全部在 WSL2 里跑） ----------
// 原因有两个：官方脚本之间是同级导入（Windows 直接跑会 ModuleNotFoundError），
// 且 scf_bootstrap 需要 0755 执行位（Windows/DrvFs 挂载设不了）。
log('③ 官方探测 + 生成 + 打包（在 WSL2 里跑）');
const wslCheck = spawnSync('wsl', ['-d', 'Ubuntu-24.04', '--', 'bash', '-lc', 'echo ok'], { encoding: 'utf8' });
if (wslCheck.status !== 0) {
  console.error('[delivery] 找不到可用的 WSL2。');
  console.error('  可选：① 装 WSL2 后重跑；② 用 Docker 跑官方脚本；③ 手工把交付目录传到 CloudBase 控制台构建。');
  process.exit(3);
}

const wslPath = (p) => '/mnt/' + p.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase()).replace(/\\/g, '/');
const packScript = path.join(WORK, '_pack_in_wsl.sh');
fs.writeFileSync(
  packScript,
  `#!/bin/bash
set -e
SKILL_SRC="${wslPath(HELPER)}"
SRC="${wslPath(WORK)}"
WORKDIR=~/zhimian-delivery
SKILLW=~/zhimian-skill
rm -rf "$WORKDIR" "$SKILLW"
cp -r "$SKILL_SRC" "$SKILLW"
cp -r "$SRC" "$WORKDIR"
cd "$WORKDIR"
find . -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true
cd "$SKILLW/scripts"

echo "--- 探测 ---"
python3 inspect_node_project.py --root "$WORKDIR" --output "$WORKDIR/_tmp/deploy-plan.json" \
  --backend-dir apps/bff --health-check-path /api/health \
  --backend-html-pages "$WORKDIR/_tmp/backend-html-pages.json"

echo "--- 校验计划 ---"
python3 validate_deploy_output.py --plan-only "$WORKDIR/_tmp"

echo "--- 生成运行时与描述符 ---"
python3 write_backend_runtime.py --project-root "$WORKDIR" --plan "$WORKDIR/_tmp/deploy-plan.json"
python3 write_deploy_descriptors.py --output-root "$WORKDIR" --plan "$WORKDIR/_tmp/deploy-plan.json" --frontend-install-cmd "npm ci"
python3 settle_agent.py --project-root "$WORKDIR" --product-code zhimian-coach --product-name "知面陪练" --product-version 0.2.0
# 注意：不要在这里跑 prepare-backend-package.js —— 那一步由平台在构建完成后执行。
# 提前跑会把根 package.json 换成运行时清单（没有 workspaces），
# 平台第 2 步的 npm run build --workspace @zhimian/bff 就会失败。

echo "--- 打包与校验 ---"
chmod +x "$WORKDIR/scf_bootstrap"
python3 create_project_archive.py --project-root "$WORKDIR" --plan "$WORKDIR/_tmp/deploy-plan.json"
python3 validate_deploy_output.py "$WORKDIR"
cp "$WORKDIR"/*.zip "${wslPath(WORK)}/"
echo "WINDOWS_ZIP_DONE"
`,
  'utf-8'
);
const wslPack = spawnSync('wsl', ['-d', 'Ubuntu-24.04', '--', 'bash', wslPath(packScript)], { encoding: 'utf8' });
const out = `${wslPack.stdout || ''}${wslPack.stderr || ''}`;
process.stdout.write(out);
if (!out.includes('WINDOWS_ZIP_DONE')) {
  console.error('[delivery] WSL 打包未完成（见上方输出）');
  process.exit(4);
}

// 收尾：把交付包与口令落到固定位置，方便上传
const zips = fs.readdirSync(WORK).filter((f) => f.endsWith('.zip'));
for (const z of zips) {
  fs.copyFileSync(path.join(WORK, z), path.join(ROOT, '.tunnel', z));
}
fs.writeFileSync(path.join(ROOT, '.tunnel', 'delivery-share-token.txt'), shareToken, 'utf-8');
log('⑦ 完成');
console.log('');
console.log('  交付包：' + zips.map((z) => path.join(ROOT, '.tunnel', z)).join(', '));
console.log('  分享口令：' + shareToken);
console.log('  上传后访问：https://<平台域名>/?k=' + shareToken);
console.log('  ⚠️ 交付包内含明文密钥：部署完成后请轮换 LLM_API_KEY 与 ZHIHU_ACCESS_SECRET，然后重跑本脚本重新生成。');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
