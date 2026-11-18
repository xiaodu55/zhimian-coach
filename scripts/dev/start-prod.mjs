#!/usr/bin/env node
/**
 * 生产启动入口（给 AiWorks / CloudBase / 任意平台的「启动命令」用）。
 *
 * 平台只会给一个启动命令，它不保证先跑构建。所以这里自己判断：
 *   - dist/index.js 不存在 → 先用 tsc 构建（tsc 在 devDependencies 里）
 *   - 存在 → 直接起
 * 端口读 PORT（平台一般会注入），静态站与 API 同域同端口，不需要额外的 nginx。
 */
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BFF = path.join(ROOT, 'apps', 'bff');
const ENTRY = path.join(BFF, 'dist', 'index.js');

if (!fs.existsSync(ENTRY)) {
  console.log('[start-prod] 没找到构建产物，先编译 TypeScript…');
  const build = spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], {
    cwd: BFF,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) {
    console.error('[start-prod] 构建失败（tsc 非零退出）');
    process.exit(build.status ?? 1);
  }
}

if (!fs.existsSync(ENTRY)) {
  console.error('[start-prod] 构建后仍找不到 dist/index.js');
  process.exit(1);
}

const port = process.env.PORT || '8787';
console.log(`[start-prod] 启动知面陪练 BFF，监听 ${port}`);

const child = spawn(process.execPath, [ENTRY], {
  cwd: BFF,
  env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production', PORT: port },
  stdio: 'inherit',
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code) => process.exit(code ?? 0));
