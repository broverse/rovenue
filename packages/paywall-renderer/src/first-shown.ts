import { COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX } from "@rovenue/shared/paywall";

// =============================================================
// The web's half of the cross-platform `durationSeconds` anchor.
//
// A `durationSeconds` countdown counts down from the instant the paywall was
// FIRST shown to this user — persisted, so it survives a reload. iOS keeps
// that instant in `UserDefaults` and Android in `SharedPreferences`, both
// under `COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX + <anchor id>`; this is the same
// thing over `localStorage`, same prefix and same shape.
//
// What the SUFFIX means is per-host, and deliberately not assumed to be the
// same everywhere. The SDKs have a `paywall.paywallIdentifier` to hand and
// use it. A web host that does not — the funnel runner has only the funnel
// config's paywall key, never an identifier — passes its own id, SCOPED so
// the two id spaces cannot land on the same key inside one origin (see
// `FUNNEL_PAYWALL_ANCHOR_SCOPE` in `funnel-runner.tsx`). The prefix is
// shared; the suffix is the caller's to make unambiguous. Hence the
// parameter below is named for the anchor, not for an identifier it is not
// guaranteed to be.
//
// It lives here rather than inside `PaywallRenderer` on purpose: the
// renderer is presentational and has no storage of its own, and an AUTHORING
// surface (the builder canvas) must NOT persist — see the note on the
// `firstShownAt` prop and canvas.tsx. Hosts that want the real deadline call
// this and pass the result in.
// =============================================================

/** Prefix is the same value on all three platforms; the suffix identifies one
 *  paywall, so every countdown node on it shares one anchor. An absent
 *  anchor id collapses to the empty suffix, as the natives do. */
function storageKey(paywallAnchorId: string | null | undefined): string {
  return COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX + (paywallAnchorId ?? "");
}

/**
 * The persisted "first shown" instant for `paywallAnchorId`: stamps `now`
 * and stores it on the first call, reads the stored value back on every
 * later call (this page load or any future one).
 *
 * Returns `undefined` — never throws — when there is no usable
 * `localStorage` (server render, privacy mode, a full quota). The renderer
 * then falls back to mount time, which is exactly the behaviour before this
 * existed: degraded, not broken.
 */
export function resolvePersistedFirstShownAt(
  paywallAnchorId: string | null | undefined,
  now: Date = new Date(),
): Date | undefined {
  let storage: Storage;
  try {
    if (typeof localStorage === "undefined") return undefined;
    storage = localStorage;
  } catch {
    // Accessing `localStorage` itself throws in some blocked-cookie modes.
    return undefined;
  }

  const key = storageKey(paywallAnchorId);
  try {
    const existing = storage.getItem(key);
    if (existing !== null) {
      const parsed = Number(existing);
      // A corrupt value re-stamps rather than producing an Invalid Date that
      // would make every deadline on the paywall NaN.
      if (Number.isFinite(parsed)) return new Date(parsed);
    }
    storage.setItem(key, String(now.getTime()));
    return now;
  } catch {
    return undefined;
  }
}
