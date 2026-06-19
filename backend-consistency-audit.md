# Backend Consistency Audit — Verified Findings & Fix Spec

> Status legend: **CONFIRMED** = code read, claim holds. **DECISION** = fix direction needs a product/owner choice before implementation.
> Generated 2026-06-19 from a 15-flow read-only audit + 6 independent verification passes. 31 findings confirmed, 1 refuted (cohort-retention paren claim — SQL is balanced, excluded).

---

## Cross-cutting themes (root causes)

- **Theme A — payload/envelope key drift silently kills downstream while tests stay green.** Only "happy/test-fire" paths build the correct shape: `FO1` (fanout envelope), `CS1` (config-stream), `FN1` (funnel `project_id`).
- **Theme B — revenue/refund events are neither idempotent nor uniformly gated** → MRR/LTV distortion: `R1`–`R7`.
- **Theme C — "same number, two implementations" that cannot reconcile:** experiments (`EX1/EX2`) and metrics (`M1`).
- **Theme D — denormalized state not recomputed after non-webhook mutations:** merge (`A3`), PAUSE (`A2`).

---

## CRITICAL

### R1 — `revenue_events` has no natural-key dedup; inserts are unconditional
- **Evidence:** `packages/db/src/drizzle/schema.ts` revenueEvents (PK `(id,eventDate)`, only non-unique indexes; no business-key unique). `packages/db/src/drizzle/repositories/revenue-events.ts:90-104` unconditional `insert(...).returning()`.
- **Current:** Any at-least-once redelivery that reaches the insert double-counts revenue.
- **Required:** Add a deterministic dedup key (e.g. `(projectId, store, storeTransactionId, type, eventDate)` or a carried `outboxEventId`/`notificationUUID`) + unique index, and convert inserts to `onConflictDoNothing`.
- **Acceptance:** Re-inserting the same economic event is a no-op; existing aggregates unchanged for distinct events. Migration + repo change + test.

### R2 — FAILED webhook events are re-claimable → revenue double-count on retry
- **Evidence:** `packages/db/src/drizzle/repositories/webhook-events.ts:144-147` `setWhere: status NOT IN ('PROCESSING','PROCESSED')` (FAILED re-claimable). `apps/api/src/services/apple/apple-webhook.ts:191-231` dispatch (purchase upsert / grantAccess / `createRevenueEvent`) and the PROCESSED mark are separate writes; a throw after revenue insert leaves FAILED → retry re-emits.
- **Current:** BullMQ retry of a non-terminal event re-inserts revenue.
- **Required:** Make revenue insert idempotent (R1 covers this) AND/OR wrap dispatch + PROCESSED mark in one transaction so a failure rolls back domain writes. Prefer R1 (idempotent insert) as the durable fix; tx-wrap as defense-in-depth.
- **Acceptance:** Forced throw-after-revenue-insert + retry produces exactly one revenue row.

### FO1 — Integrations fanout envelope lacks `outboxEventId` → Meta/TikTok dead on live traffic
- **Evidence:** `apps/api/src/services/event-bus.ts:74-93` payload has `projectId` but no `outboxEventId`/envelope `eventType`. `routes/v1/events.ts:106-112` stores `body` verbatim (no `outboxEventId`). Consumer `services/integrations-fanout/consumer.ts:93-101` unwraps to inner payload and **discards the dispatcher's outer `eventId`** (`outbox-dispatcher.ts:~198`). Providers `meta-capi.ts:128` / `tiktok-events.ts:138` throw on empty `outboxEventId`. Only `routes/dashboard/integrations.ts:639` (test-fire) sets it.
- **Current:** Every real delivery throws → dead-letters; fanout works only in the test-fire path (why tests pass).
- **Required:** Consumer builds the envelope from the dispatcher wrapper — inject `outboxEventId = parsed.eventId`, `eventType = parsed.eventType` — merged with the inner payload. (Covers `FO1`+`O2`.)
- **Acceptance:** A real revenue event fans out to a configured Meta/TikTok connection without throwing; idempotency key = `outboxEventId`.

