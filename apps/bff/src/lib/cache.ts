import crypto from 'node:crypto';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * 缓存：**纯内存**。
 *
 * 为什么去掉落盘：官方 AI Works / CloudBase 走的是云函数运行时，文件系统只读（/tmp 除外），
 * 官方部署探测会因此判定 `E_DISK_WRITE_FORBIDDEN` / `E_LOCAL_PERSISTENCE` 直接阻断交付。
 * 代价是进程重启后知乎检索缓存要重新预热（每天配额本来也只有几十次，可接受）。
 */
const memoryCache = new Map<string, CacheEntry<unknown>>();

export function sha1Key(prefix: string, raw: string): string {
  const hash = crypto.createHash('sha1').update(raw.trim().toLowerCase()).digest('hex');
  return `${prefix}:${hash}`;
}

export function getCache<T>(key: string): T | null {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return hit.value as T;
}

/** 过期也能用（熔断/配额耗尽时的兜底）——调用方负责标注"用的是旧数据" */
export function getStaleCache<T>(key: string): T | null {
  const hit = memoryCache.get(key);
  return hit ? (hit.value as T) : null;
}

export function setCache<T>(key: string, value: T, ttlMs: number): void {
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function cacheStats(): { entries: number; persist: boolean; file: string } {
  // persist 恒为 false：纯内存缓存，进程重启即丢（云函数文件系统只读，写盘会被部署探测阻断）
  return { entries: memoryCache.size, persist: false, file: '' };
}
