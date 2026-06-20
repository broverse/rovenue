# Sub-project E — First-launch Orchestration (Design)

**Date:** 2026-06-20
**Status:** Approved design, pre-plan
**Parent:** [Funnel Attribution SDK Client decomposition map](./2026-06-20-funnel-attribution-sdk-decomposition.md)
**Builds on:** A (claim core), B (Android referrer), C (iOS clipboard + IP-match), D (deep-link capture)
**Scope:** Sub-project **E** only. Email/manual-code (F) and privacy manifest (G) are out of scope.

## 1. Background

A–D shipped the deterministic recovery building blocks. E is the **orchestrator**
("the brain") that sequences the no-gesture deterministic sources once per
install and returns the result, so the host app gets attribution from a single
call instead of hand-wiring the chain.

The SDK is headless and two sources need user interaction: the iOS clipboard
read needs a gesture (the iOS 16+ paste banner), and email needs UI. So E
automates only the **no-gesture** chain (direct deep link → platform deferred
server match); the **gesture fallbacks** (clipboard, email) remain app-driven,
invoked after E returns unresolved. A pleasant consequence of B/C: `claimInstall()`
already auto-fills per platform natively (Android Install Referrer / iOS IP-only
match), so E is **platform-agnostic** — it just calls `claimFromUrl` then
`claimInstall`.

## 2. Decisions (locked)