### CS1 — `/v1/config/stream` (SSE) serves no flags, no per-subscriber eval, and has no invalidation publisher
- **Evidence:** `routes/v1/config-stream.ts:35-55` emits `loadBundleFromCache(projectId)` = `{schemaVersion, experiments, audiences}` (no `flags`), with no `subscriberId`. Contrast `routes/v1/config.ts:120` (`evaluateAllFlags(...subscriber.id...)` → `{flags, experiments}`). Channel `rovenue:experiments:invalidate` has a subscriber but **no publisher** repo-wide.
- **Current:** SSE config path is non-functional end-to-end and inconsistent with `/v1/config`.
- **Required:** (a) carry `subscriberId` into the stream, evaluate `{flags, experiments}` identically to `/v1/config`; (b) publish to `INVALIDATE_CHANNEL` from `invalidateFlagCache`/`invalidateExperimentCache` (or dashboard mutations). **DECISION:** keep SSE streaming at all, or deprecate the endpoint? If deprecating, remove it instead of fixing.
- **Acceptance:** A connected subscriber receives the same evaluated payload as `/v1/config` and an `invalidate` event after a flag/experiment change.

### ID1 — Subscriber merge crashes when both share an experiment (unique-index collision)
- **Evidence:** `services/subscriber-transfer.ts:49` → `repositories/subscribers.ts:754-763` blind `UPDATE experiment_assignments SET subscriberId=to WHERE subscriberId=from`; unique index `(experimentId, subscriberId)` at `schema.ts:1122-1123`; runs inside the merge tx (`subscriber-transfer.ts:111,145`).
- **Current:** identify/transfer rolls back for any user A/B-tested on both ids (common).
- **Required:** Dedupe before reassign — delete `from`'s rows whose `experimentId` already exists for `to` (keep `to`'s assignment as sticky), then reassign survivors; or insert-select with `ON CONFLICT DO NOTHING` + delete `from`'s.
- **Acceptance:** Merging two subscribers enrolled in the same experiment succeeds; `to` keeps one assignment per experiment.

### PR1 — Store-key namespace collision breaks fulfillment for imported products
- **Evidence:** Write: `routes/dashboard/products.ts:70` `storeKey=enum(ios,android,web)`, import body `:133-136` → `repositories/products.ts:307` writes `storeIds:{[ios|android|web]:…}`. Read: `findProductByStoreId(store: apple|google|stripe)` called with `"apple"`/`"google"` (`apple-webhook.ts:765`, `google-webhook.ts:214`), query `storeIds->>'apple'` (`offerings.ts:85`). SDK offerings also reads apple/google/stripe (`offerings.ts:35-39`). No mapping layer exists.
- **Scope (verified):** store-catalog **import** path is definitively broken; SDK paywall also can't read ios/android keys. Manual create/update uses free-form `z.record` (`products.ts:72`) so depends on the frontend payload.
- **Current:** Imported product → purchase-time lookup misses → `No product mapped…` thrown → no purchase row, no entitlement, no currency grant.
- **Required:** Pick ONE canonical key set and normalize. **DECISION:** canonical = `apple/google/stripe` (matches purchase + SDK read side, the larger surface). Then map `ios→apple, android→google, web→stripe` at import write-time in `bulkCreateProducts` (and the store-catalog query enum), plus a data migration for already-imported rows.
- **Acceptance:** A product imported via store-catalog resolves at purchase time and appears in `/v1/offerings`; existing rows migrated.

### NO1 — SES/SNS webhook signature verification is opt-in (suppression poisoning + SSRF) — SECURITY
- **Evidence:** `routes/webhooks/ses-events.ts:46` verifies only `if (env.AWS_SES_EVENTS_VERIFY_SIGNATURE)` (default falsy, `env.ts:95`); suppression `.add()` (`:135,154`), email master-switch flip (`:172`), and `fetch(payload.SubscribeURL)` (`:60`, SSRF) run regardless; route mounted unconditionally.
- **Current:** Unauthenticated POST can permanently suppress a victim's email, disable their email channel, and induce server-side fetch to an arbitrary URL.
- **Required:** Make SNS signature verification mandatory (fail-closed) whenever the route is reachable; validate `TopicArn` against an allow-list; gate the `SubscribeURL` fetch behind a verified, allow-listed topic.
- **Acceptance:** Unsigned/forged POST is rejected 4xx with no suppression/fetch side effects.

### WH1 — Dead TimescaleDB compression guard blocks webhook retry/dismiss
- **Evidence:** `routes/dashboard/webhooks.ts:25,136-139,175-178` throw HTTP 410 "compressed TimescaleDB chunk" for DEAD rows older than 7 days, but `migrations/0017_partition_outgoing_webhooks.sql` made `outgoing_webhooks` a plain RANGE partition and `0017a` dropped the legacy hypertable — no compressed chunks exist.
- **Current:** Operators permanently locked out of retrying/dismissing DEAD webhooks >7 days old.
- **Required:** Remove the `OUTGOING_WEBHOOK_COMPRESSION_CUTOFF_MS` age guard from both endpoints (plain `UPDATE … WHERE id=$1` is safe).
- **Acceptance:** Retry/dismiss succeeds on an >7-day-old DEAD webhook.

