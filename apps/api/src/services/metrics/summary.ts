import { queryAnalytics } from "../../lib/clickhouse";

// =============================================================
// Revenue summary read service — ClickHouse exclusive
// =============================================================
//
// Two CH reads, run in parallel:
//   1. raw_revenue_events window aggregate → gross, refunds,
//      distinct paying subscribers (for ARPPU).
//   2. v_revenue_lifetime_subscriber aggregate → avg/median/p90
//      lifetime net per subscriber (LTV distribution summary).
//
// Money is parsed from CH decimal-strings with Number(), summed,
// and re-emitted via toFixed(4) — same convention as overview.ts.

export interface GetRevenueSummaryInput {
  projectId: string;
  from: Date;
  to: Date;
}

export interface RevenueSummary {
  grossUsd: string;
  refundsUsd: string;
  netUsd: string;
  refundRate: number | null;
  payingSubscribers: number;
  arppu: string | null;
  avgLtvUsd: string;
  medianLtvUsd: string;
  p90LtvUsd: string;
  ltvSubscribers: number;
}

interface ChWindowRow {
  gross_usd: string;
  refunds_usd: string;
  paying_subs: string;
}

interface ChLtvRow {
  avg_usd: string;
  median_usd: string;
  p90_usd: string;
  subscribers: string;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getRevenueSummary(
  input: GetRevenueSummaryInput,
): Promise<RevenueSummary> {
  const params = {
    from: toDateOnly(input.from),
    to: toDateOnly(input.to),
  };

  const [windowRows, ltvRows] = await Promise.all([
    queryAnalytics<ChWindowRow>(
      input.projectId,
      `
        SELECT
          toString(sumIf(amountUsd, type NOT IN ('REFUND','CHARGEBACK')))          AS gross_usd,
          toString(sumIf(amountUsd, type IN ('REFUND','CHARGEBACK')))              AS refunds_usd,
          toString(uniqExactIf(subscriberId, type NOT IN ('REFUND','CHARGEBACK'))) AS paying_subs
        FROM rovenue.raw_revenue_events FINAL
        WHERE projectId = {projectId:String}
          AND toDate(eventDate) >= {from:Date}
          AND toDate(eventDate) <= {to:Date}
      `,
      params,
    ),
    queryAnalytics<ChLtvRow>(
      input.projectId,
      `
        SELECT
          toString(round(avg(net_cents) / 100, 4))                 AS avg_usd,
          toString(round(quantileExact(0.5)(net_cents) / 100, 4))  AS median_usd,
          toString(round(quantileExact(0.9)(net_cents) / 100, 4))  AS p90_usd,
          toString(count())                                        AS subscribers
        FROM (
          SELECT
            toInt64(lifetime_dollars_purchased_cents)
              - toInt64(lifetime_dollars_refunded_cents)           AS net_cents
          FROM rovenue.v_revenue_lifetime_subscriber
          WHERE projectId = {projectId:String}
        )
      `,
      params,
    ),
  ]);

  const w = windowRows[0] ?? {
    gross_usd: "0",
    refunds_usd: "0",
    paying_subs: "0",
  };
  const l = ltvRows[0] ?? {
    avg_usd: "0",
    median_usd: "0",
    p90_usd: "0",
    subscribers: "0",
  };

  const gross = Number(w.gross_usd);
  const refunds = Number(w.refunds_usd);
  const net = gross - refunds;
  const payingSubscribers = Number(w.paying_subs);

  const refundRate = gross > 0 ? refunds / gross : null;
  const arppu =
    payingSubscribers > 0 ? (net / payingSubscribers).toFixed(4) : null;

  return {
    grossUsd: gross.toFixed(4),
    refundsUsd: refunds.toFixed(4),
    netUsd: net.toFixed(4),
    refundRate,
    payingSubscribers,
    arppu,
    avgLtvUsd: l.avg_usd,
    medianLtvUsd: l.median_usd,
    p90LtvUsd: l.p90_usd,
    ltvSubscribers: Number(l.subscribers),
  };
}
