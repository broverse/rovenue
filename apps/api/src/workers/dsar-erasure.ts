import { Worker, type Job } from "bullmq";
import type { ClickHouseClient } from "@clickhouse/client";
import { drizzle, type Db } from "@rovenue/db";
import { createBullConnection } from "../lib/redis";
import { logger } from "../lib/logger";
import { audit, type AuditEntry, type AuditTx } from "../lib/audit";
import { dsarErasureCompletedTotal, dsarErasureSkippedTotal } from "../lib/metrics";
import { getClickHouseClient, isClickHouseConfigured } from "../lib/clickhouse";
import * as importStore from "../lib/import-store";
import {
  anonymizeSubscriber,
  type AnonymizeSubscriberInput,
} from "../services/gdpr/anonymize-subscriber";
import {
  DSAR_ERASURE_QUEUE_NAME,
  DSAR_ERASURE_JOB_NAME,
  type DsarJobData,
} from "../queues/dsar";

// =============================================================
// DSAR erasure worker (ROADMAP §9.1, Task 5)
// =============================================================
//
// Consumes `DSAR_ERASURE_QUEUE_NAME` (see queues/dsar.ts for why export
// and erasure sit on two separate queues — a backlog of heavy exports
// must never delay erasure, which carries a statutory deadline export
// does not). One job = one `dsar_requests` ERASURE row.
//
// Ruling C: ClickHouse is a DERIVED analytics store, not the book of
// record — the real financial records live in Stripe/Apple/Google and
// in Postgres's append-only `credit_ledger`, so deleting rows in
// ClickHouse destroys nobody's tax or accounting evidence. But leaving
// them keyed to a subscriber's stable pseudonym is not erasure either:
// Postgres stores that same value as `subscribers.appUserId` after
// anonymisation, so the link between the pseudonym and any retained
// ClickHouse row would be trivially re-established. Erasure therefore
// has THREE parts, and all three must complete before the request is
// COMPLETED (Finding 1, roadmap-9a final fix wave, added part 2 below —
// the original two-part version shipped without it, which is exactly
// what that finding described: an EXPORT artifact written before erasure
// contains the same appUserId/attributes/purchases/credit_ledger erasure
// exists to remove, and nothing was ever deleting it):
//
//   1. Postgres anonymisation (`anonymizeSubscriber`) — replaces
//      `appUserId` with a deterministic HMAC token, clears attributes,
//      and stamps `deletedAt`. The subscriber row's OWN id
//      (`subscribers.id`, i.e. this job's `subscriberId`) is NEVER
//      changed by this step — which is exactly why it is safe to run
//      the export-artifact purge and the ClickHouse purge (parts 2 and
//      3) keyed on that same id, in any order relative to part 1.
//   2. Export-artifact purge (`purgeSubscriberExportArtifacts`) — every
//      COMPLETED EXPORT `dsar_requests` row for this subscriber that
//      still has a live `artifactKey` gets that object deleted from
//      storage, then the row's `artifactKey`/`expiresAt` are nulled so
//      `GET /v1/dsar/:id/download` can never serve it again (see
//      packages/db's `findCompletedExportArtifactsForSubscriber` /
//      `invalidateExportArtifacts`). `anonymizeSubscriber` never touches
//      `purchases`/`subscriberAccess`/`creditLedger` — a prior export's
//      artifact is the only place a subject's full history could
//      otherwise outlive this worker.
//   3. ClickHouse purge (`purgeSubscriberFromClickHouseTables`) —
//      issues `ALTER TABLE ... DELETE WHERE subscriberId = ?` against
//      every STORED ClickHouse table that carries a plain, queryable
//      subscriberId column, then POLLS `system.mutations` until every
//      mutation reports `is_done`, bounded by ONE deadline shared across
//      all of them (`DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS`,
//      packages/db's dsar-requests.ts — see that file for why it lives
//      there) — not a fresh budget per table. ClickHouse mutations
//      are asynchronous — submitting one only *schedules* the delete,
//      it does not perform it — so marking the request COMPLETED on
//      submission would be a false promise: a request record that
//      claims erasure while rows are still physically present is worse
//      than no record, because it is documentary evidence of a promise
//      that was not kept.
//
// Ordering: Postgres FIRST, export-artifact purge SECOND, ClickHouse
// THIRD. Postgres holds the compliance-critical part of erasure
// (identity) and this deployment's Postgres is always present; ClickHouse
// is a derived store that some self-host deployments may not run at all
// in early bring-up, so the `isClickHouseConfigured()` guard below fails
// the WHOLE job closed (never silently "succeeds" by skipping the purge)
// before Postgres is touched, matching workers/dsar-export.ts's
// fail-closed treatment of `isStorageConfigured()`. The export-artifact
// purge gets the SAME fail-closed treatment, but only conditionally:
// object storage is required ONLY when this subscriber actually has a
// completed export artifact to delete — a subscriber who never exported
// must not have their erasure blocked by storage being unconfigured in a
// deployment that has simply never used DSAR export. If ANY part fails or
// times out after an earlier part has already succeeded, the job is
// marked FAILED (never COMPLETED) and a retry is safe: `anonymizeSubscriber`
// is idempotent (same deterministic token, plain re-set of the same
// columns), the export-artifact purge re-queries fresh state each run (an
// already-nulled row's artifact was already deleted, so it is simply not
// found again), a storage DELETE on an already-deleted key is itself
// idempotent (S3-compatible semantics), and re-submitting the same
// `ALTER ... DELETE` against already-purged ClickHouse rows matches zero
// rows and is a no-op.
//
// -----------------------------------------------------------------
// The ClickHouse table list — established by reading every migration
// in packages/db/clickhouse/migrations, not by assuming the two named
// in the task spec (raw_revenue_events, raw_credit_ledger) were
// complete. They were NOT: three more STORED tables carry a plain
// subscriberId column and are still live at HEAD (migration 0024):
//
//   INCLUDED (STORED MergeTree-family tables with a plain, queryable
//   subscriberId String column at rest):
//     - raw_exposures              (0002, ReplacingMergeTree)
//     - raw_revenue_events         (0004, ReplacingMergeTree)
//     - raw_credit_ledger          (0005, ReplacingMergeTree)
//     - raw_sdk_session_events     (0009, ReplacingMergeTree)
//     - raw_paywall_events         (0017, ReplacingMergeTree)
//
//   EXCLUDED — Kafka Engine tables (exposures_queue, revenue_queue,
//   credit_queue, sdk_session_events_queue, paywall_events_queue):
//   these store NOTHING at rest, only a consumer offset into Redpanda;
//   there is no row to delete.
//
//   EXCLUDED — materialized VIEW definitions (mv_exposures_to_raw,
//   mv_revenue_to_raw, mv_credit_to_raw, mv_sdk_sessions_to_raw,
//   mv_paywall_events_to_raw, mv_paywall_daily): a `MATERIALIZED VIEW
//   ... TO <target>` is an INSERT trigger, not storage — every row it
//   ever produced lives in its TO target, which is either in the
//   INCLUDED list above or explicitly excluded below.
//
//   EXCLUDED — query-time VIEWs (v_mrr_daily, v_credit_consumption_daily,
//   v_credit_balance, v_revenue_lifetime_subscriber, v_sdk_sessions_daily,
//   v_sdk_sessions_lifetime_subscriber): stateless SELECTs over the raw
//   ReplacingMergeTree tables (most `... FINAL`), introduced by
//   migrations 0012/0016 specifically to make revenue/credit/session
//   aggregates idempotent under outbox replay. They store no rows of
//   their own — purging the raw tables above erases them transitively,
//   automatically, on the very next query.
//
//   EXCLUDED — mv_paywall_daily_target (0018, kept live by 0022): a
//   STORED SummingMergeTree target table, so it looks like a candidate
//   at first glance, but its schema is
//     (projectId, placementId, paywallId, variantId, day, views,
//      subscribersHll AggregateFunction(uniq, String))
//   — there is no plain subscriberId column here at all. The only
//   subscriber-related data is folded into `subscribersHll`, a
//   HyperLogLog-family sketch state that MANY subscribers contribute
//   to per (placementId, paywallId, variantId, day) group. ClickHouse's
//   `uniq`/`uniqState` implementation gives no operation to subtract
//   one input's contribution from an already-merged sketch — it is not
//   invertible — so there is no `ALTER ... DELETE` that could remove
//   one subscriber's fingerprint from it even in principle, and reading
//   the sketch back can only ever answer "how many distinct
//   subscribers", never "which ones". It does not "re-establish the
//   link" Ruling C worries about: a stable pseudonym can be read out
//   and re-linked; a merged HLL state cannot.
//
//   EXCLUDED — DROPPED tables that no longer exist at HEAD, superseded
//   by the query-time views above: mv_mrr_daily_target,
//   mv_credit_balance_target, mv_credit_consumption_daily_target,
//   revenue_lifetime_subscriber_tbl (all dropped by migration 0012),
//   sdk_sessions_daily_tbl (dropped by 0016), and
//   mv_experiment_daily_target (dropped by 0022, unread by anything).
//
// Order within DSAR_ERASURE_CLICKHOUSE_TABLES is the order each table
// was introduced in the migration chain (0002, 0004, 0005, 0009,
// 0017); the five tables are independent of one another (no table's
// mutation depends on another's having finished), so all five deletes
// are SUBMITTED up front and then WAITED FOR, rather than
// submit-then-wait-one-at-a-time — letting ClickHouse's background
// mutation executor work on all five concurrently instead of forcing
// them to complete strictly in sequence.
//
// Fix Round 2: the WAIT below used to give each table its own
// independent `DSAR_ERASURE_MUTATION_WAIT_TIMEOUT_MS` (60s) budget, so
// the strict worst case scaled with the table count — 5 x 60s = 300s,
// exactly `DSAR_CLAIM_STALE_RUNNING_MS` with zero margin, and a sixth
// table would have silently pushed it past that threshold again. The
// five waits below now share ONE deadline
// (`DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS`), computed once
// before the loop, so the worst case is fixed regardless of how many
// tables this worker ever purges.
//
// Every state change the row goes through is audited, same convention
// as dsar-export.ts: PENDING -> RUNNING on claim, then RUNNING ->
// COMPLETED or RUNNING -> FAILED on the terminal outcome. This is
// separate from `anonymizeSubscriber`'s own "subscriber.anonymized"
// audit row, which records the underlying Postgres write, not the
// request record's lifecycle.