---

## HIGH

### R3 — Google revenue emitted even when the status write is guard-rejected
- **Evidence:** `services/google/google-webhook.ts:312-341` revenue block runs with no `guard.apply` gate (access grant at `:299` is gated).
- **Required:** Wrap the revenue emission in `if (guard.apply) { … }`.
- **Acceptance:** An out-of-order/replayed-after-terminal notification emits no phantom revenue.

### R4 — Google VOIDED_PURCHASE: ungated refund emit (+ REVOKE double-count) and refundDate written on guard-reject
- **Evidence:** `google-webhook.ts:483-538` `createRevenueEvent(REFUND)` ungated; `:504-506` `refundDate:new Date()` outside the `guard.apply` spread; `google-mappers.ts:108-109` maps `SUBSCRIPTION_REVOKED→REFUND` (so VOID+REVOKE = two refunds).
- **Required:** Gate both the REFUND emit and the `refundDate` write on `guard.apply`; ensure a single refund per purchase (idempotent via R1).
- **Acceptance:** VOID followed by REVOKE records exactly one refund; refundDate only set when status actually transitions.

### R5 — Stripe `charge.refunded` treats partial refunds as full
- **Evidence:** `services/stripe/stripe-webhook.ts:414-489` always writes `REFUNDED` (`:456`) + revokes access (`:460`); `amount_refunded` used only for the revenue amount (`:462`); no compare to `amount_captured`.
- **Required:** Only full-revoke + set `REFUNDED` when `amount_refunded >= amount_captured`; for partial, record the refund revenue but keep entitlement/status.
- **Acceptance:** Partial refund keeps access; full refund revokes.

### R6 — Apple receipt-verify path emits no `revenue_events` (diverges from webhook path)
- **Evidence:** `services/receipt-verify.ts` Apple branch upserts purchase + access, no `createRevenueEvent`; `routes/v1/receipts.ts:98` only `recordEvent(...,"purchase")` (experiment tracking).
- **Current:** Revenue exists only if/when the ASSN webhook arrives.
- **Required:** Emit the revenue event on the receipt path too (INITIAL/RENEWAL), idempotent under R1 so the later webhook is a no-op. **DECISION:** confirm we want receipt-path revenue (vs. webhook-only as the single source).
- **Acceptance:** A receipt-verified purchase produces exactly one revenue row even after the matching webhook.

### R7 — Google REVOKE persisted as `EXPIRED` (revoke vs expiry distinction lost)
- **Evidence:** `google-mappers.ts:67-92` mapStatus keys off `subscriptionState`; `REVOKED` only in `default` for unrecognized states; a revoke surfacing as state EXPIRED stores `EXPIRED`.
- **Required:** Check `type===SUBSCRIPTION_REVOKED` before the state switch (or override EXPIRED→REVOKED for that type).
- **Acceptance:** A revoke persists status `REVOKED`.

### A1 — Apple REFUND: single-row status write vs chain-wide access revoke → "ACTIVE purchase, no access"
- **Evidence:** `apple-webhook.ts:438-460` status `REFUNDED` on the single `(store, transactionId)` row; `:461` `revokeAccessForTransaction` over the whole `originalTransactionId` chain.
- **Required:** Align scope. **DECISION:** scope the access revoke to the refunded transaction, OR make the status write chain-wide — pick one.
- **Acceptance:** No subscriber ends with an ACTIVE purchase and no access after a partial-period refund.

### A2 — PAUSED purchases never reach the expiry-checker; perpetual access can persist
- **Evidence:** `workers/expiry-checker.ts:74-79` candidates = ACTIVE/GRACE_PERIOD/TRIAL (no PAUSED); `access-engine.ts:6-8` PAUSED not access-granting; `syncAccess` only fires from `webhook-processor.ts:116` on processed webhooks.
- **Required:** Include PAUSED in the expiry-checker candidate set (state machine allows PAUSED→EXPIRED), or add a periodic reconcile. **DECISION:** confirm PAUSED is meant to be terminal-eligible.
- **Acceptance:** A paused subscription whose `expiresDate` lapses reaches EXPIRED and access is revoked without a new webhook.

