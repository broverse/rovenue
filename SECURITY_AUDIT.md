# Rovenue — Architecture & Security Audit

**Scope:** Full monorepo (SDK · API · Dashboard · DB/jobs/analytics)
**Date:** 2026-06-20
**Method:** Three parallel mapping passes (layout/deps, API lifecycle, data layer) + direct source verification of every money-/auth-critical claim. No code was modified.
**Branch:** `main`

> Findings marked **[verified]** were read directly from source during this audit. Findings marked **[mapped]** come from the mapping pass and were not independently re-read line-by-line — treat their severity as provisional until triaged.

---

## 1. Executive Summary

1. **Overall health: good.** Auth, tenant isolation, the credit ledger, and the outbox/analytics split are deliberately engineered and mostly correct. This is a mature codebase, not a prototype. Most findings are hardening and defense-in-depth, not active exploits.
2. **The two CVEs called out in the brief do NOT apply.** `drizzle-orm` is pinned to exactly **0.45.2** — the patched release for CVE-2026-39356 — and the only `sql.identifier()` call uses hardcoded literals. `hono` is **4.12.12**, well past the Improper Authorization advisory. **[verified]**
2. **Tenant isolation (IDOR) is solid.** SDK/`/v1` routes always derive `projectId` from the authenticated API key's DB row, never from client params; dashboard routes enforce `project_members` membership + cross-project 404 checks. **[verified]**
3. **The credit ledger cannot be double-spent or driven negative under concurrency** — a per-`(subscriber,currency)` Postgres advisory xact lock serializes all writers and the balance floor is checked inside that lock. **[verified]**
4. **Biggest *real* risk is operational, not a code exploit:** webhook rows claimed to `PROCESSING` are never reaped, so a worker crash mid-processing permanently wedges that event (all future redeliveries are deduped away). **[mapped]**
5. **Two "fail-open" choices** (Redis replay guard, idempotency cache) trade dedup for availability. Safe because the DB claim gate is authoritative, but they widen the abuse/duplicate-work window during a Redis outage. **[verified]**
6. **Non-production verification bypasses exist by design** (Google Pub/Sub when `PUBSUB_PUSH_AUDIENCE` unset; Apple jose fallback with no x5c chain check). Production env-validation blocks both — the risk is a staging box pointed at prod-adjacent data. **[verified]**
7. **Supply-chain hygiene gap:** CI has no `pnpm audit` / secret-scan / SAST, the prod API image runs `tsx` on TS source (ships the esbuild/tsx toolchain into the runtime), and deprecated `@esbuild-kit/*` + 5 esbuild versions sit in the dev closure. **[mapped/verified]**
8. **Idempotency is opt-in on credit spend.** A client that retries `POST /v1/.../transactions` with neither an `Idempotency-Key` header nor a `referenceId` can double-spend. Both protections exist; neither is mandatory. **[verified]**

---

## 2. Architecture Map

```
                       ┌────────────────────────────────────────────┐
   Untrusted clients   │  SDK (RN / Swift / Kotlin) — Rust core      │
   (app users)         │  dep: @rovenue/shared ONLY (wire types)     │
                       │  offline cache: MMKV/SQLite (last-known)    │
                       └───────────────┬────────────────────────────┘
                                       │ Bearer rov_pub_…  (public key)
                                       │ X-Rovenue-User-Id, Idempotency-Key
        Dashboard (React/Vite SPA)     ▼
        Better Auth session     ┌─────────────────────────────────────────┐
        type-only AppType ───►  │  API  (Hono 4.12.12)                      │
                                │  global: reqId → logger → CORS(allowlist) │
                                │          → /health → IP rate-limit        │
                                │  /v1/*      apiKeyAuth + per-key limit     │
                                │  /dashboard requireDashboardAuth + RBAC    │
                                │  /webhooks  per-store signature + replay   │
                                │  /public/*  UNAUTH (CORS *) funnel runtime │
                                └───┬───────────────┬───────────────┬───────┘
                                    │               │               │
              ┌─────────────────────▼──┐   ┌────────▼────────┐   ┌──▼──────────────┐
              │ PostgreSQL (Drizzle)   │   │ Redis / BullMQ  │   │ outbox_events   │
              │  ★ SOURCE OF TRUTH ★   │   │ replay guard,   │   │ (same tx as     │
              │  subscriber_access     │   │ idempotency,    │   │  domain write)  │
              │  credit_ledger (append)│   │ flag/exp cache, │   └──────┬──────────┘
              │  purchases (state mc)  │   │ webhook jobs    │          │ dispatcher
              │  webhook_events (claim)│   └─────────────────┘          ▼ (separate proc)
              └────────────────────────┘                        Kafka/Redpanda → ClickHouse
                                                                (ReplacingMergeTree + FINAL,
                                                                 query-time idempotent views)

  ★ ENTITLEMENT SOURCE OF TRUTH: Postgres `subscriber_access`, read LIVE on every
    /v1/me request (NO Redis entitlement cache). SDK local cache is advisory/offline only;
    there is NO server-push revocation — a refunded user keeps local access until next refresh.
```

