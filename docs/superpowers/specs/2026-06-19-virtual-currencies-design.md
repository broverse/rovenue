# Virtual Currencies — Design Spec

**Date:** 2026-06-19
**Status:** Approved for planning
**Author:** brainstorming session

## Summary

Replace Rovenue's single, undifferentiated credit balance with **project-defined virtual
currencies** (RevenueCat "Virtual Currencies" model). Each project defines its own named
currencies (e.g. Coins, Zümrüt, Yakut, Elmas) and each subscriber holds a separate balance
per currency.

This is a **breaking change**: the single-balance concept is removed, currency becomes
mandatory on every credit operation. There is no production data, so no live backfill is
required — dev/seed data is reseeded.

## Goals

- Project admins define an arbitrary set of named currencies per project (dynamic, not a
  hardcoded enum).
- A subscriber has an independent integer balance per currency.
- Currencies are earned via (a) consumable IAP purchases and (b) manual dashboard grants.
- Currencies are spent via a server-authoritative secret-key API only.
- The SDK can **read** all balances (read-only) for in-app display.
- Reuse the existing mature ledger machinery: append-only `credit_ledger`, transactional
  outbox, per-subscriber advisory locks, monthly range partitioning, ClickHouse MVs.

## Non-Goals

- Server-API or SDK client-side **granting** of currency (earning is IAP + manual only).
  The secret-key transaction endpoint is **debit-only** in this scope; enabling grants there
  later is a trivial extension.
- Fractional/decimal currency amounts — amounts are whole integers.
- Cross-currency exchange / conversion.
- Renaming the `credit_ledger` table (partitioned hot table; rename is risky, low value).

## Rejected Alternative

A fully parallel subsystem (`virtual_currency_balances` + a separate transactions table,
RevenueCat-style) was rejected: it would duplicate the at-least-once outbox, advisory-lock
overdraft protection, partitioning, and dedup logic that `credit_ledger` already provides.
Adding a currency **dimension** to the existing ledger reuses all of it.

## Data Model

### New: `virtual_currencies` (project-defined)

| column      | type                    | notes                                          |
|-------------|-------------------------|------------------------------------------------|
| id          | text (cuid2)            | PK                                             |
| projectId   | text                    | FK → projects.id                               |
| code        | text                    | short uppercase code, **unique per project**   |
| name        | text                    | display name (e.g. "Zümrüt")                   |
| archivedAt  | timestamptz null        | soft-delete; archived currencies hidden, kept for ledger integrity |
| createdAt   | timestamptz             | default now()                                  |

- Unique constraint on `(projectId, code)`.
- Soft cap ~50 currencies per project (validated at create).
- Amounts referencing this currency are always whole integers.

### New: `product_currency_grants` (bundle support)

| column     | type         | notes                                  |
|------------|--------------|----------------------------------------|
| id         | text (cuid2) | PK                                     |
| productId  | text         | FK → products.id                       |
| currencyId | text         | FK → virtual_currencies.id             |
| amount     | integer      | positive grant amount                  |

- One consumable product → N rows → grants N currencies (e.g. Starter Pack = 1000 Coin +
  5 Zümrüt).
- Unique constraint on `(productId, currencyId)`.

### Changed: `credit_ledger`

- Add `currencyId text NOT NULL` (FK → virtual_currencies.id).
- PK `(id, createdAt)` and monthly range partitioning are unchanged; `currencyId` is a
  NOT NULL column plus an index.
- `balance` now means the running balance **for that currency** after this row.
- New/updated index to support per-currency latest-balance lookups:
  `(subscriberId, currencyId, createdAt)`.
- `CreditLedgerType` enum (PURCHASE/SPEND/REFUND/BONUS/EXPIRE/TRANSFER_IN/TRANSFER_OUT)
  is unchanged — it classifies the operation, orthogonal to currency.

## Balance & Ledger Semantics

- Balance is tracked per `(subscriberId, currencyId)`.
- `findLatestBalance(subscriberId, currencyId)` → latest row's `balance` for that currency.
- `findAllBalances(subscriberId)` → latest balance per currency
  (`DISTINCT ON (currencyId) … ORDER BY createdAt DESC`).
- **Advisory lock key becomes `(subscriberId, currencyId)`** — operations on different
  currencies for the same subscriber no longer serialize against each other.
- **Dedup guard becomes `(referenceId, currencyId)`** — critical because a single bundle
  purchase produces multiple ledger rows sharing one `referenceId` but differing in
  `currencyId`.
