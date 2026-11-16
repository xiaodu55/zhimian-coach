import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * 缓存：内存 + 可选落盘。
 * 目的：知乎公开内容（搜索结果）在进程重启后仍可复用，少烧配额。
 *
 * 诚实边界：容器（CloudBase / FC）文件系统是临时的，重启即丢；
 * 想真正持久化必须挂载持久卷。所以默认只在非生产或显式开启时落盘：
 *   CACHE_PERSIST=1 且 CACHE_DIR 可写。
 */
const CACHE_DIR = process.env.CACHE_DIR || path.resolve(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'zhihu-public-cache.json');
const PERSIST = process.env.CACHE_PERSIST === '1';
const memoryCache = new Map<string, CacheEntry<unknown>>();

if (PERSIST) {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Record<string, CacheEntry<unknown>>;
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v.expiresAt === 'number') memoryCache.set(k, v);
      }
    }
  } catch {
    // 缓存损坏不应阻塞启动
  }
}

let flushTimer: NodeJS.Timeout | null = null;
let dirty = false;

function scheduleFlush() {
  dirty = true;
  if (flushTimer || !PERSIST) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const obj: Record<string, unknown> = {};
      for (const [k, v] of memoryCache) obj[k] = v;
      fs.writeFileSync(CACHE_FILE, JSON.stringify(obj), 'utf-8');
    } catch {
      // 只读文件系统（容器）时静默跳过：内存缓存仍然生效
    }
  }, 800);
  flushTimer.unref?.();
}

/** 进程退出前落盘（容器 SIGTERM 场景） */
if (PERSIST) {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      if (!dirty) return;
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const obj: Record<string, unknown> = {};
        for (const [k, v] of memoryCache) obj[k] = v;
        fs.writeFileSync(CACHE_FILE, JSON.stringify(obj), 'utf-8');
      } catch {
        /* 忽略 */
      }
    });
  }
}

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
  scheduleFlush();
}

export function cacheStats(): { entries: number; persist: boolean; file: string } {
  return { entries: memoryCache.size, persist: PERSIST, file: CACHE_FILE };
}
