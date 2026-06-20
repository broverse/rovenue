# Sub-project D — Deep-link / Universal Link Token Capture (Design)

**Date:** 2026-06-20
**Status:** Approved design, pre-plan
**Parent:** [Funnel Attribution SDK Client decomposition map](./2026-06-20-funnel-attribution-sdk-decomposition.md)
**Builds on:** [A — Claim Core](./2026-06-20-funnel-claim-core-design.md)
**Scope:** Sub-project **D** only. First-launch orchestration (E), email/code (F), privacy manifest (G) are out of scope.

## 1. Background

When the app is **already installed**, tapping a funnel link opens the app
directly (iOS Universal Link / Android App Link, or a custom-scheme deep link
from the magic-link flow). The OS hands the app the URL that was tapped; the app
must extract the funnel token and claim it. This is the warm/direct counterpart
to B (Android cold-install referrer) and C (iOS cold-install clipboard).

In React Native the OS delivers the URL to the **app** (`Linking` /
expo-router / React Navigation linking own the URL events), so the SDK stays
headless: it exposes a one-call `claimFromUrl(url)` that the app calls from its
own deep-link handler. The SDK does not register a global listener (that would
fight the app's routing and need native config). This sub-project is pure
TypeScript — no native code, no backend change — and is therefore fully unit
tested.

## 2. Backend URL formats (authoritative)

- **Universal Link** (`apps/api/src/routes/public/funnels.ts:430`):
  `https://<universal_link_domain>/universal/funnels/open/<token>` — the token
  is the path segment after `/funnels/open/`.
- **Custom-scheme deep link** (`apps/api/src/routes/public/funnel-magic.ts:93`):
  `<scheme>://onboarding-complete?token=<token>` — the token is the `token`
  query parameter.
- The funnel token is 40–64 chars (`claim-funnel-token` validates
  `z.string().min(40).max(64)` server-side).

## 3. Goals / Non-goals

**Goals**
- `Rovenue.claimFromUrl(url)` — extract the funnel token from a funnel URL and
  claim it; resolve `null` for any non-funnel URL.
- A pure, fully-tested `extractFunnelToken(url)` recognizing both URL shapes.

**Non-goals (this sub-project)**
- Registering a global `Linking` listener (the app owns deep-link delivery).
- Native OS deep-link configuration (associated domains / intent filters) — that
  lives in the **consuming app**, documented here, not shipped by the SDK.
- First-launch orchestration sequencing deep-link → clipboard/referrer → email
  (E).

## 4. Public API (RN TS)

```ts
Rovenue.claimFromUrl(url: string): Promise<FunnelClaimResult | null>
```

The app forwards every incoming URL (warm `Linking` `url` event + cold-start
`Linking.getInitialURL()`) to `claimFromUrl`; the SDK ignores non-funnel URLs
(returns `null`) and claims when a token is present.

## 5. Implementation (`packages/sdk-rn/src/api/funnel.ts`)

### 5.1 `extractFunnelToken(url: string): string | null` (pure)
Robust string parsing — **does not use the `URL` constructor** (unreliable for
custom schemes in RN/Hermes):
1. **Universal-link path:** if the URL contains `funnels/open/`, take the
   substring after it up to the first `/`, `?`, or `#`; URL-decode it. If
   non-empty → that's the token.
2. **Query parameter:** otherwise, scan the query string (after `?`, before
   `#`):
   - `rovenue_funnel_token=<token>` → trust anywhere (the key is
     Rovenue-specific; matches the referrer/clipboard markers).
   - `token=<token>` → trust **only** when the URL also contains
     `onboarding-complete` (the Rovenue funnel deep-link host). This prevents an
     unrelated deep link's generic `?token=` from being treated as a funnel
     token (which would otherwise trigger a pointless claim that throws
     `FunnelTokenNotFound`). So `claimFromUrl` is safe to call with ANY incoming
     URL — non-funnel URLs always resolve `null`, never throw.
3. Otherwise → `null`.
Exported so it can be unit-tested directly (and is usable by E later).

### 5.2 `claimFromUrl(url: string): Promise<FunnelClaimResult | null>`
```ts
export async function claimFromUrl(url: string): Promise<FunnelClaimResult | null> {
  const token = extractFunnelToken(url);
  if (!token) return null;
  return call(async () => {
    const n = (await getNative().claimFunnelToken(token)) as NativeClaim;
    return parse(n);
  });
}
```
Reuses the existing `call()` (error mapping via `mapNativeError`) + `parse()`
(`funnelAnswersJson` → `funnelAnswers`) helpers and the native
`claimFunnelToken` from A. Only funnel-shaped URLs reach the network; arbitrary
URLs short-circuit to `null` (no wasted call). Note `claimFunnelToken` (unlike
`claimInstall`) returns a non-optional result, so a recognized-but-invalid
token surfaces as a `FunnelTokenNotFound`/`Expired`/`AlreadyClaimed` error
through `call()` — the caller can catch it; this matches the direct
`claimFunnelToken` behavior.

### 5.3 Public surface
- `index.ts`: add `claimFromUrl` to the exported `Rovenue` object; export
  `extractFunnelToken` (named export) for advanced callers / E.
- No `RovenueModuleSpec` change (no new native method — reuses `claimFunnelToken`).

## 6. Docs

`apps/docs/content/docs/reference/methods.mdx` (Funnel Attribution section): add
`### claimFromUrl`:
- Use when the app is opened via a funnel Universal Link / App Link / deep link.
- Wire the app's deep-link handler to forward URLs:
  - **Warm:** `Linking.addEventListener('url', ({ url }) => Rovenue.claimFromUrl(url))`.
  - **Cold start via link:** `const url = await Linking.getInitialURL(); if (url) await Rovenue.claimFromUrl(url)`.
  - (Or the expo-router / React Navigation linking equivalent.)
- Note the OS config the consuming app must add (iOS Associated Domains for the
  `universal_link_domain`; Android App Links intent filter; the custom scheme)
  — these are app-side, not SDK-shipped.
- Returns `FunnelClaimResult | null` (null for non-funnel URLs).

## 7. Testing (fully testable — no native gate)

- **`extractFunnelToken` (Vitest)**: universal-link path (`https://d/universal/funnels/open/<tok>`),
  path with trailing `/`/`?query`/`#frag`, deep-link `?token=<tok>`,
  `?rovenue_funnel_token=<tok>`, URL-encoded token, a non-funnel URL → `null`,
  empty/garbage → `null`.
- **`claimFromUrl` (Vitest)**: a funnel URL → calls native `claimFunnelToken` with
  the extracted token and returns the parsed result; a non-funnel URL → `null`
  without touching native.

## 8. Versioning

Additive, non-breaking. Minor bump of the unified version (crate = TS
`SDK_VERSION` = npm) in lockstep, per the `version.test.ts` parity assertions.

## 9. Out-of-scope dependency noted for E

First-launch orchestration (E) will call `claimFromUrl` (with
`Linking.getInitialURL()`) as the highest-priority deterministic source — a
direct deep link carries the exact token — before falling back to the
platform deferred sources (B referrer / C clipboard) and then email (F).
