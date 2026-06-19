import type {
  DashboardExperimentStatus,
  DashboardExperimentType,
  ExperimentListItem,
} from "@rovenue/shared";
import type {
  ExperimentGroup,
  ExperimentStatus,
  ExperimentSummary,
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

/** CSS color for each timeline tone. */
export const timelineDotColor = (
  tone: "primary" | "success" | "warning" | "muted",
): string => {
  if (tone === "primary") return "var(--color-rv-accent-500)";
  if (tone === "success") return "var(--color-rv-success)";
  if (tone === "warning") return "var(--color-rv-warning)";
  return "var(--color-rv-mute-400)";
};

/**
 * Maps a signed lift to a -12..+12 percent CI bar geometry. Returns the
 * left offset, width, and zero-line position as percentages so the bar
 * can render as plain `style={{ left, width }}`.
 */
export const ciGeometry = (lo: number, hi: number) => {
  const min = -12;
  const max = 12;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const scale = (v: number) => ((clamp(v) - min) / (max - min)) * 100;
  const left = scale(lo);
  const right = scale(hi);
  return { left, width: right - left, zero: scale(0) };
};
