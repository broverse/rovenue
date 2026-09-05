// =============================================================
// Retention policy registry (ROADMAP §9.2)
// =============================================================
//
// Three bespoke retention workers each hardcoded their own window (or
// read it from an env var) and none of them consulted the project's
// billing tier. This registry is the single source of truth for what
// is retainable, how it ages, and how long a given project keeps it.
//
// Why a code constant and not a database table: a policy names a
// physical table and the column that ages it — facts about the schema
// that change with a migration, not with a row. A database row
// describing a table that no longer exists is a silent no-op; a
// constant referencing one fails to compile.

// =============================================================
// Strategy
// =============================================================
//
// How a sweep actually reclaims space, once a policy's window has
// elapsed:
//   - DELETE_ROWS: an ordinary DELETE, optionally restricted to
//     terminal-status rows (see `terminalStatuses` below).
//   - DROP_PARTITION: the table is pg_partman range-partitioned on
//     its timestamp column, so an expired window is reclaimed by
//     dropping whole partitions rather than deleting individual rows.
//   - CHECKPOINT_TRUNCATE: the table is an append-only hash chain
//     (see audit_logs); expiring history requires checkpointing the
//     chain at the new boundary before truncating, or the chain
//     verification breaks.
export type RetentionStrategy =
  | "DELETE_ROWS"
  | "DROP_PARTITION"
  | "CHECKPOINT_TRUNCATE";

// Which column on `billing_tier_limits` (packages/db/src/drizzle/schema.ts)
// supplies this policy's default window for a project's tier.
export type RetentionTierField = "retentionDays" | "auditLogDays";

export interface RetentionPolicy {
  // The physical table name, exactly as it appears in the DB.
  table: string;
  // The column a sweep filters/orders on to determine a row's age.
  timestampColumn: string;
  strategy: RetentionStrategy;
  // Which billing-tier-limits column supplies the default window.
  tierLimitField: RetentionTierField;
  // The shortest window any tier or project override may resolve to.
  // A policy-specific floor that no override, however aggressive,
  // may undercut.
  minimumDays: number;
  // When present, names a `status` column's terminal values. A
  // DELETE_ROWS sweep may only expire rows whose status is one of
  // these — a table whose rows have a lifecycle must not lose a row
  // that is still deliverable merely because it is old. Modeled after
  // `TERMINAL_IMPORT_JOB_STATUSES`
  // (packages/db/src/drizzle/repositories/import-jobs.ts).
  terminalStatuses?: readonly string[];
}

// =============================================================
// Window resolution
// =============================================================

/**
 * Resolve how many days of history a project keeps for one policy.
 *
 * Rule: a project override may only ever SHORTEN the tier's window,
 * never lengthen it — a longer window is a storage-cost and
 * compliance decision the tier already made. Whatever that yields is
 * then floored at the policy's own `minimumDays`, which outranks both
 * the tier and any override: some data (a financial ledger, an audit
 * trail) has a retention floor no tier or project may go below.
 */
export function resolveRetentionWindowDays(args: {
  policy: RetentionPolicy;
  tierDays: number;
  projectOverrideDays: number | null;
}): number {
  const requested = args.projectOverrideDays ?? args.tierDays;
  const clampedToTier = Math.min(requested, args.tierDays);
  return Math.max(args.policy.minimumDays, clampedToTier);
}

// =============================================================
// Registry
// =============================================================

// Below a month, an audit trail cannot answer "what changed last
// quarter", which is the question it exists to answer.
const AUDIT_LOG_MINIMUM_DAYS = 30;

// A financial ledger. The floor is deliberately the longest here.
const CREDIT_LEDGER_MINIMUM_DAYS = 365;

const REVENUE_EVENTS_MINIMUM_DAYS = 365;

// outgoing_webhooks, webhook_events, copilot_messages have no
// compliance role — a week is enough floor to keep a same-week
// operator investigation from racing a sweep.
const OPERATIONAL_TABLE_MINIMUM_DAYS = 7;

