import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import type { Entitlement } from "../types";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

/**
 * Look up one entitlement by id from the native SDK's local cache — resolves
 * from disk/memory, not a network round trip. `null` when the id is unknown
 * or not currently granted. A stale (>30s) cache triggers a background
 * refresh on the native side; never call `refreshEntitlements()` from an
 * `ENTITLEMENTS_CHANGED` listener that refresh fires, or it loops.
 */
export async function entitlement(id: string): Promise<Entitlement | null> {
  return call(() => getNative().entitlement(id));
}

/**
 * All currently-granted entitlements from the native SDK's local cache — a
 * cache read, not a network call. Same background staleness-refresh
 * behaviour and `ENTITLEMENTS_CHANGED` re-entrancy footgun as
 * {@link entitlement}. Prefer the `useEntitlements` hook in components.
 */
export async function entitlementsAll(): Promise<Entitlement[]> {
  return call(() => getNative().entitlementsAll());
}

/**
 * Force a network refresh of entitlements, bypassing the 30s staleness
 * window that {@link entitlement}/{@link entitlementsAll} use. Never call
 * this from inside an `ENTITLEMENTS_CHANGED` listener — the refresh
 * re-emits that same event, which re-invokes the listener, forever.
 */
export async function refreshEntitlements(): Promise<void> {
  return call(() => getNative().refreshEntitlements());
}
