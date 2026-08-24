import type { RetryPolicy } from "./types";

// Lives in its own module (rather than inline in queues/integrations.ts or
// providers/custom-webhook.ts) to avoid a circular import: queues/integrations.ts
// depends on registry.ts (for getProvider/providerIds), registry.ts depends on
// custom-webhook.ts, and custom-webhook.ts needs WEBHOOK_RETRY_POLICY. Putting
// the constants here — with no dependency on registry.ts — lets both sides
// import them directly. queues/integrations.ts re-exports these so callers can
// keep importing DEFAULT_RETRY_POLICY / WEBHOOK_RETRY_POLICY from "./integrations".

// Fallback policy for any provider that doesn't declare its own
// `retryPolicy` (META_CAPI, TIKTOK_EVENTS). 30s → 2m → 10m → 1h → 6h.
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 5,
  backoffMs: [30_000, 120_000, 600_000, 3_600_000, 21_600_000],
};

// CUSTOM_WEBHOOK's policy — receivers like Svix (~17h) and RevenueCat
// (~1 day) keep retrying for roughly a day, so ours needs comparable
// wall-clock coverage: 30s+2m+10m+1h+6h+12h+12h = 112,350,000ms ≈ 31.2h ≥ 24h.
export const WEBHOOK_RETRY_POLICY: RetryPolicy = {
  attempts: 8,
  backoffMs: [
    30_000, 120_000, 600_000, 3_600_000, 21_600_000, 43_200_000, 43_200_000,
  ],
};
