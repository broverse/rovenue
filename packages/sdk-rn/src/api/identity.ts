import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import type { User } from "../types";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

/**
 * Current identity — the anonymous `rovenueId` plus `appUserId` once
 * {@link identify} has been called. Resolves from local state; does not
 * hit the network. Prefer the `useCurrentUser` hook in components.
 */
export async function currentUser(): Promise<User> {
  return call(() => getNative().currentUser());
}

/**
 * Link the anonymous device identity to `appUserId`. The local write
 * always succeeds and fires `IDENTITY_CHANGED`; the `POST /v1/identify`
 * to the server is best-effort — if it fails (offline/5xx) the link is
 * retried automatically later, not surfaced as an error here. Rejects
 * only on validation failure (e.g. a blank id).
 */
export async function identify(appUserId: string): Promise<void> {
  return call(() => getNative().identify(appUserId));
}

/**
 * Log out the current user: mints a fresh anonymous `rovenueId`, drops
 * `appUserId`, and clears scope-bound local state (buffered session
 * events, attributes, the Apple `appAccountToken`) so the next identity
 * starts clean. Client-local only — does not contact the server.
 */
export async function logOut(): Promise<void> {
  return call(() => getNative().logOut());
}
