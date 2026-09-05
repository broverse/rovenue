import type { RevenueEventTypeName } from "./dashboard";

// =============================================================
// Revenue-type groupings
// =============================================================
//
// Revenue types were enumerated by hand in fourteen places across the
// metrics services, the analytics router and the ClickHouse views. An
// `IN (…)` allow-list DROPS a newly added type silently — the SQL form of
// the `Partial<Record>` failure this project has been bitten by twice.
//
// Evidence the lists had already drifted: `CHARGEBACK` appears in eight
// predicates and has never been a RevenueEventType value.
//
// These live in @rovenue/shared rather than apps/api because the
// dashboard needs the same sets for its filters. The ClickHouse views
// cannot import them at all — that axis is held by the contract test in
// apps/api/tests/clickhouse-revenue-type-contract.integration.test.ts.

/** Every value of the Postgres `RevenueEventType` enum. */
export const ALL_REVENUE_TYPES = [
  "INITIAL",
  "RENEWAL",
  "TRIAL_CONVERSION",
  "CANCELLATION",
  "REFUND",
  "REACTIVATION",
  "CREDIT_PURCHASE",
  "NON_RENEWING_PURCHASE",
] as const satisfies readonly RevenueEventTypeName[];

/**
 * Money out. `CHARGEBACK` is a phantom: it has never been a
 * RevenueEventType value, so no row can carry it, and it is retained only
 * so the predicates that already name it keep byte-identical behaviour.
 * Do not add new uses.
 */
export const REVENUE_TYPES_MONEY_OUT = ["REFUND", "CHARGEBACK"] as const;

/** "A purchase happened" — used for counts, not sums. A one-time buy is one. */
export const REVENUE_TYPES_PURCHASE_COUNT = [
  "INITIAL",
  "REACTIVATION",
  "CREDIT_PURCHASE",
  "NON_RENEWING_PURCHASE",
] as const satisfies readonly RevenueEventTypeName[];

/**
 * New RECURRING revenue. One-time types are deliberately absent — that
 * exclusion is the whole reason NON_RENEWING_PURCHASE exists.
 */
export const REVENUE_TYPES_NEW_RECURRING = [
  "INITIAL",
  "TRIAL_CONVERSION",
] as const satisfies readonly RevenueEventTypeName[];

/**
 * Money the subscriber actually paid, for lifetime/LTV rollups.
 * CANCELLATION is excluded: it is a $0 lifecycle marker, not a payment.
 */
export const REVENUE_TYPES_LIFETIME_PURCHASED = [
  "INITIAL",
  "RENEWAL",
  "TRIAL_CONVERSION",
  "REACTIVATION",
  "CREDIT_PURCHASE",
  "NON_RENEWING_PURCHASE",
] as const satisfies readonly RevenueEventTypeName[];

/** `['A','B']` → `'A','B'`, for interpolation into a ClickHouse `IN (…)`. */
export function sqlTypeList(types: readonly string[]): string {
  return types.map((t) => `'${t}'`).join(",");
}