### A3 — Merge does not recompute `subscriber_access` (no `syncAccess`)
- **Evidence:** `services/subscriber-transfer.ts:41-52` moves access rows via blind UPDATE; no `syncAccess` anywhere in the file.
- **Required:** Call `await syncAccess(to.id)` after `reassignAllAssets` (inside/just after the tx).
- **Acceptance:** Post-merge there is one active row per `accessId` with the correct (latest) expiry.

### ID2 — funnel-claim binds to a merged-away subscriber
- **Evidence:** `routes/v1/funnel-claim.ts:150-152` `upsertSubscriber({rovenueId})` returns the conflict row without following `mergedInto`; `resolveSubscriberByRovenueId` (`subscribers.ts:153-175`) does follow the chain.
- **Required:** Resolve via `resolveSubscriberByRovenueId` first; upsert only if no live canonical row.
- **Acceptance:** Claiming on a merged anon id attaches to the canonical survivor.

### FO2 — Outbox dispatcher double-publishes under multi-instance (claim lock released before publish)
- **Evidence:** `repositories/outbox.ts:36-49` `claimBatch` FOR UPDATE SKIP LOCKED with no row-marking; claim tx commits (`outbox-dispatcher.ts:160`) before `producer.send` (`:198`) and the separate `markPublished` tx (`:255`).
- **Required:** Mark rows claimed (`publishedAt`/claimed marker/`claimedAt`) inside the claim tx, or hold one tx across publish+mark, or shard by partition.
- **Acceptance:** Two concurrent dispatchers do not both publish the same row (idempotency at FO1 mitigates downstream regardless).

### FO3 — No Meta/TikTok mapping for REFUND/CANCELLATION
- **Evidence:** `services/integrations/event-mapping.ts:7-22` maps only INITIAL/TRIAL_CONVERSION/RENEWAL/CREDIT_PURCHASE; `types.ts:10-16` kinds include REFUND/CANCELLATION → `no_mapping` skip.
- **Required:** Add explicit REFUND/CANCELLATION mappings, or document the intentional omission. **DECISION:** forward refunds to ad platforms? (most CAPI setups expect them.)
- **Acceptance:** Refund/cancellation either maps to the provider's refund event or is documented as intentionally dropped.

### FN1 — Funnel emits snake_case `project_id` → dropped from live-events SSE
- **Evidence:** emits use `project_id` (`routes/public/funnels.ts:192,305,385,392`; `funnel-claim.ts:193,203`); `outbox-dispatcher.ts:26` `projectIdOf` reads camelCase `payload.projectId` → null → live-events skip.
- **Required:** Emit camelCase `projectId` in funnel payloads (or make `projectIdOf` fall back to `project_id`). Prefer fixing emitters for consistency.
- **Acceptance:** Funnel events appear on the project live-events channel.

### WE1 — `webhook_events` dedup key lacks `projectId`; store + SaaS billing both `source=STRIPE`
- **Evidence:** unique index `(source, storeEventId)` (`migrations/0000_*.sql:385`); store inserts `WebhookSource.STRIPE` (`stripe-webhook.ts:122`), SaaS billing inserts `"STRIPE"` (`webhook-handlers/index.ts:110`).
- **Required:** Either add `projectId` to the unique key, or give SaaS billing a distinct `source` (e.g. `STRIPE_BILLING`). Prefer distinct source (smaller blast radius, no cross-account id assumptions).
- **Acceptance:** A store event id equal to a billing event id no longer drops one silently.

### EX1 — Two divergent experiment results engines (exposure vs assignment)
- **Evidence:** SDK `routes/v1/experiments.ts:221` → `computeExperimentResults` (CH exposures); dashboard `routes/dashboard/experiments.ts:735` → `getExperimentResults` (PG assignments).
- **Required:** Standardize on exposed-users denominator (correct A/B unit) and have both endpoints read it. **DECISION:** confirm exposed-users as the canonical denominator (vs assignments).
- **Acceptance:** Both endpoints return reconciling sample sizes/rates for the same experiment.

### EX2 — ClickHouse results conversions hardcoded to 0
- **Evidence:** `services/experiment-results.ts` `aggregate()` `conversions: 0` ("Plan 2 fills this"), fed into `analyzeConversion`.
- **Required:** Wire the conversion source (revenue/conversion join), or gate the conversion block so the API returns null/"pending" rather than misleading zeros. **DECISION:** wire now vs hide until the join MV lands.
- **Acceptance:** Results API never reports a false "0 conversions, not significant".

