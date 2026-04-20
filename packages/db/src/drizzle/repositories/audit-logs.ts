import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { Db } from "../client";
import { auditLogs, user } from "../schema";

// =============================================================
// Audit log reads — Drizzle repository
// =============================================================
//
// Mirrors the two calls under apps/api/src/routes/dashboard/
// audit-logs.ts: a filtered list with the author `user` joined
// in, plus a paired total count. Row shape matches the Prisma
// include so the shadow reader's structural diff sees apples
// to apples.

export interface AuditLogFilters {
  projectId: string;
  action?: string;
  userId?: string;
  resource?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
}

export interface AuditLogListArgs extends AuditLogFilters {
  limit: number;
  offset: number;
}

interface AuditUserLite {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface AuditLogRowWithUser {
  id: string;
  projectId: string;
  userId: string;
  action: string;
  resource: string;
  resourceId: string;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  prevHash: string | null;
  rowHash: string | null;
  createdAt: Date;
  user: AuditUserLite;
}

function buildFilters(f: AuditLogFilters): SQL[] {
  const clauses: SQL[] = [eq(auditLogs.projectId, f.projectId)];
  if (f.action) clauses.push(eq(auditLogs.action, f.action));
  if (f.userId) clauses.push(eq(auditLogs.userId, f.userId));
  if (f.resource) clauses.push(eq(auditLogs.resource, f.resource));
  if (f.resourceId) clauses.push(eq(auditLogs.resourceId, f.resourceId));
  if (f.from) clauses.push(gte(auditLogs.createdAt, f.from));
  if (f.to) clauses.push(lte(auditLogs.createdAt, f.to));
  return clauses;
}

export async function listAuditLogs(
  db: Db,
  args: AuditLogListArgs,
): Promise<AuditLogRowWithUser[]> {
  const rows = await db
    .select({
      id: auditLogs.id,
      projectId: auditLogs.projectId,
      userId: auditLogs.userId,
      action: auditLogs.action,
      resource: auditLogs.resource,
      resourceId: auditLogs.resourceId,
      before: auditLogs.before,
      after: auditLogs.after,
      ipAddress: auditLogs.ipAddress,
      userAgent: auditLogs.userAgent,
      prevHash: auditLogs.prevHash,
      rowHash: auditLogs.rowHash,
      createdAt: auditLogs.createdAt,
      userIdJoined: user.id,
      userName: user.name,
      userEmail: user.email,
      userImage: user.image,
    })
    .from(auditLogs)
    .innerJoin(user, eq(user.id, auditLogs.userId))
    .where(and(...buildFilters(args)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(args.limit)
    .offset(args.offset);

  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    userId: r.userId,
    action: r.action,
    resource: r.resource,
    resourceId: r.resourceId,
    before: r.before,
    after: r.after,
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    prevHash: r.prevHash,
    rowHash: r.rowHash,
    createdAt: r.createdAt,
    user: {
      id: r.userIdJoined,
      name: r.userName,
      email: r.userEmail,
      image: r.userImage,
    },
  }));
}

export async function countAuditLogs(
  db: Db,
  filters: AuditLogFilters,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(auditLogs)
    .where(and(...buildFilters(filters)));
  return Number(rows[0]?.total ?? 0);
}
