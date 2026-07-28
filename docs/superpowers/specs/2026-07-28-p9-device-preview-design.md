# P9 — On-Device Preview (design)

**Date:** 2026-07-28
**Phase:** P9 of the paywall-builder gap-analysis plan (`2026-07-23-paywall-builder-gap-analysis.md` §5.6, §6.16–6.18, §8 decision 4).
**Status:** Approved design. Feeds an implementation plan.

## 1. Scope decisions

1. **No standalone preview app** (§8 decision 4, re-affirmed): a preview token deep-links/copies into the customer's own debug build.
2. **The device POLLS; §6.18's SSE is descoped for v1** (user decision 2026-07-28). §5.6 sanctions "push **or poll**"; the SDKs have no verified SSE-consumption capability (core-rs's http client does not stream), so v1 ships a 2-second revision poll against the public endpoint with ETag/304. A dashboard-side "device connected" presence stream is future work, not v1.
3. **Swift + Kotlin only in v1; RN deferred** (user decision). RN is the only façade whose view never receives the paywall across the bridge (`native-view.ts:11` sends only `placementIdentifier`), so it needs a new wire prop + native resolve branch in `packages/sdk-rn/ios|android` — code with **no test gate in this repo** (compiles only inside a host app; device smoke is the only verification) and currently contended by the parallel RN-bridge phase. The RN follow-up is coordinated with that phase, not this one.

## 2. Context facts (verified 2026-07-28)

- Swift and Kotlin can already render a raw draft: `Paywall` has a public memberwise init (`Types.swift:288`, `Types.kt:151`) carrying `builderConfigJson` + `offering`, and both `RovenuePaywallView`s render purely from it. No renderer change is needed anywhere.
- Public token-authed routes are established (`public/funnels.ts`, `funnel-universal.ts` — plaintext token in URL by design, **hash-only in DB**, never logged). Token helpers ready: `apps/api/src/services/funnel/token.ts` (`generateClaimToken` 32-byte base64url, `hashToken` sha256).
- `/v1`-pathed routes can escape the blanket API-key envelope by mounting at root: `configStreamRoute` declares `"/v1/config/stream"` and mounts via `app.ts:117` — the exact pattern for §6.17.
- `hydratePaywall` (`placement-resolution.ts:55`) is private and documented "published snapshot, never the draft" — P9 adds an exported draft sibling and amends that invariant comment honestly.
- Autosave is throttled at 30s (`paywall-builder.vm.ts:919`) — hot-reload freshness requires an active-preview flush.
- QR: dashboard already depends on `qrcode` (used by 2FA) — client-side render, no API-side QR.
- Wave D2 (parallel session) is hot in `NodeViewFactory.kt` (dirty), `RovenuePaywallView.swift`, `nodes.tsx` — P9 touches NONE of them (new files + `Rovenue.swift`/`Rovenue.kt`/core-rs additions only). `apps/api`, `packages/db`, `packages/core-rs`, `packages/sdk-rn` are cold.

## 3. Data + API

### 3.1 `paywall_preview_sessions` (Postgres — every token precedent in this repo is Postgres-with-expiresAt)

`id` (cuid2), `projectId` (fk cascade), `paywallId` (fk cascade), `tokenHash` (text, unique), `expiresAt` (notNull; minted at now + `PREVIEW_SESSION_TTL_MINUTES = 60`), `createdBy` (userId), `createdAt`, `revokedAt` (nullable). Index on `(tokenHash)` and a partial cleanup-friendly index on `(expiresAt)`. Validation is read-time (expired/revoked → 404-equivalent); no reaper in v1.

### 3.2 `POST /dashboard/projects/:projectId/paywalls/:id/preview-sessions` (§6.16)

Dashboard auth + `assertProjectAccess(..., CUSTOMER_SUPPORT)`-level read is NOT enough — minting grants draft access outside the dashboard, so gate on the same `products:write` capability the PATCH uses. 404 foreign paywall. Inserts the session (hash only), `audit()` inside the tx (`action: "create"`, `resource: "paywall_preview_session"` — extend `AuditResource`). Response (plaintext token appears here ONCE and is never persisted or logged):

```ts
{ data: { sessionId, token, expiresAt, previewUrl,   // built from the REQUEST's own origin (new URL(c.req.url).origin)
          qrPayload } }                               //   + `/v1/preview/paywalls/${token}`; qrPayload = previewUrl,
                                                      //   rendered as a QR client-side by the dashboard
```

`DELETE /dashboard/projects/:projectId/paywalls/:id/preview-sessions/:sid` sets `revokedAt` (audited) — the modal's "End session".

### 3.3 `GET /v1/preview/paywalls/:token?locale=` (§6.17)

Declared with the full `/v1/...` path and **mounted at root in `app.ts`** (configStreamRoute pattern) so it does NOT inherit `apiKeyAuth` — the token is the authorization. A bearer key, if the SDK sends one anyway, is ignored. `endpointRateLimit({ name: "paywall-preview", max: PREVIEW_RATE_LIMIT_PER_MIN = 120, identify: token-hash falling back to IP })`.

