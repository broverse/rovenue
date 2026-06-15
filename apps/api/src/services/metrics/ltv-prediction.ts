import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { queryAnalytics } from "../../lib/clickhouse";
import { toDateOnly } from "./_utils";
import {
  computeLtvPrediction,
  type LtvRawRow,
  type LtvSizeRow,
} from "./ltv-extrapolation";
import type { LtvSegment } from "@rovenue/shared";

export interface GetLtvPredictionInput {
  projectId: string;
  horizonMonths: number;
  minMatureCohorts: number;
}

const STORE_LABELS: Record<string, string> = {
  APP_STORE: "App Store",
  PLAY_STORE: "Play Store",
  STRIPE: "Stripe",
  MANUAL: "Manual",
};

interface ChRevRow {
  cohort_month: string;
  store: string;
  product_id: string;
  age_month: number;
  net_usd: string;
}
interface ChSizeRow {
  cohort_month: string;
  store: string;
  product_id: string;
  size: string;
}

export async function getLtvPrediction(input: GetLtvPredictionInput) {
  const joinsCte = `
    joins AS (
      SELECT
        subscriberId,
        toStartOfMonth(min(eventDate))       AS cohort_month,
        argMin(store, eventDate)             AS join_store,
        argMin(productId, eventDate)         AS join_product
      FROM rovenue.raw_revenue_events FINAL
      WHERE projectId = {projectId:String}
        AND type IN ('INITIAL','TRIAL_CONVERSION')
      GROUP BY subscriberId
    )`;

  const [revRows, sizeRows] = await Promise.all([
    queryAnalytics<ChRevRow>(
      input.projectId,
      `
        WITH ${joinsCte}
        SELECT
          toString(j.cohort_month)                                           AS cohort_month,
          j.join_store                                                       AS store,
          j.join_product                                                     AS product_id,
          toInt32(dateDiff('month', j.cohort_month, toStartOfMonth(e.eventDate))) AS age_month,
          toString(
            sumIf(e.amountUsd, e.type NOT IN ('REFUND','CHARGEBACK'))
              - sumIf(e.amountUsd, e.type IN ('REFUND','CHARGEBACK'))
          )                                                                  AS net_usd
        FROM rovenue.raw_revenue_events AS e FINAL
        INNER JOIN joins AS j ON e.subscriberId = j.subscriberId
        WHERE e.projectId = {projectId:String}
        GROUP BY cohort_month, store, product_id, age_month
      `,
    ),
    queryAnalytics<ChSizeRow>(
      input.projectId,
      `
        WITH ${joinsCte}
        SELECT
          toString(cohort_month)  AS cohort_month,
          join_store              AS store,
          join_product            AS product_id,
          toString(count())       AS size
        FROM joins
        GROUP BY cohort_month, store, product_id
      `,
    ),
  ]);

  const rows: LtvRawRow[] = revRows.map((r) => ({
    cohortMonth: r.cohort_month.slice(0, 10),
    store: r.store,
    productId: r.product_id,
    ageMonth: Number(r.age_month),
    netUsd: Number(r.net_usd),
  }));
  const sizes: LtvSizeRow[] = sizeRows.map((r) => ({
    cohortMonth: r.cohort_month.slice(0, 10),
    store: r.store,
    productId: r.product_id,
    size: Number(r.size),
  }));

  const now = new Date();
  const asOfMonth = toDateOnly(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));

  const data = computeLtvPrediction(
    rows,
    sizes,
    input.horizonMonths,
    input.minMatureCohorts,
    asOfMonth,
  );

  const productIds = data.byProduct.map((s) => s.key).filter(Boolean);
  const nameById = new Map<string, string>();
  if (productIds.length > 0) {
    const prods = await drizzle.db
      .select({
        id: drizzle.schema.products.id,
        displayName: drizzle.schema.products.displayName,
      })
      .from(drizzle.schema.products)
      .where(
        and(
          eq(drizzle.schema.products.projectId, input.projectId),
          inArray(drizzle.schema.products.id, productIds),
        ),
      );
    for (const p of prods) nameById.set(p.id, p.displayName);
  }

  const byStore: LtvSegment[] = data.byStore.map((s) => ({
    ...s,
    label: STORE_LABELS[s.key] ?? s.key,
  }));
  const byProduct: LtvSegment[] = data.byProduct.map((s) => ({
    ...s,
    label: nameById.get(s.key) ?? s.key,
  }));

  return { ...data, byStore, byProduct };
}