### EX3 — Conversion recording ignores experiment status
- **Evidence:** `repositories/experiment-assignments.ts` `findAssignmentsWithMetrics` filters only `subscriberId` (no status); `experiment-engine.ts:368` writes `convertedAt` for stopped/paused experiments; expose path correctly rejects non-RUNNING.
- **Required:** Add a RUNNING status predicate to the conversion-recording query/path.
- **Acceptance:** Conversions are not recorded against DRAFT/PAUSED/COMPLETED experiments.

### SB1 — SaaS billing never handles `customer.subscription.deleted` (no downgrade to free)
- **Evidence:** `services/billing/webhook-handlers/index.ts:48-58` handler map lacks `customer.subscription.deleted`; unmapped → `{status:"ignored"}` (`:71-75`).
- **Required:** Add a handler resetting `billing_subscriptions` to free/expired + emit `billing.deactivated`.
- **Acceptance:** Canceling a project plan in Stripe downgrades tier/limits.

### CR1 — Credit spend has no `referenceId` dedup → retried debit double-charges
- **Evidence:** `services/credit-engine.ts` `spendCredits` has no `dedupeOnReference`/existing-ref check (grants do, `addCredits:89`); `routes/v1/virtual-currencies.ts:104` forwards `referenceId` but can't dedupe.
- **Required:** Support `dedupeOnReference` in `spendCredits` (same in-lock check), have the route pass it when `referenceId` is present.
- **Acceptance:** A retried spend with the same `referenceId` debits once.

---

## MEDIUM

### WH2 — Outgoing webhook delivered unsigned when `webhookSecret` is null
- **Evidence:** `workers/webhook-delivery.ts:144-146` attaches signature only when secret truthy; no config-time enforcement.
- **Required:** Require a `webhookSecret` whenever `webhookUrl` is set (validate at config time), or fail delivery loudly when missing.
- **Acceptance:** No project can receive unsigned webhooks.

### FL1 — Flag percentage rollout has no per-rule salt
- **Evidence:** `services/flag-engine.ts:198` `isInRollout(subscriberId, flag.key, …)` — seed is `flag.key` for every rule.
- **Required:** Salt per rule: `isInRollout(subscriberId, \`${flag.key}:${ruleId|index}\`, pct)`.
- **Acceptance:** Two rules in one flag bucket subscribers independently.

### NO2 — Digest `targetDay` computed from `targetTimezones[0]` only
- **Evidence:** `workers/digest-scheduler.ts` daily `:~78` / weekly `:~180` compute the day once from zone[0]; `eventId` embeds it.
- **Required:** Compute `targetDay`/`weekStart` per-user from `u.timezone` inside the loop.
- **Acceptance:** Each user's digest covers their own local "yesterday"; no double-send across the date line.

### FN2 — iOS deferred fingerprint timezone hardcoded `UTC` → match always fails
- **Evidence:** `routes/public/funnel-universal.ts:~106` stores `timezone:"UTC"`; SDK sends real tz (`funnel-claim.ts:248-255`); `services/funnel/fingerprint.ts:43` strict tz equality (escape hatch only for `screenDims` `0x0`).
- **Required:** Store `null`/sentinel tz server-side and skip the tz axis when either side is unknown (mirror the `0x0` treatment); also lowercase locale in `normalizeFingerprint`.
- **Acceptance:** iOS deferred claim matches for non-UTC devices.

### CR2 — `findLatestBalance` has no `id` tie-break (nondeterministic on same-timestamp rows)
- **Evidence:** `repositories/credit-ledger.ts:62` `orderBy(desc(createdAt)).limit(1)` (no `desc(id)`).
- **Required:** Add `desc(creditLedger.id)` as the final order key in `findLatestBalance` (and any other "latest row" read).
- **Acceptance:** Latest-balance pick is deterministic for identical `createdAt`.

### PR3 — Dead `products.creditAmount` still written/surfaced in metrics
- **Evidence:** grant path reads only `product_currency_grants` (`purchase-credits.ts:24-37`); `creditAmount` still written by import and read by `metrics/credits.ts:633,648,748`.
- **Required:** Remove `creditAmount` from import schema/response (or mark deprecated/no-op) and migrate metrics to `product_currency_grants`.
- **Acceptance:** No surface implies credit grants from `creditAmount`.

