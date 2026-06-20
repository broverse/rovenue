# Sub-project C — iOS Deterministic Deferred Recovery (Design)

**Date:** 2026-06-20
**Status:** Approved design, pre-plan
**Parent:** [Funnel Attribution SDK Client decomposition map](./2026-06-20-funnel-attribution-sdk-decomposition.md)
**Builds on:** [A — Claim Core](./2026-06-20-funnel-claim-core-design.md), [B — Android Install Referrer](./2026-06-20-funnel-android-install-referrer-design.md)
**Scope:** Sub-project **C** only. Deep-link resolution (D), first-launch orchestration (E), email/code (F), privacy manifest (G) are out of scope.

## 1. Background

iOS has no OS-level deferred-install channel (no Play Install Referrer
equivalent). The deterministic, App-Store-safe ways to recover a funnel token
across an iOS cold install — the way Adjust/AppsFlyer/Branch actually do it
post-iOS-14.5, without device fingerprinting — are:

1. **Clipboard (Branch NativeLink-style):** the web funnel writes the token to
   the clipboard on a user-gesture CTA; the app reads it on first launch.
2. **Server-side short-window IP match (Adjust/AppsFlyer fallback):** the server
   matches the install request's IP against the click-time IP within a short
   window — using only the IP it already observes, with NO SDK-collected device
   fingerprint.

This sub-project ships both on iOS, plus the deterministic guarantee (identity)
remains the terminal in sub-project F. **No device fingerprinting** (Apple
policy + SDK symbol-detection blast radius). The clipboard holds the funnel
**token**, so the primary path calls `claimFunnelToken`; the IP match is the
fallback via `claimInstall`.

## 2. Goals / Non-goals

**Goals**
- `Rovenue.claimFromClipboard()` — app-triggered (after a gesture) read of the
  clipboard for a `rovenue-funnel:<token>` marker → `claimFunnelToken`.
- iOS `claimInstall` sends **no device signals** (pure IP-only); the backend
  matches IP-only, **unique-match-only**, within a **1-hour** window.
- The web funnel runner writes `rovenue-funnel:<token>` to the clipboard on its
  open-app CTA.

**Non-goals (this sub-project)**
- Deep-link/universal-link token capture (D) — though the clipboard marker is a
  string the app passes in; URL parsing is D's job.
- First-launch orchestration that sequences clipboard → IP-match → email (E).
- Email/manual-code (F); privacy manifest / required-reason audit (G).
- Android clipboard (Android uses the Install Referrer from B) — `claimFromClipboard`
  is a no-op on Android.

## 3. Decisions (locked)

1. **App-triggered `claimFromClipboard()`** — not auto-on-launch. iOS 16+ shows a
   paste-consent banner on a programmatic `UIPasteboard` read; triggering it
   after a user gesture (a "Continue" tap) gives the banner context (NativeLink
   pattern) and keeps the SDK headless (the app owns the gesture/UI).
2. **Marked prefix `rovenue-funnel:<token>`** — the SDK only acts when the
   clipboard string starts with this marker; it never reads/exposes other
   clipboard content (privacy, no false positives).
