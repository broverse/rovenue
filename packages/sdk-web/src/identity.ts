import { createId } from "@paralleldrive/cuid2";
import type { SdkStorage } from "./storage";

// =============================================================
// Identity
// =============================================================
//
// Two ids, and conflating them has already cost this codebase real breakage:
//
//   rovenueId — the SDK's own permanent identifier for this browser. It is
//               what goes on the wire, always. Generated once, persisted,
//               regenerated on logOut().
//
//   app scope — whatever the host application called this person via
//               identify(). It is CLIENT-LOCAL. It is not sent as the
//               identity header, and merging two subscribers is a
//               server-side operation through the secret-key transfer
//               endpoint, not something a public browser key may do.
//
// Sending the app scope on the wire instead of the rovenueId is what
// produced orphan-subscriber routing before. The wire identity is the
// rovenueId; there is no configuration that changes that.

const ROVENUE_ID_KEY = "rovenue.rovenueId";

/**
 * Rough shape of an email address. Used only to warn, never to reject.
 *
 * The SDK's auth model rests on the app user id being unguessable: a public
 * key is visible in the browser, so anyone who can guess an id can read that
 * subscriber's entitlements. An email is the most common guessable id a
 * developer reaches for, so it earns a warning at the moment it is passed.
 *
 * It warns rather than throws because the server does not enforce this, and
 * breaking an application mid-flight over a policy its backend accepts would
 * be the SDK overreaching.
 */
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Identity {
  /** The permanent wire identity for this browser. */
  rovenueId(): string;
  /** The host application's own name for this person, if it set one. */
  appUserScope(): string | null;
  identify(appUserId: string): void;
  /** Forgets both, and mints a fresh rovenueId. */
  logOut(): void;
}

export function createIdentity(
  storage: SdkStorage,
  warn: (message: string) => void = (m) => console.warn(m),
): Identity {
  let cached = storage.get(ROVENUE_ID_KEY);
  if (!cached) {
    cached = createId();
    storage.set(ROVENUE_ID_KEY, cached);
  }
  let scope: string | null = null;

  return {
    rovenueId: () => cached as string,
    appUserScope: () => scope,
    identify(appUserId: string) {
      if (EMAIL_SHAPED.test(appUserId)) {
        warn(
          "[rovenue] identify() was given an email address. App user ids are " +
            "guessable identifiers to anyone holding your public key, which " +
            "is visible in the browser. Use an opaque id your backend maps " +
            "to the user instead.",
        );
      }
      scope = appUserId;
    },
    logOut() {
      scope = null;
      cached = createId();
      storage.set(ROVENUE_ID_KEY, cached);
    },
  };
}
