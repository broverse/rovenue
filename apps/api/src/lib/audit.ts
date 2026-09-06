import type { Context } from "hono";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import {
  canonicalJSON,
  hashAuditRow,
  type AuditChainPayload,
} from "@rovenue/shared/audit-chain";
import { logger } from "./logger";

// =============================================================
// Audit log — tamper-evident, append-only
// =============================================================
//
// Every dashboard mutation writes an immutable row with a
// Merkle-style SHA-256 `rowHash` computed over the canonical JSON
// of the entry plus the previous row's hash. A per-project chain
// gives compliance auditors a verifiable ordering: any broken or
// altered link surfaces through `verifyAuditChain()`.
//
// Writes are serialized per project via `pg_advisory_xact_lock`,
// so two concurrent `audit()` calls for the same project can't
// race on prevHash lookup. Callers can pass their own Drizzle tx
// (inside a larger `drizzle.db.transaction(...)`) so a rollback
// removes the audit row alongside the rest of the operation.

const log = logger.child("audit");

const { auditLogs } = drizzle.schema;

// =============================================================
// Action / resource enums
// =============================================================

export type AuditAction =
  // --- generic CRUD ---
  | "create"
  | "update"
  | "delete"
  // --- project ---
  | "project.created"
  | "project.updated"
  | "project.deleted"
  // --- api key ---
  | "api_key.created"
  | "api_key.revoked"
  | "api_key.allowed_origins_updated"
  // --- credentials ---
  | "credential.updated"
  | "credential.cleared"
  // --- stripe connect ---
  | "stripe.connected"
  | "stripe.disconnected"
  // --- gdpr ---
  | "subscriber.erased_revenue_received"
  // --- product / group ---
  | "product.created"
  | "product.updated"
  | "product.deleted"
  | "product_group.created"
  | "product_group.updated"
  // --- experiment ---
  | "start"
  | "pause"
  | "resume"
  | "stop"
  | "duplicate"
  | "experiment.started"
  | "experiment.stopped"
  // Written when a DRAFT experiment is deleted while another experiment's
  // `startAfterExperimentId` points at it: the FK's ON DELETE SET NULL
  // clears that column silently at the DB level, so this is the only
  // durable record that the successor's dependency was severed by a
  // deletion (vs. never having had one) — the read-time "blocked" check
  // (experiment-create.ts `computeSchedulingBlocked`) keys off it.
  | "experiment.predecessor_deleted"
  // --- feature flag ---
  | "toggle"
  // --- subscriber manual ops ---
  | "subscriber.access_granted"
  | "subscriber.credits_added"
  | "subscriber.anonymized"
  | "subscriber.exported"
  // --- subscription manual ops ---
  | "subscription.granted"
  | "subscription.cancel_scheduled"
  | "subscription.schedule_canceled"
  | "subscription.cancel_executed"
  | "subscription.cancel_failed"
  | "subscription.transition_rejected"
  // Written by the Google reconciliation sweep (Task 5, §6) when a live
  // Play Developer API check finds the purchase's real state has drifted
  // from ours — the RTDN that should have reported it was lost. Distinct
  // from `subscription.transition_rejected`: that one records a write the
  // state machine refused; this one records a write the sweep DID apply,
  // attributed to "system" rather than a user.
  | "subscription.reconciled"
  | "subscriptions.exported"
  // --- metrics ---
  | "metrics.exported"
  // --- store commission rates (proceeds) ---
  | "commission_rate.updated"
  | "commission_rate.deleted"
  // --- members ---
  | "member.invited"
  | "member.role_changed"
  | "member.removed"
  | "member.left"
  | "member.ownership_transferred"
  // --- invitations ---
  | "invitation.created"
  | "invitation.revoked"
  | "invitation.resent"
  | "invitation.accepted"
  // --- billing ---
  | "billing.subscription.activated"
  // --- funnels ---
  | "funnel.created"
  | "funnel.updated"
  | "funnel.archived"
  | "funnel.duplicated"
  | "funnel.published"
  | "funnel.reverted"
  | "funnel.from_template"
  // --- paywalls ---
  | "paywall.published"
  | "paywall.reverted"
  | "paywall.draft_discarded"
  | "paywall.version_labeled"
  // --- custom domains ---
  | "custom_domain.created"
  | "custom_domain.verified"
  | "custom_domain.verify_failed"
  | "custom_domain.deleted"
  // --- integrations ---
  | "integration.connection.created"
  | "integration.connection.updated"
  | "integration.connection.deleted"
  | "integration.credentials.rotated"
  | "integration.webhook.secret.rotated"
  | "integration.webhook.secret.revealed"
  | "integration.delivery.dead_letter"
  | "integration.delivery.redelivered"
  | "integration.test_event.sent"
  | "integration.backfill.started"
  | "integration.backfill.completed"
  // --- refund shield ---
  | "refund_shield.settings.updated"
  | "refund_shield.response.sent"
  | "refund_shield.response.failed"
  // --- merchant-initiated refunds ---
  | "transaction.refunded"
  | "subscription.refunded"
  // --- virtual currencies ---
  | "virtual_currency.created"
  | "virtual_currency.renamed"
  | "virtual_currency.archived"
  // --- paywall fonts ---
  | "font.uploaded"
  | "font.deleted"
  // --- paywall assets (CDN) ---
  | "asset.uploaded"
  | "asset.deleted"
  // --- data import (design spec §4) ---
  | "import.started"
  | "import.completed"
  // --- data import job lifecycle (Task 10) ---
  | "import.mapping_updated"
  | "import.dry_run_started"
  | "import.commit_started"
  | "import.cancelled"
  | "import.resumed"
  // --- final-fix-wave FIX 6: sandbox/anchorless opt-in actually wired ---
  | "import.options_updated"
  // --- entitlement drift reconciler (workers/access-reconciliation.ts) ---
  // Written once per subscriber whose `subscriber_access` rows the sweep
  // rewrote. `resource` is "subscriber"; before/after carry the access
  // row summaries and the drift classes that were detected, so an
  // operator can tell an automated repair apart from a webhook write.
  | "access.drift_repaired"
  // --- leaderboard seasons (workers/leaderboard-scheduler.ts) ---
  | "leaderboard_season.closed"
  // --- retention sweep DROP_PARTITION strategy (workers/retention-sweep.ts) ---
  // Written BEFORE the DDL that drops a credit_ledger/revenue_events
  // partition, never after: a partition drop bypasses the ledger's
  // append-only trigger on every DDL path (row triggers fire on row
  // DML, not DDL), so this row is the only durable record the drop
  // happened at all. A partition holds rows for every project sharing
  // it, so the sweep writes ONE of these into EACH affected project's
  // own chain — not one global row — which is also why this action
  // needed no `projectId`-nullability change here at all. See
  // AUDIT_ACTION_RETENTION_PARTITION_DROPPED.
  | typeof AUDIT_ACTION_RETENTION_PARTITION_DROPPED
  // --- retention sweep CHECKPOINT_TRUNCATE strategy (workers/retention-sweep.ts,
  // services/audit-retention/checkpoint.ts) ---
  // Written AFTER the deleted segment's proof bundle has been stored
  // and its rows deleted, never before: this row's `after` is the only
  // durable record of WHERE the bundle went and WHICH row's hash the
  // surviving chain now chains from. Unlike
  // AUDIT_ACTION_RETENTION_PARTITION_DROPPED, this action is scoped to
  // exactly one project's own audit_logs rows (a hash chain has no
  // shared-partition problem — every row already belongs to exactly
  // one project), so one of these is written per (project, sweep run),
  // never fanned out across projects.
  | typeof AUDIT_ACTION_RETENTION_CHECKPOINT
  // --- DSAR export worker (workers/dsar-export.ts, ROADMAP §9.1 Task 4) ---
  // One row per `dsar_requests` status transition the worker drives:
  // PENDING -> RUNNING on claim, then RUNNING -> COMPLETED or
  // RUNNING -> FAILED on the terminal outcome. `userId` is "system" —
  // this is an asynchronous worker, not a dashboard session. Distinct
  // from "subscriber.exported" (already written by exportSubscriber
  // itself for the underlying data read) — these three describe the
  // REQUEST record's own lifecycle, not the export contents.
  | "dsar_request.claimed"
  | "dsar_request.export_completed"
  | "dsar_request.export_failed"
  // --- DSAR erasure worker (workers/dsar-erasure.ts, ROADMAP §9.1 Task 5) ---
  // Same "claimed" transition as export above (shared literal — both
  // workers use `claimDsarRequest`), plus this worker's own terminal
  // transitions. Distinct from "subscriber.anonymized" (already written
  // by anonymizeSubscriber itself for the underlying Postgres write) —
  // these describe the REQUEST record's own lifecycle, which also
  // covers the ClickHouse purge that anonymizeSubscriber knows nothing
  // about.
  | "dsar_request.erasure_completed"
  | "dsar_request.erasure_failed";

