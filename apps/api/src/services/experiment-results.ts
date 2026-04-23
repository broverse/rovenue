import {
  analyzeConversion,
  analyzeRevenue,
  checkSRM,
  type ConversionAnalysis,
  type RevenueAnalysis,
  type SRMResult,
} from "../lib/experiment-stats";
import {
  runAnalyticsQuery,
  type ExperimentDailyRow,
} from "./analytics-router";
import { drizzle } from "@rovenue/db";

// =============================================================
// Experiment results service (CH-backed)
// =============================================================
//
// Source: superseded plan Task 8.1 (2026-04-23-clickhouse-
// foundation-and-experiments.md lines 2370-2530), copied per
// Phase F.4 of the Kafka+outbox pivot. The service reads from
// ClickHouse via the analytics router — whether the rows were
// landed by PeerDB CDC (old) or the Kafka Engine + outbox
// dispatcher (new) is invisible here.
//
// Drift vs. superseded plan: `drizzle.experimentRepo.findById`
// does not exist in the current repo — the real symbol is
// `findExperimentById`. Semantics are unchanged.

type ExperimentStatus = "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";

export interface ExperimentResults {
  experimentId: string;
  status: ExperimentStatus;
  variants: Array<{
    variantId: string;
    exposures: number;
    uniqueUsers: number;
  }>;
  conversion: ConversionAnalysis | null;
  revenue: RevenueAnalysis | null;
  srm: SRMResult | null;
  sampleSize: {
    required: number;
    reached: boolean;
  } | null;
}

interface VariantAgg {
  variantId: string;
  exposures: number;
  uniqueUsers: number;
  conversions: number;
  revenueSeries: number[];
}

export async function computeExperimentResults(
  experimentId: string,
  projectId: string,
): Promise<ExperimentResults> {
  const experiment = await drizzle.experimentRepo.findExperimentById(
    drizzle.db,
    experimentId,
  );
  if (!experiment || experiment.projectId !== projectId) {
    throw new Error("experiment not found");
  }

  const rows = await runAnalyticsQuery({
    kind: "experiment_results",
    experimentId,
    projectId,
  });

  // Plan 1 ships exposure + unique-user aggregation only. Revenue /
  // conversion joins with raw_revenue_events land in Plan 2. We still
  // return a null-filled shape so the route contract is stable.
  const byVariant = aggregate(rows);
  const variants = [...byVariant.values()];

  const srm =
    variants.length >= 2
      ? checkSRM(
          variants.map((v) => ({
            expected:
              variants.reduce((sum, x) => sum + x.exposures, 0) /
              variants.length,
            observed: v.exposures,
          })),
        )
      : null;

  const conversion =
    variants.length === 2
      ? analyzeConversion(
          {
            users: variants[0]!.exposures,
            conversions: variants[0]!.conversions,
          },
          {
            users: variants[1]!.exposures,
            conversions: variants[1]!.conversions,
          },
        )
      : null;

  const revenue =
    variants.length === 2 &&
    variants[0]!.revenueSeries.length >= 2 &&
    variants[1]!.revenueSeries.length >= 2
      ? analyzeRevenue(variants[0]!.revenueSeries, variants[1]!.revenueSeries)
      : null;

  return {
    experimentId,
    status: experiment.status as ExperimentStatus,
    variants: variants.map((v) => ({
      variantId: v.variantId,
      exposures: v.exposures,
      uniqueUsers: v.uniqueUsers,
    })),
    conversion,
    revenue,
    srm,
    sampleSize: null, // populated in Plan 2 when we have baseline data
  };
}

function aggregate(rows: ExperimentDailyRow[]): Map<string, VariantAgg> {
  const out = new Map<string, VariantAgg>();
  for (const r of rows) {
    const acc = out.get(r.variant_id) ?? {
      variantId: r.variant_id,
      exposures: 0,
      uniqueUsers: 0,
      conversions: 0, // Plan 2 fills this via a revenue join MV
      revenueSeries: [] as number[],
    };
    acc.exposures += Number(r.exposures);
    acc.uniqueUsers = Math.max(acc.uniqueUsers, Number(r.unique_users));
    out.set(r.variant_id, acc);
  }
  return out;
}
