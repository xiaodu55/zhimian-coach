#!/usr/bin/env node
/**
 * 公网体验链接：Cloudflare 快速隧道（trycloudflare.com），无需账号、免下载二进制。
 *
 *   pnpm tunnel          # 前置：pnpm dev:restart（本地服务跑在 8787）
 *
 * 会在控制台打印形如 https://xxxx-xxxx-xxxx.trycloudflare.com 的公网地址。
 * 隧道进程退出即失效；演示完直接 Ctrl+C 关闭（公网期间任何拿到链接的人都能用你的模型额度）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = process.env.PORT || '8787';
const LOCAL = `http://127.0.0.1:${PORT}`;

/** 找 cloudflared：优先 npm 内置的打包版，其次系统 PATH */
function findBinary() {
  const win = path.join(ROOT, 'node_modules', '@botharness', 'cloudflared-win32-x64', 'bin', 'cloudflared.exe');
  const linux = path.join(ROOT, 'node_modules', '@botharness', 'cloudflared-linux-x64', 'bin', 'cloudflared');
  const bundled = path.join(ROOT, 'tools', 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  for (const p of [win, linux, bundled]) {
    if (existsSync(p)) return p;
  }
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

async function ensureServer() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${LOCAL}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

if (!(await ensureServer())) {
  console.error(`[tunnel] 本地服务没起来（${LOCAL}/api/health 无响应）。先执行：pnpm dev:restart`);
  process.exit(1);
}

const bin = findBinary();
console.log(`[tunnel] 使用二进制：${bin}`);
console.log(`[tunnel] 本地服务：${LOCAL}（已就绪）`);
console.log('[tunnel] 正在申请 Cloudflare 快速隧道，稍等十几秒…\n');

const child = spawn(bin, ['tunnel', '--url', LOCAL, '--no-autoupdate', '--loglevel', 'info'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

// 真实分配到的是三段随机主机名（如 a-b-c.trycloudflare.com）；
// 单段的是 cloudflared 自己在日志里提到的 api.trycloudflare.com，别认错
const URL_RE = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+){2,}\.trycloudflare\.com/;
let printed = false;

const onLine = (buf) => {
  const text = buf.toString();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!printed && URL_RE.test(line)) {
      printed = true;
      const url = line.match(URL_RE)[0];
      console.log('\n============================================');
      console.log(`  公网体验链接： ${url}`);
      console.log(`  本机地址：     ${LOCAL}`);
      console.log('  演示结束按 Ctrl+C 关闭隧道');
      console.log('============================================\n');
    }
  }
};

child.stdout.on('data', onLine);
child.stderr.on('data', onLine);

child.on('exit', (code) => {
  console.error(`[tunnel] 隧道进程退出（code=${code}）。公网链接已失效。`);
  process.exit(code ?? 1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill();
    process.exit(0);
  });
}
