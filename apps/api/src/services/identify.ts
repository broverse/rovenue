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
    // The appUserId key MUST match transferSubscriber's construction
    // byte-for-byte (`${projectId}:${appUserId}`, no prefix) so identify
    // and transfer serialize on the same lock when they touch the same
    // label. The rovenueId gets a distinct, prefixed key since
    // transferSubscriber never locks rovenueIds.
    const keys = [
      `${projectId}:${appUserId}`,
      `${projectId}:rov:${rovenueId}`,
    ].sort();
    await drizzle.lockRepo.advisoryXactLock2(tx, keys[0]!, keys[1]!);

    let self = await drizzle.subscriberRepo.findSubscriberByRovenueId(tx, {
      projectId,
      rovenueId,
    });
    if (!self) {
      throw new Error(`Device subscriber '${rovenueId}' not found`);
    }

    // If the device row was already merged away (soft-deleted with a
    // mergedInto target), its identity now lives on the canonical row.
    // Re-resolve and operate on THAT live row — never bind a label onto
    // a dead source row.
    if (self.deletedAt) {
      const canonical =
        await drizzle.subscriberRepo.resolveSubscriberByRovenueId(tx, {
          projectId,
          rovenueId,
        });
      if (!canonical) {
        throw new Error(
          `Device subscriber '${rovenueId}' has been merged and cannot be resolved`,
        );
      }
      self = canonical;
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