// Exported (not just inlined like this file's other action literals)
// because retention-sweep.ts lives in a different subsystem and needs
// a type-checked reference to this exact string rather than
// retyping the literal at its own call site.
export const AUDIT_ACTION_RETENTION_PARTITION_DROPPED =
  "retention.partition_dropped" as const;

// Exported for the same reason as AUDIT_ACTION_RETENTION_PARTITION_DROPPED
// above — services/audit-retention/checkpoint.ts needs a type-checked
// reference rather than retyping the literal at its call site.
export const AUDIT_ACTION_RETENTION_CHECKPOINT =
  "retention.audit_checkpointed" as const;

export type AuditResource =
  | "audience"
  | "experiment"
  | "feature_flag"
  | "project"
  | "api_key"
  | "product"
  | "product_group"
  | "purchase"
  | "subscriber"
  | "member"
  | "credential"
  | "invitation"
  | "billing_subscription"
  | "funnel"
  | "paywall"
  | "paywall_preview_session"
  | "placement"
  | "custom_domain"
  | "integration_connection"
  | "refund_shield_response"
  | "transaction"
  | "virtual_currency"
  | "font_face"
  | "font_family"
  | "paywall_asset"
  | "import_job"
  | "leaderboard_season"
  // Scoped by projectId; `resourceId` is the store the rate applies to.
  | "commission_rate"
  // A dropped credit_ledger/revenue_events partition affects every
  // project sharing it, so the sweep writes one of these into EACH
  // affected project's own chain (see workers/retention-sweep.ts).
  // `resourceId` is the partition's table name.
  | "retention_partition"
  // One CHECKPOINT_TRUNCATE checkpoint row per (project, sweep run).
  // `resourceId` is the checkpoint's own id — the same id the exported
  // proof bundle's storage key is built from (see
  // services/audit-retention/checkpoint.ts) — so an operator can go
  // straight from the audit row to the bundle it describes.
  | "retention_checkpoint"
  // `resourceId` is the `dsar_requests` row id (workers/dsar-export.ts).
  | "dsar_request";

