import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../client";
import { customDomains, type CustomDomain, type NewCustomDomain } from "../schema";

export async function findById(db: Db, id: string): Promise<CustomDomain | null> {
  const rows = await db.select().from(customDomains).where(eq(customDomains.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findByHostname(
  db: Db,
  hostname: string,
): Promise<CustomDomain | null> {
  // Hostnames are stored lowercased; defense-in-depth normalise here too so
  // a caller passing a mixed-case host never misses an existing row.
  const rows = await db
    .select()
    .from(customDomains)
    .where(eq(customDomains.hostname, hostname.toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

export async function findByFunnel(db: Db, funnelId: string): Promise<CustomDomain | null> {
  const rows = await db
    .select()
    .from(customDomains)
    .where(eq(customDomains.funnelId, funnelId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listByProject(db: Db, projectId: string): Promise<CustomDomain[]> {
  return db
    .select()
    .from(customDomains)
    .where(eq(customDomains.projectId, projectId))
    .orderBy(customDomains.createdAt);
}

/**
 * Rows that have not yet been verified and were last checked before `olderThan`
 * (or never). Drives the periodic verify retry job.
 */
export async function listPending(db: Db, olderThan: Date): Promise<CustomDomain[]> {
  return db
    .select()
    .from(customDomains)
    .where(
      and(
        isNull(customDomains.verifiedAt),
        sql`(${customDomains.lastCheckedAt} IS NULL OR ${customDomains.lastCheckedAt} < ${olderThan})`,
      ),
    );
}

/**
 * Verified rows whose certificate is still pending / issuing — drives
 * the cert-status poller. The poller is responsible for time-window
 * decisions (when to give up); the repo just returns the working set.
 */
export async function listAwaitingCert(db: Db): Promise<CustomDomain[]> {
  return db
    .select()
    .from(customDomains)
    .where(
      and(
        sql`${customDomains.verifiedAt} IS NOT NULL`,
        sql`${customDomains.certStatus} IN ('pending', 'issuing')`,
      ),
    );
}

export async function insert(db: Db, row: NewCustomDomain): Promise<CustomDomain> {
  const [inserted] = await db
    .insert(customDomains)
    .values({ ...row, hostname: row.hostname.toLowerCase() })
    .returning();
  return inserted;
}

export async function updateById(
  db: Db,
  id: string,
  patch: Partial<NewCustomDomain>,
): Promise<CustomDomain | null> {
  const [updated] = await db
    .update(customDomains)
    .set({
      ...patch,
      ...(patch.hostname ? { hostname: patch.hostname.toLowerCase() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(customDomains.id, id))
    .returning();
  return updated ?? null;
}

export async function deleteById(db: Db, id: string): Promise<boolean> {
  const result = await db.delete(customDomains).where(eq(customDomains.id, id)).returning();
  return result.length > 0;
}

/**
 * Bulk-mark stale unverified rows as failed once they cross the verification
 * cutoff. Called by the retry job after the 7-day deadline.
 */
export async function failExpired(db: Db, before: Date): Promise<number> {
  const result = await db
    .update(customDomains)
    .set({
      verificationFailureReason: "verification_window_expired",
      updatedAt: new Date(),
    })
    .where(and(isNull(customDomains.verifiedAt), lt(customDomains.createdAt, before)))
    .returning({ id: customDomains.id });
  return result.length;
}
