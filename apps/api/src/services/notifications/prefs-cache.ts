import { LRUCache } from "lru-cache";
import type { Redis } from "ioredis";
import { logger } from "../../lib/logger";

// =============================================================
// prefs-cache — notifier hot-path memoization
// =============================================================
//
// processNotification fans a single Kafka message out to N
// recipients; for each recipient it reads three pieces of state:
//
//   - userPrefs:        user_preferences row (channels + locale + tz)
//   - projectDefaults:  project_notification_defaults row
//   - projectMembers:   project_members rows for a given (project, role[])
//
// All three are tiny, change-rarely-and-fan-out-wide records. We
// memoize them in a per-process LRU with a 60s TTL and invalidate
// eagerly via a Redis pub/sub channel — when the dashboard mutates
// any of these, it publishes a `{kind, key}` message and every
// notifier instance drops the stale entry.
//
// The cache values are intentionally `object` — the caller knows
// the shape and casts on read. Keeping the cache untyped means a
// single LRU can serve heterogeneous shapes without a type-system
// gymnastics over a discriminated union. LRUCache v11 forbids
// `unknown` (it requires the value to extend `{}`), so `object` is
// the closest opaque value type that compiles cleanly.

const log = logger.child("notifier.prefs-cache");

export const PREFS_CACHE_CHANNEL = "notifications.cache.invalidate";

export type PrefsCacheKind = "userPrefs" | "projectDefaults" | "projectMembers";

export interface InvalidationMessage {
  kind: PrefsCacheKind;
  key: string;
}

export interface PrefsCache {
  userPrefs: LRUCache<string, object>;
  projectDefaults: LRUCache<string, object>;
  projectMembers: LRUCache<string, object>;
  /** Disconnect the dedicated subscriber connection. */
  close: () => Promise<void>;
}

export interface CreatePrefsCacheOptions {
  max?: number;
  ttlMs?: number;
}

export function createPrefsCache(
  redis: Redis,
  opts: CreatePrefsCacheOptions = {},
): PrefsCache {
  const max = opts.max ?? 5000;
  const ttl = opts.ttlMs ?? 60_000;

  const cache: Omit<PrefsCache, "close"> = {
    userPrefs: new LRUCache<string, object>({ max, ttl }),
    projectDefaults: new LRUCache<string, object>({ max, ttl }),
    projectMembers: new LRUCache<string, object>({ max, ttl }),
  };

  // Dedicated connection for SUBSCRIBE — ioredis forbids regular
  // commands once a connection enters subscribe mode, so we clone
  // the main client and use the duplicate exclusively for pubsub.
  // duplicate() inherits the parent's options (including lazyConnect
  // and enableOfflineQueue:false in this codebase), so we explicitly
  // open the connection before SUBSCRIBE to avoid the SUBSCRIBE being
  // rejected against an unconnected client.
  const sub = redis.duplicate();
  void (async () => {
    try {
      if (sub.status !== "ready" && sub.status !== "connecting") {
        await sub.connect();
      }
      await sub.subscribe(PREFS_CACHE_CHANNEL);
    } catch (err: unknown) {
      log.error("subscribe_failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  sub.on("message", (channel: string, raw: string) => {
    if (channel !== PREFS_CACHE_CHANNEL) return;
    let msg: InvalidationMessage;
    try {
      msg = JSON.parse(raw) as InvalidationMessage;
    } catch (err) {
      log.warn("invalidation_parse_failed", {
        err: err instanceof Error ? err.message : String(err),
        rawPreview: raw.slice(0, 200),
      });
      return;
    }
    applyInvalidation(cache, msg);
  });

  const close = async (): Promise<void> => {
    try {
      await sub.unsubscribe(PREFS_CACHE_CHANNEL);
    } catch {
      // best-effort
    }
    sub.disconnect();
  };

  return { ...cache, close };
}

// Exported so unit tests can drive the invalidation path without
// having to stand up a real Redis pub/sub roundtrip.
export function applyInvalidation(
  cache: Pick<PrefsCache, "userPrefs" | "projectDefaults" | "projectMembers">,
  msg: InvalidationMessage,
): void {
  switch (msg.kind) {
    case "userPrefs":
      cache.userPrefs.delete(msg.key);
      return;
    case "projectDefaults":
      cache.projectDefaults.delete(msg.key);
      return;
    case "projectMembers":
      // projectMembers keys are composites of `<projectId>:<rolesHash>`
      // so a single projectId invalidation must drop every key that
      // starts with `<projectId>:`. LRUCache#keys() is a snapshot
      // iterator so deleting during iteration is safe.
      for (const k of cache.projectMembers.keys()) {
        if (typeof k === "string" && k.startsWith(`${msg.key}:`)) {
          cache.projectMembers.delete(k);
        }
      }
      return;
  }
}

export async function publishInvalidation(
  redis: Redis,
  kind: PrefsCacheKind,
  key: string,
): Promise<void> {
  await redis.publish(
    PREFS_CACHE_CHANNEL,
    JSON.stringify({ kind, key } satisfies InvalidationMessage),
  );
}
