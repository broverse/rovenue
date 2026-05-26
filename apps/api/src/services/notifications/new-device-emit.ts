// =============================================================
// security.signin.new_device emitter
// =============================================================
//
// Called on every successful sign-in. Computes a UA+IP
// fingerprint, upserts user_known_devices, and emits the
// notification when the upsert reports a fresh insert.
//
// Fingerprint = SHA-256(userAgent + "\n" + ipAddress). The
// salt-free hash is fine: the row is per-user (a leaked
// fingerprint from one user is useless on another), and the
// fingerprint is never returned to the user — only used as a
// uniqueness key on the device table.

import { createHash } from "node:crypto";
import { drizzle, type Db } from "@rovenue/db";
import { logger } from "../../lib/logger";
import { captureNotifierError } from "../../lib/sentry-notifications";
import { emitNotification } from "./emit";

const log = logger.child("notifier.new-device-emit");

export interface NewDeviceEmitInput {
  userId: string;
  userAgent: string;
  ipAddress: string;
  /** Optional human-readable location string ("Istanbul, TR"). */
  approxLocation?: string;
}

export function fingerprint(userAgent: string, ipAddress: string): string {
  return createHash("sha256")
    .update(`${userAgent}\n${ipAddress}`)
    .digest("hex");
}

/**
 * Fire-and-forget. Always safe to call from a sign-in hook —
 * never throws, never blocks the auth response on success.
 */
export async function maybeEmitNewDevice(
  db: Db,
  input: NewDeviceEmitInput,
): Promise<{ isNew: boolean } | null> {
  try {
    const fp = fingerprint(input.userAgent, input.ipAddress);
    const { isNew } = await drizzle.userKnownDeviceRepo.upsertKnownDevice(
      db,
      { userId: input.userId, fingerprint: fp },
    );
    if (!isNew) return { isNew: false };

    await db.transaction(async (tx) => {
      await emitNotification(tx, {
        eventKey: "security.signin.new_device",
        // The fingerprint is the dedup key — if the same device
        // somehow races a second upsert that lands first, the
        // notifier worker dedups on this eventId.
        eventId: `signin.new_device:${input.userId}:${fp.slice(0, 16)}`,
        recipients: [input.userId],
        context: {
          userAgent: input.userAgent,
          ipAddress: input.ipAddress,
          ...(input.approxLocation
            ? { approxLocation: input.approxLocation }
            : {}),
          whenIso: new Date().toISOString(),
        },
      });
    });
    return { isNew: true };
  } catch (err) {
    log.warn("emit_skipped", {
      userId: input.userId,
      err: err instanceof Error ? err.message : String(err),
    });
    captureNotifierError(err, {
      component: "notifier",
      eventKey: "security.signin.new_device",
      userId: input.userId,
      reason: "emit_failed",
    });
    return null;
  }
}