export interface AuditEntry {
  projectId: string;
  // Null for actions not initiated from a dashboard session — e.g. a
  // Stripe-side webhook revoking a Connect authorization. The column is
  // nullable at the DB level for exactly this case.
  userId: string | null;
  action: AuditAction;
  resource: AuditResource;
  resourceId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function extractRequestContext(c: Context): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  return {
    ipAddress:
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  };
}

// =============================================================
// Tx typing
// =============================================================
//
// Drizzle's transaction callback hands the caller a proxy that
// shares the parent `Db` surface (select/insert/execute). When a
// caller passes their tx, audit() runs the chain write inside it
// so the audit row commits/rolls back atomically with the caller's
// domain row. Without a callerTx, audit() opens its own inner tx
// just for advisory-lock scope.

import type { Db as DrizzleDb } from "@rovenue/db";

export type AuditTx = {
  select: DrizzleDb["select"];
  insert: DrizzleDb["insert"];
  execute: DrizzleDb["execute"];
};

// =============================================================
// Canonical JSON for the hash
// =============================================================
//
// The canonical encoder and the row hash function themselves live in
// `@rovenue/shared/audit-chain` — moved there so an external verifier
// can recompute a hash without importing anything from this server.
// `buildCanonicalPayload` stays here: it's API-side glue mapping an
// `AuditEntry` onto the shared `AuditChainPayload` shape.

