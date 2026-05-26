import type {
  DashboardFlagEnv,
  DashboardFlagRule,
  DashboardFlagType,
  FeatureFlagListItem,
} from "@rovenue/shared";
import type { FeatureFlag, FlagEnv, FlagType, Rule } from "./types";

function uiEnv(e: DashboardFlagEnv): FlagEnv {
  if (e === "STAGING") return "staging";
  if (e === "DEVELOPMENT") return "development";
  return "prod";
}

const DB_ENV_LOOKUP: Record<FlagEnv, DashboardFlagEnv> = {
  prod: "PROD",
  staging: "STAGING",
  development: "DEVELOPMENT",
};

/** Convert dashboard env tab → backend enum casing. */
export function toDbEnv(e: FlagEnv): DashboardFlagEnv {
  return DB_ENV_LOOKUP[e];
}

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
  const matchRules: Rule[] = rules.map((r) => {
    const conditions = describeRuleConditions(r);
    return {
      type: "match",
      conditions:
        conditions.length > 0
          ? conditions
          : [{ attribute: "*", op: "matches", value: "everyone" }],
      serve: serveLabel(r.value),
      ...(typeof r.rolloutPercentage === "number"
        ? { rolloutPct: Math.round(r.rolloutPercentage * 100) }
        : {}),
    };
  });
  matchRules.push({ type: "default", serve: serveLabel(defaultValue) });
  return matchRules;
}

/**
 * Flatten the rule's audience + inline `conditions` into the
 * dashboard's flat `{attribute, op, value}` cells. Inline sift
 * fragments are rendered as `<field> <op> <value>` rows so the
 * detail card stays human-readable without re-implementing sift.
 */
function describeRuleConditions(rule: DashboardFlagRule): Array<{
  attribute: string;
  op: string;
  value: string;
}> {
  const out: Array<{ attribute: string; op: string; value: string }> = [];
  if (rule.audienceId) {
    out.push({ attribute: "audience", op: "in", value: rule.audienceId });
  }
  if (rule.conditions) {
    const fragments = Array.isArray(rule.conditions.$and)
      ? (rule.conditions.$and as Record<string, unknown>[])
      : [rule.conditions];
    for (const frag of fragments) {
      for (const [field, ops] of Object.entries(frag)) {
        if (field.startsWith("$")) continue;
        if (typeof ops !== "object" || ops === null || Array.isArray(ops)) {
          out.push({ attribute: field, op: "=", value: String(ops) });
          continue;
        }
        for (const [op, raw] of Object.entries(ops as Record<string, unknown>)) {
          out.push({
            attribute: field,
            op: op.startsWith("$") ? op.slice(1) : op,
            value: Array.isArray(raw)
              ? raw.map((v) => String(v)).join(", ")
              : typeof raw === "object" && raw !== null
                ? JSON.stringify(raw)
                : String(raw),
          });
        }
      }
    }
  }
  return out;
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
 * richer `FeatureFlag` shape. Backend doesn't carry tags, eval
 * analytics, or audit history yet — those default to neutral
 * values so the UI degrades to "config-only" rendering until
 * Phase 3 hydrates the analytics path.
 */
export function mapApiFeatureFlag(item: FeatureFlagListItem): FeatureFlag {
  return {
    key: item.key,
    type: uiType(item.type),
    description: item.description ?? "",
    enabled: item.isEnabled,
    killed: false,
    rolloutPct: rolloutPercent(item.rules, item.isEnabled),
    env: uiEnv(item.env),
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
