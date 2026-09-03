import { queryAnalytics } from "../../lib/clickhouse";
import { toDateOnly, moneyStr } from "./_utils";

export interface GetMrrDecompositionInput {
  projectId: string;
  from: Date;
  to: Date;
}

// =============================================================
// Subscription-MRR decomposition
// =============================================================
//
// These four buckets partition recurring-revenue movement so the
// components reconcile to the net MRR delta:
//
//     net = newUsd + retainedUsd + reactivationUsd - churnedUsd
//
// Historically RENEWAL revenue fell into *no* bucket (so the
// decomposition never reconciled) and REACTIVATION was mislabelled
// "expansion". We now account for RENEWAL (retained) and report
// reactivation/winback as its own line.
//
// Scope: this is the *subscription* MRR view. One-time
// CREDIT_PURCHASE revenue is intentionally excluded — it is not
// recurring and does not belong in an MRR decomposition. Note this
// means the four buckets here will NOT sum to `v_mrr_daily.net_usd`
// when CREDIT_PURCHASE rows exist in the window, because that view
// defines gross as `type NOT IN ('REFUND','CHARGEBACK')` and so
// includes CREDIT_PURCHASE in its net. The mismatch is by design:
// `v_mrr_daily` is the gross-revenue series; this is the
// recurring-only decomposition.
export interface MrrDecomposition {
  /** INITIAL + TRIAL_CONVERSION. */
  newUsd: string;
  /** RENEWAL. */
  retainedUsd: string;
  /** REACTIVATION (winback). */
  reactivationUsd: string;
  /** REFUND + CHARGEBACK (money out), positive magnitude. */
  churnedUsd: string;
}

interface ChDecompRow {
  new_usd: string;
  retained_usd: string;
  reactivation_usd: string;
  churned_usd: string;
}

export async function getMrrDecomposition(
  input: GetMrrDecompositionInput,
): Promise<MrrDecomposition> {
  const rows = await queryAnalytics<ChDecompRow>(
    input.projectId,
    `
      SELECT
        toString(sumIf(amountUsd, type IN ('INITIAL','TRIAL_CONVERSION'))) AS new_usd,
        toString(sumIf(amountUsd, type = 'RENEWAL'))                       AS retained_usd,
        toString(sumIf(amountUsd, type = 'REACTIVATION'))                  AS reactivation_usd,
        toString(sumIf(abs(amountUsd), type IN ('REFUND','CHARGEBACK')))   AS churned_usd
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
    `,
    { from: toDateOnly(input.from), to: toDateOnly(input.to) },
  );

  const r = rows[0] ?? {
    new_usd: "0",
    retained_usd: "0",
    reactivation_usd: "0",
    churned_usd: "0",
  };
  return {
    newUsd: moneyStr(r.new_usd),
    retainedUsd: moneyStr(r.retained_usd),
    reactivationUsd: moneyStr(r.reactivation_usd),
    churnedUsd: moneyStr(r.churned_usd),
  };
}

// =============================================================
// Daily grain — chart-catalog `new_subs` / `reactivations`
// =============================================================

/** One day's event count. `n` counts ROWS (events), matching the grain
 *  `sumIf` above counts in — not distinct subscribers — so a day's count
 *  and that day's dollar bucket always agree on which rows they cover. */
export interface DailyLifecycleCount {
  /** YYYY-MM-DD, UTC. */
  day: string;
  n: number;
}

export interface MrrDecompositionDailyCounts {
  /** `countIf` sibling of `newUsd` — INITIAL + TRIAL_CONVERSION, per day. */
  newSubs: DailyLifecycleCount[];
  /** `countIf` sibling of `reactivationUsd` — REACTIVATION, per day. */
  reactivations: DailyLifecycleCount[];
}

interface ChDailyCountRow {
  day: string;
  new_subs: string;
  reactivations: string;
}

/**
 * Daily grain of two of the four decomposition buckets above, as EVENT
 * COUNTS rather than dollar sums — backs the chart-catalog ids
 * `new_subs` and `reactivations` (charts.ts's `readChartSeries`). Each
 * `countIf` here uses the exact same predicate as the matching `sumIf`
 * in `getMrrDecomposition`, so the two never disagree about which rows
 * they're counting.
 *
 * Same table, same `FINAL` as the window aggregate above — the outbox is
 * at-least-once and this is a ReplacingMergeTree, so dropping `FINAL`
 * would double-count a replayed event (see migration 0012). Only the
 * grain (per-day vs. one total) and the aggregate (`countIf` vs.
 * `sumIf`) differ from `getMrrDecomposition`; that function is untouched
 * by this addition.
 */
export async function getMrrDecompositionDailyCounts(
  input: GetMrrDecompositionInput,
): Promise<MrrDecompositionDailyCounts> {
  const rows = await queryAnalytics<ChDailyCountRow>(
    input.projectId,
    `
      SELECT
        toString(toDate(eventDate))                                AS day,
        toString(countIf(type IN ('INITIAL','TRIAL_CONVERSION')))  AS new_subs,
        toString(countIf(type = 'REACTIVATION'))                   AS reactivations
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
      GROUP BY day
      ORDER BY day
    `,
    { from: toDateOnly(input.from), to: toDateOnly(input.to) },
  );

  return {
    newSubs: rows.map((r) => ({ day: r.day, n: Number(r.new_subs) })),
    reactivations: rows.map((r) => ({ day: r.day, n: Number(r.reactivations) })),
  };
}
