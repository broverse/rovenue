import { PurchaseStatus, drizzle, type Store } from "@rovenue/db";
import { ACCESS_GRANTING_STATUSES } from "@rovenue/shared/subscription-status";
import { logger } from "../lib/logger";

const log = logger.child("access-engine");

// Derived from the shared status-semantics table — see
// packages/shared/src/subscription-status.ts. A new status that grants
// access is picked up here automatically.
const ACCESS_GRANTING: ReadonlySet<PurchaseStatus> = new Set<PurchaseStatus>(
  ACCESS_GRANTING_STATUSES,
);

// Derived from the repo's return type rather than re-declared, so this
// stays byte-for-byte identical to what `findPurchasesWithAccessIds`
// actually returns without packages/db needing to export it separately.
type PurchaseWithAccessIds = Awaited<
  ReturnType<typeof drizzle.accessRepo.findPurchasesWithAccessIds>
>[number];

export interface DesiredAccess {
  purchaseId: string;
  expiresDate: Date | null;
  store: Store;
}

/**
 * When a purchase's entitlement actually ends — which is not always its
 * `expiresDate`.
 *
 * For every status but GRACE_PERIOD it IS `expiresDate`. GRACE_PERIOD is
 * the exception, and it has to be: a subscription only enters grace once
 * its paid period has LAPSED, so a grace purchase's `expiresDate` is in
 * the past by definition. Reading grace access off `expiresDate` meant
 * `grantsAccess: true` in the shared status table (packages/shared/src/
 * subscription-status.ts) granted precisely nothing, and the distinction
 * between GRACE_PERIOD (payment retry WITH access) and BILLING_ISSUE
 * (retry without) existed only on paper.
 *
 * Two deliberate decisions live here:
 *
 * 1. A NULL `gracePeriodExpires` is NOT infinite. It means the store did
 *    not state a window, so there is no known grace period to honour and
 *    the purchase falls back to `expiresDate` — exactly the pre-existing
 *    behaviour. Treating unknown as unbounded would hand permanent
 *    access to someone who has not paid, on the strength of a missing
 *    field.
 *
 * 2. The answer is the LATER of the two dates, never just the grace one.
 *    A store can mark a subscription in grace before its paid period
 *    ends (Stripe `past_due` on a renewal invoice, for one), and such a
 *    purchase grants access until `expiresDate` today. Taking the max
 *    makes this change strictly additive: no purchase's entitlement
 *    window can come out shorter than it is now.
 *
 * `isLaterExpiry` below is NOT reused for the comparison: it treats null
 * as "longest-lived", which is right for `expiresDate` (a lifetime
 * purchase never lapses) and wrong for `gracePeriodExpires` (an unstated
 * window is unknown, not eternal).
 *
 * EXPORTED, and structurally typed rather than taking a whole purchase
 * row, because the three store webhook handlers write access rows of
 * their own on the ingestion path. They used to write `purchase
 * .expiresDate` directly, which for a GRACE_PERIOD purchase is the
 * PRE-grace date the read path will not serve. That was masked only by
 * `syncAccess` running afterwards and overwriting the row — the invariant
 * held by ORDERING rather than by construction, and a crash between the
 * two left a grant that served nothing. One rule, one function, every
 * writer.
 */
export function entitlementExpiry(purchase: {
  // `string`, not `PurchaseStatus`: `findPurchasesWithAccessIds` returns
  // the column as a bare string, and the same widening lets a caller pass
  // a row straight from any repository without a cast. The one comparison
  // below is against a PurchaseStatus member, so a value outside the enum
  // simply is not GRACE_PERIOD.
  status: PurchaseStatus | string;
  expiresDate: Date | null;
  gracePeriodExpires: Date | null;
}): Date | null {
  if (purchase.status !== PurchaseStatus.GRACE_PERIOD) {
    return purchase.expiresDate;
  }
  // A non-expiring purchase in grace is already the longest-lived grant
  // there is; no grace window can extend it.
  if (purchase.expiresDate === null) return null;
  const grace = purchase.gracePeriodExpires;
  if (grace === null) return purchase.expiresDate;
  return grace.getTime() > purchase.expiresDate.getTime()
    ? grace
    : purchase.expiresDate;
}

/**
 * The authoritative answer to "what access should this subscriber have
 * right now", derived purely from their purchases. Pure and exported so
 * the drift reconciler (workers/access-reconciliation.ts) checks against
 * the EXACT function syncAccess writes from — a second implementation of
 * this rule would rot against the first, which is the failure this
 * codebase has already paid for in analytics.
 *
 * The expiry this returns is written verbatim onto `subscriber_access`
 * by `syncAccess`, and the read path (`accessRepo.findActiveAccess`)
 * serves a row only while `expiresDate > now`. So the entitlement window
 * computed here IS the window the SDK sees: writing a grace purchase's
 * past `expiresDate` onto the row would store a grant that serves
 * nothing. Write and read agree on one date, and `entitlementExpiry`
 * above is where that date is decided.
 */
export function computeDesiredAccess(
  purchases: PurchaseWithAccessIds[],
  now: Date,
): Map<string, DesiredAccess> {
  const desired = new Map<string, DesiredAccess>();
  for (const purchase of purchases) {
    if (!ACCESS_GRANTING.has(purchase.status as PurchaseStatus)) continue;
    const expiresDate = entitlementExpiry(purchase);
    if (expiresDate && expiresDate < now) continue;

    for (const accessId of purchase.accessIds) {
      const existing = desired.get(accessId);
      if (!existing || isLaterExpiry(expiresDate, existing.expiresDate)) {
        desired.set(accessId, {
          purchaseId: purchase.id,
          expiresDate,
          store: purchase.store,
        });
      }
    }
  }
  return desired;
}

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

    const purchases = await drizzle.accessRepo.findPurchasesWithAccessIds(
      tx,
      subscriberId,
    );

    const desired = computeDesiredAccess(purchases, new Date());

    const current = await drizzle.accessRepo.findAllAccessBySubscriber(
      tx,
      subscriberId,
    );

    for (const record of current) {
      const target = desired.get(record.accessId);
      const isSource = target?.purchaseId === record.purchaseId;
      if (!isSource && record.isActive) {
        await drizzle.accessRepo.setAccessActive(tx, record.id, false);
      }
    }

    for (const [accessId, target] of desired) {
      const existing = current.find(
        (r) =>
          r.accessId === accessId && r.purchaseId === target.purchaseId,
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
          accessId,
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
  accessId: string,
): Promise<boolean> {
  const records = await drizzle.accessRepo.findActiveAccess(
    drizzle.db,
    subscriberId,
    new Date(),
  );
  return records.some((r) => r.accessId === accessId);
}

export async function getActiveAccess(
  subscriberId: string,
): Promise<Record<string, ActiveAccessEntry>> {
  const now = new Date();
  const records = await drizzle.accessRepo.findActiveAccess(
    drizzle.db,
    subscriberId,
    now,
  );

  const result: Record<string, ActiveAccessEntry> = {};
  for (const record of records) {
    const existing = result[record.accessId];
    if (
      !existing ||
      isLaterExpiry(record.expiresDate, existing.expiresDate)
    ) {
      result[record.accessId] = {
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