**Boundary verdict [verified]:** The SDK ships only `@rovenue/shared`, whose barrel (`packages/shared/src/index.ts:103-116`) *intentionally* excludes `./crypto` (AES-256-GCM) and `node:crypto`-dependent experiment bucketing. The dashboard imports `@rovenue/api` as a **type-only** `AppType` (erased at build). No DB models, ORM types, or secrets reach client bundles.

---

## 3. Findings

Severity = impact if exploited. Confidence = certainty the issue is real as described.

| # | Sev | Conf | Area | File:line | Finding | Why it matters | Fix |
|---|-----|------|------|-----------|---------|----------------|-----|
| F1 | **High** | High | Jobs | `services/webhook-processor.ts` (claim) + `repositories/webhook-events.ts:130-151` | **`PROCESSING` webhook rows are never reaped.** A worker that crashes after `claimWebhookEvent` flips status to `PROCESSING` but before `PROCESSED/FAILED` leaves a permanently stuck row; all redeliveries hit `status NOT IN ('PROCESSING','PROCESSED')` and return null. [mapped] | A single crash silently drops a store event forever (missed renewal/refund/grant). No alerting; manual recovery only. | Add a reaper: requeue rows in `PROCESSING` older than N×tolerance, or use a lease/`claimedAt` timestamp on the claim. |
| F2 | **High** | Med | Webhooks | `middleware/webhook-verify.ts:223-229` | **Google webhook skips OIDC verification when `PUBSUB_PUSH_AUDIENCE` unset.** Prod is guarded by env validation, but a non-prod instance pointed at a real Play account accepts forged purchase notifications. [verified] | Unauthenticated injection of fraudulent subscription/purchase events in any non-prod env with real data. | Fail closed even outside prod, or hard-require the audience whenever real store creds are present. |
| F3 | **High** | Med | Ledger | `routes/v1/virtual-currencies.ts:113` + `services/credit-engine.ts:195-216` + `middleware/idempotency.ts:50-55` | **Credit spend dedup is opt-in.** `dedupeOnReference: body.referenceId != null`; the `Idempotency-Key` middleware only engages if the header is present. A retry with neither double-debits. [verified] | Network retries / malicious replays drain wallets. | Make `referenceId` required on the spend endpoint, or mandate `Idempotency-Key` for it. |
| F4 | **Med** | High | Ledger | `packages/db/src/drizzle/schema.ts:452` | **No DB-level `CHECK (balance >= 0)`** (and none on append-only-ness). The non-negative + append-only invariants are enforced only by the two engine callers. [verified] | A future direct `insertCreditLedger` caller, or a bug, silently corrupts balances with no backstop. | Add `check('credit_ledger_balance_non_negative', sql\`balance >= 0\`)`; consider a no-UPDATE/DELETE trigger or revoked grants. |
| F5 | **Med** | Med | Ledger | `services/credit-engine.ts:177` → `repositories/credit-ledger.ts:121` | **Nested transaction → implicit savepoint.** `spendCredits`/`addCredits` open a tx, then `insertCreditLedger` opens another (savepoint) for the row+outbox write. Errors *do* propagate today (practically safe), but the pattern is fragile and easy to break. [verified] | A future edit that swallows the inner error commits the outer tx (and releases the lock) without the ledger row. | Make `insertCreditLedger` accept and reuse the caller's tx handle instead of always opening its own. |
| F6 | **Med** | High | Webhooks | `middleware/webhook-replay-guard.ts` (fail-open) | **Redis replay guard fails open.** On Redis error, duplicates pass to the DB claim gate. [verified — pattern matches idempotency.ts] | DB gate prevents double-*processing*, but duplicates still hit BullMQ and burn worker capacity during a Redis outage. | Active Redis alerting; optionally fail-closed for high-value sources. |
| F7 | **Med** | High | Webhooks (non-prod) | `services/apple/apple-verify.ts:121-150` (via `webhook-verify.ts:145-150`) | **Apple jose fallback skips x5c chain validation** when no project creds (non-prod only; prod throws 401). [verified] | Self-signed JWS accepted in staging/CI — poisons any prod-adjacent shared DB. | Validate the x5c chain even in the fallback, or refuse to process unverified Apple events outside local dev. |
| F8 | **Med** | High | Abuse | `routes/billing/webhook.ts` (no limit); `routes/webhooks/ses-events.ts` (no limit, no dedup) | **Platform Stripe billing webhook and SES-events endpoint have no rate limit** (store webhooks get 200/min/IP). SES has no replay dedup. [mapped] | Unauthenticated CPU burn (HMAC/body reads); replayed SNS Bounce can suppress a legit address. | Apply the `storeLimit()` wrapper to both; dedup SNS by `MessageId`. |
| F9 | **Med** | High | SSRF | `routes/webhooks/ses-events.ts:66-72` | **`SubscribeURL` fetched without host allowlist** on SNS `SubscriptionConfirmation` (signature must pass first; `SubscribeURL` itself is not constrained to `*.amazonaws.com`). [mapped] | Latent SSRF to internal endpoints if signature path is ever weakened/bypassed. | Allowlist `SubscribeURL` host to `sns.*.amazonaws.com` before fetching. |
| F10 | **Med** | High | Validation | `routes/public/funnels.ts:136-221` | **Unauthed funnel routes:** wildcard CORS, no rate limit on session creation, `answer: z.unknown()` with no size cap. [mapped] | Storage-amplification / OOM via unbounded rows and multi-MB JSON blobs. | Per-IP limit on session/answer creation; bound `answer` shape and byte size. |
| F11 | **Low** | High | Supply chain | `.github/workflows/ci.yml`, `sdk.yml` | **No `pnpm audit` / secret-scan / SAST in CI.** [verified] | Transitive-dep compromise or committed secret ships unnoticed. | Add `pnpm audit --prod`, gitleaks/trufflehog, and a SAST step. |
| F12 | **Low** | High | Supply chain | `apps/api/Dockerfile:53` | **Prod API runs `tsx src/index.ts`** — TS source via tsx; the `tsc` build output is unused. [verified] | esbuild/tsx toolchain is in the production attack surface; image larger than needed. | Ship compiled JS; run node on the build output. |
| F13 | **Low** | High | Supply chain | `pnpm-lock.yaml` (`@esbuild-kit/*`, esbuild ×5) | Deprecated `@esbuild-kit/core-utils@3.3.2` + `esm-loader@2.6.5`; five esbuild majors incl. 0.18.20. Dev/build only, no known CVE. [verified] | Unmaintained code in the toolchain. | Bump `drizzle-kit`/`tsx`; dedupe esbuild. |
| F14 | **Low** | Med | Secrets | `apps/api/tests/setup.ts:74` (+6 test files) | Test-fixture `ENCRYPTION_KEY` is committed in clear. Never used in prod (env superRefine blocks blank). [verified] | If an operator copies a test env to prod without overriding, all stored creds use a public key. | Generate the test key at runtime, or document loudly. |
| F15 | **Low** | High | Data exposure | `middleware/error.ts:35-37` | ZodError serialized into the client `message` leaks field names/constraints (schema structure). Stack traces are *not* leaked (only `"Internal server error"`). [mapped] | Minor info disclosure of internal schema shape. | Return a generic validation message; log details server-side. |
| F16 | **Low** | High | Cookies | `routes/public/funnels.ts:195-200` | `rv_funnel_sid` cookie missing `secure` (has HttpOnly + SameSite=Lax). | Cookie sent over plain HTTP in non-TLS envs. | Set `secure: true` (rely on TLS-terminating proxy in prod). |
| F17 | **Info** | High | Injection (CLEARED) | `repositories/fx-rates.ts:34-35` | `sql.identifier("rate"/"fetchedAt")` uses **hardcoded literals**; no user-controlled string is interpolated into any `sql\`\`` template anywhere. With drizzle 0.45.2, CVE-2026-39356 does not apply. [verified] | — | None. Keep an eslint guard against dynamic `sql.identifier`. |
| F18 | **Info** | High | Caching | (no entitlement cache) | Entitlements read live from Postgres on every `/v1/me`; no Redis entitlement cache → no stale-grant risk server-side. SDK MMKV cache is offline-only with no server-push revocation. [verified] | Architectural note: refunded users keep *local* access until refresh. | Optional: SSE/push revocation if real-time revocation is required. |
| F19 | **Info** | Med | Analytics | `clickhouse/migrations/0010_sdk_sessions_daily.sql:42` | SDK session daily counts use `SummingMergeTree` (not the idempotent view pattern) → can double-count on outbox replay. Analytics-only, not money. [mapped] | Slightly inflated session metrics. | Move to the query-time idempotent view pattern if accuracy matters. |
| F20 | **Info** | Med | Infra | `deploy/clickhouse/users.d/rovenue.xml:25` | ClickHouse admin user network ACL is `::/0` (not published by default in compose). [mapped] | Internet-exposed admin if the port is ever published. | Restrict to the compose subnet. |

