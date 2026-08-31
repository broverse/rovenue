# Migration & Data Import — Design Spec

**Date:** 2026-08-31
**Roadmap area:** §11 Docs & DX (65 → 95), priority item 2 — "RevenueCat / Adapty migration guides + data import tool"
**Parity bar:** RevenueCat's and Adapty's own documented migration paths. Both are beatable; see §1.

---

## 1. Context (from the 2026-08-31 exploration)

**Research file:** `docs/superpowers/research/2026-08-31-rc-adapty-export-formats.md` — every vendor claim below is sourced there, with unconfirmed items labelled. Read it before implementing a parser.

### What the vendors actually give a departing customer

- **RevenueCat** — Scheduled Data Exports (CSV/Parquet to S3/GCS/Azure/email), self-serve but **Pro+ plan gated**. The Transactions feed's column set is documented and confirmed. Three facts drive this design:
  1. **The schema is versioned (v3 / v4 / v5)** and has changed between versions. An importer that hard-codes one column layout will silently mis-parse another customer's file.
  2. **Google Play purchase tokens are NOT in the standard export.** They require a separate, support-mediated CSV (`user_id, google_purchase_token, google_product_id`). Without it, Android subscriptions cannot be re-verified against the Play API.
  3. Rows are **snapshots**, not an event log — the same transaction can look different across deliveries (`updated_at` is the reconciliation anchor). There is no bulk "list all customers" REST endpoint; the API is one customer at a time.
- **Adapty** — daily S3 CSV export and an Analytics Export API, both self-serve. **Its literal column table could not be confirmed** in research; treat any Adapty column list as unverified until re-fetched.
- **Neither vendor's inbound migration is self-serve for history.** Adapty's is explicitly support-mediated: you email a human a CSV — and *RevenueCat's export works unmodified*, which makes the RC export the de-facto interchange format of this market.
- **Adapty is candid about what it loses on import** (quoted in the research file): every transaction is re-validated against the store and unrecognised rows are **dropped**; promotional/manual entitlements arrive as transaction-less profiles; refund and billing-issue history loses its original dates; on Android **only active subscriptions and only the latest renewal** are restored, and the *current* price is used for past purchases.

That last bullet is the opening. A migration that keeps history *and* re-validates what it can is strictly better than the incumbent, and is achievable.

### What already exists in this repo

- **A bulk-import precedent, catalog-only:** `POST /dashboard/projects/:projectId/products/import` (`apps/api/src/routes/dashboard/products.ts:358-410`) → `bulkCreateProducts` (`packages/db/src/drizzle/repositories/products.ts:264-362`). One transaction, per-row skip reasons, capped at 500 items, fully synchronous. Good shape to imitate for reporting; wrong shape for volume.
- **The safe write seam.** Third-party integration fan-out (Meta/TikTok/Braze…) and the customer's own outgoing webhooks are emitted **only** from `runPostProcessing` (`apps/api/src/services/webhook-processor.ts:240-459`). The receipt-verification path (`apps/api/src/services/receipt-verify.ts`) writes purchases, subscribers and access without touching either. **An importer modelled on receipt-verify therefore cannot spam a customer's integrations with two years of backdated events.** This is the single most important structural fact in this design.
- **One exception to side-effect-freedom:** `createRevenueEvent` (`packages/db/src/drizzle/repositories/revenue-events.ts:139-190`) writes a `REVENUE_EVENT` outbox row inside its own transaction — not opt-in. That row feeds Kafka → ClickHouse, which is exactly how imported history reaches analytics. It supports an optional `dedupeKey` (unique on `(projectId, dedupeKey)`); replays return the existing row and skip the second emit.
- **`subscriber_access` is derived, never hand-authored.** `syncAccess(subscriberId)` (`apps/api/src/services/access-engine.ts:23-108`) recomputes it from live `purchases` rows under a per-subscriber advisory lock, with no outbox/audit/webhook side effects.
- **Identity has no alias table.** A subscriber is one `subscribers` row unique on `(projectId, rovenueId)`, with `appUserId` and `appleAppAccountToken` columns. Merges are `UPDATE`-based reassignment plus a `mergedInto` stamp. Every SDK write path resolves through `resolveSubscriberForWrite`/`resolveOrCreateSubscriber` (`apps/api/src/lib/resolve-or-create-subscriber.ts:35-89`), which **follows the merge chain before inserting**. An importer that writes subscribers directly and skips this will fork writes onto dead rows.
- **Idempotency primitives available:** `ON CONFLICT` upserts (`upsertSubscriber` on `(projectId, rovenueId)`; `upsertPurchase` on `(store, storeTransactionId)`, with a guard so terminal `REFUNDED`/`REVOKED` can never be resurrected), advisory locks (`packages/db/src/drizzle/repositories/locks.ts`), the audit hash chain (`apps/api/src/lib/audit.ts`, `AuditAction` is a closed union that must be extended for new actions).
- **No job UX exists — anywhere.** There is no "start a job, watch progress, download the result" pattern in the dashboard. Both CSV exports stream synchronously inside one request; SSE is used only for live feeds. This sub-project introduces that pattern for the first time.
- **No generic file ingestion.** The only upload path is paywall assets (`apps/api/src/routes/dashboard/assets.ts`), raw-body (not multipart), per-kind `bodyLimit`, sha256 dedup, S3 via `apps/api/src/lib/asset-store.ts` (key `{projectId}/{assetId}.{ext}`).
- **Docs:** a lean `resources/migrating-from-revenuecat.mdx` **already exists** (ROADMAP §11 is stale on this point — it lists both guides as unstarted). `resources/` is the established home; `resources/meta.json` registers pages. Nothing anywhere claims a CSV import tool exists — do not create that claim before it ships. Separately: `pnpm run check:links` in `apps/docs` **already exits 1** on a pre-existing broken link (`reference/methods.mdx` → `/docs/guides/funnel-attribution`), and **no CI job builds `apps/docs` at all**.

