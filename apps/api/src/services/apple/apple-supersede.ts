import { PurchaseStatus, Store, type Db, drizzle } from "@rovenue/db";
import { guardStatusWrite } from "../subscription-transition-guard";
import { syncAccess } from "../access-engine";
import { logger } from "../../lib/logger";

const log = logger.child("apple-supersede");

// =============================================================
// Apple upgrade supersession
// =============================================================
//
// The Apple twin of google-supersede.ts. When a subscriber upgrades,
// Apple charges immediately and sends DID_CHANGE_RENEWAL_PREF/UPGRADE
// carrying the NEW transaction — and sends nothing at all for the old
// one. Its row keeps a frozen future expiresDate, and access-engine.ts
// unions granting rows across ALL of a subscriber's purchases, so the
// pre-upgrade tier stays entitled for the rest of the old period.
//
// Scope is deliberately narrow (see findSupersedableApplePurchases):
// Apple mints a new transactionId per renewal, so the chain holds one
// row per billing period. Expiring every sibling would rewrite the
// subscription's whole history and emit an audit row per period.

/** A sibling row this call actually moved to EXPIRED. */
export interface SupersededApplePurchase {
  purchaseId: string;
  subscriberId: string;
  /** The product the subscriber was on before the upgrade replaced it. */
  productId: string;
}

/**
 * Expire the (at most one) unexpired sibling purchase row that the
 * incoming upgrade transaction replaced, and recompute access for its
 * subscriber. Idempotent: a replay finds the row already EXPIRED (guard
 * withholds) and syncAccess is a no-op recompute of the same set.
 *
 * Returns the rows it ACTUALLY retired (guard applied), not every row it
 * considered. `applyRenewalPrefChange` uses them as the `previousProductId`
 * of `subscription.product_changed`: Apple mints a NEW transactionId for
 * the replacing transaction, so `guardStatusWrite`'s before-image on that
 * key is null and cannot see the plan change — the retired sibling is the
 * honest source, and it is already in hand here. Restricting the result to
 * rows this call moved is also what makes the emit replay-safe: a redelivered
 * upgrade finds the sibling already EXPIRED, retires nothing, and emits
 * nothing.
 */
export async function expireSupersededApplePurchases(args: {
  projectId: string;
  originalTransactionId: string;
  /** The replacing transaction's own id — guards against self-expiry. */
  currentStoreTransactionId: string;
  now: Date;
  source: string;
  /**
   * Invoked INSIDE the same transaction as the expiry write, once per row
   * this call actually retired, with that transaction's handle.
   *
   * This exists so the caller's `subscription.product_changed` outbox row
   * commits atomically with the retirement that makes the plan change
   * true. It matters more than it looks: the caller's emit is gated on a
   * row having MOVED, so if the retirement committed and a separate outbox
   * write then failed, the redelivery would find the sibling already
   * EXPIRED, suppress the emit, and lose the event permanently. Same
   * transaction, or the gate turns a crash into silent data loss.
   */
  onSuperseded?: (tx: Db, retired: SupersededApplePurchase) => Promise<void>;
}): Promise<{ expired: number; superseded: SupersededApplePurchase[] }> {
  const siblings =
    await drizzle.purchaseExtRepo.findSupersedableApplePurchases(drizzle.db, {
      projectId: args.projectId,
      originalTransactionId: args.originalTransactionId,
      excludeStoreTransactionId: args.currentStoreTransactionId,
      now: args.now,
    });

  const superseded: SupersededApplePurchase[] = [];
  for (const sibling of siblings) {
    await drizzle.db.transaction(async (tx) => {
      const guard = await guardStatusWrite({
        db: tx,
        projectId: args.projectId,
        store: Store.APP_STORE,
        storeTransactionId: sibling.storeTransactionId,
        to: PurchaseStatus.EXPIRED,
        source: `${args.source}:apple_upgrade_supersede`,
        eventTime: args.now,
      });
      if (!guard.apply) return;
      // EXPIRED is not a TERMINAL status and this row keeps its frozen
      // future expiresDate, so an already-expired sibling still matches
      // `findSupersedableApplePurchases` and the guard still applies an
      // EXPIRED -> EXPIRED write. That re-write is harmless, but treating
      // it as a supersession is not: the caller emits
      // `subscription.product_changed` per returned row, and a redelivered
      // upgrade would emit the same plan change a second time. Only a row
      // whose status actually MOVED counts.
      const alreadyExpired =
        guard.previous?.status === PurchaseStatus.EXPIRED;
      await drizzle.purchaseRepo.updatePurchase(tx, sibling.id, {
        status: PurchaseStatus.EXPIRED,
        lastStoreEventAt: args.now,
      });
      if (alreadyExpired) return;
      const retired: SupersededApplePurchase = {
        purchaseId: sibling.id,
        subscriberId: sibling.subscriberId,
        productId: sibling.productId,
      };
      superseded.push(retired);
      await args.onSuperseded?.(tx, retired);
    });
    // Access is re-derived from the whole purchase set, so this is safe
    // to run even when the guard withheld the status write (e.g. the
    // row was already terminal) — skipping it can leave stale
    // entitlement behind, running it is always harmless.
    await syncAccess(sibling.subscriberId);
  }

  if (superseded.length > 0) {
    log.info("expired superseded Apple purchases", {
      projectId: args.projectId,
      originalTransactionId: args.originalTransactionId,
      expired: superseded.length,
    });
  }
  return { expired: superseded.length, superseded };
}
