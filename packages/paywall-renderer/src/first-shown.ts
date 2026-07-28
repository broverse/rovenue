import { COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX } from "@rovenue/shared/paywall";

// =============================================================
// The web's half of the cross-platform `durationSeconds` anchor.
//
// A `durationSeconds` countdown counts down from the instant the paywall was
// FIRST shown to this user — persisted, so it survives a reload. iOS keeps
// that instant in `UserDefaults` and Android in `SharedPreferences`, both
// under `COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX + <paywall identifier>`; this is
// the same thing over `localStorage`, same key, so the three platforms
// anchor one paywall identically.
//
// It lives here rather than inside `PaywallRenderer` on purpose: the
// renderer is presentational and has no storage of its own, and an AUTHORING
// surface (the builder canvas) must NOT persist — see the note on the
// `firstShownAt` prop and canvas.tsx. Hosts that want the real deadline call
// this and pass the result in.
// =============================================================

/** Same value on all three platforms, one anchor per paywall shared by every
 *  countdown node on it; an absent identifier collapses to the empty suffix. */
function storageKey(paywallIdentifier: string | null | undefined): string {
  return COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX + (paywallIdentifier ?? "");
}

/**
 * The persisted "first shown" instant for `paywallIdentifier`: stamps `now`
 * and stores it on the first call, reads the stored value back on every
 * later call (this page load or any future one).
 *
 * Returns `undefined` — never throws — when there is no usable
 * `localStorage` (server render, privacy mode, a full quota). The renderer
 * then falls back to mount time, which is exactly the behaviour before this
 * existed: degraded, not broken.
 */
export function resolvePersistedFirstShownAt(
  paywallIdentifier: string | null | undefined,
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

  const key = storageKey(paywallIdentifier);
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
