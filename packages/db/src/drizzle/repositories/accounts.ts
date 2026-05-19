import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { account } from "../schema";

// =============================================================
// OAuth account reads / disconnect — Drizzle repository
// =============================================================
//
// Better Auth owns the *create* side of `account` (one row per
// linked OAuth provider per user). This module exposes the
// minimal read + delete surface the dashboard's "connected"
// page needs. Token columns are never selected — disclosing
// them would defeat the encryption story.

export interface LinkedAccount {
  id: string;
  providerId: string;
  accountId: string;
  createdAt: Date;
  updatedAt: Date;
}

const LINKED_ACCOUNT_COLUMNS = {
  id: account.id,
  providerId: account.providerId,
  accountId: account.accountId,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
} as const;

export async function listAccountsByUser(
  db: Db,
  userId: string,
): Promise<LinkedAccount[]> {
  return db
    .select(LINKED_ACCOUNT_COLUMNS)
    .from(account)
    .where(eq(account.userId, userId))
    .orderBy(desc(account.createdAt));
}

/**
 * Counts how many OAuth accounts are linked to the user.
 * Callers use this to refuse the final disconnect (which would
 * lock the user out of an OAuth-only deployment).
 */
export async function countAccountsByUser(
  db: Db,
  userId: string,
): Promise<number> {
  const rows = await db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.userId, userId));
  return rows.length;
}

/**
 * Deletes the user's row for a single provider (e.g. "github" /
 * "google"). Returns true if a row was removed.
 */
export async function deleteAccountByProvider(
  db: Db,
  userId: string,
  providerId: string,
): Promise<boolean> {
  const removed = await db
    .delete(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, providerId)))
    .returning({ id: account.id });
  return removed.length > 0;
}
