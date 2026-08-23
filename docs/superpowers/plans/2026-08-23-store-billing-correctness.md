# Store Billing & Reliability Correctness Fix Set

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the verified P0/P1 defects from the 2026-08-23 external review: Google Play lifecycle-event loss, unpaid-purchase entitlements, missing product binding, unreliable Google revenue, Apple refund-reversal asymmetry, the expiry blind spot, non-durable webhook side effects, inflating paywall view counts, and unguarded asset deletion.

**Architecture:** All fixes are server-side (apps/api + packages/db). Each task is independently shippable and mirrors an existing correct pattern already in the codebase (Apple's `notificationUUID` dedup, Apple's productId binding check, the 0012/0016 query-time-idempotent ClickHouse pattern, the existing `paywall_asset_usages` machinery).

**Tech Stack:** Hono + TypeScript strict, Drizzle/Postgres, BullMQ, ClickHouse, Vitest.

**Spec:** This document doubles as the spec — the *Verified evidence* block in each task is the authoritative statement of the defect (produced by 4 adversarial verification agents on 2026-08-23, all line references confirmed against HEAD `e8ebc6d8`).

## Global Constraints

- Stay on the current branch (`main`). NEVER create branches or worktrees. Commit directly on HEAD.
- NEVER `git add -A` / `git add .`. Stage only the files you created/modified for your task. The working tree carries unrelated in-progress user edits in `apps/dashboard/src/components/assets/asset-library.tsx` and `packages/db/seed.ts` — do NOT stage, commit, revert, or modify these two files.
- TypeScript strict; API inputs validated with Zod; responses are `{ data: T }` or `{ error: { code, message } }`.
- Postgres only via Drizzle repositories (`packages/db/src/drizzle/repositories`). In raw `sql` templates, qualify columns (`"purchases"."id"`), never bare `${table.col}`.
- No magic values: hoist literals (windows, limits, state lists) into named constants.
- Conventional commits. One commit per task.
- TDD: write the failing test first where a unit seam exists. Run the touched package's related tests before committing (`pnpm vitest run <file>` from the package dir; `@rovenue/db` tests need `DATABASE_URL` exported). Integration tests requiring testcontainers: write/update them, run them if Docker is available, otherwise state that they were not run.
- Purchase statuses live in shared enums — reuse `PURCHASE_STATUS` / `ACCESS_GRANTING_STATUSES`; never invent status strings.

---

### Task 1: Google RTDN dedup key — messageId, not purchaseToken

**Files:**
- Modify: `apps/api/src/services/google/google-webhook.ts:85-89`
- Modify: `apps/api/tests/**/google-webhook.concurrency.integration.test.ts` (path approximate — find by name)
- Test: unit/integration tests colocated with the webhook tests

**Verified evidence:** `storeEventId` is `payload.*.purchaseToken ?? opts.pushBody.message.messageId`. The dedup unique index is `(source, storeEventId)` (`packages/db/src/drizzle/schema.ts:1018-1020`) and `claimWebhookEvent` returns `duplicate` once a row is PROCESSED. Google reuses the same purchaseToken for RENEWED / CANCELED / IN_GRACE_PERIOD / ON_HOLD / EXPIRED / REVOKED and `voidedPurchaseNotification` — so every lifecycle event after the first PROCESSED one is silently dropped. Apple correctly uses per-notification `notificationUUID` (`apple-webhook.ts:164`). The concurrency integration test explicitly encodes "SAME purchaseToken (= storeEventId)" and must be updated.

