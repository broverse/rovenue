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
// Stale buckets age out on same-key access, and an opportunistic
// sweep runs once the Map crosses SWEEP_THRESHOLD — that caps
// amortized memory during a runaway Redis outage with high key
// churn (e.g. DDoS probe from many IPs).

interface Bucket {
  windowStart: number;
  count: number;
}

const INSURANCE_WINDOW_MS = 60_000;
const INSURANCE_MAX = 50;
// Kick off an opportunistic stale-bucket sweep whenever the Map
// exceeds this size. The sweep itself is O(n) — bounded by the
// growth rate of distinct keys during a Redis outage. 10k gives
// plenty of headroom before memory matters.
const SWEEP_THRESHOLD = 10_000;

const buckets = new Map<string, Bucket>();

function maybeSweepStale(now: number): void {
  if (buckets.size < SWEEP_THRESHOLD) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= INSURANCE_WINDOW_MS) {
      buckets.delete(key);
    }
  }
}

export function insuranceConsume(key: string): boolean {
  const now = Date.now();
  maybeSweepStale(now);
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