- Spend throws `InsufficientCreditsError` if the per-currency balance is below the requested
  amount. Balances can never go negative. Grants are always positive.

## Flows

### IAP grant (consumable purchase)

When a consumable purchase is verified/processed, read `product_currency_grants` for the
product. For each row call `addCredits({ currencyId, amount, type: PURCHASE,
referenceType: 'purchase', referenceId: purchaseId })`. Dedup on `(purchaseId, currencyId)`
makes replays idempotent (outbox is at-least-once).

### Manual grant (dashboard)

`POST /projects/:projectId/credits` gains a required `currencyId` (or `code`). The grant
modal gets a currency selector.

### Spend (server, secret-key)

`POST /v1/subscribers/:id/virtual-currencies/:code/transactions` with a debit amount.
Server-authoritative: balance check and `InsufficientCreditsError` happen on the server
under the `(subscriberId, currencyId)` advisory lock. Debit-only in this scope.

## SDK (read-only)

- `GET /v1/subscribers/me/virtual-currencies` (public key) → `{ "EMR": 500, "GLD": 1200 }`.
- New hook `useVirtualCurrencies()` returning the balance map.
- `CREDIT_BALANCE_CHANGED` event payload carries the per-currency map.
- **Removed (breaking):** `creditBalance(): number`, `consumeCredits(amount)` — the SDK can
  no longer spend (spend is server-only) and balances are now per-currency.
- Native bridge (`librovenue` + Swift/Kotlin façades): the single `creditBalance` field is
  replaced by a currency→balance map in the change payload and state read.

## Dashboard

- **Currencies screen:** create / rename / archive currencies (per project).
- **Grant modal:** currency selector added.
- **Ledger table:** currency column added.
- **Rollup / KPI widgets:** currency dimension (per-currency balance & flow).
- **Product editor:** manage `product_currency_grants` for consumable products.

## Analytics (ClickHouse)

- `mv_credit_balance`: add `currencyId` to `ORDER BY (projectId, subscriberId, currencyId)`.
- `mv_credit_consumption_daily`: add `currencyId` to the grouping / ordering.
- Outbox `CREDIT_LEDGER` event payload gains `currencyId`; Kafka Engine + MV columns updated.
- `db:verify:clickhouse` parity check extended to the currency dimension.

## Migration

Because there is **no production data**:

1. Create `virtual_currencies` and `product_currency_grants` tables.
2. Add `credit_ledger.currencyId NOT NULL` from the start (no backfill / default-currency
   dance). Any existing dev/seed ledger rows are dropped and reseeded.
3. Update the seed script to create a few sample currencies per demo project and sample
   `product_currency_grants`, and to write ledger rows with `currencyId`.
4. Apply matching ClickHouse migrations.

## API Surface Summary

| Endpoint                                                              | Auth        | Purpose                          |
|-----------------------------------------------------------------------|-------------|----------------------------------|
| `GET/POST/PATCH /projects/:projectId/virtual-currencies`              | dashboard   | currency CRUD (+ archive)        |
| `POST /projects/:projectId/credits`                                   | dashboard   | manual grant (now requires currency) |
| `GET /projects/:projectId/credits/rollup`                             | dashboard   | per-currency flow                |
| `POST /v1/subscribers/:id/virtual-currencies/:code/transactions`      | secret key  | server-authoritative debit       |
| `GET /v1/subscribers/me/virtual-currencies`                           | public key  | read all balances (SDK)          |

## Shared Types

- `VirtualCurrency { id, projectId, code, name, archivedAt, createdAt }`.
- `CreditsLedgerRow` gains `currencyId` (and currency `code`/`name` for display).
- `GrantCreditsRequest` gains required `currencyId`.
- New `VirtualCurrencyBalances = Record<string /*code*/, number>`.

## Testing

`*.integration.test.ts` (testcontainers Postgres + ClickHouse):

- Concurrent grant/spend on the **same** currency → no overdraft (advisory lock).
- Concurrent operations on **different** currencies for one subscriber → run in parallel,
  no false serialization.
- Bundle purchase grants all currencies; replay is idempotent via `(purchaseId, currencyId)`.
- Spend below balance throws `InsufficientCreditsError`; balance never negative.
- `findAllBalances` returns correct latest-per-currency.
- ClickHouse parity (`db:verify:clickhouse`) across the currency dimension.

## Open Questions

None blocking. Future extensions noted: server-API grants, currency conversion, expiry
policies per currency.