**Requirements:**
- [ ] `storeEventId` becomes `opts.pushBody.message.messageId` (Pub/Sub messageId is stable across redeliveries of the same message, unique across distinct notifications — the exact analog of Apple's notificationUUID).
- [ ] Keep the purchaseToken available for processing (it still drives purchase lookup); only the dedup key changes.
- [ ] Write a test first proving that two notifications with the same purchaseToken but different messageIds are BOTH processed (this fails today), and that a redelivery with the same messageId is deduped.
- [ ] Update the concurrency integration test to race two deliveries of the SAME messageId (that is the real concurrent-redelivery scenario).
- [ ] Grep for any other reader of google `storeEventId` semantics (e.g. admin/debug endpoints) and confirm nothing assumes token-keyed rows.
- [ ] Commit: `fix(api): key Google RTDN dedup on Pub/Sub messageId, not purchaseToken`

### Task 2: Gate Google entitlements on paid state

**Files:**
- Modify: `apps/api/src/services/receipt-verify.ts` (`verifyGoogleSubscriptionReceipt` ~346-426, `verifyGoogleProductReceipt` ~428-487)
- Modify: `apps/api/src/services/google/google-mappers.ts:91-97`
- Modify: `apps/api/src/services/google/google-types.ts` (add `subscriptionState` / `purchaseState` fields if missing)
- Test: colocated receipt-verify + mapper tests

**Verified evidence:** `verifyGoogleSubscriptionReceipt` never reads `subscriptionState`; status is hardcoded `ACTIVE` at lines 389/404/415. `verifyGoogleProductReceipt` never reads `purchaseState` (0=purchased, 1=canceled, 2=pending); line 473 sets `ACTIVE` unconditionally, then `routes/v1/receipts.ts:69-76` grants consumable credits. The RTDN mapper maps `PENDING` **and** `PENDING_PURCHASE_CANCELED` to `TRIAL` (access-granting) and defaults unknown states to `ACTIVE`.

**Requirements:**
- [ ] Subscriptions (receipt path): define a named constant listing access-granting Google states — `SUBSCRIPTION_STATE_ACTIVE`, `SUBSCRIPTION_STATE_IN_GRACE_PERIOD`, `SUBSCRIPTION_STATE_CANCELED` (canceled-but-not-expired keeps access until expiry). For any other state (PENDING, ON_HOLD, PAUSED, EXPIRED, unknown) do NOT write ACTIVE: map ON_HOLD/PAUSED/EXPIRED via the existing mapper statuses; reject PENDING with a 400 `{ error: { code: "purchase_not_paid" } }` (client should retry after payment completes).
- [ ] One-time products (receipt path): require `purchaseState === 0` before ACTIVE + credit grant; return the same `purchase_not_paid` 400 for pending (2); treat canceled (1) as invalid receipt.
- [ ] Mapper: `PENDING` and `PENDING_PURCHASE_CANCELED` map to a NON-access-granting status (use `EXPIRED` — semantically "no access, may become active later via a fresh RTDN"); unknown states default to non-access-granting with a `log.warn`, not ACTIVE.
- [ ] Tests first: PENDING subscription receipt → 400, no purchase row / no credits; pending one-time → 400; mapper table test covering PENDING, PENDING_PURCHASE_CANCELED, and an unknown state.
- [ ] Commit: `fix(api): gate Google entitlements and credits on paid purchase state`

### Task 3: Bind Google receipt to the verified productId (port the Apple check)

**Files:**
- Modify: `apps/api/src/services/receipt-verify.ts` (~326-332 lookup; `verifyGoogleSubscriptionReceipt`)
- Test: colocated receipt-verify tests

**Verified evidence:** The product is resolved purely from client-supplied `args.productId` (line 326-332); `subscription.lineItems[].productId` is read only for expiry/autorenew, never compared. Apple has the exact check at lines 161-178 (“productId does not match the verified transaction” → 400). One-time is partially mitigated (the resolved store id is passed to Google's `products.get`), subscriptions have no mitigation (`subscriptionsv2.get` is token-only).

**Requirements:**
- [ ] After fetching the subscription, require that the resolved product's Google store id (or identifier) matches one of `subscription.lineItems[].productId`; on mismatch throw the same-shaped 400 as Apple (`productId does not match the verified transaction`).
- [ ] Use the MATCHING line item (not `lineItems[0]`) for expiry/autorenew extraction.
- [ ] Test first: valid token whose lineItems name product A + client claims product B → 400, nothing persisted; happy path with multi-line-item response picks the right line.
- [ ] Commit: `fix(api): reject Google receipts whose token does not cover the claimed product`

### Task 4: Google revenue correctness

**Files:**
- Modify: `apps/api/src/services/receipt-verify.ts` (Google sub + product paths)
- Modify: `apps/api/src/services/google/google-types.ts` (~148-190)
- Modify: `apps/api/src/services/google/google-webhook.ts` (~150-154, ~320-344, ~536-541)
- Test: colocated tests

**Verified evidence:** (a) `createRevenueEvent` is called for Apple receipts (`receipt-verify.ts:281`, dedupeKey `apple:${transactionId}`) but never on either Google receipt path; Google one-time purchases therefore never produce revenue at all, because (b) the one-time RTDN branch is log-only (and its "acknowledging" log is false — no ack call exists). (c) `latestSuccessfulOrderId` appears nowhere in the repo; the code uses deprecated top-level `latestOrderId`, and the fallback `dedupeKey: google:${latestOrderId ?? purchaseToken}:purchase` collapses a renewal into the initial purchase when the field is absent. (e) `resolvePricing` failure writes revenue rows with `amount 0 / USD` (lines 321-322, 536-538).

**Requirements:**
- [ ] Add `latestSuccessfulOrderId?: string` to `GoogleSubscriptionPurchaseLineItem`; wherever an order id is needed use `lineItem.latestSuccessfulOrderId ?? purchase.latestOrderId` (named helper, one place).
- [ ] Receipt path (subscription): after a successful paid verification, emit an INITIAL/RENEWAL revenue event with dedupeKey `google:${orderId ?? purchaseToken}:{kind}` — the SAME key shape the webhook uses, so the two paths converge instead of double-recording. Mirror the Apple R6 block's structure.
- [ ] Receipt path (one-time): emit an INITIAL revenue event (`google:${orderId ?? purchaseToken}:purchase`) using the product's pricing.
- [ ] When pricing cannot be resolved: do NOT write a 0-USD row. Skip the revenue event and `log.error` with token+product context (metrics counter if one exists nearby). Same for the voided-purchase refund path.
- [ ] One-time RTDN branch: remove the false "acknowledging" wording; keep the branch minimal but make it call the same one-time verification/upsert path used by receipts (server-authoritative), or — if that pulls in >~50 lines of new plumbing — leave processing to the receipt path, log at `warn`, and note the deferral in the follow-ups section commit message. Do not silently mark log-only success.
- [ ] Tests first: receipt-verify Google sub happy path asserts `createRevenueEvent` called with converged dedupeKey; pricing-miss asserts NO revenue event + error log; type test for `latestSuccessfulOrderId` preference order.
- [ ] Commit: `fix(api): make Google revenue events real — receipt-path emission, order-id v2 fields, no 0-USD rows`

### Task 5: Apple REFUND_REVERSED restores the purchase

**Files:**
- Modify: `apps/api/src/services/apple/apple-webhook.ts` (`applyRefundReversed`, lines 533-593; compare REFUND at 454-476)
- Possibly modify: the status-guard helper (`guardStatusWrite`) call site — pass an explicit allow for REFUNDED→(ACTIVE|EXPIRED) on this event only
- Test: colocated apple-webhook tests

**Verified evidence:** `applyRefundReversed` only rewrites the refund-shield outcome, bumps a metric, and emits a REACTIVATION revenue event. The purchase stays `REFUNDED` (terminal), `syncAccess` in post-processing cannot re-grant (REFUNDED is not access-granting), and no code path anywhere transitions REFUNDED→anything — for lifetime/non-renewing purchases the loss is permanent.

**Requirements:**
- [ ] In `applyRefundReversed`: restore status — `expiresDate` in the future (or absent, e.g. lifetime non-consumable) → `ACTIVE`; past → `EXPIRED`. Clear `refundDate`. This must be an explicit, narrowly-scoped exception to the terminal guard (do not weaken `guardStatusWrite` globally — add an option/param used only here).
- [ ] Rely on the existing post-processing `syncAccess` to re-grant access (verify in the test that access returns).
- [ ] Keep the REACTIVATION revenue emission as is.
- [ ] Tests first: REFUND then REFUND_REVERSED → status ACTIVE + access restored; reversal after expiry → EXPIRED, no access; replayed REFUND after reversal still able to re-refund (guard still works forward).
- [ ] Commit: `fix(api): restore purchase status and access on Apple REFUND_REVERSED`

### Task 6: Remove the expiry checker's 24h blind spot

**Files:**
- Modify: `packages/db/src/drizzle/repositories/purchases-ext.ts` (`findPurchasesNearExpiry`, ~221-256)
- Modify: `apps/api/src/workers/expiry-checker.ts` (drop/repurpose `LOOKBACK_MS`)
- Test: repo tests in `packages/db` (needs `DATABASE_URL`) or worker unit tests

**Verified evidence:** the query requires `expiresDate <= now AND expiresDate > now - 24h`; a purchase that misses its window (worker down >24h, or a per-candidate error — errors are only counted, never retried) stays ACTIVE forever. Entitlement reads are expiry-aware (`findActiveAccess` filters `expiresDate > now`) so this is status/webhook/analytics drift, not access leakage — but it is permanent drift.

**Requirements:**
- [ ] Drop the lower time bound. Bound the scan by status instead: `status IN (ACTIVE, TRIAL, GRACE_PERIOD) AND expiresDate <= now`, keeping/adding the existing limit+pagination so a large backlog drains across runs.
- [ ] Verify an index supports the new predicate (check schema for an index on `(status, expiresDate)` or similar; if missing, add a migration with one — partial index on the three statuses).
- [ ] Test first: a purchase whose `expiresDate` is 3 days old is returned by the repo query (fails today).
- [ ] Commit: `fix(db): expiry sweep finds any overdue access-granting purchase, not just the last 24h`

### Task 7: Webhook side-effect durability (PROCESSED ordering + reaper re-enqueue)

**Files:**
- Modify: `apps/api/src/services/webhook-processor.ts` (`runPostProcessing` ~189-224, queue config)
- Modify: `apps/api/src/services/apple/apple-webhook.ts` / google/stripe equivalents (move the `PROCESSED` write)
- Modify: `apps/api/src/workers/webhook-reaper.ts` (~39) + `packages/db/src/drizzle/repositories/webhook-events.ts` (`reclaimStaleWebhookEvents` ~200)
- Test: colocated tests

**Verified evidence:** (i) handlers mark the `webhook_events` row `PROCESSED` *before* `runPostProcessing`; the three side effects (`syncAccess`, `maybeCreditConsumablePurchase`, `enqueueOutgoingWebhook`) are each try/caught into a `log.warn`, so the job completes and any redelivery hits the `duplicate` gate — a webhook-only consumable credit grant that fails is lost permanently. (ii) BullMQ retries (5 attempts, exp backoff from 1s ≈ 30s total) exhaust inside the 5-minute claim lease; the reaper then marks rows FAILED but nothing ever re-enqueues them, and providers never redeliver because the route returned 202.

**Requirements:**
- [ ] Reorder: run post-processing BEFORE marking the event PROCESSED. If a post-processing step fails, throw — the row stays claimable (lease expiry / FAILED) and BullMQ retries. All three side effects are already idempotent (`guardStatusWrite`, `addCredits` dedupe on `(purchase, referenceId, currencyId)`, outgoing-webhook enqueue must be checked — if it is not idempotent, give it a deterministic jobId derived from the webhook event id).
- [ ] Fix the retry/lease race: either set BullMQ backoff so total retry span exceeds `WEBHOOK_CLAIM_LEASE_MS` (5 min), or shorten the lease — pick one and name both constants side by side with a comment stating the invariant (`retry span > lease`).
- [ ] Reaper closes the loop: `reclaimStaleWebhookEvents` returns the reclaimed rows; for each, the reaper re-enqueues a processing job from the stored `payload` (deterministic jobId = event id so double-reap can't double-enqueue). Cap attempts with a named constant (e.g. `MAX_REAPER_REQUEUES = 5` via the existing `retryCount`) — beyond it, leave FAILED and `log.error`.
- [ ] Tests first: post-processing failure → event NOT marked PROCESSED and job throws; reaper test: stale PROCESSING row → re-enqueued once with deterministic id; retryCount exceeded → stays FAILED.
- [ ] Commit: `fix(api): make webhook side effects durable — process-then-mark, reaper re-enqueues stranded events`

### Task 8: Idempotent paywall view counts; drop dead experiment MV

**Files:**
- Modify: `apps/api/src/services/analytics-router.ts` (`placement_metrics`, ~175)
- Create: `packages/db/clickhouse/migrations/0022_paywall_views_idempotent.sql`
- Test: CH query tests if a harness exists; otherwise `db:verify:clickhouse` from inside the compose network

**Verified evidence:** `placement_metrics` reads `sum(views)` from `mv_paywall_daily_target` (SummingMergeTree) — outbox replays permanently inflate it. `unique_views` (uniqMerge HLL) and the experiment exposure query (`uniqExact(eventId)` over raw) are already replay-safe. `mv_experiment_daily`/`_target` (0003) are referenced by nothing outside migrations — dead weight that only wastes inserts.

**Requirements:**
- [ ] Rewrite the `views` read as a query-time idempotent count over raw: `uniqExact("eventId") FROM rovenue.raw_paywall_events WHERE kind = 'view' ...` — copy the structure/comment style of the 0012/0016 pattern. Keep `unique_views` as-is.
- [ ] Migration 0022: `DROP TABLE IF EXISTS` `mv_experiment_daily` and `mv_experiment_daily_target`; if the paywall `views` MV/target become unread after the query rewrite, drop `mv_paywall_daily` + target too — first grep apps/api for ALL readers (`charts.ts:440` reads `uniqMerge(subscribersHll)` from the paywall target — if that read stays, keep the paywall MV and only stop reading `sum(views)`).
- [ ] These MVs read from raw tables, not Kafka queue tables, so dropping them has no consumer-offset gap (the 0015 gotcha does not apply) — state this in the migration header.
- [ ] Comment-prefixed statements are fine (splitter fixed in b36d8c6) but keep statements `;`-terminated and avoid block comments (CH-lint).
- [ ] Test/verify: run the analytics query change against local CH if available (compose-network rule from CLAUDE.md); otherwise unit-test the SQL builder output.
- [ ] Commit: `fix(analytics): replay-safe paywall view counts; drop unread experiment daily MV`

### Task 9: Asset deletion referential guard + publish-time existence check

**Files:**
- Modify: `apps/api/src/routes/dashboard/assets.ts` (DELETE `/:id`, ~858-908)
- Modify: `apps/api/src/routes/dashboard/paywalls.ts` (publish, ~684-764)
- Reuse: `packages/shared/src/paywall/collect-urls.ts` (`collectMediaUrls`), `parseAssetUrl`, `assetRepo.listPublishedUsage`
- Test: colocated route tests
- NOTE: `apps/dashboard/src/components/assets/asset-library.tsx` is OFF-LIMITS (uncommitted user work). The orchestrator wires the `force` param in the UI separately.

**Verified evidence:** DELETE does no reference check and hard-deletes the S3 object → device 404s on live paywalls; the module's own comment admits it. Publish (`validateBuilderConfig`) has zero asset checks; `resolveAssetUrl` only records usage, never rejects soft-deleted assets. The advisory UI warning covers published usage only; raw API callers get nothing. `collectMediaUrls` + `parseAssetUrl` already walk every media URL deterministically — a hard check is cheap.

**Requirements:**
- [ ] DELETE: before deleting, compute usage = `listPublishedUsage(assetId)` ∪ draft usage (walk current draft `builderConfig`s of the project's paywalls with `collectMediaUrls` + `parseAssetUrl`, match assetId). If non-empty and `force` (Zod-validated query param, default false) is not set → `409 { error: { code: "asset_in_use", message } }` with the referencing paywall ids/names in the message. With `force=true`, proceed (current behavior).
- [ ] Publish: after collecting media URLs, resolve each `parseAssetUrl` hit against the project's assets; any soft-deleted/missing asset → `400 { error: { code: "asset_missing" } }` naming the URL. Non-asset URLs (external) pass through untouched.
- [ ] Tests first: delete of an asset referenced by a published version → 409; by only a draft → 409; force → deletes; publish of a tree referencing a soft-deleted asset → 400; external URLs unaffected.
- [ ] Commit: `fix(api): block deleting in-use paywall assets and publishing trees with missing assets`

### Task 10 (spec-only — no code this session): external-action follow-ups

Recorded for planning; each needs credentials/decisions the agent does not have:

1. **RN SDK distribution (P0, confirmed, worse than reported):** `@rovenue/react-native-sdk` is not on npm (404); zero GitHub releases; `dev.rovenue:sdk:0.1.0` hardcoded vs real 0.16.0 and not on Maven Central; `Rovenue.podspec` sha256 is 64 zeros and its URL points at the wrong org (`rovenue/rovenue` vs `broverse/rovenue`) with no artifact; `withRovenueAndroid.ts` emits `includeBuild("../../../packages/sdk-kotlin")` unconditionally, contradicting its own README's Maven-default; RN podspec ships monorepo-relative `SWIFT_INCLUDE_PATHS`. Fix order: make the plugin match its documented Maven-only default → publish Kotlin AAR (0.16.0) to Maven Central → build XCFramework (device+sim) via `build-ios-static.sh`, cut a GitHub release, stamp real sha256 + repo URL, push pod to Trunk → repoint RN podspec at the pod artifact → publish npm → clean-consumer CI (fresh Expo app, both platforms). Also fix docs: `installation.mdx` "bundles the prebuilt dylib" claim is false; plugin name inconsistency; SPM URL points at a nonexistent repo.
2. **Actual transaction pricing:** replace catalog-price revenue amounts with the charged amount via the Play `orders.get` API (needs API enablement + quota review). Until then catalog price stays, but 0-USD rows are already eliminated by Task 4.
3. **Historical Google reconciliation:** after Tasks 1–4 ship, a one-off job should re-fetch `subscriptionsv2.get` for every Google purchase, replay status + backfill missing revenue events (dedupeKeys from Task 4 make this idempotent).
4. **One-time RTDN full processing** if Task 4 chose the deferral path.
5. **Dashboard production-readiness work stream** (separate spec, verified sound 2026-08-23 with amendments in its §11 addendum): `docs/superpowers/specs/2026-08-23-dashboard-production-readiness-design.md`. Independent of this plan except the asset-library `force`-param wiring after Task 9's server-side 409 lands — that file carries in-progress user edits, coordinate before touching.