Handler: `hashToken(token)` → session lookup → expired/revoked/missing → **404 with a generic body** (no oracle distinguishing the cases); load the paywall row; hydrate the **DRAFT** via the new exported `hydrateDraftPaywall(projectId, paywall, requestedLocale)` (same body as `hydratePaywall` but reading `paywalls.builderConfig`; `placement-resolution.ts`'s invariant comment amended to name this single sanctioned exception). Response envelope = the existing `PaywallWire` shape + `revision: string` (the paywall row's `updatedAt` ISO). Sets `ETag: "<revision>"`; a matching `If-None-Match` short-circuits to **304 before hydration** (the poll's cheap path). `lastFetchedAt` is NOT tracked in v1 (YAGNI — presence UI is descoped with SSE).

### 3.4 Freshness: active-preview flush

The builder VM gains `previewSessionActive: boolean` (set on mint; cleared on End-session or expiry — NOT on modal close, matching §4: the developer's hands are on the device while the modal may be closed). While true, edits schedule a **debounced `saveNow()` flush at `PREVIEW_FLUSH_DEBOUNCE_MS = 2000`** instead of waiting out the 30s autosave throttle. The PATCH handler is otherwise untouched (no SSE publish — the poll reads `updatedAt`, which the existing update already bumps).

## 4. Dashboard

TopBar gains a "Preview on device" entry (`Smartphone` icon, `onOpenDevicePreview` prop threaded from builder-shell — the established modal pattern). The modal (`device-preview-modal.tsx`):
- On open: mints a session; shows the QR (client-side `qrcode` render of `qrPayload`), the copyable token, `previewUrl`, an expiry countdown, and a tabbed Swift/Kotlin snippet showing the one-liner integration (below).
- "End session" calls DELETE and clears the VM flag; closing the modal keeps the session alive but clears the flush flag only on explicit end (decision: closing the modal should NOT kill the session — the developer's hands are on the device; flag stays until End session or expiry, tracked by expiresAt countdown in the VM).
- Errors surface inline; re-mint allowed after expiry.

## 5. SDK (additive wire; Swift + Kotlin)

- **core-rs:** `get_paywall_preview(token: String, locale: Option<String>) -> Result<Paywall>` on the placements client — `GET {base_url}/v1/preview/paywalls/{token}` through the existing transport (the bearer header rides along harmlessly), decoding the existing `PaywallWire`; `revision` surfaced on the returned object (additive field on the core `Paywall`/wire struct, lenient-decoded so old servers/new clients coexist). Exposed via uniffi (`npm run sdk:bindings` regenerates; generated files stay gitignored).
- **Swift:** `Rovenue.getPaywallPreview(token:locale:) async throws -> Paywall` + a NEW file `RovenuePaywallPreviewView.swift`: fetches, renders the existing `RovenuePaywallView`, polls every `PREVIEW_POLL_INTERVAL_SECONDS = 2` with `If-None-Match` semantics (core returns the revision; the view refetches and re-binds only when it changes), draws a small "PREVIEW" pill overlay (corner, constant styling), and wires purchase/restore callbacks to no-ops (previewing a draft must never charge; hosts may override `onClose`/`onUrl`). Poll stops on disappear; fetch errors show a minimal retry state.
- **Kotlin:** mirror — `Rovenue.getPaywallPreview(token, locale)` + `RovenuePaywallPreviewView` (new file) with `bindPreview(token, options)`, same poll/pill/no-op semantics, coroutine-scoped polling cancelled on detach.
- **Docs:** one snippet per platform in the modal + a short page in apps/docs (deep-link wiring is the HOST's job: the snippet shows receiving a token — from a scanned QR, a pasted string, or the host's own URL scheme — and presenting the preview view).
- **RN:** explicitly deferred; the modal's snippet tab shows Swift/Kotlin only with a "React Native: coming soon" caption.

## 6. Security posture

32-byte base64url token; sha256 hash only in DB; plaintext never logged (funnel-universal's documented threat model). TTL 60 min + manual revocation. The endpoint exposes exactly one paywall's DRAFT (plus its hydrated offering — same data `/v1/placements` already exposes for published content) and nothing else; minting requires `products:write`. Generic 404 for missing/expired/revoked. Per-token+IP rate limiting. The revision string is an `updatedAt` timestamp — no content leak.

## 7. Testing

- **API:** mint (capability gate, audit, hash-not-plaintext persisted), DELETE revoke, token GET (valid → PaywallWire+revision; expired/revoked/garbage → indistinguishable 404s), ETag/304 path skips hydration (spy), rate-limit identify, `hydrateDraftPaywall` unit (draft vs published divergence pinned; null builderConfig → 404-equivalent).
- **core-rs:** `cargo test` with the mock transport — URL shape, wire decode incl. `revision`, lenient absence of `revision`.
- **Swift/Kotlin:** pure poll-decision logic unit-tested (revision compare → refetch decision); REAL `swift test` / `testDebugUnitTest` runs; no renderer/fixture changes (render-fixtures.json untouched — nothing about node rendering changes).
- **Dashboard:** modal flow (mint → QR render → countdown → End session), VM flush-debounce behaviour under `previewSessionActive`, TopBar entry.

## 8. Collision + sequencing

P9's surface — `apps/api`, `packages/db`, `packages/core-rs`, NEW Swift/Kotlin files + `Rovenue.swift`/`Rovenue.kt` additions, dashboard modal — has **zero overlap with wave D2's hot files** (`NodeViewFactory.kt`, `RovenuePaywallView.swift`, `nodes.tsx`, inspector tabs). Single block, no gate; standing constraints (current branch, sequential dispatch, explicit staging, no bare `git stash`, named constants, static t() keys with same-task en.json, both api test dirs scanned). One watch-item: `Rovenue.swift`/`Rovenue.kt` are shared entry files — re-locate insertion points by symbol at implementation time.
