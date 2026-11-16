import crypto from 'node:crypto';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

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

export function getStaleCache<T>(key: string): T | null {
  const hit = memoryCache.get(key);
  return hit ? (hit.value as T) : null;
}

export function setCache<T>(key: string, value: T, ttlMs: number): void {
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}
