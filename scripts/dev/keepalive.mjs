#!/usr/bin/env node
/**
 * 本机保活：盯住「BFF 服务」和「公网隧道」，任一挂掉就自动拉起。
 *
 * 为什么需要：trycloudflare 隧道依赖本机进程，电脑休眠 / 进程被杀 → 演示链接直接 530。
 * 这个脚本适合"演示当天临时保命"，**正式提交请用 docs/部署指南.md 里的 AiWorks / CloudBase / 云主机**。
 *
 * 用法：node scripts/dev/keepalive.mjs
 * 开机自启：powershell -ExecutionPolicy Bypass -File scripts/dev/install-autostart.ps1
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT || 8787);
const HEALTH = `http://127.0.0.1:${PORT}/api/health`;
const LOG_DIR = path.join(ROOT, '.tunnel');

fs.mkdirSync(LOG_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(HEALTH, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function startBff() {
  const log = fs.openSync(path.join(LOG_DIR, 'bff.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'bff', 'dist', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', log, log],
  });
  child.on('exit', (code) => console.log(`[keepalive] BFF 退出（code=${code}），3 秒后重启`));
  return child;
}

function startCpolar() {
  const bin = process.env.CPOLAR_BIN || 'D:/college/cpolar/cpolar.exe';
  if (!fs.existsSync(bin)) return null;
  const log = fs.openSync(path.join(LOG_DIR, 'cpolar.log'), 'a');
  const child = spawn(bin, ['start', 'zhimian', '--log=stdout'], {
    cwd: ROOT,
    stdio: ['ignore', log, log],
  });
  child.on('exit', (code) => console.log(`[keepalive] cpolar 退出（code=${code}），5 秒后重启`));
  return child;
}

function startTunnel() {
  const log = fs.openSync(path.join(LOG_DIR, 'tunnel.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev', 'tunnel.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', log, log],
  });
  child.on('exit', (code) => console.log(`[keepalive] 隧道退出（code=${code}），5 秒后重启`));
  return child;
}

console.log(`[keepalive] 监控 ${HEALTH}｜日志目录 ${LOG_DIR}`);

let bff = startBff();
// 等 BFF 起来再拉隧道
for (let i = 0; i < 20 && !(await alive()); i++) await sleep(500);
let tunnel = startTunnel();
// cpolar 命名隧道：域名固定（重启不变），比 trycloudflare 适合当提交链接
let cpolar = startCpolar();

let lastUrl = '';
setInterval(async () => {
  if (!(await alive())) {
    console.log('[keepalive] BFF 不在 → 重启');
    try {
      bff.kill();
    } catch {
      /* ignore */
    }
    bff = startBff();
    await sleep(3000);
  }
  if (!tunnel || tunnel.exitCode !== null) {
    console.log('[keepalive] 隧道不在 → 重启');
    tunnel = startTunnel();
  }
  if (cpolar && cpolar.exitCode !== null) {
    console.log('[keepalive] cpolar 不在 → 重启');
    cpolar = startCpolar();
  }
  // 把当前公网地址打印出来，方便复制（每次隧道重启地址都会变）
  try {
    const log = fs.readFileSync(path.join(LOG_DIR, 'tunnel.log'), 'utf8');
    try {
      const cp = fs.readFileSync(path.join(LOG_DIR, 'cpolar.log'), 'utf8');
      const cpUrl = [...cp.matchAll(/https:\/\/[a-z0-9.-]+\.cpolar\.[a-z]+/g)].map((m) => m[0]).pop();
      if (cpUrl && cpUrl !== lastUrl) {
        lastUrl = cpUrl;
        console.log(`[keepalive] 固定域名（cpolar，重启不变）：${cpUrl}`);
      }
    } catch {
      /* ignore */
    }
    const urls = [...log.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)].map((m) => m[0]);
    const latest = urls[urls.length - 1];
    if (latest && latest !== lastUrl) {
      lastUrl = latest;
      console.log(`[keepalive] 当前公网地址：${latest}`);
    }
  } catch {
    /* ignore */
  }
}, 60_000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    bff.kill();
    tunnel.kill();
    cpolar?.kill();
    process.exit(0);
  });
}