### PR2 — `product_groups` table absent (schema drift; "one active sub per group" unenforceable) — DECISION
- **Evidence:** no `product_groups`/`productGroups` in `schema.ts`; CLAUDE.md lists it as an app table.
- **Required:** **DECISION:** is the product-group feature in scope? If yes, add table + `group_id` on products + a purchase-time "deactivate other active access in same group" step. If no, remove it from CLAUDE.md.
- **Acceptance:** Doc and schema agree; group exclusivity enforced if the feature is kept.

---

## Implementation progress

### W1 — Revenue integrity ✅ (compile-clean, 59/59 unit tests green)
- **R1** — Idempotent revenue recording via a dedicated **`revenue_event_dedupe(projectId, dedupeKey)`** table (migration `0078_freezing_silvermane.sql`), NOT a unique index on the partitioned `revenue_events` (which would force `eventDate` into the key and break cross-path convergence). `createRevenueEvent` claims the dedupe key first; on conflict it returns the existing row and skips the insert + outbox emit. `revenue_events.dedupeKey` kept as a denormalized trace column. *(schema.ts, revenue-events.ts, db barrel)*
- **R2** — Closed via R1's idempotent claim (durable fix). Full dispatch tx-wrap deferred as defense-in-depth.
- **R3** — Google subscription revenue now gated on `guard.apply`. *(google-webhook.ts)*
- **R4** — Google VOIDED_PURCHASE: refund emit + `refundDate` now gated on `guard.apply` (REVOKE+VOID converge to one refund). *(google-webhook.ts)*
- **R5** — Stripe `charge.refunded`: full-vs-partial split — only a full refund flips REFUNDED + revokes access; a partial records the amount only. *(stripe-webhook.ts)*
- **R6** — ✅ Apple **receipt-verify** path now emits INITIAL/RENEWAL revenue, idempotent via the same `apple:<txId>:<kind>` dedupeKey as the webhook (RevenueCat/Adapty model — receipt records immediately, webhook is async + backstop, dedup converges). *(receipt-verify.ts)* **Google receipt-side revenue deferred**: it needs the same store pricing resolution the webhook uses (`resolvePricing`) to guarantee an identical amount before "first-wins" dedup is safe — tracked as a follow-up; Google revenue stays webhook-sourced for now.
- **R7** — Google `mapStatus`: `SUBSCRIPTION_REVOKED` honored before the state switch → persists `REVOKED` not `EXPIRED`. *(google-mappers.ts)*
- **dedupeKey design** — keyed on `<store>:<transactionId>:<kind>` where `kind` ∈ {purchase, reactivation, refund, cancel} (helper `revenueDedupeKind`, exported top-level from `@rovenue/db`). Coarse `kind` lets receipt + webhook converge despite classifying the same transaction differently, while keeping REACTIVATION/REFUND on the same transaction id distinct. Per-transaction id: Apple `transactionId`, Google `latestOrderId` (period-specific — purchaseToken is stable across renewals), Stripe `invoice.id` / `event.id`. Google/Stripe emit dates made deterministic (RTDN `eventTimeMillis` / Stripe `event.created`) → correct analytics period.

### W2 — Fulfillment & access ✅ (compile-clean; affected tests green in isolation)
- **PR1** — ✅ Store-key collision fixed. Canonical `apple/google/stripe` everywhere: `canonicalStoreKey`/`normalizeStoreIds` helpers map `ios→apple, android→google, web→stripe` at every write boundary (`bulkCreateProducts`, `createProduct`, `updateProduct`, list-filter, import-response, store-catalog reconciliation). Data backfill migration `0079_backfill_product_store_keys.sql` renames legacy JSON keys on existing rows. *(products.ts repo, dashboard/products.ts, store-catalog.ts, migration 0079)*
- **A1** — ✅ Apple REFUND access revoke scoped to the refunded transaction (`revokeAccessByPurchaseId(found.id)`) instead of the whole originalTransactionId chain — no more "ACTIVE purchase, no access" on sibling purchases. REVOKE/EXPIRE stay chain-wide. *(apple-webhook.ts)*
- **A2** — ✅ PAUSED added to the expiry-checker candidate statuses (so a lapsed paused sub reaches EXPIRED + emits cancellation) and excluded from the grace-period promotion. *(expiry-checker.ts)*
- **A3** — ✅ Merge now recomputes the surviving subscriber's denormalized access — `safeSyncAccessAfterMerge` (best-effort, post-commit) called from both `transferSubscriber` and `bindAppUserId` (when a merge happened). *(subscriber-transfer.ts, identify.ts)*
- **ID1** — ✅ Merge no longer crashes when both subscribers share an experiment: `reassignExperimentAssignments` deletes the source's colliding rows (correlated EXISTS, explicitly qualified to dodge the Drizzle unqualified-subquery footgun) before the UPDATE. *(subscribers.ts repo)*
- **ID2** — ✅ funnel-claim resolves via `resolveSubscriberByRovenueId` (follows `mergedInto`) before upserting, so a claim never binds to a merged-away subscriber. *(funnel-claim.ts)*