// outgoing_webhooks status lifecycle (packages/db/src/drizzle/enums.ts,
// `outgoingWebhookStatus`): PENDING, DELIVERING and FAILED are all
// still in play — the delivery worker's claim query is
// `status IN ('PENDING', 'FAILED')` (apps/api/src/workers/webhook-delivery.ts),
// so a FAILED row is retried automatically until MAX_ATTEMPTS, and
// DELIVERING is an in-flight claim the stale-claim reaper can return
// to PENDING. SENT is a successful terminal delivery. DEAD is
// reached only after automatic retries are exhausted; the only path
// out of it is the dashboard's manual retry endpoint
// (resetWebhookForRetry), the same "recovery is a manual operator
// action they are free to take before the window elapses" shape as
// TERMINAL_IMPORT_JOB_STATUSES treats FAILED/CANCELLED import jobs —
// so DEAD is terminal for retention purposes even though an operator
// can revive it before the window closes. DISMISSED is reachable only
// from DEAD (an explicit operator acknowledgement) and has no path
// back. PENDING, DELIVERING and FAILED are excluded: a row in any of
// them is still owed a delivery attempt, and an age-based sweep must
// never destroy it.
const OUTGOING_WEBHOOK_TERMINAL_STATUSES: readonly string[] = [
  "SENT",
  "DEAD",
  "DISMISSED",
];

export const RETENTION_POLICIES: readonly RetentionPolicy[] = [
  {
    table: "audit_logs",
    timestampColumn: "createdAt",
    strategy: "CHECKPOINT_TRUNCATE",
    tierLimitField: "auditLogDays",
    minimumDays: AUDIT_LOG_MINIMUM_DAYS,
  },
  {
    table: "credit_ledger",
    timestampColumn: "createdAt",
    strategy: "DROP_PARTITION",
    tierLimitField: "retentionDays",
    minimumDays: CREDIT_LEDGER_MINIMUM_DAYS,
  },
  {
    table: "revenue_events",
    timestampColumn: "eventDate",
    strategy: "DROP_PARTITION",
    tierLimitField: "retentionDays",
    minimumDays: REVENUE_EVENTS_MINIMUM_DAYS,
  },
  {
    // DELETE_ROWS, not DROP_PARTITION, on purpose: 0017's own
    // migration comment says the retention predicate is composite
    // (status AND age), so a whole monthly partition is never
    // uniformly expired — a partition can hold both a long-DEAD row
    // and a row still awaiting its next retry.
    table: "outgoing_webhooks",
    timestampColumn: "createdAt",
    strategy: "DELETE_ROWS",
    tierLimitField: "retentionDays",
    minimumDays: OPERATIONAL_TABLE_MINIMUM_DAYS,
    terminalStatuses: OUTGOING_WEBHOOK_TERMINAL_STATUSES,
  },
  {
    // Dedup/log table (UNIQUE(source, storeEventId)) with no delivery
    // lifecycle of its own — every row is a terminal record of an
    // already-processed event, so age alone is a safe expiry
    // predicate. No terminalStatuses.
    table: "webhook_events",
    timestampColumn: "createdAt",
    strategy: "DELETE_ROWS",
    tierLimitField: "retentionDays",
    minimumDays: OPERATIONAL_TABLE_MINIMUM_DAYS,
  },
  {
    // Chat transcript log with no delivery lifecycle — every row is
    // an already-sent message, so age alone is a safe expiry
    // predicate. No terminalStatuses.
    table: "copilot_messages",
    timestampColumn: "createdAt",
    strategy: "DELETE_ROWS",
    tierLimitField: "retentionDays",
    minimumDays: OPERATIONAL_TABLE_MINIMUM_DAYS,
  },
] as const;

export function findRetentionPolicy(
  table: string,
): RetentionPolicy | undefined {
  return RETENTION_POLICIES.find((policy) => policy.table === table);
}
