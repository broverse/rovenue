# P9 — On-Device Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mint a short-lived preview session in the builder, serve the paywall DRAFT to the customer's own debug build under that token, and hot-reload it by polling.

**Architecture:** A hashed `paywall_preview_sessions` row + a mint/revoke dashboard route; a root-mounted public `GET /v1/preview/paywalls/:token` that hydrates the draft (new exported `hydrateDraftPaywall`) and answers ETag/304; an additive `get_paywall_preview` on core-rs consumed by new Swift/Kotlin preview views that poll every 2s; a builder modal (QR + snippet) that also flips the VM into a fast-flush mode. RN is deferred.

**Tech Stack:** Hono + Drizzle + Redis (api), Rust/uniffi (core-rs), Swift/Kotlin (façades), React + `qrcode` (dashboard), Vitest / cargo test / swift test / testDebugUnitTest.

**Spec:** `docs/superpowers/specs/2026-07-28-p9-device-preview-design.md` — read it first.

## Global Constraints

- **Current branch (main); no branch/worktree; sequential dispatch; stage ONLY your own files (never `git add -A`); never bare `git stash`.** Wave D2 runs in parallel — its hot files are `NodeViewFactory.kt`, `RovenuePaywallView.swift`, `nodes.tsx`, inspector tabs. **P9 touches NONE of them** (new SDK files + additions to `Rovenue.swift`/`Rovenue.kt`/core-rs only). Attribute foreign red before acting.
- **No SSE in v1** — the device polls. **RN is deferred** — no `packages/sdk-rn` changes.
- **Preview token: 32-byte base64url, sha256 hash ONLY in the DB, plaintext never logged** (funnel-universal threat model). Reuse `apps/api/src/services/funnel/token.ts` (`generateClaimToken`, `hashToken`).
- Named constants: `PREVIEW_SESSION_TTL_MINUTES = 60`, `PREVIEW_RATE_LIMIT_PER_MIN = 120`, `PREVIEW_FLUSH_DEBOUNCE_MS = 2000`, `PREVIEW_POLL_INTERVAL_SECONDS = 2`.
- API responses `{ data: T }` / typed `fail()` codes (register new codes in `packages/shared/src/index.ts` ERROR_CODE, not HTTPException-buried). `audit()` inside the caller's tx. Existing-test checks scan BOTH `apps/api/src/**` AND `apps/api/tests/`.
- Static-literal `t()` keys with same-task `en.json` entries. uniffi generated bindings stay gitignored (`npm run sdk:bindings` regenerates).
- Verify commands: `pnpm --filter @rovenue/api exec vitest run <files>`, `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder`, `cd packages/core-rs && cargo test`, `cd packages/sdk-swift && swift test`, `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`, tsc per package. Route-test idiom: `products.store-catalog.test.ts`.

## File Structure

- `packages/db/drizzle/schema.ts` + `drizzle/migrations/0096_paywall_preview_sessions.sql` — new table (next number after 0095).
- `packages/db/src/drizzle/repositories/paywall-preview-sessions.ts` — repo (create/findByHash/revoke).
- `apps/api/src/lib/placement-resolution.ts` — export `hydrateDraftPaywall`; amend the invariant comment.
- `apps/api/src/routes/dashboard/paywalls.ts` — mint + revoke sub-routes.
- `apps/api/src/routes/v1/paywall-preview.ts` — NEW public token route (root-mounted).
- `apps/api/src/app.ts` — mount the preview route at root (configStreamRoute pattern).
- `packages/shared/src/index.ts` — ERROR_CODE additions.
- `packages/core-rs/src/placements/client.rs` + `librovenue.udl` + `Types` wire — `get_paywall_preview` + `revision`.
- `packages/sdk-swift/Sources/Rovenue/Rovenue.swift` + NEW `PaywallUI/RovenuePaywallPreviewView.swift` + a pure `PreviewPollDecision.swift`.
- `packages/sdk-kotlin/.../Rovenue.kt` + NEW `paywallui/RovenuePaywallPreviewView.kt` + a pure poll-decision helper.
- `apps/dashboard/src/components/paywall-builder/device-preview-modal.tsx`, `top-bar.tsx`, `builder-shell.tsx`, `vm/paywall-builder.vm.ts`, `i18n/locales/en.json`, `lib/services/paywall-builder-api.ts`.

