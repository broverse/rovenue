// =============================================================
// user-known-devices repo — Drizzle repository
// =============================================================
//
// Per-user device fingerprint registry powering the
// security.signin.new_device notification producer. The single
// hot path is upsertKnownDevice, which uses an INSERT ... ON
// CONFLICT DO UPDATE ... RETURNING (xmax = 0) trick to tell
// callers whether the row was freshly inserted or just refreshed.

import { eq, and, sql } from "drizzle-orm";
import type { Db } from "../client";
import {
  userKnownDevices,
  type UserKnownDevice,
} from "../schema";

export interface UpsertResult {
  device: UserKnownDevice;
  /** True only when the row was inserted on this call (vs refreshed). */
  isNew: boolean;
}

/**
 * Insert-or-refresh by (userId, fingerprint). Returns the row
 * plus `isNew=true` when the insert actually created it.
 *
 * Detection uses Postgres's xmax pseudo-column — on a fresh
 * insert xmax = 0, on a conflict-update it carries the previous
 * row's xmax (always non-zero for visible rows). This is the
 * canonical PG idiom and avoids a second SELECT.
 */
export async function upsertKnownDevice(
  db: Db,
  input: { userId: string; fingerprint: string },
): Promise<UpsertResult> {
  const rows = (await db
    .insert(userKnownDevices)
    .values({ userId: input.userId, fingerprint: input.fingerprint })
    .onConflictDoUpdate({
      target: [userKnownDevices.userId, userKnownDevices.fingerprint],
      set: { lastSeenAt: new Date() },
    })
    .returning({
      id: userKnownDevices.id,
      userId: userKnownDevices.userId,
      fingerprint: userKnownDevices.fingerprint,
      lastSeenAt: userKnownDevices.lastSeenAt,
      createdAt: userKnownDevices.createdAt,
      // `xmax = 0` ⇒ this returning row came from the INSERT branch,
      // not the UPDATE branch. Cast to text so the type stays
      // wire-stable across pg client versions.
      xmaxText: sql<string>`(xmax)::text`.as("xmaxText"),
    })) as Array<
    UserKnownDevice & { xmaxText: string }
  >;

  const row = rows[0];
  if (!row) throw new Error("upsertKnownDevice: no row returned");

  const { xmaxText, ...device } = row;
  return {
    device,
    isNew: xmaxText === "0",
  };
}

/** Test/diagnostic helper. */
export async function findKnownDevice(
  db: Db,
  userId: string,
  fingerprint: string,
): Promise<UserKnownDevice | null> {
  const rows = await db
    .select()
    .from(userKnownDevices)
    .where(
      and(
        eq(userKnownDevices.userId, userId),
        eq(userKnownDevices.fingerprint, fingerprint),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