function buildCanonicalPayload(
  entry: AuditEntry,
  createdAt: Date,
  prevHash: string | null,
): AuditChainPayload {
  return {
    projectId: entry.projectId,
    userId: entry.userId,
    action: entry.action,
    resource: entry.resource,
    resourceId: entry.resourceId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ?? null,
    createdAt: createdAt.toISOString(),
    prevHash,
  };
}

// =============================================================
// audit — main writer
// =============================================================

export async function audit(
  entry: AuditEntry,
  callerTx?: AuditTx,
  // The connection to open audit()'s OWN transaction on when there is
  // no `callerTx` — never passed as `callerTx` itself: `db` here is an
  // ordinary (non-transactional) handle, and starting the advisory
  // lock on one of those releases it right after the LOCK statement
  // itself, before the read-compute-insert it exists to serialise ever
  // runs (see access-reconciliation.ts's comment on the same trap).
  // Defaults to the module singleton so all but one caller
  // (workers/retention-sweep.ts, which threads through whatever `Db`
  // it was actually given rather than silently reaching around it)
  // need not pass this at all.
  db: DrizzleDb = drizzle.db,
): Promise<void> {
  if (entry.resource === "credential") {
    for (const snapshot of [entry.before, entry.after]) {
      if (snapshot && !isRedacted(snapshot)) {
        throw new Error(
          "credential audit entries must pass redacted snapshots",
        );
      }
    }
  }

  if (callerTx) {
    await writeChained(entry, callerTx);
    return;
  }

  await db.transaction(async (innerTx) =>
    writeChained(entry, innerTx as unknown as AuditTx),
  );
}

