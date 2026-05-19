import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { personalAccessTokens } from "../schema";

// =============================================================
// Personal access tokens — Drizzle repository
// =============================================================
//
// Token plaintext only exists at creation time (returned in the
// API response). After that the row only carries `tokenHash` for
// verification and `prefix` for dashboard display. Token hashing
// is computed at the route layer; this repo treats the value as
// opaque so we don't accidentally leak the hashing strategy into
// downstream queries.

export interface PersonalAccessTokenRow {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

const PAT_LIST_COLUMNS = {
  id: personalAccessTokens.id,
  name: personalAccessTokens.name,
  prefix: personalAccessTokens.prefix,
  lastUsedAt: personalAccessTokens.lastUsedAt,
  expiresAt: personalAccessTokens.expiresAt,
  createdAt: personalAccessTokens.createdAt,
} as const;

export async function listTokensByUser(
  db: Db,
  userId: string,
): Promise<PersonalAccessTokenRow[]> {
  return db
    .select(PAT_LIST_COLUMNS)
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.userId, userId))
    .orderBy(desc(personalAccessTokens.createdAt));
}

export interface CreatePersonalAccessTokenInput {
  userId: string;
  name: string;
  prefix: string;
  tokenHash: string;
  expiresAt?: Date | null;
}

export async function createToken(
  db: Db,
  input: CreatePersonalAccessTokenInput,
): Promise<PersonalAccessTokenRow> {
  const rows = await db
    .insert(personalAccessTokens)
    .values({
      userId: input.userId,
      name: input.name,
      prefix: input.prefix,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt ?? null,
    })
    .returning(PAT_LIST_COLUMNS);
  // Postgres always returns the inserted row when `RETURNING`
  // mentions a column — the assertion captures that invariant
  // without an extra defensive throw.
  return rows[0]!;
}

/**
 * True when the token row with `id` belongs to `userId`. Callers
 * gate destructive operations with this check so cross-user
 * deletes return 404 rather than 200.
 */
export async function isTokenOwnedBy(
  db: Db,
  id: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: personalAccessTokens.id })
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.id, id),
        eq(personalAccessTokens.userId, userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function deleteTokenById(db: Db, id: string): Promise<void> {
  await db
    .delete(personalAccessTokens)
    .where(eq(personalAccessTokens.id, id));
}
