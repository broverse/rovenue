import type { SdkStorage } from "./storage";

// =============================================================
// Last-known entitlements
// =============================================================
//
// The web analogue of the native SDKs' MMKV / SQLite cache. Its job is to let
// a page render something truthful before the network answers, and to keep
// rendering it when the network does not answer at all.
//
// What it is NOT is an authorization decision. A cached entitlement is a
// statement about what the server said last time, held in storage the viewer
// can edit freely. Anything that must actually be enforced is enforced on the
// server; this exists so a returning subscriber does not see a flash of the
// paywall they already paid to remove.

const CACHE_KEY = "rovenue.entitlements";

export interface CachedEntitlements {
  entitlements: Record<string, unknown>;
  /** Epoch millis of the response this came from. */
  fetchedAt: number;
}

export interface EntitlementCache {
  read(): CachedEntitlements | null;
  write(entitlements: Record<string, unknown>): void;
  clear(): void;
}

export function createEntitlementCache(
  storage: SdkStorage,
  now: () => number = Date.now,
): EntitlementCache {
  return {
    read() {
      const raw = storage.get(CACHE_KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as CachedEntitlements;
        // Storage is viewer-editable, so the shape is checked rather than
        // trusted. A malformed entry is treated as no entry: the SDK falls
        // back to the network instead of handing the caller a broken object.
        if (
          !parsed ||
          typeof parsed !== "object" ||
          typeof parsed.fetchedAt !== "number" ||
          typeof parsed.entitlements !== "object" ||
          parsed.entitlements === null
        ) {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    },
    write(entitlements) {
      storage.set(
        CACHE_KEY,
        JSON.stringify({ entitlements, fetchedAt: now() }),
      );
    },
    clear() {
      storage.remove(CACHE_KEY);
    },
  };
}
