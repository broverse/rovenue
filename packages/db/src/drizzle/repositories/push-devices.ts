// =============================================================
// push-devices repo — Drizzle repository
// =============================================================
//
// Per-user push token registry. The (platform, token) unique
// index means a token migrates ownership when a different user
// signs in on the same device — the upsert clears revokedAt and
// re-points userId so push delivery follows the active sign-in.
//
// listActivePushDevicesForUser is the hot path the dispatcher
// hits on every push delivery; the partial index on userId
// where revokedAt IS NULL makes it O(log n) in active devices.

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../client";
import {
  pushDevices,
  type NewPushDevice,
  type PushDevice,
} from "../schema";

/**
 * Insert-or-transfer-ownership. ON CONFLICT (platform, token):
 *   - userId → re-points to the new caller (sign-in migration)
 *   - appBundleId/locale/timezone → refreshed from the latest payload
 *   - lastSeenAt → now()
 *   - revokedAt → cleared so a previously-revoked token re-activates
 *     when the user reinstalls and re-registers.
 */
export async function upsertPushDeviceByToken(
  db: Db,
  input: NewPushDevice,
): Promise<PushDevice> {
  const rows = await db
    .insert(pushDevices)
    .values(input)
    .onConflictDoUpdate({
      target: [pushDevices.platform, pushDevices.token],
      set: {
        userId: input.userId,
        appBundleId: input.appBundleId,
        locale: input.locale,
        timezone: input.timezone,
        lastSeenAt: new Date(),
        revokedAt: null,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("upsertPushDeviceByToken: no row returned");
  return row;
}

/**
 * Dispatcher hot path. revokedAt IS NULL filter pairs with the
 * partial index `push_devices_userId_active_idx`.
 */
export async function listActivePushDevicesForUser(
  db: Db,
  userId: string,
): Promise<PushDevice[]> {
  return db
    .select()
    .from(pushDevices)
    .where(
      and(
        eq(pushDevices.userId, userId),
        // Aligns with the partial index
        // `push_devices_userId_active_idx WHERE revokedAt IS NULL`.
        isNull(pushDevices.revokedAt),
      ),
    );
}

/**
 * Soft-delete by row id, scoped on userId so a leaked device id
 * can't be revoked by another tenant. No-op when the (id, userId)
 * pair doesn't match.
 */
export async function revokePushDeviceById(
  db: Db,
  userId: string,
  id: string,
): Promise<void> {
  await db
    .update(pushDevices)
    .set({ revokedAt: new Date() })
    .where(and(eq(pushDevices.id, id), eq(pushDevices.userId, userId)));
}

/**
 * Soft-delete by (platform, token). Used by the SES/FCM/APNs
 * feedback webhook when the provider reports the token as
 * permanently invalid. No-op if no row matches — the webhook
 * may arrive for a token that was already revoked client-side.
 */
export async function revokePushDeviceByToken(
  db: Db,
  platform: "ios" | "android",
  token: string,
): Promise<void> {
  await db
    .update(pushDevices)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(pushDevices.platform, platform), eq(pushDevices.token, token)),
    );
}
