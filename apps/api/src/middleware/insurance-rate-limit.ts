// Tiny in-process sliding window counter. Used as a safety net when
// the Redis-backed limiter trips on infra errors. The cap is
// intentionally lower than any Redis-backed preset — this is not
// policy enforcement, it's server protection against uncontrolled
// traffic while Redis is unavailable.
//
// Behaviour:
//   - First request for a key starts a new 1-minute window.
//   - Subsequent requests in the window increment the count.
//   - Once the count exceeds INSURANCE_MAX, consume() returns false.
//   - After the window rolls over (window start older than
//     INSURANCE_WINDOW_MS), the next request starts a fresh window.
//
// Memory bound: one entry per distinct key within the active window.
// Stale buckets age out on next access; there is no sweeper. If a
// process sees hundreds of thousands of distinct IPs in a minute,
// the map grows accordingly — but by then Redis-backed limiting is
// presumably active again.

interface Bucket {
  windowStart: number;
  count: number;
}

const INSURANCE_WINDOW_MS = 60_000;
const INSURANCE_MAX = 50;

const buckets = new Map<string, Bucket>();

export function insuranceConsume(key: string): boolean {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart >= INSURANCE_WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  existing.count += 1;
  return existing.count <= INSURANCE_MAX;
}

export function __resetInsurance(): void {
  buckets.clear();
}