1. **App-triggered convenience** `resolveFunnelClaim({ url? })` — not auto-on-configure
   (avoids a `Linking` dependency and conflicts with the app's deep-link routing;
   the clipboard step can't be auto-run anyway).
2. **Once-per-install dedup via a core accessor** `hasResolvedFunnelClaim()` —
   reads the persisted `funnel_claim_state` (from A); only a prior **claimed**
   state skips the chain (a `failed`/absent state re-runs next launch, since the
   referrer/IP window may resolve later).
3. **No-gesture chain with throw-and-fall-through**: a recognized-but-invalid
   deep-link token (`claimFromUrl` throws) must not abort the chain — it falls
   through to `claimInstall`.

## 3. Goals / Non-goals

**Goals**
- `Rovenue.resolveFunnelClaim({ url? })` — run the no-gesture deterministic chain
  once per install; return `FunnelClaimResult | null`.
- A small core `hasResolvedFunnelClaim()` accessor for the dedup.

**Non-goals (this sub-project)**
- Auto-running on configure / owning the `Linking` listener (app passes the URL).
- The gesture fallbacks themselves (clipboard is C, email is F) — E documents the
  recommended sequence; the app drives them.
- Firing the resolution callback (the building blocks already fire
  `onFunnelClaimResolved` on success via the core funnel bus).

## 4. Public API (RN TS)

```ts
Rovenue.resolveFunnelClaim(opts?: { url?: string }): Promise<FunnelClaimResult | null>
```

Recommended first-launch flow (documented, app-written):
```ts
const url = await Linking.getInitialURL();
const result = await Rovenue.resolveFunnelClaim({ url: url ?? undefined });
if (!result) {
  // iOS gesture fallback (C): show a "Continue" button →
  //   const r2 = await Rovenue.claimFromClipboard();
  // then email fallback (F): show email field →
  //   await Rovenue.claimViaEmail(email);
}
// Either way, react to resolved claims via Rovenue.addFunnelClaimListener(...).
```

## 5. Implementation

### 5.1 Core accessor (Rust)
`packages/core-rs/src/api.rs` — add (mirroring the sync `install_id()`):
```rust
/// True iff this install has already successfully claimed a funnel token
/// (funnel_claim_state == "claimed"). Used by the SDK's first-launch
/// orchestration to run the resolution chain at most once per install.
pub fn has_resolved_funnel_claim(&self) -> bool {
    let install_id = self.install_id();
    FunnelRepo::new(&self.store)
        .claim_state(&install_id)
        .ok()
        .flatten()
        .as_deref()
        == Some("claimed")
}
```

### 5.2 FFI + façades
- `librovenue.udl` (on `interface RovenueCore`, near `string install_id();`):
  `boolean has_resolved_funnel_claim();` — non-throwing. Regenerate bindings
  (commit the tracked Kotlin binding; Swift gitignored).
- Swift façade (`Rovenue.swift`): `public func hasResolvedFunnelClaim() -> Bool { core.hasResolvedFunnelClaim() }` (sync, mirrors `installId()`).
- Swift Expo module: `AsyncFunction("hasResolvedFunnelClaim") { () -> Bool in Rovenue.shared.hasResolvedFunnelClaim() }`.
- Kotlin façade: `fun hasResolvedFunnelClaim(): Boolean = core.hasResolvedFunnelClaim()`.
- Kotlin Expo module: `AsyncFunction("hasResolvedFunnelClaim") Coroutine { -> Rovenue.shared.hasResolvedFunnelClaim() }`.
- `RovenueModuleSpec`: `hasResolvedFunnelClaim(): Promise<boolean>;`.

### 5.3 TS orchestrator (`packages/sdk-rn/src/api/funnel.ts`)
```ts
/**
 * Run the no-gesture deterministic funnel-recovery chain once per install:
 *   direct deep link (opts.url) → platform deferred match (claimInstall:
 *   Android Install Referrer / iOS IP-only). Returns the claim, or null when
 *   nothing resolves — then surface the gesture fallbacks yourself
 *   (claimFromClipboard on iOS, then claimViaEmail). Resolved claims also fire
 *   the addFunnelClaimListener callback. Safe to call on every launch.
 */
export async function resolveFunnelClaim(
  opts: { url?: string } = {},
): Promise<FunnelClaimResult | null> {
  if (await getNative().hasResolvedFunnelClaim()) return null;

  if (opts.url) {
    try {
      const r = await claimFromUrl(opts.url);
      if (r) return r;
    } catch {
      // recognized-but-invalid deep-link token → fall through to the next source
    }
  }

  try {
    const r = await claimInstall(); // native auto-fills referrer (Android) / IP-match (iOS)
    if (r) return r;
  } catch {
    // network/transient → unresolved
  }

  return null;
}
```
Reuses `claimFromUrl`/`claimInstall` (which reuse `call()`/`parse()`). Add
`resolveFunnelClaim` to the `Rovenue` object in `index.ts`.

## 6. Docs

`apps/docs/content/docs/reference/methods.mdx` (Funnel Attribution): add
`### resolveFunnelClaim`:
- One call that runs the no-gesture chain (deep link → platform deferred match),
  once per install; returns `FunnelClaimResult | null`.
- The recommended first-launch flow (§4) including the gesture fallbacks.
- Note it never throws on its own (internal claim errors are swallowed as
  "unresolved"); resolved claims arrive on `addFunnelClaimListener` too.
- Add to the Funnel Attribution summary table.

## 7. Testing

- **Rust unit** (`api.rs`, `--lib`): `has_resolved_funnel_claim` — true after a
  successful claim (state "claimed"); false for absent state and for a "failed"
  state. (Set state via the existing `FunnelRepo::set_claim_state` or by driving
  a claim through a mockito server, mirroring the A `claim_*` tests.)
- **RN TS** (Vitest): `resolveFunnelClaim` — `hasResolvedFunnelClaim()=true` →
  returns null without calling claimFromUrl/claimInstall; url resolves → returns
  it; url throws → falls through to claimInstall; claimInstall resolves → returns
  it; everything null → null; claimInstall throws → null. (Mock `getNative()` +
  the funnel methods.)
- **Façade build**: Kotlin `testDebugUnitTest`; Swift build.
- **iOS/Android native** (`hasResolvedFunnelClaim` AsyncFunction): review-only —
  tiny pass-through mirroring `installId`.

## 8. Versioning

Additive, non-breaking. Minor bump of the unified version (crate = TS
`SDK_VERSION` = npm) in lockstep, per the `version.test.ts` parity assertions.

## 9. Out-of-scope dependency noted for F

The email/manual-code path (F) is the terminal gesture fallback the app invokes
when `resolveFunnelClaim` returns null and the iOS clipboard attempt
(`claimFromClipboard`) also returns null.
