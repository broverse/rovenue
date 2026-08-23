import { PurchaseStatus, Store, drizzle } from "@rovenue/db";
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

/**
 * Expire the purchase row keyed by the superseded (old) purchase token and
 * revoke its denormalized access. Idempotent: a replay finds the row
 * already EXPIRED (guard withholds) and the access revoke is a no-op.
 * Terminal rows (REFUNDED/REVOKED) keep their status — the guard refuses
 * the EXPIRED write — but their access is revoked either way (it already
 * was; revoking again is harmless).
 */
export async function expireSupersededGooglePurchase(args: {
  projectId: string;
  /** `linkedPurchaseToken` from the replacing purchase. */
  supersededToken: string;
  /** The replacing purchase's own token — guards against self-expiry. */
  currentToken: string;
  /** Origin tag for the transition audit trail. */
  source: string;
}): Promise<void> {
  const { projectId, supersededToken, currentToken, source } = args;
  if (supersededToken === currentToken) return;

  const old = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
    projectId,
    Store.PLAY_STORE,
    supersededToken,
  );
  // No row for the old token: the chain predates this project's Rovenue
  // history (or the old token was never synced) — nothing to supersede.
  if (!old) return;

  const now = new Date();
  const guard = await guardStatusWrite({
    db: drizzle.db,
    projectId,
    store: Store.PLAY_STORE,
    storeTransactionId: supersededToken,
    to: PurchaseStatus.EXPIRED,
    source: `${source}:linked_token_supersede`,
  });
  if (guard.apply) {
    await drizzle.purchaseRepo.updatePurchase(drizzle.db, old.id, {
      status: PurchaseStatus.EXPIRED,
      expiresDate: now,
      autoRenewStatus: false,
    });
    log.info("expired superseded purchase", {
      projectId,
      purchaseId: old.id,
      tokenPrefix: supersededToken.slice(0, 12),
    });
  }
  await drizzle.accessRepo.revokeAccessByPurchaseId(drizzle.db, old.id);
}
