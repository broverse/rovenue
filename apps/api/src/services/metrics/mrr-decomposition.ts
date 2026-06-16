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
