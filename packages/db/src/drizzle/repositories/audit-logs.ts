import { and, asc, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { AuditChainPayload } from "@rovenue/shared/audit-chain";
import type { Db } from "../client";
import { auditLogs, user } from "../schema";

// =============================================================
// Audit log reads
// =============================================================
//
// Covers the two calls under apps/api/src/routes/dashboard/
// audit-logs.ts: a filtered list with the author `user` joined
// in, plus a paired total count.

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
  userId: string | null;
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

  // The WHERE clause matches `auditLogs.projectId = f.projectId`,
  // which excludes orphan rows whose projectId was nulled by the
  // ON DELETE SET NULL FK — hence the non-null assertion is sound.
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId!,
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

/**
 * Existence check with no `user` join — unlike `listAuditLogs`/
 * `findAuditLogById`, this must also match rows written with a
 * non-Better-Auth `userId` (e.g. `"system"`, the scheduler worker's
 * attribution), which an INNER JOIN against `user` would silently
 * exclude. Used by `computeSchedulingBlocked` (apps/api/src/services/
 * experiment-create.ts) to check for a durable "predecessor deleted"
 * marker without pulling the row itself.
 */
export async function existsAuditEntry(
  db: Db,
  filters: { resource: string; resourceId: string; action: string },
): Promise<boolean> {
  const rows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.resource, filters.resource),
        eq(auditLogs.resourceId, filters.resourceId),
        eq(auditLogs.action, filters.action),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Full project chain ordered by (createdAt, id) ASC so the
 * verifyAuditChain walker reads rows in insertion order. Does
 * NOT join the user — the verifier only needs the hash columns
 * + core payload fields.
 */
export async function findProjectChain(
  db: Db,
  projectId: string,
): Promise<Array<{
  id: string;
  projectId: string;
  userId: string | null;
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
}>> {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.projectId, projectId))
    .orderBy(auditLogs.createdAt, auditLogs.id);
  // WHERE filters to a specific projectId, so orphan rows with
  // null projectId (post-cascade SET NULL) cannot appear here.
  return rows.map((r) => ({ ...r, projectId: r.projectId! }));
}

/**
 * A proof-bundle row: exactly the fields `hashAuditRow` covers
 * (`AuditChainPayload`) plus the two identifiers a verifier needs
 * to address and re-link a row (`id`, `rowHash`). Deliberately a
 * sibling of `listAuditLogs`/`findProjectChain` rather than a
 * variant of either — those return display fields (the joined
 * `user`) or the raw Drizzle row shape (`createdAt` as a `Date`),
 * and a proof row that carried either would silently fail to
 * re-hash to its stored `rowHash`.
 *
 * `rowHash` is nullable: the column itself is nullable (rows
 * predating the hash chain have no hash state — schema.ts), and
 * this read applies no `WHERE rowHash IS NOT NULL` filter, so a
 * legacy row inside a proof-export range flows through here. A
 * proof export needs to KNOW an unhashed row was in range rather
 * than have it silently omitted or coerced into looking hashed —
 * so the type says exactly what can come back, and the caller
 * (an export/verify step) decides what a null means.
 */
export interface AuditProofRow extends AuditChainPayload {
  id: string;
  rowHash: string | null;
}

/**
 * Chain-ordered proof read for an audit-proof export bundle.
 * Selects only the columns `hashAuditRow` covers plus `id` and
 * `rowHash`, and stringifies `createdAt` with `.toISOString()` —
 * `AuditChainPayload.createdAt` is a string because the canonical
 * encoder (`@rovenue/shared/audit-chain`) never sees a `Date`,
 * matching how `apps/api/src/lib/audit.ts` builds the payload it
 * hashes at write time.
 *
 * Ordered by (`createdAt`, `id`) ascending: `createdAt` alone is
 * not a total order (multiple rows can share a timestamp), and an
 * arbitrary tiebreak would make chain verification fail
 * intermittently in a way that resembles tampering.
 */
export async function listAuditProofRows(
  db: Db,
  args: { projectId: string; from?: Date; to?: Date; limit: number },
): Promise<AuditProofRow[]> {
  const clauses: SQL[] = [eq(auditLogs.projectId, args.projectId)];
  if (args.from) clauses.push(gte(auditLogs.createdAt, args.from));
  if (args.to) clauses.push(lte(auditLogs.createdAt, args.to));

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
      createdAt: auditLogs.createdAt,
      prevHash: auditLogs.prevHash,
      rowHash: auditLogs.rowHash,
    })
    .from(auditLogs)
    .where(and(...clauses))
    .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id))
    .limit(args.limit);

  // WHERE filters to a specific projectId, so orphan rows with a
  // null projectId (post-cascade SET NULL) cannot appear here — that
  // non-null assertion mirrors findProjectChain's. `rowHash` has no
  // such filter and is mapped through as-is (possibly null): a
  // legacy pre-chain row must surface to the caller, not be coerced
  // or hidden.
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId!,
    userId: r.userId,
    action: r.action,
    resource: r.resource,
    resourceId: r.resourceId,
    before: r.before as Record<string, unknown> | null,
    after: r.after as Record<string, unknown> | null,
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    createdAt: r.createdAt.toISOString(),
    prevHash: r.prevHash,
    rowHash: r.rowHash,
  }));
}

/**
 * Single-row lookup by PK. Returns null when the row doesn't
 * exist so the caller decides on 404 semantics. Includes the
 * author user row in the same shape the list helper emits.
 */
export async function findAuditLogById(
  db: Db,
  id: string,
): Promise<AuditLogRowWithUser | null> {
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
    .where(eq(auditLogs.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  // findAuditLogById is reached only from project-scoped routes
  // that already verified the row belongs to a live project, so
  // the projectId is guaranteed non-null in this path.
  return {
    id: r.id,
    projectId: r.projectId!,
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
  };
}