async function writeChained(
  entry: AuditEntry,
  tx: AuditTx,
): Promise<void> {
  // Per-project advisory xact lock. Two concurrent audit writes for
  // the same project now serialise at this lock, so prevHash lookup
  // + rowHash compute + insert happen atomically. Writes for
  // different projects proceed in parallel (different lock keys).
  const lockKey = `audit:${entry.projectId}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${sql.param(lockKey)}, 0))`,
  );

  const latestRows = await tx
    .select({ rowHash: auditLogs.rowHash, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.projectId, entry.projectId),
        isNotNull(auditLogs.rowHash),
      ),
    )
    // The id tiebreak keeps the tip lookup deterministic should legacy rows
    // tie on createdAt (ids are random cuid2s, so it is deterministic, not
    // chronological — the strictly-monotonic createdAt below is what makes
    // ties impossible for rows written from here on).
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(1);
  const tip = latestRows[0];
  const prevHash = tip?.rowHash ?? null;

  // `createdAt` orders the chain (verifyAuditChain walks createdAt asc), but
  // it has millisecond resolution and the advisory lock only serialises
  // writes — it doesn't space them apart in time. Two same-millisecond
  // entries would tie, and with random cuid2 ids the tie order need not
  // match link order, surfacing as a false `broken_link`. Under the lock we
  // can simply force strict monotonicity per project: never stamp a time at
  // or before the current tip's.
  const now = Date.now();
  const createdAt = new Date(
    tip ? Math.max(now, tip.createdAt.getTime() + 1) : now,
  );
  const rowHash = hashAuditRow(
    buildCanonicalPayload(entry, createdAt, prevHash),
  );

  try {
    await tx.insert(auditLogs).values({
      projectId: entry.projectId,
      userId: entry.userId,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      before: (entry.before as unknown) ?? null,
      after: (entry.after as unknown) ?? null,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
      prevHash,
      rowHash,
      createdAt,
    });
  } catch (err) {
    log.warn("audit log write failed", {
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// =============================================================
// verifyAuditChain — re-hash every row and check links
// =============================================================
//
// Walks a project's audit history from the oldest chained row
// forward, reconstructing each `rowHash` from the stored entry
// and comparing it to the one the DB holds. The chain is valid
// when every link verifies AND each row's `prevHash` matches the
// previous row's `rowHash`.

export interface ChainVerificationError {
  rowId: string;
  createdAt: Date;
  kind: "bad_hash" | "broken_link" | "missing_hash";
  expected?: string;
  actual?: string | null;
}

export interface ChainVerificationResult {
  projectId: string;
  rowCount: number;
  firstVerifiedAt: Date | null;
  lastVerifiedAt: Date | null;
  errors: ChainVerificationError[];
}

export async function verifyAuditChain(
  projectId: string,
): Promise<ChainVerificationResult> {
  const rows = await drizzle.auditLogRepo.findProjectChain(drizzle.db, projectId);

  const errors: ChainVerificationError[] = [];
  let expectedPrevHash: string | null = null;

  for (const row of rows) {
    if (!row.rowHash) {
      errors.push({
        rowId: row.id,
        createdAt: row.createdAt,
        kind: "missing_hash",
      });
      // Skip forward chain checks for rows before the chain began.
      expectedPrevHash = null;
      continue;
    }

    if (row.prevHash !== expectedPrevHash) {
      errors.push({
        rowId: row.id,
        createdAt: row.createdAt,
        kind: "broken_link",
        expected: expectedPrevHash ?? undefined,
        actual: row.prevHash,
      });
    }

    // Schema allows null projectId/userId. `writeChained` requires
    // `projectId` to be a real project id (it's typed `string`, never
    // `string | null`, on `AuditEntry`) -- every chained row (one with a
    // rowHash, filtered above) was written with one, so the coercion below
    // is just narrowing a type FK cascades can null out later. `userId`,
    // by contrast, is genuinely nullable on `AuditEntry` -- a webhook-
    // initiated action (e.g. Stripe revoking a Connect authorization) has
    // no dashboard user to attribute it to, and such a row is written and
    // hashed with `userId: null`. Coercing it to `""` here would recompute
    // a DIFFERENT hash than the one actually stored, so it is passed
    // through unchanged to match what `buildCanonicalPayload` hashed at
    // write time.
    const recomputed = hashAuditRow(
      buildCanonicalPayload(
        {
          projectId: row.projectId ?? "",
          userId: row.userId,
          action: row.action as AuditAction,
          resource: row.resource as AuditResource,
          resourceId: row.resourceId,
          before: row.before as Record<string, unknown> | null,
          after: row.after as Record<string, unknown> | null,
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
        },
        row.createdAt,
        row.prevHash,
      ),
    );

    if (recomputed !== row.rowHash) {
      errors.push({
        rowId: row.id,
        createdAt: row.createdAt,
        kind: "bad_hash",
        expected: recomputed,
        actual: row.rowHash,
      });
    }

    expectedPrevHash = row.rowHash;
  }

  return {
    projectId,
    rowCount: rows.length,
    firstVerifiedAt: rows[0]?.createdAt ?? null,
    lastVerifiedAt: rows[rows.length - 1]?.createdAt ?? null,
    errors,
  };
}

// =============================================================
// Credential redaction helpers
// =============================================================

function isRedacted(obj: Record<string, unknown>): boolean {
  for (const value of Object.values(obj)) {
    if (value !== "[REDACTED]") return false;
  }
  return true;
}

export function redactCredentials(
  obj: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!obj) return null;
  const redacted: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    redacted[key] = "[REDACTED]";
  }
  return redacted;
}

// =============================================================
// Test hooks
// =============================================================
//
// Exported for verifier tests — not part of the public API.

export const __testing = {
  canonicalJSON,
  hashAuditRow,
  buildCanonicalPayload,
};
