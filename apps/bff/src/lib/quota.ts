/**
 * §13 配额与熔断器：按自然日重置配额；连续 5 次上游失败熔断 60s
 */
const dailyCounters = new Map<string, { day: string; count: number }>();

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function consumeQuota(bucket: string, limit: number): boolean {
  const day = todayStr();
  const cur = dailyCounters.get(bucket);
  if (!cur || cur.day !== day) {
    dailyCounters.set(bucket, { day, count: 1 });
    return true;
  }
  if (cur.count >= limit) {
    return false;
  }
  cur.count += 1;
  return true;
}

export function isCircuitOpen(): boolean {
  if (circuitOpenUntil === 0) return false;
  if (Date.now() > circuitOpenUntil) {
    circuitOpenUntil = 0;
    consecutiveFailures = 0;
    return false;
  }
  return true;
}

export function recordUpstreamSuccess(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

export function recordUpstreamFailure(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= 5) {
    circuitOpenUntil = Date.now() + 60_000;
  }
}