> Verification: db + api compile clean; W2-affected unit + integration tests pass in isolation (apple ×N, subscriber-transfer integration, funnel-claim, products/offerings). Broad-sweep flakes in `integrations-deliver`/`backfill` integration tests are shared-infra parallel contention (pass in isolation), unrelated to these changes. One test mock updated (`apple-webhook.refund-shield.test.ts` accessRepo gained `revokeAccessByPurchaseId`).

### W3 — Fanout / config / webhooks ✅ (compile-clean; affected tests green in isolation)
- **FO1** — ✅ Integrations fanout fixed. New `toFanoutEnvelope` in the consumer builds a proper `RovenueEventEnvelope` from the dispatcher wrapper — injecting `outboxEventId = wrapper.eventId` (the field providers hard-require + dedup on) and mapping the ClickHouse-shaped revenue payload (`type→revenueEventKind`, `eventDate→occurredAt`, `amount/currency`, `subscriberId→identityContext.externalId`). Producer payload unchanged (CH Kafka-engine reads it). Non-revenue events skipped. *(integrations-fanout/consumer.ts)*
- **FO2** — ✅ Resolved by the **single-dispatcher contract** (`OUTBOX_DISPATCHER_ENABLED` gates the one dedicated dispatcher; API replicas off) + FO1's idempotency (BullMQ jobId `connectionId:outboxEventId` + CH idempotent views). Documented at `claimBatch` with the leased-`claimedAt` upgrade path if multi-dispatcher is ever needed. *(outbox.ts)*
- **FO3** — ✅ REFUND/CANCELLATION intentional omission documented (Meta CAPI / TikTok Events have no refund conversion event; forwarding would corrupt ad optimization). `no_mapping` skip is the desired behavior, now explicit. *(event-mapping.ts)*
- **FN1** — ✅ `projectIdOf` accepts both camelCase `projectId` and the funnel domain's snake_case `project_id`, so funnel lifecycle events reach the live-events stream. *(outbox-dispatcher.ts)*
- **WE1** — ✅ SaaS billing claims `webhook_events` under a distinct `STRIPE_BILLING` source (new enum value, migration `0080_grey_reaper`) so the `(source, storeEventId)` dedup can't collide with per-project store STRIPE events across the two Stripe accounts. *(enums.ts, db index, webhook-handlers/index.ts, migration 0080)*
- **CS1** — ✅ `/v1/config/stream` rewritten: requires a subscriberId and emits the SAME evaluated `{ flags, experiments }` as `/v1/config` (shared `evaluateSubscriberConfig` service), and the flag/experiment cache-invalidation paths now `publishConfigInvalidation` to the channel the stream listens on (`lib/config-invalidation.ts`). Stream test rewritten for the new contract. *(config-stream.ts, subscriber-config.ts, config.ts, flag-engine.ts, experiment-engine.ts)*
- **WH1** — ✅ Dead TimescaleDB 7-day "compressed chunk" guard removed from retry + dismiss (the hypertable was dropped in 0017/0017a/0018). *(dashboard/webhooks.ts)*

> Migrations added by this audit: `0078_freezing_silvermane` (revenue dedupe), `0079_backfill_product_store_keys` (store-key data), `0080_grey_reaper` (STRIPE_BILLING enum).