const log = logger.child("worker:dsar-erasure");

// -------------------------------------------------------------
// Constants (no magic values)
// -------------------------------------------------------------

export const DSAR_ERASURE_CLICKHOUSE_DATABASE = "rovenue";

/**
 * The complete, deliberately-enumerated list of STORED (MergeTree
 * family) ClickHouse tables that carry a plain, queryable subscriberId
 * column at rest. See the module doc above for the full
 * inclusion/exclusion audit of every table in
 * packages/db/clickhouse/migrations.
 *
 * A structured list of table names is not a "magic value" in the sense
 * CLAUDE.md warns about (a bare literal standing in for an unnamed
 * business rule) — it IS the named constant: the one place this
 * worker's erasure scope is declared, so a new subscriber-scoped
 * ClickHouse table added later has exactly one list to update.
 */
export const DSAR_ERASURE_CLICKHOUSE_TABLES = [
  "raw_exposures",
  "raw_revenue_events",
  "raw_credit_ledger",
  "raw_sdk_session_events",
  "raw_paywall_events",
] as const;

// Poll interval for `system.mutations.is_done`. 500ms keeps the total
// number of polls modest against the total wait budget
// (`DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS`, imported below from
// packages/db — see that file's dsar-requests.ts for why it is owned
// there) while staying well under any latency a caller would notice. A
// timeout always resolves to FAILED (never a silent COMPLETED), so a
// customer is never told erasure succeeded while rows are still
// physically present.
export const DSAR_ERASURE_MUTATION_POLL_INTERVAL_MS = 500;

