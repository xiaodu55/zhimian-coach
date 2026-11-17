/**
 * 一键重启本地后端：先杀掉占用端口的旧实例（避免"两个实例抢 8787"导致页面打到旧代码），
 * 再以当前代码启动一个，并等 /api/health 通过后才算完成。
 *
 * 用法：npm run dev:restart        （默认 8787）
 *       npm run dev:restart -- 8899
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.argv[2]) || 8787;
const isWindows = process.platform === 'win32';

/** 找出监听指定端口的 PID（Windows 用 netstat） */
function pidsOnPort(port) {
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  if (!out.stdout) return [];
  const pids = new Set();
  for (const line of out.stdout.split(/\r?\n/)) {
    if (!new RegExp(`[:.]${port}\\s`).test(line) || !/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

function killPid(pid) {
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  console.log(`[dev:restart] 已结束占用端口的进程 pid=${pid}`);
}

async function waitHealthy(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const data = await res.json();
        return data;
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  const old = pidsOnPort(PORT);
  if (old.length) {
    console.log(`[dev:restart] 端口 ${PORT} 被 ${old.length} 个进程占用，先清理`);
    for (const pid of old) killPid(pid);
    await new Promise((r) => setTimeout(r, 1200));
  }

  const child = spawn(process.execPath, ['apps/bff/dist/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CACHE_PERSIST: process.env.CACHE_PERSIST ?? '1' },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`[dev:restart] 已拉起新实例 pid=${child.pid} port=${PORT}`);

  const health = await waitHealthy(PORT);
  if (!health) {
    console.error('[dev:restart] 启动超时：请看 apps/bff/dist 运行日志');
    process.exit(1);
  }
  console.log('[dev:restart] 健康检查通过：', JSON.stringify(health));
}

main();
