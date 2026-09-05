// =============================================================
// Storage seam
// =============================================================
//
// The SDK persists two things across page loads: the generated rovenueId and
// the unsent event queue. Both need somewhere to live, and that somewhere is
// not always available.
//
// This module defines the seam only. The browser-backed implementation, and
// the reasons `localStorage` cannot simply be used directly, live in the
// storage implementation added alongside the entitlement cache.

export interface SdkStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * In-memory storage. The default, and the fallback whenever a real store is
 * unavailable.
 *
 * Nothing here throws: a viewer whose browser refuses storage must still get
 * a working SDK, just one that forgets between page loads.
 */
export function createMemoryStorage(): SdkStorage {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

const PROBE_KEY = "rovenue.__probe";

/**
 * Storage backed by `localStorage` where it works, memory where it does not.
 *
 * `localStorage` fails in three different ways and only the first is caught
 * by asking whether it is defined:
 *
 *   1. **Absent** — server-side rendering. This is why the probe runs on
 *      first use and never at module scope: an access during import throws
 *      before any consumer could guard it.
 *   2. **Present but throwing** — Safari private mode, and browsers with
 *      site data blocked. `typeof localStorage` is `"object"` and the first
 *      write raises.
 *   3. **Present and full** — a quota error on a write, long after the probe
 *      said everything was fine. So every operation is guarded, not just the
 *      probe: a store that passed once can still fail later.
 *
 * A failed write drops the value and returns. Losing a cached entitlement is
 * a lost convenience; taking the host application down over it is not a
 * trade the SDK gets to make on the developer's behalf.
 */
export function createStorage(): SdkStorage {
  const memory = createMemoryStorage();

  let backing: Storage | null = null;
  try {
    const candidate = globalThis.localStorage;
    if (candidate) {
      // Write-then-remove rather than a read: a store can be readable and
      // refuse writes, which is exactly case 2.
      candidate.setItem(PROBE_KEY, "1");
      candidate.removeItem(PROBE_KEY);
      backing = candidate;
    }
  } catch {
    backing = null;
  }

  if (!backing) return memory;
  const store = backing;

  return {
    get(key) {
      try {
        // `?? memory.get` and not just the try/catch: a FULL localStorage
        // refuses writes while `getItem` returns null without throwing, so a
        // value that fell back to memory on write was unreachable on read.
        // That silently dropped queued events in the module that documents
        // at-least-once delivery.
        return store.getItem(key) ?? memory.get(key);
      } catch {
        return memory.get(key);
      }
    },
    set(key, value) {
      try {
        store.setItem(key, value);
      } catch {
        // Quota, or storage revoked mid-session. Keep it in memory so the
        // value survives this page at least.
        memory.set(key, value);
      }
    },
    remove(key) {
      try {
        store.removeItem(key);
      } catch {
        // Nothing to do: the key is unreachable either way.
      }
      memory.remove(key);
    },
  };
}
