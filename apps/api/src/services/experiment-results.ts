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
  type ExperimentVariantRow,
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
    /** Precisely-attributed conversions (raw_revenue_events.experimentKey/
     *  variantId) — 0 for non-PAYWALL experiment types, which don't carry
     *  presentedContext. See analytics-router's `attributed_conversions`. */
    attributedConversions: number;
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
  attributedConversions: number;
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
    experimentKey: experiment.key,
    projectId,
  });

  const byVariant = aggregate(rows);
  const variants = [...byVariant.values()];

  // SRM and conversion use the EXPOSED-USER count (uniqueUsers) — the correct
  // A/B unit — not the raw exposure-event count, which over-weights
  // repeat-viewers.
  const srm =
    variants.length >= 2
      ? checkSRM(
          variants.map((v) => ({
            expected:
              variants.reduce((sum, x) => sum + x.uniqueUsers, 0) /
              variants.length,
            observed: v.uniqueUsers,
          })),
        )
      : null;

  const conversion =
    variants.length === 2
      ? analyzeConversion(
          {
            users: variants[0]!.uniqueUsers,
            conversions: variants[0]!.conversions,
          },
          {
            users: variants[1]!.uniqueUsers,
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
      attributedConversions: v.attributedConversions,
    })),
    conversion,
    revenue,
    srm,
    sampleSize: null, // populated in Plan 2 when we have baseline data
  };
}

function aggregate(rows: ExperimentVariantRow[]): Map<string, VariantAgg> {
  const out = new Map<string, VariantAgg>();
  // One row per variant from the query — no per-day rollup to fold.
  for (const r of rows) {
    out.set(r.variant_id, {
      variantId: r.variant_id,
      exposures: Number(r.exposures),
      uniqueUsers: Number(r.unique_users),
      conversions: Number(r.conversions),
      attributedConversions: Number(r.attributed_conversions),
      // Per-user revenue series for analyzeRevenue is a separate enhancement;
      // conversion-rate analysis above is the shipped metric.
      revenueSeries: [],
    });
  }
  return out;
}
