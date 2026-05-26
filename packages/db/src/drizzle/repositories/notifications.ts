// =============================================================
// notifications repo — Drizzle repository
// =============================================================
//
// User-facing notification inbox writes + reads. Idempotency is
// enforced at the DB layer via the `(userId, eventId)` unique
// index — `insertNotificationIdempotent` swallows the conflict
// and returns `null` so callers can branch on "already delivered".
//
// The feed query uses `(createdAt, id) < (cursor.createdAt, cursor.id)`
// keyset pagination — stable under concurrent inserts and
// index-friendly against `notifications_userId_feed_idx`.

import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client";
import type { DbOrTx } from "./projects";
import {
  notifications,
  type NewNotification,
  type Notification,
} from "../schema";

// ---------- writes ----------

/**
 * Insert a notification row, swallowing the duplicate-eventId
 * conflict. Returns the inserted row, or `null` if a row with
 * the same `(userId, eventId)` already exists.
 */
export async function insertNotificationIdempotent(
  db: DbOrTx,
  input: Omit<NewNotification, "id" | "createdAt" | "readAt">,
): Promise<Notification | null> {
  const rows = await db
    .insert(notifications)
    .values({
      userId: input.userId,
      projectId: input.projectId ?? null,
      eventKey: input.eventKey,
      eventId: input.eventId,
      title: input.title,
      body: input.body,
      data: input.data ?? {},
    })
    .onConflictDoNothing({
      target: [notifications.userId, notifications.eventId],
    })
    .returning();
  return rows[0] ?? null;
}

// ---------- reads ----------

export interface ListNotificationsOpts {
  limit: number;
  cursor?: { createdAt: Date; id: string };
  projectId?: string;
  unreadOnly?: boolean;
}

/**
 * Paginated feed for the bell-icon dropdown. Ordered newest-
 * first; cursor uses `(createdAt, id) < (cursor.createdAt, cursor.id)`
 * so ties on createdAt resolve deterministically.
 */
export async function listNotificationsForUser(
  db: Db,
  userId: string,
  opts: ListNotificationsOpts,
): Promise<Notification[]> {
  const conditions = [eq(notifications.userId, userId)];

  if (opts.projectId !== undefined) {
    conditions.push(eq(notifications.projectId, opts.projectId));
  }
  if (opts.unreadOnly) {
    conditions.push(isNull(notifications.readAt));
  }
  if (opts.cursor) {
    // Keyset: (createdAt, id) < (cursor.createdAt, cursor.id).
    conditions.push(
      or(
        lt(notifications.createdAt, opts.cursor.createdAt),
        and(
          eq(notifications.createdAt, opts.cursor.createdAt),
          lt(notifications.id, opts.cursor.id),
        ),
      )!,
    );
  }

  return db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(opts.limit);
}

// ---------- mutations ----------

/**
 * Idempotent mark-read. Scoped on `userId` so a leaked id can't
 * be mutated by another user. Calling twice is a no-op (the row
 * stays marked read).
 */
export async function markNotificationRead(
  db: Db,
  userId: string,
  id: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.id, id), eq(notifications.userId, userId)),
    );
}

/**
 * Bulk mark-read for the inbox. Restricted to currently unread
 * rows so we don't repeatedly bump `readAt` on already-read
 * rows. Returns the affected row count for UI confirmation.
 */
export async function markAllNotificationsRead(
  db: Db,
  userId: string,
  projectId?: string,
): Promise<number> {
  const conditions = [
    eq(notifications.userId, userId),
    isNull(notifications.readAt),
  ];
  if (projectId !== undefined) {
    conditions.push(eq(notifications.projectId, projectId));
  }

  const result = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(...conditions))
    .returning({ id: notifications.id });
  return result.length;
}

/**
 * Unread badge payload. Returns total + per-project breakdown so
 * the project switcher can render a count next to each workspace
 * in a single round-trip.
 */
export async function unreadNotificationCount(
  db: Db,
  userId: string,
): Promise<{ total: number; byProject: Record<string, number> }> {
  const rows = await db
    .select({
      projectId: notifications.projectId,
      count: sql<string>`count(*)`,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    )
    .groupBy(notifications.projectId);

  let total = 0;
  const byProject: Record<string, number> = {};
  for (const row of rows) {
    const n = Number(row.count);
    total += n;
    if (row.projectId !== null) byProject[row.projectId] = n;
  }
  return { total, byProject };
}
