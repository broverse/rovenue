// =============================================================
// subscriber-identity-cache — delivery-time identity lookup cache (Task 2)
// =============================================================
//
// Mirrors services/integrations-fanout/connection-cache.ts EXACTLY (Map +
// ttlMs + loader). No invalidate/emitter here — a stale identity for up to
// SUBSCRIBER_IDENTITY_CACHE_TTL_MS is an acceptable trade-off for the
// deliver worker's hot path (same trade-off connection-cache.ts already
// makes for connection config), and nothing writes to this cache to
// invalidate against.

/** A loader-miss (null) result is cached too — a not-found subscriberId
 *  doesn't magically start existing before the TTL rolls over. */
export interface SubscriberIdentity {
  appUserId: string | null;
  attributes: Record<string, string>;
}

interface CacheEntry {
  value: SubscriberIdentity | null;
  expiresAt: number;
}

export interface SubscriberIdentityCacheOptions {
  ttlMs: number;
  loader: (subscriberId: string) => Promise<SubscriberIdentity | null>;
}

/** Same 60s window as CONNECTION_CACHE — replica lag on identity changes
 *  (a new $email attribute mutation) is bounded by this. */
export const SUBSCRIBER_IDENTITY_CACHE_TTL_MS = 60_000;

export function createSubscriberIdentityCache(opts: SubscriberIdentityCacheOptions) {
  const store = new Map<string, CacheEntry>();

  async function get(subscriberId: string): Promise<SubscriberIdentity | null> {
    const entry = store.get(subscriberId);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    const value = await opts.loader(subscriberId);
    store.set(subscriberId, { value, expiresAt: Date.now() + opts.ttlMs });
    return value;
  }

  return { get };
}

export type SubscriberIdentityCache = ReturnType<typeof createSubscriberIdentityCache>;
