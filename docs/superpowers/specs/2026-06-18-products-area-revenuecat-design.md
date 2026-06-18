# Products Area (RevenueCat-aligned, decoupled model) — Design

**Date:** 2026-06-18
**Status:** Approved (design); pending implementation plan
**Author:** brainstorming session

## Summary

Restructure the dashboard "catalog" area into a single **Products** area with three
sibling sections — **Products**, **Offerings**, and **Access Levels** (RevenueCat
"Entitlements", renamed). Align the underlying data model with RevenueCat semantics:
offerings become **independent** of access levels, offering slots become first-class
**packages** with standard identifiers, and a single project-wide **current** offering
replaces the per-access-level default.

The DB/API/SDK foundations mostly exist already. The SDK already behaves as decoupled
(`getOfferings()` returns offerings with packages; entitlements checked separately via
`entitlement(id)`), so the mandatory `offerings.accessId` is a server-side modeling
artifact that this work removes.

## Goals

- One "Products" sidebar group with three routes: Products, Offerings, Access Levels.
- A dedicated Offerings page (currently offerings are edited inline inside Access).
- Decouple offerings from access levels (Model B / RevenueCat).
- First-class packages with standard identifiers inside offerings.
- A single project-wide current offering.

## Non-Goals

- No paywall visual builder / placements / targeting beyond the existing experiment hook.
- No change to the products↔access-level mapping mechanism (`products.accessIds[]` stays).
- No ClickHouse analytics changes (offerings are not mirrored to CH).
- No rename of the `access` table; only the dashboard label changes to "Access Levels".

## Current State (verified 2026-06-18)

- **DB** (`packages/db/src/drizzle/schema.ts`): `access` (≈ Access Levels, lines ~550),
  `products` (~579, has `accessIds text[]`), `offerings` (~623, has `accessId` FK +
  `products` jsonb `[{productId, order, isPromoted, metadata?}]`), `purchases`,
  `subscriber_access`. No separate `product_groups`/`entitlements`/`access_levels` table.
- **API**: dashboard `products.ts` + `access.ts` CRUD; public `v1/offerings.ts`
  (list, `?accessId=` filter, `:identifier` hydrate, runs OFFERING experiments,
  emits `X-Rovenue-Experiment`).
- **Repos**: `access-catalog.ts`, `products.ts`, `offerings.ts`, `access.ts`.
- **Dashboard**: nav `components/dashboard/navigation.ts` has a `catalog` section with
  Products + Access (siblings). Products page + Access page exist; **no Offerings route** —
  offerings edited inline via `AccessOfferingsSection`. UI: Base UI dialogs, custom `ui/`
  components, Tailwind `rv-*` tokens, TanStack Router + Query, i18n.
- **SDK**: RN (`specs/RovenueModule.types.ts`) + Swift (`Types.swift`) already expose
  `OfferingDTO`, `PackageDTO { identifier, product }`, `OfferingsDTO { current, offerings }` —
  RevenueCat-shaped and decoupled.

## Decisions (from brainstorming)

1. **Scope:** UI restructure **and** align the data model to RevenueCat.
2. **Model:** **Model B** — offerings independent of access levels.
3. **Navigation:** sidebar group with **3 separate items + routes** (not tabs).
4. **Packages:** **first-class** packages with standard identifiers.

## Data Model

### `offerings` table changes
- **Remove** `accessId` column + FK. An offering is no longer tied to one access level.
- `identifier` uniqueness: `(projectId, accessId)` → **`(projectId)`**.
- `isDefault`: at-most-one per `(projectId, accessId)` → **at-most-one per `(projectId)`**;
  this single default is the project-wide "current offering". Keep as a partial unique index.
- Replace `products` jsonb with **`packages`** jsonb:
  `[{ identifier, productId, order, isPromoted, metadata? }]`.
  - `identifier`: standard (`$rc_monthly`, `$rc_annual`, `$rc_weekly`, `$rc_lifetime`) or
    custom slug (alphanumeric, `-`, `_`); **unique within the offering**.

