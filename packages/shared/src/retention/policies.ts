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

import { IMPORT_FILE_RETENTION_DAYS } from "../import/constants";

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
//   - EXTERNAL_WORKER (ROADMAP §9.2 Task 6): the row exists here so the
//     WINDOW is resolved by the same tier+override+floor rules as every
//     other policy, but the actual reclamation is owned entirely by a
//     dedicated worker OUTSIDE `workers/retention-sweep.ts` — today only
//     `import_jobs` (`workers/import-retention.ts`), which deletes
//     object-storage FILES alongside the row and tracks that with a
//     `filesDeletedAt` column so a re-run cannot re-select the same job.
//     Folding that into the generic sweep would either lose that
//     idempotency guard or push storage semantics into every policy, so
//     `runRetentionSweep` deliberately never dispatches this strategy —
//     it falls through to the existing "strategy not implemented" skip
//     branch, which is the CORRECT signal (this sweep must never touch
//     an EXTERNAL_WORKER table directly), not a gap to fill in later.
export type RetentionStrategy =
  | "DELETE_ROWS"
  | "DROP_PARTITION"
  | "CHECKPOINT_TRUNCATE"
  | "EXTERNAL_WORKER";

// Which column on `billing_tier_limits` (packages/db/src/drizzle/schema.ts)
// supplies this policy's default window for a project's tier.
export type RetentionTierField = "retentionDays" | "auditLogDays";

