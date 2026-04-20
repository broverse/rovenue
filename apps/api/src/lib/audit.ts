import type { Context } from "hono";
import prisma, { type Prisma, type PrismaClient } from "@rovenue/db";
import { logger } from "./logger";

// =============================================================
// Audit log — persisted mutation history
// =============================================================
//
// Every dashboard mutation writes an immutable row to audit_logs.
// The write is awaited so a failure surfaces immediately — audit
// coverage is a compliance requirement, not an optimisation.
// For credential updates `before`/`after` MUST be redacted via
// `redactCredentials` (or the `redacted: true` flag passes the
// intent through verbatim).
// If the write is participating in an outer transaction pass `tx`
// as the second argument so a rollback removes the audit row too.

const log = logger.child("audit");

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

type AuditClient = Pick<PrismaClient, "auditLog">;

export async function audit(
  entry: AuditEntry,
  client: AuditClient = prisma,
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
  try {
    await client.auditLog.create({
      data: {
        projectId: entry.projectId,
        userId: entry.userId,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId,
        before: (entry.before as Prisma.InputJsonValue) ?? undefined,
        after: (entry.after as Prisma.InputJsonValue) ?? undefined,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
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
