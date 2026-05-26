// =============================================================
// notification-preferences repo — Drizzle repository
// =============================================================
//
// Three layers of notification preference storage:
//   - user_preferences.notifications.channels — per-user master
//     switch for email/push channels (plus locale/timezone for
//     template rendering).
//   - user_project_notification_prefs.overrides — per-user,
//     per-project override map keyed by eventKey.
//   - project_notification_defaults.defaults — workspace-wide
//     defaults set by an admin.
//
// The notifier resolver layers them at send time:
//   defaults <- per-user overrides <- channel master switch.
//
// All three writes use JSONB `||` to merge new keys into the
// existing blob without clobbering untouched keys — this lets
// independent UI pages save concurrently without read-modify-
// write races.

import { eq, sql, and } from "drizzle-orm";
import type { Db } from "../client";
import {
  projectNotificationDefaults,
  userPreferences,
  userProjectNotificationPrefs,
} from "../schema";

// ---------- user-level channels ----------

export interface UserChannels {
  email: boolean;
  push: boolean;
  locale: string;
  timezone: string;
}

/**
 * Returns null if the user_preferences row doesn't exist yet.
 * The dashboard's "ensurePreferences" path inserts an empty row
 * on first read; this repo is consumed by the notifier worker
 * which should NOT side-effect — null means "no preferences,
 * use sensible defaults at the call site".
 */
export async function getUserChannels(
  db: Db,
  userId: string,
): Promise<UserChannels | null> {
  const rows = await db
    .select({
      notifications: userPreferences.notifications,
      locale: userPreferences.locale,
      timezone: userPreferences.timezone,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const channels =
    (row.notifications as Record<string, unknown> | null)?.channels ?? {};
  const c = channels as Record<string, unknown>;
  return {
    // Channels default to true if absent — explicit opt-out is
    // the only way to suppress.
    email: c.email !== false,
    push: c.push !== false,
    locale: row.locale,
    timezone: row.timezone,
  };
}

/**
 * Upsert into user_preferences. Channel flags merge into the
 * existing `notifications.channels` JSONB; locale/timezone are
 * plain column updates. Only the supplied fields in `patch` are
 * written — `{ push: false }` does not touch the email flag.
 */
export async function updateUserChannels(
  db: Db,
  userId: string,
  patch: {
    email?: boolean;
    push?: boolean;
    locale?: string;
    timezone?: string;
  },
): Promise<void> {
  const channelPatch: Record<string, boolean> = {};
  if (patch.email !== undefined) channelPatch.email = patch.email;
  if (patch.push !== undefined) channelPatch.push = patch.push;
  const hasChannelPatch = Object.keys(channelPatch).length > 0;

  // Build the initial-insert JSONB. On a fresh row we seed the
  // channel keys directly; otherwise the ON CONFLICT branch
  // merges them in.
  const initialNotifications = hasChannelPatch
    ? { channels: channelPatch }
    : {};

  await db
    .insert(userPreferences)
    .values({
      userId,
      notifications: initialNotifications,
      ...(patch.locale !== undefined && { locale: patch.locale }),
      ...(patch.timezone !== undefined && { timezone: patch.timezone }),
    })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: {
        ...(hasChannelPatch && {
          // Merge: existing.notifications || jsonb_build_object('channels', existing.channels || patch).
          // Postgres' || on jsonb objects is shallow — so we
          // need to deep-merge the channels sub-object explicitly.
          notifications: sql`
            jsonb_set(
              ${userPreferences.notifications},
              '{channels}',
              COALESCE(${userPreferences.notifications}->'channels', '{}'::jsonb) || ${JSON.stringify(channelPatch)}::jsonb,
              true
            )
          `,
        }),
        ...(patch.locale !== undefined && { locale: patch.locale }),
        ...(patch.timezone !== undefined && { timezone: patch.timezone }),
        updatedAt: new Date(),
      },
    });
}

// ---------- per-(user, project) overrides ----------

/**
 * Returns {} when no row exists — callers treat the absence of
 * a row as "no overrides, use project defaults".
 */
export async function getUserProjectOverrides(
  db: Db,
  userId: string,
  projectId: string,
): Promise<Record<string, boolean>> {
  const rows = await db
    .select({ overrides: userProjectNotificationPrefs.overrides })
    .from(userProjectNotificationPrefs)
    .where(
      and(
        eq(userProjectNotificationPrefs.userId, userId),
        eq(userProjectNotificationPrefs.projectId, projectId),
      ),
    )
    .limit(1);
  return (rows[0]?.overrides as Record<string, boolean>) ?? {};
}

/**
 * Upsert: insert a fresh row with the supplied overrides, or
 * merge into an existing row's JSONB via `overrides || $new`.
 * Postgres' || on jsonb objects is a shallow right-wins merge,
 * which is exactly what we want for an event-keyed map.
 */
export async function upsertUserProjectOverrides(
  db: Db,
  userId: string,
  projectId: string,
  overrides: Record<string, boolean>,
): Promise<void> {
  await db
    .insert(userProjectNotificationPrefs)
    .values({ userId, projectId, overrides })
    .onConflictDoUpdate({
      target: [
        userProjectNotificationPrefs.userId,
        userProjectNotificationPrefs.projectId,
      ],
      set: {
        overrides: sql`${userProjectNotificationPrefs.overrides} || ${JSON.stringify(
          overrides,
        )}::jsonb`,
        updatedAt: new Date(),
      },
    });
}

// ---------- project-wide defaults ----------

export async function getProjectDefaults(
  db: Db,
  projectId: string,
): Promise<Record<string, boolean>> {
  const rows = await db
    .select({ defaults: projectNotificationDefaults.defaults })
    .from(projectNotificationDefaults)
    .where(eq(projectNotificationDefaults.projectId, projectId))
    .limit(1);
  return (rows[0]?.defaults as Record<string, boolean>) ?? {};
}

export async function upsertProjectDefaults(
  db: Db,
  projectId: string,
  defaults: Record<string, boolean>,
): Promise<void> {
  await db
    .insert(projectNotificationDefaults)
    .values({ projectId, defaults })
    .onConflictDoUpdate({
      target: projectNotificationDefaults.projectId,
      set: {
        defaults: sql`${projectNotificationDefaults.defaults} || ${JSON.stringify(
          defaults,
        )}::jsonb`,
        updatedAt: new Date(),
      },
    });
}
