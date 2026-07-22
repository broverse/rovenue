import type {
  DashboardExperimentStatus,
  DashboardExperimentType,
  ExperimentListItem,
  ExperimentResultsResponse,
} from "@rovenue/shared";
import type {
  ExperimentGroup,
  ExperimentStatus,
  ExperimentSummary,
  ResultVariantRow,
  VariantColorToken,
} from "./types";

// =============================================================
// API → UI mapping
// =============================================================
//
// Backend stores its own enum (DRAFT/RUNNING/PAUSED/COMPLETED).
// We mirror it as lowercase so the list/hero/dot can branch on a
// single string without re-importing the API enum.
function uiStatus(s: DashboardExperimentStatus): ExperimentStatus {
  if (s === "DRAFT") return "draft";
  if (s === "COMPLETED") return "completed";
  if (s === "PAUSED") return "paused";
  return "running";
}

// The dashboard tags experiments with a `group` chip purely for
// visual grouping. The backend doesn't carry that signal, so we
// derive a reasonable default from the experiment type until the
// dashboard exposes a real group field.
function groupFromType(t: DashboardExperimentType): ExperimentGroup {
  if (t === "PAYWALL") return "paywall";
  if (t === "FLAG") return "engagement";
  if (t === "OFFERING") return "monetization";
  return "onboarding";
}

/**
 * Column-visibility predicate for the variants table's "Attributed"
 * column: PAYWALL-type experiments are the only ones whose purchases
 * carry `presentedContext` (raw_revenue_events.experimentKey/variantId,
 * CH migration 0019), so precise attribution only exists for them —
 * OFFERING/FLAG experiment types keep the post-exposure heuristic
 * `conversions` column as today.
 *
 * `group` (not the raw API `type`) is the signal available on this page:
 * `mapApiExperiment` derives it via `groupFromType`, and PAYWALL is the
 * only backend type that maps to the `"paywall"` group.
 */
export function isPaywallExperimentGroup(group: ExperimentGroup): boolean {
  return group === "paywall";
}

function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 86_400_000);
}

function shortMonthDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

interface AgeLabel {
  ageLabelKey: string;
  ageLabelValues?: Readonly<Record<string, string | number>>;
}

function ageLabel(
  status: ExperimentStatus,
  startedAt: string | null,
  completedAt: string | null,
): AgeLabel {
  if (status === "draft") {
    return { ageLabelKey: "experiments.list.age.draft" };
  }
  if (status === "completed" && completedAt) {
    return {
      ageLabelKey: "experiments.list.age.completedOn",
      ageLabelValues: { date: shortMonthDay(completedAt) },
    };
  }
  // running / paused — count days since startedAt
  return {
    ageLabelKey: "experiments.list.age.runningDays",
    ageLabelValues: { days: daysSince(startedAt) },
  };
}

/**
 * Maps an `ExperimentListItem` from the API to the richer
 * `ExperimentSummary` shape the dashboard's list + hero render
 * against. Fields the API does not surface yet (`assigned`,
 * `confidence`, `outcome`, `lift`) default to neutral values so
 * the UI degrades gracefully — Phase 3 will hydrate them from
 * the results endpoint.
 */
export function mapApiExperiment(item: ExperimentListItem): ExperimentSummary {
  const status = uiStatus(item.status);
  const metric = item.metrics?.[0] ?? "";
  const description = item.description ?? "";
  const age = ageLabel(status, item.startedAt, item.completedAt);

  return {
    id: item.id,
    key: item.key,
    status,
    description,
    metric,
    started: item.startedAt,
    days: daysSince(item.startedAt),
    ageLabelKey: age.ageLabelKey,
    ...(age.ageLabelValues ? { ageLabelValues: age.ageLabelValues } : {}),
    variantCount: item.variants.length,
    assigned: 0,
    confidence: 0,
    outcome: "",
    group: groupFromType(item.type),
    lift: 0,
    winner: item.winnerVariantId,
    // Phase 3 hydrates this from the results endpoint; until then there is
    // no real leader, so the "ship winner" banner stays hidden.
    leadingVariant: null,
  };
}


/**
 * Maps a variant color token to its CSS color value. The accent token
 * resolves to the dashboard's accent variable so it auto-tints when the
 * accent hue is changed.
 */
