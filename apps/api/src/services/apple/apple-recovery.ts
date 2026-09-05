import { PurchaseStatus, Store, type Db, drizzle } from "@rovenue/db";
import { guardStatusWrite } from "../subscription-transition-guard";
import { logger } from "../../lib/logger";

const log = logger.child("apple-recovery");

// =============================================================
// Apple billing-issue recovery
// =============================================================
//
// The counterpart to apple-supersede.ts, for the OTHER consequence of
// Apple minting a new transactionId per billing period.
//
// `applyFailedRenewal` writes BILLING_ISSUE chain-wide, onto the row of
// the transaction that failed. The renewal that eventually SUCCEEDS
// carries a brand-new transactionId, so `guardStatusWrite`'s before-image
// for that key is null: nothing in the recovering delivery can see that
// the subscription was in billing trouble. Two things break as a result —
//
//   1. `subscription.recovered` never fires for Apple at all. It is gated
//      on a BILLING_ISSUE before-image, and there isn't one.
//   2. The old BILLING_ISSUE row is never resolved. It is not sweepable,
//      so it sits until `runBillingIssueAgeing` retires it 60 days later,
//      emitting `subscription.expired` and a zero-amount CANCELLATION for
//      a subscriber who has been paying the whole time.
//
// Resolving the chain is what fixes both: the retirement gives the
// recovering delivery a truthful "this chain WAS in BILLING_ISSUE" signal
// (so the emit can fire exactly once) and removes the row that would
// otherwise age out.
//
// The stale rows are retired to EXPIRED, not to the recovering status:
// their billing period genuinely ended, and the new transaction's own row
// is the one that carries the live entitlement. EXPIRED is written the
// same way apple-supersede.ts writes it — through the guard, directly,
// WITHOUT the expiry worker's `subscription.expired` + CANCELLATION
// bookkeeping. Announcing an expiry here would be exactly the false
// signal this function exists to prevent.

/**
 * Retire every BILLING_ISSUE row on this Apple chain other than the
 * incoming transaction's own, and report whether any actually moved.
 *
 * `db` MUST be the caller's transaction handle: the retirement and the
 * caller's `subscription.recovered` outbox row have to commit together.
 * If the retirement committed alone, a redelivery would find no
 * BILLING_ISSUE row, retire nothing, and the recovery event would be lost
 * permanently — the same failure mode `expireSupersededApplePurchases`
 * documents for its `onSuperseded` callback.
 *
 * Idempotent by construction: a replay finds the rows already EXPIRED,
 * matches nothing, and returns `retired: 0`, so the caller emits nothing.
 */
export async function retireChainBillingIssue(args: {
  db: Db;
  projectId: string;
  originalTransactionId: string;
  /** The recovering transaction's own id — never retire the live row. */
  excludeStoreTransactionId: string;
  now: Date;
  source: string;
}): Promise<{ retired: number }> {
  const stale =
    await drizzle.purchaseExtRepo.findChainBillingIssuePurchases(args.db, {
      projectId: args.projectId,
      originalTransactionId: args.originalTransactionId,
      excludeStoreTransactionId: args.excludeStoreTransactionId,
    });
  if (stale.length === 0) return { retired: 0 };

  let retired = 0;
  for (const row of stale) {
    const guard = await guardStatusWrite({
      db: args.db,
      projectId: args.projectId,
      store: Store.APP_STORE,
      storeTransactionId: row.storeTransactionId,
      to: PurchaseStatus.EXPIRED,
      source: `${args.source}:apple_billing_issue_recovered`,
      eventTime: args.now,
    });
    if (!guard.apply) continue;
    await drizzle.purchaseRepo.updatePurchase(args.db, row.id, {
      status: PurchaseStatus.EXPIRED,
      lastStoreEventAt: args.now,
    });
    retired += 1;
  }

  if (retired > 0) {
    log.info("retired stale BILLING_ISSUE rows on a recovered Apple chain", {
      projectId: args.projectId,
      originalTransactionId: args.originalTransactionId,
      retired,
    });
  }
  return { retired };
}
