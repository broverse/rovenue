import { drizzle } from "@rovenue/db";
import type { Db, Store } from "@rovenue/db";
import {
  COMMISSION_RATE_PRESETS,
  type CommissionRatePreset,
} from "@rovenue/shared";

export { COMMISSION_RATE_PRESETS, type CommissionRatePreset };

// =============================================================
// Proceeds after store commission — query-time only
// =============================================================
//
// Design (spec §4.3, .superpowers/sdd/2026-09-01-analytics-integrity-and-
// proceeds/task-4-context.md):
//
//   1. Query time only. A proceeds figure is NEVER written into
//      `raw_revenue_events` or any aggregate — every function here is
//      pure or a read, and nothing in this module writes anything. A rate
//      change must re-compute history, not require rewriting it.
//   2. Refunds net first, then the rate applies:
//        proceeds = (gross − refunds) × (1 − rate)
//      NOT gross × (1 − rate) − refunds. The store returns its own
//      commission on a refund, so netting before applying the rate is the
//      economically correct order. See proceeds.test.ts for the pinned
//      regression covering this.
//   3. The rate is the customer's statement of their own situation. Apple's
//      Small Business Program tier depends on the developer's prior-year
//      proceeds across their WHOLE account (invisible to us), and both
//      stores apply per-country tax/currency handling we cannot see. We
//      never infer a rate from revenue, thresholds, or anything else —
//      doing so would produce a number that looks authoritative and is
//      not, the same class of error as fabricating a currency.
//   4. Any caller presenting this number must label it an ESTIMATE with
//      the applied rate visible next to it — never as a store payout.
//
// The rate itself is configured per project per store in
// `project_store_commission_rates` (packages/db/src/drizzle/schema.ts).
// No row for a (projectId, store) pair means "no rate configured", which
// this module surfaces as `null` — never a silently-assumed 0%.

// =============================================================
// Commission rate presets
// =============================================================
//
// Values, citations, and the `CommissionRatePresetOption[]` shown to
// operators all live in `@rovenue/shared`'s `commission-rates.ts` — the
// single source both this module and the dashboard's commission-rate
// settings form (`apps/dashboard/src/components/projects/SettingsForm.tsx`)
// read from. `COMMISSION_RATE_PRESETS`/`CommissionRatePreset` above are
// re-exported from there so existing callers of this module are
// unaffected. They are never applied automatically — a project always
// needs an explicit configured row (see rule 3 above).

// =============================================================
// Pure arithmetic
// =============================================================

function assertValidRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(
      `computeProceeds: rate must be a finite number in [0, 1], got ${rate}`,
    );
  }
}

/**
 * proceeds = netRevenue × (1 − rate).
 *
 * `netRevenue` must already have refunds subtracted — see
 * `computeNetRevenue` / `computeProceedsFromGrossAndRefunds` for the
 * caller-facing helper that gets the ordering right.
 */
export function computeProceeds(netRevenue: number, rate: number): number {
  assertValidRate(rate);
  return netRevenue * (1 - rate);
}

/** gross − refunds. Refunds are expected as a positive amount (this
 * codebase's convention — see `refund_amountusd_positive_convention`). */
export function computeNetRevenue(gross: number, refunds: number): number {
  return gross - refunds;
}

/**
 * The composed, caller-facing helper: nets refunds from gross FIRST, then
 * applies the commission rate. This is the one function callers should
 * reach for — it makes the correct ordering the only option.
 */
export function computeProceedsFromGrossAndRefunds(
  gross: number,
  refunds: number,
  rate: number,
): number {
  return computeProceeds(computeNetRevenue(gross, refunds), rate);
}

// =============================================================
// Rate resolution (Postgres-backed)
// =============================================================

/**
 * Read the configured commission rate for a project+store. Returns
 * `null` when nothing has been configured — the caller's signal to
 * render "no proceeds estimate available", never a silently-assumed 0%.
 */
export async function resolveCommissionRate(
  db: Db,
  projectId: string,
  store: Store,
): Promise<number | null> {
  const row = await drizzle.commissionRateRepo.getCommissionRate(
    db,
    projectId,
    store,
  );
  return row ? Number(row.rate) : null;
}

export interface ComputeProceedsForProjectInput {
  projectId: string;
  store: Store;
  gross: number;
  refunds: number;
}

export interface ProceedsEstimate {
  /** The configured rate actually applied, or `null` if none is configured. */
  rate: number | null;
  /**
   * The estimate, or `null` when no rate is configured for this
   * project+store — deliberately NOT 0, which would misrepresent an
   * unconfigured project as a 100%-proceeds one.
   */
  proceeds: number | null;
}

/**
 * Resolve the configured rate for (projectId, store) and compute the
 * proceeds estimate from it, at query time, from the caller-supplied
 * gross/refunds for whatever period they're asking about. Nothing here
 * is persisted — call it again after the customer edits their configured
 * rate and the same historical gross/refunds re-compute under the new
 * rate.
 */
export async function computeProceedsForProject(
  db: Db,
  input: ComputeProceedsForProjectInput,
): Promise<ProceedsEstimate> {
  const rate = await resolveCommissionRate(db, input.projectId, input.store);
  if (rate === null) {
    return { rate: null, proceeds: null };
  }
  return {
    rate,
    proceeds: computeProceedsFromGrossAndRefunds(
      input.gross,
      input.refunds,
      rate,
    ),
  };
}