// Re-exported under this worker's own name for readability at call
// sites in this file and its tests — the VALUE is owned by
// packages/db's dsar-requests.ts (`DSAR_CLAIM_STALE_RUNNING_MS` derives
// from that same constant), so this is an alias, never a second
// definition that could drift from it.
export const DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS =
  drizzle.dsarRequestRepo.DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS;

// dsarErasureSkippedTotal reason labels.
const SKIP_REASON_RACE = "race";
const SKIP_REASON_CLICKHOUSE_UNCONFIGURED = "clickhouse-unconfigured";
// Finding 1 (roadmap-9a final fix wave): the subscriber has at least one
// completed export artifact, but export storage is unconfigured, so
// erasure cannot verify it deleted them. Distinct from
// SKIP_REASON_CLICKHOUSE_UNCONFIGURED so the two independent stores this
// worker depends on are distinguishable in metrics.
const SKIP_REASON_EXPORT_STORAGE_UNCONFIGURED = "export-storage-unconfigured";
const SKIP_REASON_ERROR = "error";

/**
 * Thrown ONLY by `purgeSubscriberExportArtifacts` when it finds at least
 * one export artifact to purge but export storage is unconfigured. The
 * catch block in `runDsarErasure` below matches this with `instanceof`
 * to choose `SKIP_REASON_EXPORT_STORAGE_UNCONFIGURED`, never by
 * pattern-matching the thrown message: a message match would silently
 * degrade to `SKIP_REASON_ERROR` the moment anyone edited this class's
 * message text.
 *
 * A bare `deps.isExportStorageConfigured()` re-check in the catch block
 * — the sibling `isClickHouseConfigured()` pattern just above — would
 * NOT be correct here, unlike for ClickHouse: `isClickHouseConfigured()`
 * is checked unconditionally at the very top of this function, before
 * any other step runs, so re-reading it in the catch always reflects
 * why THIS run failed. `isExportStorageConfigured()` is checked only
 * conditionally, inside `purgeSubscriberExportArtifacts`, and only when
 * that function finds at least one artifact to purge — so a bare
 * re-check could be false (storage genuinely unconfigured) while some
 * unrelated step (e.g. `anonymizeSubscriber`) is what actually threw.
 * A typed error tied to the one throw site avoids that false positive.
 */