---

### Task 1: Preview-session table + repo + draft hydration

**Files:**
- Modify: `packages/db/drizzle/schema.ts` (append `paywallPreviewSessions`)
- Create: `packages/db/drizzle/migrations/0096_paywall_preview_sessions.sql`
- Create: `packages/db/src/drizzle/repositories/paywall-preview-sessions.ts`
- Modify: `apps/api/src/lib/placement-resolution.ts` (export `hydrateDraftPaywall`, amend the `:46-48` invariant comment)
- Test: `apps/api/src/lib/placement-resolution.draft.test.ts`

**Interfaces (Tasks 2-3 depend on these exact names):**

```ts
// schema.ts
export const paywallPreviewSessions = pgTable("paywall_preview_sessions", {
  id: text("id").primaryKey().$defaultFn(() => createId()),
  projectId: text("projectId").notNull().references(() => projects.id, { onDelete: "cascade" }),
  paywallId: text("paywallId").notNull().references(() => paywalls.id, { onDelete: "cascade" }),
  tokenHash: text("tokenHash").notNull().unique(),
  createdBy: text("createdBy").notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revokedAt", { withTimezone: true }),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ expiresIdx: index("paywall_preview_sessions_expires_idx").on(t.expiresAt) }));

// repositories/paywall-preview-sessions.ts (barrel-exported as previewSessionRepo)
export async function createPreviewSession(db, input: { projectId; paywallId; tokenHash; createdBy; expiresAt: Date }): Promise<PreviewSession>;
export async function findActiveByHash(db, tokenHash: string, now: Date): Promise<PreviewSession | null>; // revokedAt null AND expiresAt > now
export async function revokePreviewSession(db, projectId: string, sessionId: string): Promise<PreviewSession | null>;

// placement-resolution.ts
export async function hydrateDraftPaywall(projectId: string, paywall: PaywallRow, requestedLocale: string | null): Promise<HydratedPaywall | null>;
// null when paywall.builderConfig is null. Same body as the private hydratePaywall but reads paywall.builderConfig instead of version.builderConfig; reuses hydrateOffering.
```

