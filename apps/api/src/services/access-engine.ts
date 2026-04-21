import { PurchaseStatus, drizzle, type Store } from "@rovenue/db";
import { logger } from "../lib/logger";

const log = logger.child("access-engine");

const ENTITLEMENT_GRANTING_STATUSES: ReadonlySet<PurchaseStatus> = new Set<
  PurchaseStatus
>([PurchaseStatus.ACTIVE, PurchaseStatus.TRIAL, PurchaseStatus.GRACE_PERIOD]);

export interface ActiveAccessEntry {
  isActive: boolean;
  expiresDate: Date | null;
  store: Store;
  purchaseId: string;
}

/**
 * Reconcile a subscriber's `subscriber_access` rows against the authoritative
 * set derived from their current purchases. Holds a Postgres advisory lock
 * keyed on the subscriberId for the duration of the transaction so concurrent
 * webhook workers can't race on the same subscriber.
 */
export async function syncAccess(subscriberId: string): Promise<void> {
  await drizzle.db.transaction(async (tx) => {
    // Serialize access sync per-subscriber. Non-blocking for different
    // subscribers; blocking for the same one.
    await drizzle.lockRepo.advisoryXactLock(tx, subscriberId);

    const purchases = await drizzle.accessRepo.findPurchasesWithEntitlementKeys(
      tx,
      subscriberId,
    );

    const now = new Date();
    interface Target {
      purchaseId: string;
      expiresDate: Date | null;
      store: Store;
    }
    const desired = new Map<string, Target>();

    for (const purchase of purchases) {
      if (!ENTITLEMENT_GRANTING_STATUSES.has(purchase.status as PurchaseStatus)) continue;
      if (purchase.expiresDate && purchase.expiresDate < now) continue;

      for (const key of purchase.entitlementKeys) {
        const existing = desired.get(key);
        if (
          !existing ||
          isLaterExpiry(purchase.expiresDate, existing.expiresDate)
        ) {
          desired.set(key, {
            purchaseId: purchase.id,
            expiresDate: purchase.expiresDate,
            store: purchase.store,
          });
        }
      }
    }

    const current = await drizzle.accessRepo.findAllAccessBySubscriber(
      tx,
      subscriberId,
    );

    for (const record of current) {
      const target = desired.get(record.entitlementKey);
      const isSource = target?.purchaseId === record.purchaseId;
      if (!isSource && record.isActive) {
        await drizzle.accessRepo.setAccessActive(tx, record.id, false);
      }
    }

    for (const [key, target] of desired) {
      const existing = current.find(
        (r) =>
          r.entitlementKey === key && r.purchaseId === target.purchaseId,
      );
      if (existing) {
        const expiryChanged =
          existing.expiresDate?.getTime() !== target.expiresDate?.getTime();
        if (!existing.isActive || expiryChanged) {
          await drizzle.accessRepo.setAccessActiveAndExpiry(
            tx,
            existing.id,
            true,
            target.expiresDate,
          );
        }
      } else {
        await drizzle.accessRepo.createAccess(tx, {
          subscriberId,
          purchaseId: target.purchaseId,
          entitlementKey: key,
          isActive: true,
          expiresDate: target.expiresDate,
          store: target.store,
        });
      }
    }

    log.debug("synced access", {
      subscriberId,
      granted: desired.size,
      total: current.length,
    });
  });
}

export async function hasAccess(
  subscriberId: string,
  entitlementKey: string,
): Promise<boolean> {
  const records = await drizzle.accessRepo.findActiveAccess(
    drizzle.db,
    subscriberId,
    new Date(),
  );
  return records.some((r) => r.entitlementKey === entitlementKey);
}

export async function getActiveAccess(
  subscriberId: string,
): Promise<Record<string, ActiveAccessEntry>> {
  const now = new Date();
  // Phase 6 cutover: Drizzle canonical. SDK entitlement checks
  // land on subscriberAccess.findActive via the repo.
  const records = await drizzle.accessRepo.findActiveAccess(
    drizzle.db,
    subscriberId,
    now,
  );

  const result: Record<string, ActiveAccessEntry> = {};
  for (const record of records) {
    const existing = result[record.entitlementKey];
    if (
      !existing ||
      isLaterExpiry(record.expiresDate, existing.expiresDate)
    ) {
      result[record.entitlementKey] = {
        isActive: record.isActive,
        expiresDate: record.expiresDate,
        store: record.store,
        purchaseId: record.purchaseId,
      };
    }
  }
  return result;
}

function isLaterExpiry(a: Date | null, b: Date | null): boolean {
  if (a === b) return false;
  if (a === null) return true;
  if (b === null) return false;
  return a.getTime() > b.getTime();
}