export const variantColor = (token: VariantColorToken): string => {
  if (token === "primary") return "var(--color-rv-accent-500)";
  if (token === "violet") return "var(--color-rv-violet)";
  return "var(--color-rv-mute-500)";
};

// =============================================================
// Live results (/dashboard/experiments/:id/results) → view-model
// =============================================================
//
// The results endpoint degrades to `variants: []` whenever ClickHouse
// is unconfigured OR the experiment genuinely has zero exposures yet
// (see apps/api/src/services/experiment-results.ts — the CH query only
// ever returns a row for a variant that had at least one exposure
// event). That single fact is what lets the mapping below stay honest:
// there is no "populate every configured variant, zero-fill the rest"
// step anywhere, so the UI can never mistake "no data" for "a real 0%
// result".

const VARIANT_COLOR_CYCLE: ReadonlyArray<VariantColorToken> = [
  "default",
  "primary",
  "violet",
];

function colorForIndex(i: number): VariantColorToken {
  return VARIANT_COLOR_CYCLE[i % VARIANT_COLOR_CYCLE.length]!;
}

/**
 * Maps the live results payload to per-variant table/funnel rows.
 * `attributedConversions` is only surfaced when `showAttributed` (the
 * PAYWALL-gated column from D-12) — other experiment types never
 * carried that signal, so gating doubles as row-shaping: components
 * never receive a real-looking 0 for data that was never tracked.
 */
export function mapResultsVariants(
  results: Pick<ExperimentResultsResponse, "variants"> | null | undefined,
  showAttributed: boolean,
): ResultVariantRow[] {
  const rows = results?.variants ?? [];
  return rows.map((v, i) => ({
    variantId: v.variantId,
    exposures: v.exposures,
    uniqueUsers: v.uniqueUsers,
    attributedConversions: showAttributed ? v.attributedConversions : null,
    colorToken: colorForIndex(i),
    // Best-effort: the wire type carries no explicit "is control" flag,
    // but `control` is the conventional id (see new-experiment's
    // variantId placeholder) — purely cosmetic (badge suffix), never
    // used to pick which numbers to show.
    isControl: v.variantId === "control",
  }));
}

/**
 * True once the results endpoint has at least one variant row — the
 * "no exposures yet" (or "ClickHouse unconfigured") case is an empty
 * array, never zero-value rows, so this is the single honest gate for
 * every live card on the detail panel.
 */
export function hasLiveResultsData(
  results: Pick<ExperimentResultsResponse, "variants"> | null | undefined,
): boolean {
  return (results?.variants.length ?? 0) > 0;
}

export type FunnelSeriesStage = {
  key: "exposures" | "uniqueUsers" | "attributed";
  labelKey: string;
  values: ReadonlyArray<{
    variantId: string;
    value: number;
    colorToken: VariantColorToken;
  }>;
};

/**
 * Builds the funnel's stages from live variant rows: exposures →
 * exposed users always, plus an attributed-conversions stage only when
 * `showAttributed` — there is no viewed/CTA/trial per-step breakdown in
 * the results payload, so the funnel reflects exactly the three counts
 * the API actually returns rather than inventing intermediate steps.
 */
export function buildFunnelStages(
  variants: ReadonlyArray<ResultVariantRow>,
  showAttributed: boolean,
): FunnelSeriesStage[] {
  const stages: FunnelSeriesStage[] = [
    {
      key: "exposures",
      labelKey: "experiments.funnel.stages.exposures.title",
      values: variants.map((v) => ({
        variantId: v.variantId,
        value: v.exposures,
        colorToken: v.colorToken,
      })),
    },
    {
      key: "uniqueUsers",
      labelKey: "experiments.funnel.stages.uniqueUsers.title",
      values: variants.map((v) => ({
        variantId: v.variantId,
        value: v.uniqueUsers,
        colorToken: v.colorToken,
      })),
    },
  ];
  if (showAttributed) {
    stages.push({
      key: "attributed",
      labelKey: "experiments.funnel.stages.attributed.title",
      values: variants.map((v) => ({
        variantId: v.variantId,
        value: v.attributedConversions ?? 0,
        colorToken: v.colorToken,
      })),
    });
  }
  return stages;
}