export interface RetentionPolicy {
  // The physical table name, exactly as it appears in the DB.
  table: string;
  // The DRIZZLE SCHEMA PROPERTY NAME (packages/db/src/drizzle/schema.ts)
  // of the column a sweep filters/orders on to determine a row's age —
  // deliberately NOT guaranteed to be the physical DB column name.
  // `copilot_messages` is the proof this distinction is load-bearing:
  // its Drizzle field is `createdAt` but the physical column is
  // `created_at`. A consumer must resolve this through the real Drizzle
  // table object (e.g. `schemaTable[policy.timestampColumn]`), never by
  // raw-interpolating the string as a quoted SQL identifier — that
  // would silently target a nonexistent column for any table whose
  // property name and physical name diverge. See
  // packages/db/src/drizzle/repositories/retention-rows.ts for the
  // DELETE_ROWS consumer that does this correctly.
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
  // The window a project with NEITHER a billing tier NOR an override
  // resolves to, instead of being skipped ("no-window", rule 3 below).
  //
  // Deliberately absent on every policy except `copilot_messages` and
  // `webhook_events`: those two tables were deleted UNCONDITIONALLY,
  // for every project, by the bespoke workers this registry replaced
  // (`rovi-retention.ts` at `ROVI_MESSAGE_RETENTION_DAYS`/90,
  // `webhook-retention.ts` at a hardcoded 90) — neither ever consulted
  // a tier. `defaultDays: 90` on each carries that EXISTING,
  // already-applied-to-everyone behaviour forward unchanged.
  //
  // This does not contradict rule 3's refusal to default a tierless
  // project to the free tier's window: that refusal is about NEVER
  // inventing a window a table never had (inventing one for, say,
  // `audit_logs` would delete a self-hoster's history a week after
  // install). `defaultDays` only ever preserves a window that already
  // existed and already ran for every project — it must never be added
  // to a policy that had no unconditional predecessor.
  defaultDays?: number;
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
 *
 * Both `tierDays` and `projectOverrideDays` must be finite. A NaN or
 * Infinity input would otherwise flow silently into a caller's
 * `now - days` cutoff arithmetic and produce an Invalid Date — a
 * retention sweep computed against a meaningless cutoff is exactly
 * the failure mode this function must not permit quietly.
 */
export function resolveRetentionWindowDays(args: {
  policy: RetentionPolicy;
  tierDays: number;
  projectOverrideDays: number | null;
}): number {
  if (!Number.isFinite(args.tierDays)) {
    throw new Error(
      `resolveRetentionWindowDays: tierDays must be a finite number, got ${args.tierDays}`,
    );
  }
  if (
    args.projectOverrideDays !== null &&
    !Number.isFinite(args.projectOverrideDays)
  ) {
    throw new Error(
      `resolveRetentionWindowDays: projectOverrideDays must be a finite number or null, got ${args.projectOverrideDays}`,
    );
  }
  const requested = args.projectOverrideDays ?? args.tierDays;
  const clampedToTier = Math.min(requested, args.tierDays);
  return Math.max(args.policy.minimumDays, clampedToTier);
}

// =============================================================
// Per-project window resolution
// =============================================================
//
// Lives here, not in `workers/retention-sweep.ts`, even though that is
// the only consumer for most policies: `import_jobs`'s worker
// (`workers/import-retention.ts`, ROADMAP §9.2 Task 6) resolves ITS OWN
// window through this exact function too, and neither worker should
// have to import the OTHER worker's module (retention-sweep.ts pulls in
// `../lib/audit`, ClickHouse-adjacent metrics, and BullMQ Queue/Worker
// wiring — dependencies import-retention.ts has no reason to carry, and
// which make it far harder to unit-test in isolation). A pure function
// with no DB dependency of its own belongs next to the registry it
// resolves against, not inside one particular caller.
//
// `workers/retention-sweep.ts` re-exports these names for backward
// compatibility with its own existing imports/tests.

/** The subset of a `billing_tier_limits` row this resolution needs —
 *  deliberately NOT the full Drizzle-inferred row type, which lives in
 *  `@rovenue/db` and would make this package (a dependency OF db, per
 *  packages/db/package.json) depend on it instead. Any object with
 *  these two fields — including the real DB row — satisfies this
 *  structurally. */
export interface TierRetentionLimits {
  retentionDays: number;
  auditLogDays: number;
}

// retentionSweepSkippedTotal / resolveProjectPolicyWindowDays reason
// labels for "this project's window could not be resolved."
export const RETENTION_SKIP_REASON_NO_WINDOW = "no-window";
export const RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND =
  "tier-limits-not-found";

type WindowSkipReason =
  | typeof RETENTION_SKIP_REASON_NO_WINDOW
  | typeof RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND;

export type WindowResolution =
  | { kind: "resolved"; days: number }
  | { kind: "skip"; reason: WindowSkipReason };

/**
 * Resolve how many days of history one project keeps for one policy.
 *
 * Precedence: an override wins if present; else the tier window if the
 * project has one; else the policy's `defaultDays` if it has one; else
 * skip ("no-window"). The policy's `minimumDays` floor is applied in
 * every branch that resolves a number.
 *
 *   1. A project WITH a billing subscription AND a matching
 *      `billing_tier_limits` row resolves normally: tier window,
 *      override clamped down, policy floor applied
 *      (`resolveRetentionWindowDays`).
 *   2. A project WITHOUT a billing subscription, but WITH an explicit
 *      override for that table, uses the override clamped by the FLOOR
 *      ONLY — there is no tier to clamp down to, and the operator who
 *      wrote the override is the authority.
 *   3. A project with neither a tier nor an override falls back to the
 *      policy's `defaultDays`, floored, when the policy has one —
 *      carrying forward a window that already applied to every project
 *      unconditionally before this registry existed (see `defaultDays`
 *      on `RetentionPolicy`). A policy with NO `defaultDays` is
 *      skipped instead: it is NOT defaulted to the free tier's window,
 *      because that would invent a window a table never had — retaining
 *      too much is recoverable, deleting what nobody asked to delete is
 *      not.
 *   4. A project WITH a subscription whose (tier, cycle) has no row at
 *      all in `billing_tier_limits` (a reference-ladder integrity gap)
 *      is NOT the same as "no tier" — falling through to rule 2/3 would
 *      silently drop a PAYING project's tier clamp — so it gets its own
 *      skip reason, never `defaultDays` either.
 *
 * See `apps/api/src/workers/retention-sweep.ts`'s module doc comment
 * for the full "why a project's tier is optional" rationale.
 */
export function resolveProjectPolicyWindowDays(
  policy: RetentionPolicy,
  hasTier: boolean,
  tierLimits: TierRetentionLimits | null,
  overrideDays: number | undefined,
): WindowResolution {
  if (hasTier && !tierLimits) {
    // Rule 4.
    return {
      kind: "skip",
      reason: RETENTION_SKIP_REASON_TIER_LIMITS_NOT_FOUND,
    };
  }

  if (tierLimits) {
    // Rule 1.
    const tierDays = tierLimits[policy.tierLimitField];
    const days = resolveRetentionWindowDays({
      policy,
      tierDays,
      projectOverrideDays: overrideDays ?? null,
    });
    return { kind: "resolved", days };
  }

  if (overrideDays !== undefined) {
    // Rule 2.
    return { kind: "resolved", days: Math.max(policy.minimumDays, overrideDays) };
  }

  if (policy.defaultDays !== undefined) {
    // Rule 3 (default branch): no tier, no override, but this policy
    // carries forward a window that used to apply unconditionally.
    return {
      kind: "resolved",
      days: Math.max(policy.minimumDays, policy.defaultDays),
    };
  }

  // Rule 3 (skip branch): no tier, no override, no default.
  return { kind: "skip", reason: RETENTION_SKIP_REASON_NO_WINDOW };
}

// =============================================================
// Registry
// =============================================================

// Below a month, an audit trail cannot answer "what changed last
// quarter", which is the question it exists to answer.
const AUDIT_LOG_MINIMUM_DAYS = 30;

// A financial ledger. The floor is deliberately the longest here.
//
// Documentation note for Task 6: at 365 days, this floor makes
// `retentionDays` inert for free (30) and indie (180) tiers — a
// project on either tier retains a full year regardless of what its
// tier advertises, because `resolveRetentionWindowDays` floors the
// tier window at `minimumDays`. Defensible for a financial ledger;
// worth calling out explicitly wherever the tier ladder's retention
// numbers are documented, since the ladder alone would otherwise
// overpromise how short a project can make this window.
const CREDIT_LEDGER_MINIMUM_DAYS = 365;

// Same inert-floor note as CREDIT_LEDGER_MINIMUM_DAYS above applies
// here too — free and indie tiers both retain a full year of revenue
// events regardless of their advertised `retentionDays`.
const REVENUE_EVENTS_MINIMUM_DAYS = 365;

// outgoing_webhooks, webhook_events, copilot_messages have no
// compliance role — a week is enough floor to keep a same-week
// operator investigation from racing a sweep.
const OPERATIONAL_TABLE_MINIMUM_DAYS = 7;

// Fix round 1, Finding 1: `webhook_events` and `copilot_messages` were
// each deleted unconditionally, for EVERY project, by the bespoke
// worker this registry replaced — `webhook-retention.ts` at a
// hardcoded 90 days, `rovi-retention.ts` at `env.ROVI_MESSAGE_RETENTION_DAYS`,
// which itself defaulted to 90. Set as each policy's `defaultDays` so a
// project with neither a billing tier nor an override (most self-hosted
// deployments, by construction) keeps resolving a window instead of
// silently retaining these two tables forever — the exact regression a
// naive registry migration would otherwise ship. Deliberately not used
// as a fallback for any OTHER table: those never had an unconditional
// window to carry forward, and inventing one now would be the mirror-
// image mistake.
const RETIRED_WORKER_DEFAULT_DAYS = 90;

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
    //
    // Documentation note for Task 6: this ages on `createdAt`, not on
    // `deadAt` (when the row actually reached a terminal state). A row
    // that burns through the full backoff schedule before landing on
    // DEAD (apps/api/src/workers/webhook-delivery.ts,
    // BACKOFF_SCHEDULE_MS, ≈14.6h worst case: 1+5+30+120+720 min)
    // loses that much of the operator's manual-retry window before
    // the sweep's cutoff is reached. Negligible against a 7-day
    // floor, but real, and worth a mention wherever this window is
    // documented.
    table: "outgoing_webhooks",
    timestampColumn: "createdAt",
    strategy: "DELETE_ROWS",
    tierLimitField: "retentionDays",
    minimumDays: OPERATIONAL_TABLE_MINIMUM_DAYS,
    terminalStatuses: OUTGOING_WEBHOOK_TERMINAL_STATUSES,
  },
  {
    // webhook_events DOES have a lifecycle (RECEIVED / PROCESSING /
    // PROCESSED / FAILED — packages/db/src/drizzle/enums.ts,
    // `webhookEventStatus`) with an atomic claim
    // (claimWebhookEvent, packages/db/src/drizzle/repositories/webhook-events.ts)
    // — this is NOT a plain dedup/log table. It still needs no
    // terminalStatuses, for a different reason than outgoing_webhooks:
    // this table records INBOUND deliveries from Stripe/Apple/Google,
    // so we are the receiver, not the party that owes a delivery —
    // nothing here is "still owed" to a third party the way an
    // undelivered outgoing_webhooks row is. Retries are also bounded,
    // unlike outgoing_webhooks' perpetual poller: the processor's
    // BullMQ job (apps/api/src/services/webhook-processor.ts,
    // WEBHOOK_JOB_ATTEMPTS, ≈635s total span) exhausts on its own,
    // and the reaper (apps/api/src/workers/webhook-reaper.ts) leases
    // only orphaned PROCESSING rows and caps requeues at
    // MAX_REAPER_REQUEUES (5) before leaving a row FAILED for good.
    // By the time a row is old enough to hit even this policy's
    // 7-day floor, it has long since reached a stable end state
    // (PROCESSED, or FAILED with retries exhausted) — there is no
    // plausible "still in progress" row at that age, so age alone is
    // a safe expiry predicate. No terminalStatuses.
    table: "webhook_events",
    timestampColumn: "createdAt",
    strategy: "DELETE_ROWS",
    tierLimitField: "retentionDays",
    minimumDays: OPERATIONAL_TABLE_MINIMUM_DAYS,
    // See RETIRED_WORKER_DEFAULT_DAYS: webhook-retention.ts deleted
    // this table's rows at a hardcoded 90 days for every project,
    // tier or no tier. Carried forward, not invented.
    defaultDays: RETIRED_WORKER_DEFAULT_DAYS,
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
    // See RETIRED_WORKER_DEFAULT_DAYS: rovi-retention.ts deleted this
    // table's rows at env.ROVI_MESSAGE_RETENTION_DAYS (default 90) for
    // every project, tier or no tier. Carried forward, not invented.
    defaultDays: RETIRED_WORKER_DEFAULT_DAYS,
  },
  {
    // ROADMAP §9.2 Task 6. EXTERNAL_WORKER, not DELETE_ROWS — see the
    // strategy's own doc comment above. `workers/import-retention.ts`
    // owns this table end-to-end (it also deletes the job's
    // object-storage files and marks `filesDeletedAt`, neither of which
    // `runRetentionSweep` can do), but resolves its per-project window
    // through this SAME entry via `resolveProjectPolicyWindowDays`, so
    // "how many days" has one source of truth even though "what to do
    // once expired" does not.
    //
    // Ages on `finishedAt` (when the job reached a terminal state), not
    // `createdAt` — a long-running job must never be swept mid-flight
    // just because it was CREATED long ago; see
    // `listImportJobsEligibleForFileRetention`'s own doc comment for the
    // full status-eligibility rules (VERIFICATION_INCOMPLETE/VERIFYING
    // are never eligible regardless of age).
    //
    // `minimumDays` reuses `IMPORT_FILE_RETENTION_DAYS` — the exact
    // number this table used as an unconditional constant before this
    // task — as the FLOOR, not a fixed value: before Task 6, every
    // project's import files were deleted after exactly 7 days
    // regardless of tier or self-host status. Under the registry's
    // general rule, a project with no billing tier and no override for
    // "import_jobs" now resolves NO window at all and keeps its files
    // indefinitely, same as every other table here — a self-hosted
    // deployment opts in with an override, it is not defaulted into one.
    // A tiered project's window can now run well past 7 days (up to the
    // tier's `retentionDays` — 1825 for enterprise), trading the
    // previous fixed privacy deadline for consistency with how long that
    // project's tier already promises to keep its other data. Documented
    // plainly on the guide page rather than left for an operator to
    // discover by reading source.
    table: "import_jobs",
    timestampColumn: "finishedAt",
    strategy: "EXTERNAL_WORKER",
    tierLimitField: "retentionDays",
    minimumDays: IMPORT_FILE_RETENTION_DAYS,
  },
] as const;

export function findRetentionPolicy(
  table: string,
): RetentionPolicy | undefined {
  return RETENTION_POLICIES.find((policy) => policy.table === table);
}