---

## 4. Top 5 Fix-Now

1. **F1 — Webhook `PROCESSING` reaper.** This is the one finding that silently *loses money events* in normal operation (any worker crash). Add a staleness-based requeue. **Highest priority.**
2. **F3 — Make credit-spend idempotency mandatory.** Require `referenceId` (or `Idempotency-Key`) on the spend endpoint so a retry can never double-debit. Small change, directly protects user wallets.
3. **F2 / F7 — Fail closed on webhook verification outside prod** (or whenever real store creds exist). Removes the "staging poisons prod-adjacent data" class of bug.
4. **F4 — Add `CHECK (balance >= 0)` (+ append-only enforcement) to `credit_ledger`.** Cheap database-level backstop for the single most important financial invariant; protects against future regressions.
5. **F11/F12 — CI `pnpm audit` + secret scan, and ship compiled JS in the prod image.** Closes the supply-chain blind spot and shrinks the production attack surface.

---

## 5. Open Questions (need your input)

1. **F1:** Is there an out-of-band monitor (Sentry/alert) on stuck `PROCESSING` rows or on BullMQ `failed`? If so, F1 drops to Medium.
2. **F3:** Do the official SDKs *always* send a `referenceId`/`Idempotency-Key` on spend? If the Rust core guarantees it, the server-side gap is defense-in-depth only.
3. **F2/F7:** Are staging/CI environments ever pointed at production-adjacent Postgres/ClickHouse? That determines whether these are High or Low.
4. **State machine (C, [mapped]):** Confirm intended behavior for `PAUSED → GRACE_PERIOD` (currently unreachable) and trial-pause on Google. Functionally safe (guard rejects + audits) but worth a product decision.
5. **F6:** Is fail-open acceptable for the replay guard given the DB claim gate is authoritative, or do you want fail-closed for high-value sources?
6. **Out-of-order delivery:** A delayed legal transition (e.g. late `GRACE_PERIOD`) can still apply since the guard validates *transition legality*, not *event timestamp ordering*. Is timestamp-based ordering desired?

---

*Audit pass only — no code changed. Severities are pre-triage; `[mapped]` items should be re-read before action.*
