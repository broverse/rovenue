import type {
  DashboardFlagRule,
  DashboardFlagType,
  FeatureFlagListItem,
} from "@rovenue/shared";
import type { FeatureFlag, FlagType, Rule } from "./types";

/** Compact "1.2M" / "342k" / "84" rendering for evaluation counts. */
export function formatEvalCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

// =============================================================
// API → UI mapping
// =============================================================

function uiType(t: DashboardFlagType): FlagType {
  if (t === "BOOLEAN") return "bool";
  if (t === "STRING") return "string";
  if (t === "NUMBER") return "number";
  return "json";
}

function serveLabel(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function uiRules(
  rules: ReadonlyArray<DashboardFlagRule>,
  defaultValue: unknown,
): ReadonlyArray<Rule> {
  const matchRules: Rule[] = rules.map((r) => ({
    type: "match",
    conditions: [{ attribute: "audience", op: "in", value: r.audienceId }],
    serve: serveLabel(r.value),
    ...(typeof r.rolloutPercentage === "number"
      ? { rolloutPct: Math.round(r.rolloutPercentage * 100) }
      : {}),
  }));
  matchRules.push({ type: "default", serve: serveLabel(defaultValue) });
  return matchRules;
}

function rolloutPercent(
  rules: ReadonlyArray<DashboardFlagRule>,
  isEnabled: boolean,
): number {
  if (!isEnabled) return 0;
  // No rule pct → flag serves defaultValue to 100% of traffic
  const first = rules.find((r) => typeof r.rolloutPercentage === "number");
  if (!first || typeof first.rolloutPercentage !== "number") return 100;
  return Math.round(first.rolloutPercentage * 100);
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return iso;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * Maps a `FeatureFlagListItem` from the API to the dashboard's
 * richer `FeatureFlag` shape. Backend doesn't carry env splits,
 * tags, eval analytics, or audit history yet — those default to
 * neutral values so the UI degrades to "config-only" rendering
 * until Phase 3 hydrates the analytics path.
 */
export function mapApiFeatureFlag(item: FeatureFlagListItem): FeatureFlag {
  return {
    key: item.key,
    type: uiType(item.type),
    description: item.description ?? "",
    enabled: item.isEnabled,
    killed: false,
    rolloutPct: rolloutPercent(item.rules, item.isEnabled),
    env: "prod",
    evalRate: 0,
    evals24h: 0,
    lastChanged: formatRelativeTime(item.updatedAt),
    by: "—",
    tags: [],
    rules: uiRules(item.rules, item.defaultValue),
    history: [],
  };
}


/** 24-h sparkline series of evaluation density. Deterministic per `seed`. */
export function evalSparkSeries(seed: number): ReadonlyArray<number> {
  const points: number[] = [];
  for (let i = 0; i < 24; i++) {
    points.push(0.5 + Math.sin((i + seed) / 2.2) * 0.35 + ((i * 13 + seed) % 7) / 100);
  }
  return points;
}
