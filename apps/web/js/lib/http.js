/**
 * 带退避重试的 fetch。
 *
 * 为什么要重试：AI Works / CloudBase 的 HTTP 网关单次请求约 15 秒上限，
 * 且云函数冷启动时实例并发不够 —— 第一次请求可能整条失败（554 空响应 / 连接中断）。
 * 实例预热之后同样的请求几秒就成功，所以失败重试能把"静默降级"变成"正常出结果"。
 *
 * 4xx 属于业务错误（参数错、无权限），重试没有意义，直接把响应交回调用方。
 */
export async function fetchWithRetry(
  url,
  options = {},
  { attempts = 3, backoffMs = 800, onRetry = null } = {}
) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || res.status < 500) return res;
      lastErr = new Error('HTTP ' + res.status);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < attempts) {
      onRetry?.(attempt);
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }
  throw lastErr ?? new Error('请求失败');
}

/**
 * 带退避重试的动态 import。
 * 网关会限流并发请求（429），运行时按需加载的模块偶尔会被掐掉，
 * 重试一次即可（模块本身不大，几 KB）。
 */
export async function importWithRetry(path, { attempts = 3, backoffMs = 600 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await import(/* @vite-ignore */ path);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
  }
  throw lastErr ?? new Error('模块加载失败：' + path);
}
