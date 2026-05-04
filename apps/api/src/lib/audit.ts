import { createHash } from "node:crypto";
import type { Context } from "hono";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
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
  // --- credentials ---
  | "credential.updated"
  | "credential.cleared"
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
  | "experiment.started"
  | "experiment.stopped"
  // --- feature flag ---
  | "toggle"
  // --- subscriber manual ops ---
  | "subscriber.access_granted"
  | "subscriber.credits_added"
  | "subscriber.anonymized"
  | "subscriber.exported"
  // --- members ---
  | "member.invited"
  | "member.role_changed"
  | "member.removed";

export type AuditResource =
  | "audience"
  | "experiment"
  | "feature_flag"
  | "project"
  | "api_key"
  | "product"
  | "product_group"
  | "subscriber"
  | "member"
  | "credential";

export interface AuditEntry {
  projectId: string;
  userId: string;
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
// `JSON.stringify` does not guarantee key order across engines. A
// compliance-grade chain must be byte-identical on re-hash, so we
// emit keys in sorted order and recurse through arrays/objects
// ourselves.

function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`)
    .join(",")}}`;
}

function hashRow(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

interface CanonicalPayload {
  projectId: string;
  userId: string;
  action: string;
  resource: string;
  resourceId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  prevHash: string | null;
}

function buildCanonicalPayload(
  entry: AuditEntry,
  createdAt: Date,
  prevHash: string | null,
): CanonicalPayload {
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

  await drizzle.db.transaction(async (innerTx) =>
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
    .select({ rowHash: auditLogs.rowHash })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.projectId, entry.projectId),
        isNotNull(auditLogs.rowHash),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  const prevHash = latestRows[0]?.rowHash ?? null;

  const createdAt = new Date();
  const canonical = canonicalJSON(
    buildCanonicalPayload(entry, createdAt, prevHash),
  );
  const rowHash = hashRow(canonical);

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

    const canonical = canonicalJSON(
      buildCanonicalPayload(
        {
          projectId: row.projectId,
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
    const recomputed = hashRow(canonical);

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
  hashRow,
  buildCanonicalPayload,
};
