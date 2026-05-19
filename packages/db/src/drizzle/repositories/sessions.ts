import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { session } from "../schema";

// =============================================================
// Session reads / revokes — Drizzle repository
// =============================================================
//
// Better Auth owns the *create* side of `session`; this module
// exposes the read + revoke surface the dashboard's account
// pages need. The token column is intentionally not selected —
// the dashboard never needs the raw token, only metadata.

export interface SessionRow {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SESSION_COLUMNS = {
  id: session.id,
  ipAddress: session.ipAddress,
  userAgent: session.userAgent,
  expiresAt: session.expiresAt,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
} as const;

export async function listSessionsByUser(
  db: Db,
  userId: string,
): Promise<SessionRow[]> {
  return db
    .select(SESSION_COLUMNS)
    .from(session)
    .where(eq(session.userId, userId))
    .orderBy(desc(session.updatedAt));
}

/**
 * Returns true when a session row with the given id belongs to
 * `userId`. Used to authorise revoke calls without leaking other
 * users' session existence — callers should treat `false` as 404.
 */
export async function isSessionOwnedBy(
  db: Db,
  id: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.id, id), eq(session.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Deletes a session row regardless of ownership — call sites
 * MUST gate this with {@link isSessionOwnedBy} first.
 */
export async function deleteSessionById(db: Db, id: string): Promise<void> {
  await db.delete(session).where(eq(session.id, id));
}