3. **Pure IP-only + unique-match + 1h** — the SDK collects no device signals on
   iOS; the server matches the request IP (server-observed) against click-time
   rows in a 1h window and grants ONLY when exactly one unclaimed candidate
   exists (0 or 2+ → 404). This is Adjust's short-window IP approach, plus
   unique-match because we grant entitlements (a false match would leak a paying
   user's purchase).

## 4. Public API change (RN TS)

```ts
// New method (iOS clipboard primary; Android no-op → null):
Rovenue.claimFromClipboard(): Promise<FunnelClaimResult | null>
```

`claimInstall()` (optional params, from B) is unchanged in signature; on iOS it
now sends minimal context (see §5.2).

## 5. Implementation

### 5.1 iOS native — `claimFromClipboard` (C1)
`packages/sdk-rn/ios/RovenueModule.swift` (add `import UIKit`):
```swift
AsyncFunction("claimFromClipboard") { () -> [String: Any?]? in
    let marker = "rovenue-funnel:"
    let raw: String? = await MainActor.run { UIPasteboard.general.string }
    guard let s = raw, s.hasPrefix(marker) else { return nil }
    let token = String(s.dropFirst(marker.count))
    guard !token.isEmpty else { return nil }
    let r = try await Rovenue.shared.claimFunnelToken(token)
    // Clear only our own marked content so it isn't re-claimed/leaked.
    await MainActor.run {
        if UIPasteboard.general.string?.hasPrefix(marker) == true {
            UIPasteboard.general.string = ""
        }
    }
    return ["subscriberId": r.subscriberId, "funnelAnswersJson": r.funnelAnswersJson]
}
```
- `UIPasteboard` access on `@MainActor` (Expo async functions run off-main).
- Reads the clipboard only when prefixed; ignores everything else.
- On a found token, claims via the existing façade `claimFunnelToken` and clears
  our marked content.

`packages/sdk-rn/android/.../RovenueModule.kt` — add a no-op for API symmetry:
```kotlin
AsyncFunction("claimFromClipboard") Coroutine { -> null }
```
(Android's deferred path is the Install Referrer from B; clipboard is unused.)

### 5.2 iOS minimal `claimInstall` + backend IP-only (C2)
- iOS Expo module `claimInstall`: build `ClaimInstallParams` with `platform = "ios"`
  and the device fields left empty (`locale`/`timezone`/`screenDims` = `""`,
  `deviceModel`/`installReferrer` = nil). The generated `ClaimInstallParams` FFI
  struct types `locale`/`timezone`/`screenDims` as non-optional `String`, so the
  iOS module sends `""` (not absent). No UIKit device collection on iOS.
- Backend `apps/api`:
  - `claim-install` request schema (`funnel-claim.ts`): relax `locale`,
    `timezone`, `screen_dims` so an **empty string is accepted** — drop their
    min-length and make them optional (e.g. `z.string().optional()` with no
    `.min()`), so the iOS `""` values pass. Android still sends real values; the
    backend uses these for neither the Android (referrer) nor iOS (IP-only) match,
    so loosening validation is harmless.
  - iOS branch (`funnel-claim.ts:257-307`): replace the `normalizeFingerprint` +
    per-candidate `fingerprintsMatch` loop with IP-only unique-match:
    ```ts
    const ipHash = hashIp(readIp(c));
    const candidates = await drizzle.funnelDeferredClaimRepo
      .findRecentByIpHash(drizzle.db, ipHash, new Date()); // ipHash + unexpired + unmatched
    if (candidates.length !== 1) return c.json({ data: null }, 404);
    const cand = candidates[0];
    const fresh = generateClaimToken();
    await drizzle.funnelClaimTokenRepo.rotateHash(drizzle.db, cand.tokenId, hashToken(fresh));
    await drizzle.funnelDeferredClaimRepo.markMatched(drizzle.db, cand.id, body.install_id);
    return c.json({ data: { token: fresh } });
    ```
    (`findRecentByIpHash` already filters `ipHash` + `expiresAt >= now` +
    `matchedAt IS NULL`; `length !== 1` covers both "no match" and "ambiguous".)
  - `DEFERRED_TTL_MS` (`funnel-universal.ts:49`): `24h` → `1h`. The click-time
    write keeps populating the row's `locale`/`ua`/`screenDims` columns
    (harmless; only `ipHash` + recency are used for matching).
  - `fingerprintsMatch` is no longer used by the iOS claim path. Leave
    `normalizeFingerprint`/`hashIp` (click-time `ipHash`); a follow-up may delete
    `fingerprintsMatch` if nothing else references it (out of scope to chase).

### 5.3 Web clipboard write (C3)
`apps/dashboard/src/runner/funnel-runner.tsx`: on the open-app CTA (after
`claimToken(sessionId)` returns the token), before redirecting to the App Store:
```ts
try {
  await navigator.clipboard.writeText(`rovenue-funnel:${token}`);
} catch {
  // Clipboard write can reject (permission/insecure context); ignore — the
  // user can still recover via deep link or email. (Same posture as 52b5612d.)
}
```
The CTA tap is the user gesture `navigator.clipboard.writeText` requires.

## 6. Testing

- **Backend (fully testable)**: integration/unit tests for the iOS `claim-install`
  IP-only branch — exactly-one candidate → token; zero → 404; two+ (same IP) →
  404; expired (>1h) → 404; the schema accepts an iOS body without
  locale/timezone/screen_dims. (Follow the existing `funnel-claim` test pattern.)
- **RN TS (Vitest)**: `claimFromClipboard` wrapper parses the native
  `{subscriberId, funnelAnswersJson}` → `FunnelClaimResult`, and null → null.
- **Web (C3)**: a unit test that the CTA writes `rovenue-funnel:<token>` and
  swallows a rejected `clipboard.writeText` (mock `navigator.clipboard`).
- **iOS native (C1 + iOS C2)**: **review-only** — `packages/sdk-rn/ios` has no
  standalone compile path; `UIPasteboard` needs an iOS runtime. Verified by
  review + a consuming Expo app on a device (clipboard read with the marker →
  claim; no marker → null; banner appears on the gesture). Stated limitation,
  same as sub-project B's Android native.

## 7. Versioning

Additive, non-breaking (new method + optional backend fields + shorter TTL).
Minor bump of the unified version (crate = TS `SDK_VERSION` = npm) in lockstep,
per the `version.test.ts` parity assertions.

## 8. Out-of-scope dependencies noted for later sub-projects

- First-launch orchestration (E) sequences: deep-link (D) → `claimFromClipboard`
  → `claimInstall` (IP-only) → surface "email needed" (F), once per install via
  A's `funnel_claim_state`.
- The clipboard marker carries a raw token; URL/deep-link parsing is D.
- `UIPasteControl` (banner-free, requires app UI) is an app-side enhancement,
  documented but not shipped by the headless SDK.
