import { queryAnalytics } from "../../lib/clickhouse";
import { toDateOnly, moneyStr } from "./_utils";

export interface GetMrrDecompositionInput {
  projectId: string;
  from: Date;
  to: Date;
}

export interface MrrDecomposition {
  newUsd: string;
  expansionUsd: string;
  churnedUsd: string;
}

interface ChDecompRow {
  new_usd: string;
  expansion_usd: string;
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
        toString(sumIf(amountUsd, type = 'REACTIVATION'))                  AS expansion_usd,
        toString(sumIf(amountUsd, type IN ('REFUND','CHARGEBACK')))        AS churned_usd
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND toDate(eventDate) >= {from:Date}
        AND toDate(eventDate) <= {to:Date}
    `,
    { from: toDateOnly(input.from), to: toDateOnly(input.to) },
  );

  const r = rows[0] ?? { new_usd: "0", expansion_usd: "0", churned_usd: "0" };
  return {
    newUsd: moneyStr(r.new_usd),
    expansionUsd: moneyStr(r.expansion_usd),
    churnedUsd: moneyStr(r.churned_usd),
  };
}