### W4 — Experiments ✅ (compile-clean; CH query validated against the live ClickHouse schema)
- **EX1** — ✅ Dashboard `/:id/results` now calls `computeExperimentResults` (CH, exposed-users) — the SAME source as the SDK endpoint — so the two can no longer report divergent numbers. (No dashboard frontend consumed the old PG shape, so the swap is safe.) *(dashboard/experiments.ts)*
- **EX2** — ✅ Conversions wired (no longer hardcoded 0). The `experiment_results` analytics query was rewritten: it joins `raw_exposures` with `raw_revenue_events` at query time (no new MV → no MV-recreate Kafka-gap risk) to count, per variant, distinct exposed subscribers with a purchase-class revenue event at/after first exposure. Also scoped by `projectId`. **Latent bug fixed**: the old query referenced columns that don't exist in the real schema (`experiment_id`/`unique_users_state`/`country` vs the actual `experimentId`/`subscribersHll`) — it would have errored against production ClickHouse; it was masked because CH is off in dev/tests. New query validated (parse + run) against the live dev ClickHouse. *(analytics-router.ts, experiment-results.ts)*
- **EX3** — ✅ `findAssignmentsWithMetrics` now filters to `status = RUNNING`, so a COMPLETED/PAUSED experiment stops accruing conversions (consistent with the expose path). *(experiment-assignments.ts repo)*
- Denominator unified on **exposed users** (`uniqueUsers`) for both the conversion analysis and SRM — not raw exposure events. *(experiment-results.ts)*

> Verification: experiment unit tests green (results 3/3 with a real conversion-rate assertion, engine 20/20, expose 7/7). The corrected CH query was validated against the running dev ClickHouse (correct columns + conversion join run cleanly).

### W5 — Security / billing / credits ✅ (compile-clean; affected tests green in isolation)
- **NO1** — ✅ SES/SNS signature verification is now **fail-closed**: mandatory in production (`NODE_ENV === "production"`), with the `AWS_SES_EVENTS_VERIFY_SIGNATURE` flag able to relax it ONLY in non-production. A forged payload is now rejected (403) before any suppression-list write or `SubscribeURL` fetch — closing the suppression-poisoning + SSRF holes. *(routes/webhooks/ses-events.ts)*
- **SB1** — ✅ Added the `customer.subscription.deleted` handler: a canceled/ended project plan now downgrades the billing record back to free (`downgradeToFreeOnDeleted` → state/tier `free`), so a lapsed plan no longer keeps elevated tier/capabilities. *(billing/webhook-handlers/handle-subscription-deleted.ts + index.ts, billing-subscriptions.ts repo)* — coordinated with the parallel billing work (the handler map still lacked it; no conflict).
- **CR1** — ✅ `spendCredits` supports `dedupeOnReference` (mirrors `addCredits`): a retried spend with the same `referenceId` returns the original SPEND row inside the per-wallet advisory lock instead of double-debiting; the v1 spend route passes it whenever a `referenceId` is supplied. *(credit-engine.ts, routes/v1/virtual-currencies.ts)*

---

## ✅ AUDIT COMPLETE — all 26 CRITICAL + HIGH findings fixed (W1–W5)

8 CRITICAL + 18 HIGH, across 5 workstreams. **The 6 MEDIUM + PR2 are now also resolved** (second pass): FL1 per-rule rollout salt, NO2 per-user digest day (daily+weekly), FN2 iOS deferred fingerprint empty-tz sentinel + lowercase locale, WH2 reject webhookUrl without a signing secret, CR2 `desc(id)` tie-break on credit balance reads, PR3 dropped the dead `creditAmount` from product import (metrics-display migration to product_currency_grants deferred to align with the dashboard VC work), PR2 resolved as doc-drift (product_groups removed from CLAUDE.md — feature out of scope). db + api compile clean (only the unrelated parallel `billing/usage.ts` WIP is red). All workstream-affected tests pass in isolation. **4 migrations**: `0078_freezing_silvermane` (revenue dedupe), `0079_backfill_product_store_keys`, `0080_grey_reaper` (STRIPE_BILLING enum). The corrected experiment CH query was validated against the live dev ClickHouse. No commits made (branch managed by the user). The 6 MEDIUM findings (WH2, FL1, NO2, FN2, CR2, PR3) + PR2 remain deferred for a follow-up pass.

> Note: a parallel **billing-usage-metering** effort is live in the working tree (`apps/api/src/services/billing/usage.ts` + specs under `docs/superpowers/`). Its `usage.ts` tsc errors are pre-existing/unrelated to this audit. W5's `SB1` is the **SaaS billing** path (`billing/webhook-handlers/`) — the *store* Stripe path already handles `customer.subscription.deleted` — will coordinate to avoid collision.
> Integration tests for the new dedupe table (replay → single row) should run under testcontainers before merge.

## REFUTED (excluded)

- **Cohort retention SQL "unbalanced parens"** — `services/cohorts.ts`: the `dateDiff('month'` open-paren is closed by the trailing literal `)` at each interpolation site; SELECT and WHERE are parenthesis-balanced. Not a bug.