- [ ] **Step 1: Migration** — write `0096_paywall_preview_sessions.sql` by hand (CREATE TABLE + the unique index on tokenHash + the expires index), matching the DDL style of `0094`/`0095`. Add the `paywallPreviewSessions` table to schema.ts. Barrel the repo in `packages/db/src/drizzle/repositories/index.ts` as `previewSessionRepo`.
- [ ] **Step 2: Failing tests** — `hydrateDraftPaywall`: (a) reads `paywall.builderConfig` (not a version), hydrates the offering, slices the requested locale; (b) null builderConfig → null; (c) divergence pin — given a paywall whose draft differs from its published version, `hydrateDraftPaywall` returns the DRAFT tree (construct both, assert the draft's node ids). Use the same test scaffolding `placement-resolution`'s existing tests use (find them; mock the repos).
- [ ] **Step 3: Run to verify failure.**
- [ ] **Step 4: Implement** — extract the shared hydration body so `hydratePaywall` (published) and `hydrateDraftPaywall` (draft) both call it with the right config source; amend the invariant doc comment to name the sanctioned draft exception (P9 preview, token-gated).
- [ ] **Step 5: Verify** — the draft test + `pnpm --filter @rovenue/db exec tsc --noEmit` + `pnpm --filter @rovenue/api exec tsc --noEmit`; do NOT run the migration against a live DB here (the controller handles migration ordering).
- [ ] **Step 6: Commit** `feat(api,db): paywall preview sessions table + draft hydration`.

---

### Task 2: Mint + revoke dashboard routes

**Files:**
- Modify: `apps/api/src/routes/dashboard/paywalls.ts` (two sub-routes, placed before `/:id` shadowing routes as needed — mirror the `/from-app-store` placement)
- Modify: `apps/api/src/lib/audit.ts` (add `"paywall_preview_session"` to `AuditResource`)
- Test: `apps/api/src/routes/dashboard/paywalls.preview-sessions.test.ts`

**Interfaces:**
- Consumes: Task 1's `previewSessionRepo.{createPreviewSession, revokePreviewSession}`; `generateClaimToken`/`hashToken` from `apps/api/src/services/funnel/token.ts`; `assertProjectCapability(..., "products:write")`.
- Produces: `POST …/paywalls/:id/preview-sessions` → `{ data: { sessionId, token, expiresAt, previewUrl, qrPayload } }`; `DELETE …/paywalls/:id/preview-sessions/:sid` → `{ data: { revoked: true } }`. The RPC paths the dashboard calls (Task 7).

Handler notes: `products:write` gate (minting grants draft access outside the dashboard); 404 foreign paywall; generate a plaintext token, persist ONLY `hashToken(token)`; `expiresAt = now + PREVIEW_SESSION_TTL_MINUTES*60_000`; `previewUrl = `${new URL(c.req.url).origin}/v1/preview/paywalls/${token}``, `qrPayload = previewUrl`; `audit()` inside the tx (`action: "create"`/`"delete"`, `resource: "paywall_preview_session"`). Response returns the plaintext token exactly once — never log it.

- [ ] Steps: failing tests (mint returns token+url+expiresAt and persists a HASH not the plaintext — assert the repo insert arg's tokenHash !== token and === hashToken(token); capability gate called with products:write; foreign paywall 404; revoke sets revokedAt via repo; audit called with the new resource) → RED → implement → GREEN + api tsc + dashboard tsc (RPC inference) → commit `feat(api): mint/revoke paywall preview sessions (§6.16)`.

---

### Task 3: Public token endpoint with ETag/304

**Files:**
- Create: `apps/api/src/routes/v1/paywall-preview.ts` (declares path `/v1/preview/paywalls/:token`)
- Modify: `apps/api/src/app.ts` (mount at root: `.route("/", paywallPreviewRoute)`, beside `configStreamRoute`)
- Modify: `packages/shared/src/index.ts` (ERROR_CODE: `PREVIEW_SESSION_INVALID`)
- Test: `apps/api/src/routes/v1/paywall-preview.test.ts`

**Interfaces:**
- Consumes: Task 1's `previewSessionRepo.findActiveByHash` + `hydrateDraftPaywall`; `hashToken`; `endpointRateLimit`; `drizzle.paywallRepo.findPaywallById`.
- Produces: `GET /v1/preview/paywalls/:token?locale=` → `{ data: <PaywallWire + revision> }` (Task 4 decodes). 404 `PREVIEW_SESSION_INVALID` for missing/expired/revoked (indistinguishable); 304 on matching `If-None-Match`.

Handler: `endpointRateLimit({ name: "paywall-preview", max: PREVIEW_RATE_LIMIT_PER_MIN, identify: (c) => hashToken(c.req.param("token")) })`; `findActiveByHash(hashToken(token), now)` → null → 404 generic; load the paywall (project from the session); `revision = paywall.updatedAt.toISOString()`; if `c.req.header("If-None-Match") === '"'+revision+'"'` return `c.body(null, 304)` BEFORE hydration; else `hydrateDraftPaywall(...)` → null builderConfig → 404; set `ETag: '"'+revision+'"'` and return `ok({ ...paywallWire, revision })`. NO apiKeyAuth (root mount bypasses the v1 envelope; verify by asserting a request WITHOUT a bearer key succeeds).

- [ ] Steps: failing tests (valid token → PaywallWire+revision+ETag; no-bearer-key still 200 proving the mount escaped the envelope; expired/revoked/garbage → identical 404 PREVIEW_SESSION_INVALID; If-None-Match match → 304 and hydrateDraftPaywall spy NOT called; null builderConfig → 404; rate-limit identify uses the token hash) → RED → implement → GREEN + api tsc → commit `feat(api): public preview endpoint with ETag/304 (§6.17)`.

---

### Task 4: core-rs preview fetch + revision wire

**Files:**
- Modify: `packages/core-rs/src/placements/types.rs` (`PaywallWire.revision`, `CorePaywall.revision`)
- Modify: `packages/core-rs/src/placements/client.rs` (`get_paywall_preview`)
- Modify: `packages/core-rs/src/librovenue.udl` (`CorePaywall` gains `revision`; new method `get_paywall_preview`)
- Test: `packages/core-rs/tests/` (mirror the existing placements test file)

**Interfaces:**
- Consumes: existing `HttpRequest`/`get_json`/`resolve` machinery.
- Produces (Tasks 5-6 consume via uniffi): `get_paywall_preview(token: String, locale: Option<String>) -> RovenueResult<Option<CorePaywall>>`; `CorePaywall.revision: Option<String>` (String? in udl — lenient).

Notes: `PaywallWire` gains `#[serde(rename = "revision", default)] pub revision: Option<String>` (lenient — old servers omit it). `CorePaywall` (udl dictionary at :130) gains `string? revision;`. `get_paywall_preview` builds `GET /v1/preview/paywalls/{token}` (+`?locale=`), does NOT cache (a draft is ephemeral; skip the PlacementsCacheRepo write), decodes `ApiEnvelope<PaywallWire>` (NOT PlacementsResponse — the preview endpoint returns a bare paywall, not a placement envelope), and maps to `CorePaywall` carrying `revision`. No subscriber_id needed (add a stable placeholder or omit — read `HttpRequest` to see if it is required; the bearer header is harmless).

- [ ] Steps: failing cargo test (mock transport: URL is `/v1/preview/paywalls/<token>`; decodes builder_config_json + revision; a response WITHOUT revision decodes to `revision: None`) → `cargo test` RED → implement → GREEN → `npm run sdk:bindings` regenerates Swift/Kotlin bindings (gitignored) → commit `feat(core-rs): get_paywall_preview + revision wire (additive)`.

---

### Task 5: Swift preview view

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift` (add `getPaywallPreview`, mirroring `getPaywall` at :691 — re-locate by symbol)
- Create: `packages/sdk-swift/Sources/Rovenue/PaywallUI/RovenuePaywallPreviewView.swift`
- Create: `packages/sdk-swift/Sources/Rovenue/PaywallUI/PreviewPollDecision.swift` (pure)
- Test: `packages/sdk-swift/Tests/RovenueTests/PreviewPollDecisionTests.swift`

**Interfaces:**
- Consumes: Task 4's `core.getPaywallPreview(token:locale:)` (uniffi) returning `CorePaywall` with `revision`; existing `mapPaywall`/`hydrateOffering`; the existing `RovenuePaywallView`.
- Produces: `Rovenue.getPaywallPreview(token:locale:) async throws -> Paywall?` (Paywall carries `revision` — add the field to the `Paywall` struct + `mapPaywall`, defaulting nil); `RovenuePaywallPreviewView(token:locale:onClose:onUrl:)`.

Pure decision helper (unit-testable without a view):

```swift
enum PreviewPollDecision { case refetch, noChange }
func previewPollDecision(current: String?, latest: String?) -> PreviewPollDecision // latest != current && latest != nil → refetch, else noChange
```

`RovenuePaywallPreviewView`: on appear fetch → render `RovenuePaywallView(paywall:)` with purchase/restore callbacks bound to no-ops (a comment: previewing a draft must never charge; `onClose`/`onUrl` pass through); a Timer/Task polling every `PREVIEW_POLL_INTERVAL_SECONDS`, calling `getPaywallPreview` and `previewPollDecision(current: shown.revision, latest: fetched.revision)` → re-bind on `.refetch`; a small "PREVIEW" pill overlay (constant styling, corner); poll cancelled on disappear; a minimal retry state on fetch error.

- [ ] Steps: failing `swift test` for `previewPollDecision` (all four cases: nil/nil→noChange, "a"/"a"→noChange, "a"/"b"→refetch, "a"/nil→noChange) → RED → implement helper + view + Rovenue method + Paywall.revision → `swift test` GREEN (SourceKit diagnostics are NOT a build) → commit `feat(sdk-swift): on-device paywall preview view + poll`.

---

### Task 6: Kotlin preview view

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` (add `getPaywallPreview`, mirror `getPaywall` at :582)
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/RovenuePaywallPreviewView.kt`
- Create a pure poll-decision function (in a new small file or the preview view's companion) — mirror Swift's `previewPollDecision`.
- Modify: `packages/sdk-kotlin/.../Types.kt` (`Paywall.revision: String? = null`)
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/paywallui/PreviewPollDecisionTest.kt`

**Interfaces:** mirror Task 5 exactly: `Rovenue.getPaywallPreview(token, locale): Paywall?` (revision on `Paywall`), `previewPollDecision(current, latest): PreviewPollDecision` (enum REFETCH/NO_CHANGE), `RovenuePaywallPreviewView` with `bindPreview(token, options)` wrapping the existing `RovenuePaywallView`, coroutine-scoped 2s polling cancelled on detach, no-op purchase/restore, "PREVIEW" pill.

- [ ] Steps: failing `testDebugUnitTest` for the poll decision (same four cases) → RED → implement → `./gradlew testDebugUnitTest` BUILD SUCCESSFUL → commit `feat(sdk-kotlin): on-device paywall preview view + poll`. (Do NOT touch NodeViewFactory.kt — wave D2 owns it.)

---

### Task 7: Dashboard modal + VM fast-flush + i18n

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/device-preview-modal.tsx`
- Modify: `top-bar.tsx` (Smartphone button + `onOpenDevicePreview`), `builder-shell.tsx` (state + mount), `vm/paywall-builder.vm.ts` (`previewSessionActive` + debounced flush), `lib/services/paywall-builder-api.ts` (`createPreviewSession`/`revokePreviewSession`), `i18n/locales/en.json`
- Test: `apps/dashboard/src/components/paywall-builder/__tests__/device-preview-modal.test.tsx`, VM test extension

**Interfaces:** Consumes Task 2's routes via rpc/unwrap; `qrcode` (already a dep) for client-side QR render.

Behaviour: TopBar `Smartphone` button opens the modal; modal mints on open, renders the QR from `qrPayload` (via `qrcode.toDataURL`), shows the copyable token + `previewUrl` + an expiry countdown + a tabbed Swift/Kotlin snippet (React Native tab: "coming soon" caption); "End session" → DELETE + `vm.setPreviewSessionActive(false)`; mint sets it true. The VM: `@state previewSessionActive`; when true, edit mutations schedule a `saveNow()` flush debounced at `PREVIEW_FLUSH_DEBOUNCE_MS` (hook the existing dirty path; do not change the 30s throttle for the inactive case). All copy static-literal `t("paywalls.builder.devicePreview.*", …)` with en.json entries this task.

- [ ] Steps: failing tests (modal mints on open → shows a QR img + token; countdown renders; End session posts DELETE + flips the VM flag; VM: with previewSessionActive true, an edit triggers a debounced saveNow within PREVIEW_FLUSH_DEBOUNCE_MS — fake timers; with it false, no early flush; TopBar button calls onOpenDevicePreview; i18n grep-audit zero missing) → RED → implement → GREEN: dashboard paywall-builder suite at baseline + tsc → commit `feat(dashboard): device-preview modal + active-preview fast flush`.

---

## Final verification (controller)

- [ ] api targeted (Tasks 1-3 files, BOTH test dirs) · `cargo test` · `swift test` · `testDebugUnitTest` · dashboard paywall-builder suite · tsc on db/api/shared/dashboard.
- [ ] Whole-feature review pointing at: the draft-serving invariant exception (is it token-gated and single-purpose?), the root-mount escaping apiKeyAuth (no-bearer test proves it), token hash-only persistence + generic 404 (no oracle), the additive `revision` wire (old-server absence lenient), and the no-charge-in-preview no-op binding.