---

## 2. Goals

1. A **vendor-agnostic CSV importer** that ingests a RevenueCat export (the market's de-facto interchange format), an Adapty export, or a hand-rolled CSV, and creates subscribers, historical purchases, revenue history and live entitlements in a Rovenue project.
2. **Two-phase fidelity**: keep the full history the CSV carries, *and* re-validate against the stores whatever carries a usable anchor — so a migrating customer loses neither analytics history nor live access.
3. **Safe by construction**: an import never triggers third-party integration fan-out or the customer's outgoing webhooks, and never double-counts revenue on a re-run.
4. **Honest by construction**: every row that could not be fully imported is reported with a reason, downloadable as CSV. The tool states what it could not do rather than silently succeeding.
5. **A first-class async job UX** — upload, dry-run preview, commit, live progress, error report — established here as the pattern for future long-running dashboard work.
6. Two docs guides at the quality bar of the platform pages: **Migrate from RevenueCat** (extend the existing page) and **Migrate from Adapty** (new).

## 3. Non-goals

- **Pulling data from vendor APIs on the customer's behalf.** RC has no bulk customer endpoint and Adapty's export is file-based; an API-pull integration would need the customer's vendor credentials for marginal benefit. The customer exports; we ingest the file.
- **Importing paywall, offering, experiment or audience *configuration*.** Neither vendor documents an export for these. Products/offerings already have their own import path.
- **A shipped "Adapty preset" built on unverified columns.** Adapty's column table could not be confirmed; shipping a preset that claims to know it would be fabrication. Adapty users go through the generic mapper, and the guide walks them through it. If the columns are confirmed later, a preset is a small follow-up.
- **Migrating from any third vendor by name.** The generic mapper serves them; we make no per-vendor claim we have not verified.
- **Backfilling ClickHouse directly.** Imported revenue reaches analytics the same way live revenue does — through the outbox. No second path to the same table.

---

## 4. Design

### 4.1 Shape: a mapper, not a parser

The importer is a **column-mapping engine with vendor presets**, not a set of hard-coded vendor parsers. This falls directly out of the research: RC's schema is versioned and partly unconfirmed, and Adapty's is unconfirmed entirely. A fixed parser would be wrong for some customers on day one and silently wrong later.

Flow: **upload → detect → map → dry run → commit → report.**

- **Detect**: parse the header row, fingerprint it against known presets, propose a mapping. The **RevenueCat Transactions preset** ships with the confirmed v4/v5 column names and is applied only when the header actually matches; a partial match proposes a mapping and says so rather than assuming.
- **Map**: the operator confirms or corrects the source-column → canonical-field mapping in the UI. Unmapped required fields block the commit; unmapped optional fields are listed as "will not be imported".
- The **canonical import field set** is the contract between the mapper and the writer — a named, documented set (subscriber identity, store, store transaction id, product identifier, purchase/expiry/grace timestamps, price + currency, trial/intro flags, refund/unsubscribe timestamps, sandbox flag, renewal number, entitlement identifiers, country, attributes). Every preset targets it; the writer only ever sees canonical fields.

### 4.2 The two-phase fidelity model

**Phase A — historical ledger (always runs).** Every accepted row becomes a `purchases` row and, where it carries money, a revenue event. These are marked as **imported and unverified**: they are history, and they power LTV/MRR/cohorts. Nothing is dropped merely because the store no longer recognises it — this is precisely where Adapty loses data, and keeping it is the differentiator.

**Phase B — live re-validation (runs where an anchor exists).** For rows carrying a usable store anchor — Apple `originalTransactionId`, Google `purchaseToken`, Stripe subscription/customer id — the importer re-verifies against the store using the project's already-configured store credentials, exactly as receipt validation does today, and lets the normal state machine own the subscription from then on. Verified rows are marked verified; the live state supersedes the imported snapshot.

Then `syncAccess(subscriberId)` derives `subscriber_access` from the resulting purchases. Access is never written directly.

**The Google gap is surfaced, not hidden.** Because RC's standard export omits `google_purchase_token`, an RC-sourced import will have Android rows that cannot reach Phase B. The tool must:
- detect that the mapped file has Play rows with no purchase-token column,
- state plainly in the dry-run preview how many Android subscriptions will be **history-only** and therefore will not grant live access,
- and point at the remedy: request the supplemental CSV from RC support (`user_id, google_purchase_token, google_product_id`) and run a **second import** that joins on `user_id` to upgrade those rows.

Supporting that second, token-only file is a first-class case, not an afterthought: the mapper must accept a file whose only useful columns are an identity and an anchor.

### 4.3 Side-effect discipline (the rules the writer obeys)

1. **Never** write a `SUBSCRIPTION`-aggregate outbox row, and never enqueue an outgoing webhook. Import writes go through repository functions and `syncAccess`, never through `runPostProcessing`.
2. **Do** create revenue events, always with a **stable `dedupeKey` derived only from the source transaction** — never from the import-job id, or a re-run doubles the customer's revenue. Shape: `import:<store>:<storeTransactionId>:<renewalNumber>`.
3. Resolve subscribers through the existing merge-chain-following resolver; never insert around it.
4. Write **one** audit entry per import job (started / completed, with counts), not one per row. This needs a new `AuditAction` literal.
5. Sandbox rows are **skipped by default**, with an explicit opt-in toggle, and counted in the report either way.

### 4.4 Job model and data changes

A new `import_jobs` table (project-scoped): source vendor label, uploaded file reference, the confirmed column mapping, options (skip-sandbox, dry-run), status, per-phase counters, error-report reference, who started it, timestamps. Status is a closed enum covering upload → mapping → dry-run-complete → running → completed / failed / cancelled.

Row-level outcomes are **not** stored as table rows (a million-row import would double the write volume for data nobody queries). They are streamed into an error/outcome report file in object storage, downloadable from the dashboard.

Processing runs on a **new BullMQ queue** (the repo has no queue factory; each worker declares its own, and this one follows that convention). The worker streams the file from object storage, processes in bounded batches, and **checkpoints progress on the job row** so a worker restart resumes rather than restarting — a million-row import must survive a deploy.

**Uploaded files contain end-user PII.** They are stored under a dedicated key prefix, never publicly readable (note: `mc anonymous set download` also grants public `ListBucket` — the bucket policy must be `s3:GetObject`-only and verified in both directions), and are deleted on a documented retention window after the job reaches a terminal state.

### 4.5 Dry run

A dry run is mandatory before commit and does everything the real run does except write: parse, map, validate, resolve identities, classify each row (would-create / would-update / would-skip + reason), and count what Phase B could and could not verify. It produces the same report artefact as a real run. This is what makes the Google-token gap visible *before* a customer commits a migration.

### 4.6 Auth

Dashboard-initiated, project-scoped, gated by a **new capability at ADMIN+** — bulk creation of subscribers and purchases is at least as sensitive as the GDPR operations, which are already ADMIN-only. The service re-checks `projectId` server-side and 404s (not 403s) on cross-tenant ids, matching the GDPR export/anonymize discipline. No S2S secret-key surface in v1; `apiKeyAuth` is wired only to `/v1/*` SDK routes today and a bulk-admin secret-key path is new territory that this sub-project does not need.

### 4.7 Dashboard UX

A project-scoped Migration page: upload → mapping table (source column ↔ canonical field, with the preset pre-filled and every unmapped required field blocking) → dry-run summary (counts by outcome, the Android history-only warning where applicable) → commit → live progress → completion summary with a downloadable report. Progress is polled; the codebase has no job-progress SSE pattern and introducing one is not justified by this feature.

### 4.8 Docs deliverables

- **Extend `resources/migrating-from-revenuecat.mdx`** — it exists and is lean (concept-mapping table + key differences). It gains the actual migration procedure: export from RC, what the export does and does not contain, the Google-purchase-token support request and the two-pass import, the mapping step, the dry run, verification, and SDK cutover. It must not contradict its existing claims.
- **New `resources/migrating-from-adapty.mdx`**, registered in `resources/meta.json` — same structure, honest that Adapty's export columns are mapped by hand through the generic mapper.
- Both pages state, plainly, **what does not survive any migration** (event history, original historical prices, full renewal chains, promotional entitlements without a store transaction) — symmetric with what Adapty publishes about importing our competitors' data. A guide that overpromises here is a support burden and a credibility loss.
- Docs conventions are fixed by the existing corpus: two frontmatter fields only, no top-level `#`, `Tabs`/`Steps`/`Callout` imported per page, `Cards`/`Accordion` unused anywhere, and **generic angle brackets only ever inside code spans** (bare `<T>` in prose is parsed as JSX and breaks the prerender).

---

## 5. Data changes

- New `import_jobs` table + its status enum (one migration).
- One new `AuditAction` literal.
- One new capability entry in the capability→roles table.
- No changes to `subscribers`, `purchases`, `subscriber_access`, or `revenue_events` **schemas**; the importer writes through existing repository functions. If a row-level "imported/unverified" marker is needed on `purchases`, it is an additive nullable column — the plan must confirm against the real schema whether one already exists rather than assuming.

---

## 6. Risks / decisions worth stating

- **Mapper over fixed parsers** costs a UI step and a mapping contract, and buys correctness against a versioned schema we do not fully control, plus Adapty and every hand-rolled CSV for free.
- **Keeping unverifiable history** (where Adapty drops it) is the core product bet. The cost is that some imported purchases are historical records that never grant access; the mitigation is that they are explicitly marked and counted, never silently presented as live.
- **The Google purchase-token gap is a vendor limitation we cannot engineer away.** The design's obligation is to make it loud and to support the two-pass remedy — not to paper over it.
- **Revenue dedup is the highest-consequence detail in this spec.** A `dedupeKey` that includes the job id would double a customer's lifetime revenue on their second attempt. It is derived from source transaction identity only.
- **Import volume is unbounded.** Streaming + batching + checkpointed resume are requirements, not optimisations.
- **Vendor claims must stay sourced.** The research file labels several items unconfirmed (RC's Subscriber-feed columns, RC's raw currency column, Adapty's S3 columns, v3/v4/v5 deltas). Implementation may not convert an unconfirmed item into a confident assertion in code comments or docs; it must re-verify first-party or keep the hedge.

---

## 7. Acceptance criteria

1. An operator can upload a RevenueCat Transactions export, see a proposed mapping, run a dry run, read a per-outcome summary, commit, watch progress, and download a report — for a file large enough to exercise batching.
2. Imported subscribers resolve through the merge chain; imported purchases upsert idempotently; **running the same import twice produces no duplicate subscribers, purchases, or revenue** — proven by a test that runs it twice and asserts revenue totals are unchanged.
3. An import emits **zero** `SUBSCRIPTION` outbox rows and **zero** outgoing webhooks — proven by a test that asserts on the outbox and the outgoing-webhook queue, not by inspection.
4. Rows with a usable store anchor are re-validated against the store and grant live entitlements via `syncAccess`; rows without one are imported as history and are visibly counted as history-only.
5. An RC export with no Google purchase-token column produces an explicit, quantified Android warning in the dry run, and a subsequent token-only import upgrades those rows.
6. A worker restart mid-import resumes from its checkpoint without duplicating work.
7. Sandbox rows are skipped by default and counted; the opt-in imports them.
8. The capability gate rejects non-ADMIN members; cross-tenant ids 404.
9. Both docs guides build (`apps/docs` prerender) and state the migration's real limits; `resources/meta.json` registers the new page. The pre-existing `check:links` failure is not made worse.
10. Zero changes to the SDKs, the store-webhook processing path, or `render-fixtures.json`.
