import { queryAnalytics } from "../../lib/clickhouse";

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

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
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
  const fix = (v: string): string => Number(v).toFixed(4);
  return {
    newUsd: fix(r.new_usd),
    expansionUsd: fix(r.expansion_usd),
    churnedUsd: fix(r.churned_usd),
  };
}
