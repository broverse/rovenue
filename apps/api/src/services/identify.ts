import { drizzle } from "@rovenue/db";
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";
import { reassignAllAssets } from "./subscriber-transfer";

const log = logger.child("identify");

export interface BindResult {
  subscriberId: string;
  appUserId: string;
  transferred: boolean;
}

/**
 * Binds a customer `appUserId` label to the device's permanent `rovenueId`
 * row. RevenueCat-style "transfer to new id": if the label currently lives
 * on a different subscriber, that subscriber's assets are auto-transferred
 * onto this device's row and the prior holder is soft-deleted as merged.
 *
 * Serialised by a project-scoped advisory lock on both the rovenueId and
 * the appUserId so concurrent identify/transfer calls can't race the
 * balance read+write or the uniqueness swap.
 */
export async function bindAppUserId(
  projectId: string,
  rovenueId: string,
  appUserId: string,
  userId?: string,
): Promise<BindResult> {
  return drizzle.db.transaction(async (tx) => {
    // Acquire advisory locks in sorted order to avoid deadlocks when two
    // concurrent calls swap the same pair of keys in opposite order.
    const [k1, k2] = [`r:${rovenueId}`, `u:${appUserId}`].sort();
    await drizzle.lockRepo.advisoryXactLock2(
      tx,
      `${projectId}:${k1}`,
      `${projectId}:${k2}`,
    );

    const self = await drizzle.subscriberRepo.findSubscriberByRovenueId(tx, {
      projectId,
      rovenueId,
    });
    if (!self) {
      throw new Error(`Device subscriber '${rovenueId}' not found`);
    }

    // Idempotent: label already set on this row — ensure identifiedAt is
    // populated (may have been omitted before identifiedAt column existed).
    if (self.appUserId === appUserId) {
      if (!self.identifiedAt) {
        await drizzle.subscriberRepo.setAppUserId(tx, self.id, appUserId, new Date());
      }
      return { subscriberId: self.id, appUserId, transferred: false };
    }

    // Check whether this appUserId is already held by another active
    // subscriber row; if so, transfer that holder's assets to this device
    // and soft-delete the prior holder. Ordering matters: soft-delete MUST
    // run before setAppUserId(self) to free the partial unique index
    // (projectId, appUserId) WHERE appUserId IS NOT NULL AND deletedAt IS NULL.
    const other = await drizzle.subscriberRepo.findSubscriberByAppUserId(tx, {
      projectId,
      appUserId,
    });

    let transferred = false;
    if (other && !other.deletedAt && other.id !== self.id) {
      await reassignAllAssets(
        tx,
        projectId,
        { id: other.id, label: appUserId },
        { id: self.id, label: rovenueId },
      );
      transferred = true;
    }

    await drizzle.subscriberRepo.setAppUserId(tx, self.id, appUserId, new Date());

    log.info("appUserId bound", {
      projectId,
      rovenueId,
      subscriberId: self.id,
      transferred,
    });

    if (userId) {
      await audit(
        {
          projectId,
          userId,
          action: "update",
          resource: "subscriber",
          resourceId: self.id,
          before: { rovenueId, appUserId: self.appUserId },
          after: { appUserId, transferred },
        },
        tx,
      );
    }

    return { subscriberId: self.id, appUserId, transferred };
  });
}
