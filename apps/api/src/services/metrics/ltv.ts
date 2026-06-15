import { queryAnalytics } from "../../lib/clickhouse";

// =============================================================
// LTV distribution read service — ClickHouse exclusive
// =============================================================
//
// One CH read over v_revenue_lifetime_subscriber. Net lifetime
// per subscriber = purchased - refunded (both UInt64 cents, cast
// to Int64 so refund-heavy subscribers can go negative). Bucketed
// into fixed USD bands via countIf; avg/median/p90 alongside.

export interface LtvBucket {
  lowerUsd: number;
  upperUsd: number | null;
  count: number;
}

export interface LtvDistribution {
  avgUsd: string;
  medianUsd: string;
  p90Usd: string;
  totalSubscribers: number;
  histogram: LtvBucket[];
}

const BANDS: ReadonlyArray<{ lowerUsd: number; upperUsd: number | null }> = [
  { lowerUsd: 0, upperUsd: 5 },
  { lowerUsd: 5, upperUsd: 10 },
  { lowerUsd: 10, upperUsd: 25 },
  { lowerUsd: 25, upperUsd: 50 },
  { lowerUsd: 50, upperUsd: 100 },
  { lowerUsd: 100, upperUsd: 250 },
  { lowerUsd: 250, upperUsd: 500 },
  { lowerUsd: 500, upperUsd: 1000 },
  { lowerUsd: 1000, upperUsd: null },
];

interface ChLtvDistRow {
  b0: string;
  b1: string;
  b2: string;
  b3: string;
  b4: string;
  b5: string;
  b6: string;
  b7: string;
  b8: string;
  avg_usd: string;
  median_usd: string;
  p90_usd: string;
  subscribers: string;
}

export async function getLtvDistribution(
  projectId: string,
): Promise<LtvDistribution> {
  const rows = await queryAnalytics<ChLtvDistRow>(
    projectId,
    `
      SELECT
        toString(countIf(net_cents < 500))                          AS b0,
        toString(countIf(net_cents >= 500 AND net_cents < 1000))    AS b1,
        toString(countIf(net_cents >= 1000 AND net_cents < 2500))   AS b2,
        toString(countIf(net_cents >= 2500 AND net_cents < 5000))   AS b3,
        toString(countIf(net_cents >= 5000 AND net_cents < 10000))  AS b4,
        toString(countIf(net_cents >= 10000 AND net_cents < 25000)) AS b5,
        toString(countIf(net_cents >= 25000 AND net_cents < 50000)) AS b6,
        toString(countIf(net_cents >= 50000 AND net_cents < 100000))AS b7,
        toString(countIf(net_cents >= 100000))                      AS b8,
        toString(round(avg(net_cents) / 100, 4))                    AS avg_usd,
        toString(round(quantileExact(0.5)(net_cents) / 100, 4))     AS median_usd,
        toString(round(quantileExact(0.9)(net_cents) / 100, 4))     AS p90_usd,
        toString(count())                                           AS subscribers
      FROM (
        SELECT
          toInt64(lifetime_dollars_purchased_cents)
            - toInt64(lifetime_dollars_refunded_cents)              AS net_cents
        FROM rovenue.v_revenue_lifetime_subscriber
        WHERE projectId = {projectId:String}
      )
    `,
  );

  const r = rows[0] ?? {
    b0: "0", b1: "0", b2: "0", b3: "0", b4: "0",
    b5: "0", b6: "0", b7: "0", b8: "0",
    avg_usd: "0", median_usd: "0", p90_usd: "0", subscribers: "0",
  };

  const counts = [r.b0, r.b1, r.b2, r.b3, r.b4, r.b5, r.b6, r.b7, r.b8];

  return {
    avgUsd: r.avg_usd,
    medianUsd: r.median_usd,
    p90Usd: r.p90_usd,
    totalSubscribers: Number(r.subscribers),
    histogram: BANDS.map((band, i) => ({
      lowerUsd: band.lowerUsd,
      upperUsd: band.upperUsd,
      count: Number(counts[i]),
    })),
  };
}
