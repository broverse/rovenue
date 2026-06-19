# SDK ↔ Backend Reconciliation — Design

**Date:** 2026-06-20
**Status:** Approved (design)
**Scope:** Reconcile the Rovenue SDK with the current backend `/v1` contract for two features that drifted out of sync. Stay on `main`.

## Background

A cross-layer SDK review (Rust core `core-rs` v0.7.0 → native façades `sdk-swift`/`sdk-kotlin` → RN bridge/JS `sdk-rn` v0.3.0 → backend `/v1`) found that the per-layer surfaces are internally consistent, but two backend contracts diverged from what the SDK calls:

1. **Credits feature is dead.** Commit `9e66899c` ("v1 virtual-currencies route; remove legacy single-currency credit endpoints") deleted `GET /v1/me/credits` and `POST /v1/me/credits/spend`. The SDK's entire credit stack (`credit_balance`/`refresh_credits`/`consume_credits` → native → RN `creditBalance`/`refreshCredits`/`consumeCredits` + `useCreditBalance`) still calls the removed endpoints → **404**. The backend replaced them with a multi-currency system at `/v1/virtual-currencies/*` (balances keyed by currency `code`, no default currency) where **client-side spend was deliberately removed** (debit is secret-key/server-side only).

2. **Experiment exposure is never logged.** The backend has `POST /v1/experiments/:id/expose`, but the SDK only ever *reads* assignments (`experiment()`/`experiments_all()`) and never posts exposures. Without exposure rows, `GET /v1/experiments/:id/results` (SRM + conversion/lift) has no denominator — experiment analysis from SDK traffic is blank.

Out of scope (deferred to a separate spec): install/funnel attribution (`/v1/sdk/claim-install` via Android Install Referrer + iOS fingerprint, `/v1/sdk/claim-via-email`, `/v1/subscribers/claim-funnel-token`) and generic `POST /v1/events`. These are a distinct, much larger native feature family and warrant their own brainstorm.

## Verified backend contracts

- `GET /v1/virtual-currencies/me` (public key, subscriber from context) → `{ data: { balances: { [code: string]: number } } }`.
- Debit: `POST /v1/virtual-currencies/:appUserId/:code/transactions` — **secret key only**. No public client spend exists by design.
- `POST /v1/experiments/:id/expose` — body `{ variantId: string, subscriberId: string, platform?: "ios"|"android"|"web", country?: string, exposedAt?: string(datetime) }`. Auth/rate-limit via the `/v1` parent middleware (`apiKeyAuth` + `apiKeyRateLimit`). Writes one `outbox_events` row (CH is the read surface).
- `POST /v1/receipts/{apple,google}` → response now carries `{ data: { ..., access, virtualCurrencyBalances: { [code]: number } } }`. So a receipt POST can hydrate both entitlements **and** VC balances in one round trip — no follow-up GET.

## Decisions (from brainstorm)

- **Credits → Full VC model (breaking).** Replace single-balance credit API with a multi-currency balances map + per-code getter. Remove client `consume`, since no public spend endpoint exists.
- **Exposure → automatic, deduped in the Rust core.** No developer action, no manual `trackExposure()`. Dedup collapses repeated cache reads into one exposure per assignment.
- **Attribution → deferred** to its own spec.

---

## Feature 1 — Credits → Virtual Currencies

### Rust core (`packages/core-rs`)

**Transport (`src/transport/http_client.rs`)**
- Replace `GET /v1/me/credits` with `GET /v1/virtual-currencies/me`; parse `data.balances` into a `BTreeMap<String, i64>` (ordered for stable serialization/snapshotting).
- Remove the `POST /v1/me/credits/spend` request builder.

**Cache (`src/` cache module + schema version)**
- Credits cache record changes from a single `i64` balance to `map<String, i64>` (code → balance), scoped per user (rovenue_id / app_user_id) as today.
- Bump the cache schema version and add a migration step (reuse the existing `cache_migration` / `cache_schema_v2` machinery): on upgrade, drop the legacy single-balance credit row (no lossless mapping — single balance had no currency code); next read repopulates from the network.

**Public API (`src/api.rs`) + UDL (`src/librovenue.udl`)**
- Remove: `credit_balance() -> i64`, `consume_credits(amount, description?) -> i64`, `refresh_credits()`.
- Add:
  - `virtual_currency_balances() -> record<string, i64>` — cached map; triggers async refresh when stale (same staleness/coalescing policy as the other readers).
  - `virtual_currency(code: string) -> i64` — convenience; returns `0` when the code is absent.
  - `refresh_virtual_currencies()` (throws) — forces `GET /v1/virtual-currencies/me`.
- `ReceiptResult.credit_balance: i64` → `virtual_currencies: record<string, i64>`, hydrated from the receipt response's `virtualCurrencyBalances`. Receipt success also updates the VC cache and emits the change event (no follow-up GET).
- `ChangeEvent::CreditBalanceChanged` → `ChangeEvent::VirtualCurrenciesChanged`.
- Remove `RovenueError::InsufficientCredits` from the surface (only reachable from the removed client spend).

### Native façades + bridges