class ExportStorageUnconfiguredError extends Error {}

// The worker has no dashboard session to attribute audit rows or the
// underlying `anonymizeSubscriber` write to — mirrors dsar-export.ts's
// `SYSTEM_ACTOR`.
const SYSTEM_ACTOR = "system";

// A self-service DSAR erasure carries no admin-asserted jurisdiction
// (dsar_requests has no jurisdiction column) and is not an automated
// retention sweep, so it gets its own AnonymizeReason distinct from
// the dashboard's "gdpr_request" / "kvkk_request" (an admin's own
// choice) and from "retention_policy" (workers/retention-sweep.ts).
const ANONYMIZE_REASON: AnonymizeSubscriberInput["reason"] = "dsar_request";

export type DsarErasureOutcome =
  | { outcome: "completed" }
  | { outcome: "skipped_race" }
  | { outcome: "failed"; error: string };

interface MutationWaitOptions {
  /**
   * Absolute deadline (`Date.now()`-based ms), computed ONCE per
   * `purgeSubscriberFromClickHouseTables` call and shared across every
   * table's `waitForMutation` — never a fresh budget per table. See
   * that function and packages/db's dsar-requests.ts for why a shared
   * deadline is the fix, not just a bigger per-table number.
   */
  deadline: number;
  pollIntervalMs: number;
}

interface MutationStatusRow {
  is_done: number | string;
  latest_fail_reason: string;
}

