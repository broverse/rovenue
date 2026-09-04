import { PurchaseStatus, Store, type Db, drizzle } from "@rovenue/db";
import { guardStatusWrite } from "../subscription-transition-guard";
import { logger } from "../../lib/logger";

const log = logger.child("google-supersede");

// =============================================================
// linkedPurchaseToken supersession
// =============================================================
//
// When a Play subscription is replaced (upgrade/downgrade), Google issues a
// NEW purchase token and points at the retired one via
// `linkedPurchaseToken` — and does NOT reliably send an independent RTDN
// for the old token. Without this step the old token's purchase row keeps
// whatever status/expiresDate it last synced (typically ACTIVE with a
// frozen future expiry), and the access engine — which unions granting
// access across ALL of a subscriber's rows — keeps the old tier's
// entitlements alive for up to a full billing period after a downgrade.

/** The row this call actually moved to EXPIRED, if any. */
export interface SupersededGooglePurchase {
  purchaseId: string;
  /** The product the subscriber was on before the replacement. */
  productId: string;
}

/**
 * Expire the purchase row keyed by the superseded (old) purchase token and
 * revoke its denormalized access. Idempotent: a replay finds the row
 * already EXPIRED (guard withholds) and the access revoke is a no-op.
 * Terminal rows (REFUNDED/REVOKED) keep their status — the guard refuses
 * the EXPIRED write — but their access is revoked either way (it already
 * was; revoking again is harmless).
 *
 * Returns the row it ACTUALLY retired, or null. The caller emits it as the
 * `previousProductId` of `subscription.product_changed`: an immediate Play
 * upgrade/downgrade (replacement mode WITH_TIME_PRORATION /
 * CHARGE_PRORATED_PRICE) issues a NEW purchase token, so the replacing
 * row is an INSERT whose guard before-image is null — this retired row is
 * the only place the old product survives. Returning only what this call
 * moved is what keeps the emit replay-safe: a redelivered RTDN finds the
 * old token already EXPIRED and returns null.
 */
export async function expireSupersededGooglePurchase(args: {
  projectId: string;
  /** `linkedPurchaseToken` from the replacing purchase. */
  supersededToken: string;
  /** The replacing purchase's own token — guards against self-expiry. */
  currentToken: string;
  /** Origin tag for the transition audit trail. */
  source: string;
  /**
   * Invoked INSIDE the same transaction as the expiry write, when this
   * call actually retired the row, with that transaction's handle.
   *
   * The caller's `subscription.product_changed` outbox row must commit
   * with the retirement that makes the plan change true: the emit is gated
   * on the row having MOVED, so a crash between a committed retirement and
   * a separate outbox write would make the redelivery suppress an event
   * that was never written, losing it permanently.
   */
  onSuperseded?: (tx: Db, retired: SupersededGooglePurchase) => Promise<void>;
}): Promise<SupersededGooglePurchase | null> {
  const { projectId, supersededToken, currentToken, source } = args;
  if (supersededToken === currentToken) return null;

  const old = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
    projectId,
    Store.PLAY_STORE,
    supersededToken,
  );
  // No row for the old token: the chain predates this project's Rovenue
  // history (or the old token was never synced) — nothing to supersede.
  if (!old) return null;

  const now = new Date();
  let retired: SupersededGooglePurchase | null = null;
  // Guard + expiry write + the caller's emit in ONE transaction. The guard
  // takes a FOR UPDATE lock; running it on the pool handle (as this did
  // before) released that lock before the write, so this also brings the
  // path in line with mechanism (a) used by every other supersede/upsert
  // site. Access is revoked AFTER the commit, mirroring apple-supersede:
  // it is re-derived from the whole purchase set and must not hold the
  // subscriber's advisory lock inside this transaction.
  await drizzle.db.transaction(async (tx) => {
    const guard = await guardStatusWrite({
      db: tx,
      projectId,
      store: Store.PLAY_STORE,
      storeTransactionId: supersededToken,
      to: PurchaseStatus.EXPIRED,
      source: `${source}:linked_token_supersede`,
      eventTime: now,
    });
    if (!guard.apply) return;
    // EXPIRED is not a TERMINAL status, so the guard applies an
    // EXPIRED -> EXPIRED write on a redelivered RTDN too. Re-writing is
    // harmless; reporting it as a supersession is not, because the caller
    // emits `subscription.product_changed` for a returned row and would
    // emit the same plan change twice. Only a row that actually MOVED
    // counts as retired.
    const alreadyExpired = guard.previous?.status === PurchaseStatus.EXPIRED;
    await drizzle.purchaseRepo.updatePurchase(tx, old.id, {
      status: PurchaseStatus.EXPIRED,
      expiresDate: now,
      autoRenewStatus: false,
      lastStoreEventAt: now,
    });
    if (!alreadyExpired) {
      const row: SupersededGooglePurchase = {
        purchaseId: old.id,
        productId: old.productId,
      };
      retired = row;
      await args.onSuperseded?.(tx, row);
    }
    log.info("expired superseded purchase", {
      projectId,
      purchaseId: old.id,
      tokenPrefix: supersededToken.slice(0, 12),
    });
  });
  await drizzle.accessRepo.revokeAccessByPurchaseId(drizzle.db, old.id);
  return retired;
}
