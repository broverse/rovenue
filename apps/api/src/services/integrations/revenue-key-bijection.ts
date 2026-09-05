import type { RevenueEventType } from "@rovenue/db";
import type { RovenueEventKey } from "@rovenue/shared";

// =============================================================
// Postgres enum <-> public revenue key bijection
// =============================================================
//
// `deriveRevenueEventKey` builds `revenue.${revenueEventKind}` and CASTS
// the result to RovenueEventKey. Nothing checked that the cast was true.
// It was not: REACTIVATION has been produced since Apple's RESUBSCRIBE
// handler shipped, and `revenue.REACTIVATION` was never in the catalog —
// so `enabledEvents.includes()` was false for every provider and the
// event was skipped silently, CUSTOM_WEBHOOK included.
//
// A compile error rather than a test: a SQL string literal is invisible
// to tsc, but this correspondence is not, and a compile error beats a
// test somebody can skip. The SQL allow-list axis is held instead by the
// named groupings in @rovenue/shared and the ClickHouse contract test.

import { ALL_REVENUE_TYPES } from "@rovenue/shared";

type RevenueKeyFor<T extends string> = `revenue.${T}`;

/**
 * Fails to instantiate unless `T` is `never`.
 *
 * NOT `const x: SomeType = undefined as never` — `never` is assignable to
 * every type, so that form compiles no matter what `SomeType` resolves to
 * and the guard would assert nothing. The constraint is what does the
 * work here.
 */
type AssertNever<T extends never> = T;

/** Every RevenueEventType has a public key. */
type MissingKeys = Exclude<RevenueKeyFor<RevenueEventType>, RovenueEventKey>;

/** Every revenue.* key names a real RevenueEventType. */
type OrphanKeys = Exclude<
  Extract<RovenueEventKey, `revenue.${string}`>,
  RevenueKeyFor<RevenueEventType>
>;

/**
 * @rovenue/shared cannot import @rovenue/db (the dashboard and the SDK
 * consume shared), so ALL_REVENUE_TYPES is a literal list there. This is
 * the one place that can see both, so this is where the list is held to
 * the enum.
 */
type UnlistedTypes = Exclude<RevenueEventType, (typeof ALL_REVENUE_TYPES)[number]>;

// A failure reads as "Type '"revenue.REACTIVATION"' does not satisfy the
// constraint 'never'", which names the missing key directly.
type _EveryRevenueTypeHasAKey = AssertNever<MissingKeys>;
type _EveryRevenueKeyHasAType = AssertNever<OrphanKeys>;
type _AllRevenueTypesCoversTheEnum = AssertNever<UnlistedTypes>;
