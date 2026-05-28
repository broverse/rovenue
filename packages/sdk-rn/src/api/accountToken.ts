import { getNative } from "../core/native";
import { mapNativeError } from "../errors";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

/**
 * Returns a stable per-subscriber UUID. Pass this to your StoreKit2
 * `Product.purchase(options:)` call as `.appAccountToken(uuid)` on iOS,
 * and to `BillingFlowParams.Builder.setObfuscatedAccountId(token)` on
 * Android. The same UUID is reused for the lifetime of the install
 * (and bound to the current SDK user — calling `identify()` first
 * changes the scope so the next `getAppAccountToken()` returns a
 * different UUID for the now-known user).
 *
 * Storage is the Rust core's SQLite cache (not MMKV) — survives JS
 * reloads but is wiped on app reinstall, matching Apple's documented
 * `appAccountToken` semantics.
 */
export async function getAppAccountToken(): Promise<string> {
  return call(() => getNative().getAppAccountToken());
}