- **`sdk-swift` / `sdk-kotlin`:** regenerate uniffi bindings (`npm run sdk:bindings`); update façade wrappers (`creditBalance` → `virtualCurrencies` / `virtualCurrency(code)` / `refreshVirtualCurrencies`), the `PurchaseResult` DTO mapper (`creditBalance` → `virtualCurrencies` map), and the change-event mapping.
- **`sdk-rn/ios` (`RovenueModule.swift`) / `sdk-rn/android` (`RovenueModule.kt`):** replace the three credit bridge methods with `virtualCurrencies(): Map<String, Double>`, `virtualCurrency(code): Double`, `refreshVirtualCurrencies()`. (JS bridges numbers as Double; i64 → Double is lossless ≤ 2^53.)

### RN / JS (`packages/sdk-rn/src`)

- `api/credits.ts` → `api/virtualCurrencies.ts`: export `virtualCurrencies()`, `virtualCurrency(code)`, `refreshVirtualCurrencies()`. Drop `consumeCredits`.
- `specs/RovenueModule.types.ts`: replace the three credit native-spec methods with the three VC methods.
- `hooks/useCreditBalance.ts` → `hooks/useVirtualCurrencies.ts`: `useVirtualCurrencies(): Record<string, number>`; add `useVirtualCurrency(code: string): number`. Both via `useSyncExternalStore` over the reactive store, keyed off the renamed change event.
- `types.ts`: `PurchaseResult.creditBalance: number` → `virtualCurrencies: Record<string, number>`; change-event union `'CREDIT_BALANCE_CHANGED'` → `'VIRTUAL_CURRENCIES_CHANGED'`.
- `core/eventBridge.ts` + `store/reactiveStore.ts`: handle the renamed event.
- `errors.ts` / `index.ts`: remove `InsufficientCreditsError` from the public surface; update the barrel (drop `consumeCredits`, `useCreditBalance`; add the VC api + hooks).

### Tests
- Core: VC cache read/refresh + staleness coalescing; receipt VC hydration (no follow-up GET); cache migration from legacy single-balance; map ordering. Rewrite `cache_credits_test` / `credits_test` as VC.
- RN: `virtualCurrencies` api + `useVirtualCurrencies`/`useVirtualCurrency` hook tests (rewrite credits tests).
- Native: Kotlin `testDebugUnitTest`, Swift façade tests.

---

## Feature 2 — Automatic exposure tracking (core-only)

### Rust core (`packages/core-rs`)

- In `experiment(key)` (`src/api.rs`), when a **real** assignment resolves (not `None`):
  - Compute a dedup key `(experiment_id, variant_id)` scoped to the current user + config version.
  - If not already in the exposed-set, schedule an async `POST /v1/experiments/{experiment_id}/expose` with body `{ variantId, subscriberId }` (`subscriberId` = the SDK's user identifier sent on user-scoped requests; confirm during implementation whether the endpoint expects app_user_id or rovenue_id and map accordingly).
  - Add to the exposed-set **only on HTTP success**, so transient failures retry on the next read.
- `experiments_all()` does **not** trigger exposure (bulk/debug read).
- Exposed-set: in-memory `HashSet` + persisted in the cache per user-scope + config version. When a config refresh changes a user's assignment (new variant), the dedup key changes → the new variant is exposed once.
- Best-effort, fire-and-forget. No durable queue (unlike session events): offline simply means the dedup entry isn't set, so the next read retries.
- **No UDL change.** Exposure is fully internal; native and RN layers are untouched.

### Tests
- Core: fires exactly one exposure on first `experiment(key)` read; deduped across repeated reads; re-fires after a variant change; `experiments_all()` fires nothing; failed POST is retried (dedup not set on failure).

---

## Explicitly out of scope (conscious)

- `Rovenue.getVersion()` returns the JS-bundled `SDK_VERSION` constant rather than calling native `getVersion()` — intentional (reports the JS bundle version). No change.
- `remoteConfigInt()` / `remoteConfigKeys()` native-spec methods are unused but harmless — leave.
- `GET /v1/config/stream` (SSE) exists; the core polls config every 60s instead. Polling works; SSE is a latency optimization for a separate effort.
- Attribution / funnel / generic events — separate spec.

## Sequencing

1. **Core** — UDL + cache schema/migration + http_client + receipt hydration + exposure logic, with core tests green.
2. **Bindings** — regenerate uniffi (`npm run sdk:bindings`).
3. **Native façade/bridge** — `sdk-swift`, `sdk-kotlin`, RN iOS/Android bridges; native tests green (Kotlin `testDebugUnitTest`, Swift).
4. **RN/JS** — api/hooks/types/event rename; RN tests green.
5. **Docs** — update credit → virtual-currency sections in `apps/docs/content/docs/**` (react-native, ios-swift, android-kotlin, core-concepts, quickstart, migrating-from-revenuecat) + a breaking-change note.

Each layer must be green before the next. Work stays on `main` (user manages branching).

## Risks / notes

- **Breaking API change** across all three client surfaces — bump SDK package/crate versions and document the migration (credits → virtual currencies; `consumeCredits` removed; `useCreditBalance` → `useVirtualCurrencies`).
- **Exposure identifier mapping** — confirm whether `POST /expose`'s `subscriberId` expects the app_user_id (as `/experiments/track` resolves) or the internal subscriber id, and map the core's user identifier accordingly. This is the one open implementation detail.
- **No public spend** — `consumeCredits` has no replacement in the client SDK by design; any client docs/examples showing credit spend must be removed or redirected to server-side virtual-currency debit.