### `products` table
- Unchanged. `accessIds text[]` remains the product→access-level (entitlement) mapping.
  In Model B, the entitlement a purchase grants is derived from the purchased product's
  `accessIds`, not from the offering.

### `access` table
- Unchanged.

### Migration (Drizzle, `packages/db/drizzle/migrations`)
1. Add `packages` jsonb column.
2. Backfill `packages` from existing `products` jsonb: each `{productId, order, isPromoted}`
   → `{identifier, productId, order, isPromoted, metadata}`. Derive `identifier` best-effort;
   on collision/unknown, fall back to `package_<order>`. (Pre-launch data is small; admins
   can rename afterward.)
3. Drop the old per-`(projectId, accessId)` unique/default indexes; create
   per-`(projectId)` unique index on `identifier` and partial unique index on
   `isDefault = true`.
4. Drop `accessId` FK + column.
5. Drop the `products` jsonb column once `packages` is populated.

No data loss: entitlement info already lives in `products.accessIds[]`.
No ClickHouse impact (offerings not mirrored), but run `db:verify:clickhouse` to confirm parity.

## API

### Dashboard — new `apps/api/src/routes/dashboard/offerings.ts`
- `GET /` — list offerings (search, cursor pagination).
- `POST /` — create (identifier, displayName, packages[]).
- `GET /:id` — single offering hydrated with package products.
- `PATCH /:id` — update metadata + packages.
- `DELETE /:id`.
- `PATCH /:id/default` (or a field on PATCH) — set as the project's current offering
  (atomically clears any prior default).
- Capability gate: `products:write`. Reuse `repositories/offerings.ts` after removing
  `accessId` from its signatures (`listOfferingsByAccess`/`findDefaultOffering` become
  project-scoped; drop access filtering).

### Public — `apps/api/src/routes/v1/offerings.ts`
- Remove `?accessId=` filter (deprecate; ignore param if sent).
- `GET /` returns all active offerings + project-wide `current`.
- `GET /:identifier` hydrates packages with real `identifier` + store pricing.
- Experiment engine: OFFERING experiments still reference offerings by identifier —
  unchanged; only the "current" selection is now project-wide. Keep `X-Rovenue-Experiment`.

## SDK

- DTOs already match. Work is ensuring the server now emits **real** package identifiers
  and verifying the RN + Swift bridges map `PackageDTO.identifier` end-to-end.
- Behavior change is minimal; no public API surface change expected.

## Dashboard UI

- **Nav** (`components/dashboard/navigation.ts`): rename `catalog` section to **Products**;
  items: Products, **Offerings** (new), Access Levels (rename label from "Access").
- **Offerings page** (new `routes/_authed/projects/$projectId/offerings.tsx`): sticky left
  list + detail. Detail = package editor (pick identifier + product, order, isPromoted),
  "Set as current" toggle, and a read-only view of which access levels the offering's
  products grant. Reuse `components/offerings/` (OfferingList, OfferingFormDialog).
- **Access Levels page** (`access.tsx`): remove inline `AccessOfferingsSection`. Replace
  with "Products granting this access level" (derived from `products.accessIds`).
- **Products page**: unchanged.

## Phasing (single spec, multi-phase plan)

1. **DB** — offering decouple + packages migration (+ repo signature updates).
2. **API** — dashboard offerings CRUD + `/v1/offerings` update + experiment engine check.
3. **Dashboard** — nav restructure + Offerings page + Access page cleanup.
4. **SDK** — package-identifier end-to-end verification.

## Testing

- Vitest unit + `*.integration.test.ts` (testcontainers: Postgres) for the migration,
  repos, and routes.
- Verify the partial-unique "single current offering" constraint via integration test.
- Verify `/v1/offerings` hydration + experiment exposure header unchanged.
- `db:verify:clickhouse` to confirm no analytics parity regression.
- SDK: existing RN/Swift tests for offerings/packages mapping.

## Risks

- Migration backfill of package identifiers is best-effort; document that admins should
  review package identifiers post-migration.
- Removing `?accessId=` from `/v1/offerings` is a public contract change; safe because the
  SDK does not depend on it (uses `current` + full list), but note it in SDK changelog.
