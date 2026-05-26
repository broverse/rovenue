import { eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import { userPreferences } from "../schema";

// =============================================================
// User preferences — Drizzle repository
// =============================================================
//
// One row per user. The two JSON columns are opaque storage —
// the dashboard owns key shapes for `notifications` and
// `appearance`. Reads upsert an empty row so first-time callers
// always get a 200 (instead of branching on 404 in the route).

export interface UserPreferencesRow {
  userId: string;
  notifications: Record<string, unknown>;
  appearance: Record<string, unknown>;
  profile: Record<string, unknown>;
  updatedAt: Date;
}

export async function ensurePreferences(
  db: Db,
  userId: string,
): Promise<UserPreferencesRow> {
  const existing = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (existing[0]) return existing[0] as UserPreferencesRow;

  const inserted = await db
    .insert(userPreferences)
    .values({ userId })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0] as UserPreferencesRow;

  // Conflict path: another request inserted concurrently — read
  // the now-existing row.
  const rows = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return rows[0] as UserPreferencesRow;
}

export interface UpdatePreferencesInput {
  notifications?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
  profile?: Record<string, unknown>;
}

/**
 * Shallow-merges the supplied blob into the existing JSON
 * column server-side via `jsonb || excluded`, so independent
 * pages (notifications / appearance / profile) can save
 * concurrently without clobbering each other's untouched keys.
 */
export async function mergePreferences(
  db: Db,
  userId: string,
  input: UpdatePreferencesInput,
): Promise<UserPreferencesRow> {
  await ensurePreferences(db, userId);

  const rows = await db
    .update(userPreferences)
    .set({
      ...(input.notifications !== undefined && {
        notifications: sql`${userPreferences.notifications} || ${JSON.stringify(
          input.notifications,
        )}::jsonb`,
      }),
      ...(input.appearance !== undefined && {
        appearance: sql`${userPreferences.appearance} || ${JSON.stringify(
          input.appearance,
        )}::jsonb`,
      }),
      ...(input.profile !== undefined && {
        profile: sql`${userPreferences.profile} || ${JSON.stringify(
          input.profile,
        )}::jsonb`,
      }),
      updatedAt: new Date(),
    })
    .where(eq(userPreferences.userId, userId))
    .returning();
  return rows[0] as UserPreferencesRow;
}
