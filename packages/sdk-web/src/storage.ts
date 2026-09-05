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