/**
 * Polls `system.mutations` for one table's most recently submitted
 * erasure mutation until it reports `is_done`, bounded by
 * `options.deadline` — an absolute point in time shared with every
 * OTHER table waited on in the same purge, not a fresh budget of its
 * own. Never resolves early on a guess — a timeout always throws, which
 * the caller turns into a FAILED request, never a COMPLETED one.
 *
 * Mutations are matched by `command LIKE '%<subscriberId>%'` rather
 * than by tracking a query id: ClickHouse's HTTP `query_id` is not the
 * same identifier as `system.mutations.mutation_id`, and there is no
 * client-side handle that links the two. `subscriberId` is a cuid2
 * (our own trusted, alphanumeric-only id — never raw external input),
 * so it can never collide with ClickHouse's `%`/`_` LIKE wildcards,
 * and because ClickHouse resolves `{subscriberId:String}` query
 * parameters to their literal value before the mutation is recorded,
 * the submitted DELETE's own subscriberId always appears verbatim in
 * `system.mutations.command`.
 */
async function waitForMutation(
  ch: ClickHouseClient,
  table: string,
  subscriberId: string,
  options: MutationWaitOptions,
): Promise<void> {
  for (;;) {
    const result = await ch.query({
      query: `
        SELECT is_done, latest_fail_reason
        FROM system.mutations
        WHERE database = {database:String}
          AND table = {table:String}
          AND command LIKE {pattern:String}
        ORDER BY create_time DESC
        LIMIT 1
      `,
      query_params: {
        database: DSAR_ERASURE_CLICKHOUSE_DATABASE,
        table,
        pattern: `%${subscriberId}%`,
      },
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as MutationStatusRow[];
    const row = rows[0];
    if (row && Number(row.is_done) === 1) {
      if (row.latest_fail_reason) {
        throw new Error(
          `ClickHouse erasure mutation failed on ${DSAR_ERASURE_CLICKHOUSE_DATABASE}.${table}: ${row.latest_fail_reason}`,
        );
      }
      return;
    }
    if (Date.now() >= options.deadline) {
      throw new Error(
        `ClickHouse erasure mutation on ${DSAR_ERASURE_CLICKHOUSE_DATABASE}.${table} did not finish within the shared ClickHouse purge budget (deadline ${new Date(options.deadline).toISOString()})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
}

export interface ClickHousePurgeOptions {
  /**
   * TOTAL wait budget for this purge, shared across every table in
   * `DSAR_ERASURE_CLICKHOUSE_TABLES` — NOT a per-table allotment. This
   * is Fix Round 2's actual fix: previously each table got its own
   * full `DSAR_ERASURE_MUTATION_WAIT_TIMEOUT_MS`, so the worst case
   * scaled linearly with the table count (5 x 60s = 300s, exactly
   * `DSAR_CLAIM_STALE_RUNNING_MS` with zero margin). A single shared
   * budget means a sixth table can never push the worst case past this
   * one constant.
   */
  totalBudgetMs: number;
  pollIntervalMs: number;
}

/**
 * Submits `ALTER TABLE ... DELETE WHERE subscriberId = ?` against
 * every table in `DSAR_ERASURE_CLICKHOUSE_TABLES`, then waits for
 * every submitted mutation to finish against ONE shared deadline. See
 * the module doc for why all five are submitted up front rather than
 * one at a time, and why "submitted" is never treated as "complete".
 */
export async function purgeSubscriberFromClickHouseTables(
  subscriberId: string,
  options: ClickHousePurgeOptions = {
    totalBudgetMs: DSAR_ERASURE_CLICKHOUSE_PURGE_TOTAL_BUDGET_MS,
    pollIntervalMs: DSAR_ERASURE_MUTATION_POLL_INTERVAL_MS,
  },
): Promise<void> {
  const ch = getClickHouseClient();

  for (const table of DSAR_ERASURE_CLICKHOUSE_TABLES) {
    await ch.command({
      query: `ALTER TABLE ${DSAR_ERASURE_CLICKHOUSE_DATABASE}.${table} DELETE WHERE subscriberId = {subscriberId:String}`,
      query_params: { subscriberId },
    });
  }

  // ONE deadline, computed ONCE here, shared by every waitForMutation
  // call below — this is what makes options.totalBudgetMs a TOTAL
  // rather than a per-table timeout. Each wait is bounded by whatever
  // of the budget remains when its turn comes, not by a fresh
  // allotment of its own.
  const deadline = Date.now() + options.totalBudgetMs;
  for (const table of DSAR_ERASURE_CLICKHOUSE_TABLES) {
    await waitForMutation(ch, table, subscriberId, {
      deadline,
      pollIntervalMs: options.pollIntervalMs,
    });
  }
}

/**
 * Finding 1 (roadmap-9a final fix wave), part 2 of erasure's three parts
 * (see module doc): deletes every COMPLETED EXPORT artifact this
 * subscriber has from storage, then nulls the owning `dsar_requests`
 * rows' `artifactKey`/`expiresAt` so `GET /v1/dsar/:id/download` can never
 * serve them again. Storage deletes run OUTSIDE any DB transaction (this
 * repo's convention: storage writes never run inside one); the DB write
 * that invalidates the rows runs in its own transaction only AFTER every
 * delete has resolved, so a crash mid-loop leaves some artifacts already
 * gone from storage but their rows not yet nulled — safe, because the
 * download route independently probes `importStore.objectExists` before
 * streaming (dsar.ts) and because a retry of this same function re-reads
 * fresh state and only re-deletes rows still pointing at a live
 * artifactKey (an idempotent no-op for ones already nulled, and an
 * idempotent no-op storage delete for a key already gone).
 *
 * Object storage is required ONLY when there is at least one artifact to
 * delete — `deps.isStorageConfigured` is checked for real here (never
 * assumed), exactly like `workers/dsar-export.ts`'s own fail-closed
 * check, but conditionally: a subscriber who never ran a DSAR export must
 * not have their erasure blocked by storage being unconfigured in a
 * deployment that has simply never used DSAR export at all.
 */
async function purgeSubscriberExportArtifacts(
  subscriberId: string,
  deps: Pick<
    DsarErasureDeps,
    | "findCompletedExportArtifacts"
    | "deleteExportArtifact"
    | "isExportStorageConfigured"
    | "invalidateExportArtifacts"
    | "transaction"
  >,
): Promise<void> {
  const artifacts = await deps.findCompletedExportArtifacts(subscriberId);
  if (artifacts.length === 0) return;

  if (!deps.isExportStorageConfigured()) {
    throw new ExportStorageUnconfiguredError(
      "DSAR export storage is not configured — refusing to complete erasure while a prior export artifact for this subscriber may still be downloadable",
    );
  }

  for (const artifact of artifacts) {
    await deps.deleteExportArtifact(artifact.artifactKey);
  }

  await deps.transaction((tx) =>
    deps.invalidateExportArtifacts(
      tx,
      artifacts.map((a) => a.id),
    ),
  );
}

export interface DsarErasureDeps {
  claimDsarRequest: typeof drizzle.dsarRequestRepo.claimDsarRequest;
  completeDsarRequest: typeof drizzle.dsarRequestRepo.completeDsarRequest;
  failDsarRequest: typeof drizzle.dsarRequestRepo.failDsarRequest;
  anonymizeSubscriber: (
    input: AnonymizeSubscriberInput,
  ) => Promise<{ anonymousId: string; deletedAt: Date }>;
  // Finding 1 (roadmap-9a final fix wave), erasure's part 2 — see
  // `purgeSubscriberExportArtifacts` above and the module doc.
  findCompletedExportArtifacts: (
    subscriberId: string,
  ) => ReturnType<typeof drizzle.dsarRequestRepo.findCompletedExportArtifactsForSubscriber>;
  deleteExportArtifact: typeof importStore.deleteObject;
  isExportStorageConfigured: typeof importStore.isStorageConfigured;
  invalidateExportArtifacts: typeof drizzle.dsarRequestRepo.invalidateExportArtifacts;
  isClickHouseConfigured: typeof isClickHouseConfigured;
  purgeSubscriberFromClickHouse: (subscriberId: string) => Promise<void>;
  audit: (entry: AuditEntry, tx?: AuditTx) => Promise<void>;
  // Every DB write this worker makes is paired with its own audit row
  // in the SAME transaction (CLAUDE.md: "audit() runs inside the
  // caller's Drizzle tx"). The ClickHouse purge sits OUTSIDE every
  // Postgres transaction on purpose — an HTTP call to ClickHouse
  // cannot participate in one — which is exactly why the ordering
  // guarantee is enforced by the CODE PATH (anonymize, then purge,
  // then a single atomic claim/complete/fail + audit transaction)
  // rather than by a database transaction spanning both stores.
  transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
}

export const defaultDeps: DsarErasureDeps = {
  claimDsarRequest: drizzle.dsarRequestRepo.claimDsarRequest,
  completeDsarRequest: drizzle.dsarRequestRepo.completeDsarRequest,
  failDsarRequest: drizzle.dsarRequestRepo.failDsarRequest,
  anonymizeSubscriber,
  findCompletedExportArtifacts: (subscriberId) =>
    drizzle.dsarRequestRepo.findCompletedExportArtifactsForSubscriber(
      drizzle.db,
      subscriberId,
    ),
  deleteExportArtifact: importStore.deleteObject,
  isExportStorageConfigured: importStore.isStorageConfigured,
  invalidateExportArtifacts: drizzle.dsarRequestRepo.invalidateExportArtifacts,
  isClickHouseConfigured,
  purgeSubscriberFromClickHouse: (subscriberId) =>
    purgeSubscriberFromClickHouseTables(subscriberId),
  audit,
  transaction: (fn) => drizzle.db.transaction((tx) => fn(tx as unknown as Db)),
};

/**
 * Pure, directly-testable body — no BullMQ types cross this boundary.
 * See the module doc above for the three-part ordering this function
 * exists to enforce.
 */
export async function runDsarErasure(
  jobData: DsarJobData,
  deps: DsarErasureDeps = defaultDeps,
): Promise<DsarErasureOutcome> {
  const { dsarRequestId, projectId, subscriberId } = jobData;

  // Claim + its audit row in ONE transaction: a crash between the two
  // must never leave a RUNNING row with no record of who/what claimed
  // it, and must never leave an audit row for a claim that didn't
  // actually commit.
  const claimed = await deps.transaction(async (tx) => {
    const row = await deps.claimDsarRequest(tx, dsarRequestId);
    if (!row) return null;
    await deps.audit(
      {
        projectId,
        userId: SYSTEM_ACTOR,
        action: "dsar_request.claimed",
        resource: "dsar_request",
        resourceId: dsarRequestId,
        before: { status: "PENDING" },
        after: { status: "RUNNING" },
        ipAddress: null,
        userAgent: null,
      },
      tx as unknown as AuditTx,
    );
    return row;
  });

  if (!claimed) {
    dsarErasureSkippedTotal.inc({ reason: SKIP_REASON_RACE });
    log.info("dsar erasure: claim lost, another replica already has this row", {
      dsarRequestId,
    });
    return { outcome: "skipped_race" };
  }

  try {
    // Fail CLOSED before touching Postgres — checked for real, never
    // assumed. ClickHouse is a required env var in production
    // (CLAUDE.md), but a self-host bring-up may still have it blank; a
    // request record that claims erasure while ClickHouse rows remain
    // untouched is worse than no record at all.
    if (!deps.isClickHouseConfigured()) {
      throw new Error(
        "ClickHouse is not configured — refusing to mark erasure complete without purging analytics",
      );
    }

    // 1. Postgres — the compliance-critical part. `subscriberId` (the
    //    row's own id) is unchanged by this call, which is exactly why
    //    parts 2 and 3 below can key on the same value regardless of
    //    order.
    await deps.anonymizeSubscriber({
      subscriberId,
      projectId,
      actorUserId: SYSTEM_ACTOR,
      reason: ANONYMIZE_REASON,
    });

    // 2. Export artifacts (Finding 1, roadmap-9a final fix wave) — every
    //    COMPLETED EXPORT this subscriber ever produced gets its object
    //    deleted from storage and its row's artifactKey/expiresAt nulled.
    //    `anonymizeSubscriber` never touches purchases/subscriberAccess/
    //    creditLedger, so a prior export's artifact is the one place a
    //    subject's full history could otherwise outlive this worker.
    await purgeSubscriberExportArtifacts(subscriberId, deps);

    // 3. ClickHouse — submit every table's DELETE, then wait for every
    //    mutation to actually finish. Throws (never returns early) on
    //    a mutation failure or a bounded-wait timeout.
    await deps.purgeSubscriberFromClickHouse(subscriberId);

    await deps.transaction(async (tx) => {
      await deps.completeDsarRequest(tx, {
        id: dsarRequestId,
        artifactKey: null,
        expiresAt: null,
      });
      await deps.audit(
        {
          projectId,
          userId: SYSTEM_ACTOR,
          action: "dsar_request.erasure_completed",
          resource: "dsar_request",
          resourceId: dsarRequestId,
          before: { status: "RUNNING" },
          after: { status: "COMPLETED" },
          ipAddress: null,
          userAgent: null,
        },
        tx as unknown as AuditTx,
      );
    });

    dsarErasureCompletedTotal.inc();
    log.info("dsar erasure completed", { dsarRequestId, projectId });
    return { outcome: "completed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isClickHouseUnconfigured = !deps.isClickHouseConfigured();
    // Matched by type (`ExportStorageUnconfiguredError`, thrown only by
    // `purgeSubscriberExportArtifacts`) rather than re-checking
    // `isExportStorageConfigured()` here — see that class's doc comment
    // for why a bare predicate re-check would be wrong for this one
    // (unlike the `isClickHouseConfigured()` sibling above) — and rather
    // than matching the thrown message, which would silently degrade to
    // `SKIP_REASON_ERROR` if the message text ever changed.
    const isExportStorageUnconfigured = err instanceof ExportStorageUnconfiguredError;

    await deps.transaction(async (tx) => {
      await deps.failDsarRequest(tx, dsarRequestId, message);
      await deps.audit(
        {
          projectId,
          userId: SYSTEM_ACTOR,
          action: "dsar_request.erasure_failed",
          resource: "dsar_request",
          resourceId: dsarRequestId,
          before: { status: "RUNNING" },
          after: { status: "FAILED", error: message },
          ipAddress: null,
          userAgent: null,
        },
        tx as unknown as AuditTx,
      );
    });

    dsarErasureSkippedTotal.inc({
      reason: isClickHouseUnconfigured
        ? SKIP_REASON_CLICKHOUSE_UNCONFIGURED
        : isExportStorageUnconfigured
          ? SKIP_REASON_EXPORT_STORAGE_UNCONFIGURED
          : SKIP_REASON_ERROR,
    });
    log.error("dsar erasure failed", { dsarRequestId, projectId, err: message });
    return { outcome: "failed", error: message };
  }
}

// =============================================================
// BullMQ worker
// =============================================================

let cachedWorker: Worker<DsarJobData> | undefined;

export function createDsarErasureWorker(): Worker<DsarJobData> {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker<DsarJobData>(
    DSAR_ERASURE_QUEUE_NAME,
    async (job: Job<DsarJobData>) => {
      return runDsarErasure(job.data);
    },
    {
      connection: createBullConnection("dsar-erasure"),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("dsar erasure job failed", {
      jobId: job?.id,
      dsarRequestId: job?.data?.dsarRequestId,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  return cachedWorker;
}

/** Single entry point for boot wiring (apps/api/src/index.ts). */
export function ensureDsarErasureWorker(): void {
  createDsarErasureWorker();
  log.info("dsar erasure worker started", { queue: DSAR_ERASURE_QUEUE_NAME });
}

// Re-exported so callers of this worker file don't also need to import
// from queues/dsar.ts for the one constant they need (the task brief's
// "Produces" list names this alongside runDsarErasure/ensureDsarErasureWorker).
export { DSAR_ERASURE_JOB_NAME, DSAR_ERASURE_QUEUE_NAME };
