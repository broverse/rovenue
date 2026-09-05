import { PurchaseStatus, drizzle, type Db } from "@rovenue/db";
import { PRODUCT_CHANGE_PHASE_EFFECTIVE } from "@rovenue/shared";
import {
  SUBSCRIPTION_STATUS_SEMANTICS,
  type PlanChangeType,
} from "@rovenue/shared/subscription-status";
import {
  APPLE_NOTIFICATION_SUBTYPE,
  type AppleNotificationSubtype,
} from "./apple/apple-types";

/**
 * Re-exported so this module stays the one place the api reads plan-change
 * vocabulary from. It is DEFINED in `@rovenue/shared/subscription-status`
 * because `packages/db`'s schema types `purchases.pendingChangeType` with
 * it, and packages/db cannot import from apps/api.
 */
export type { PlanChangeType };

/**
 * The public lifecycle key a plan change is announced under. Also present
 * in `STORE_EVENT_TO_PUBLIC_KEY` (packages/shared/src/store-event-normalization.ts)
 * for the store events that mean "a change was ANNOUNCED" — this one is
 * emitted for the narrower, and more useful, fact that the product on a
 * purchase actually moved.
 */
const PRODUCT_CHANGED_EVENT_KEY = "subscription.product_changed";

/** Outbox aggregate every subscription-lifecycle key is filed under. */
const SUBSCRIPTION_AGGREGATE = "SUBSCRIPTION" as const;

/**
 * Apple is the only store that states the direction of a plan change.
 *
 * Deriving it elsewhere was considered and rejected: `purchases.priceAmount`
 * is the amount the store CHARGED, and a prorated upgrade charges less
 * than list price, so a price comparison labels upgrades as downgrades.
 * `products` carries neither price nor period, and calling the store
 * catalog from a webhook path is not acceptable. A null direction is
 * honest; a guessed one corrupts every cohort built on it.
 */
export function applePlanChangeType(
  subtype: AppleNotificationSubtype | undefined,
): PlanChangeType | null {
  if (subtype === APPLE_NOTIFICATION_SUBTYPE.UPGRADE) return "UPGRADE";
  if (subtype === APPLE_NOTIFICATION_SUBTYPE.DOWNGRADE) return "DOWNGRADE";
  return null;
}

/**
 * The three `purchases.pending*` columns, as a unit. Always written
 * together — a pending change is a single fact, and leaving two of the
 * three behind from an earlier announcement is how a stale row starts
 * claiming a change that is no longer coming.
 */
export interface PendingPlanChangeFields {
  pendingProductId: string | null;
  pendingChangeType: PlanChangeType | null;
  pendingChangeEffectiveAt: Date | null;
}

/**
 * Project the store's LIVE announcement of a not-yet-effective plan change
 * onto the three pending columns.
 *
 * These fields are a projection, not an accumulator: every guarded sync
 * rewrites all three from what the store says right now. That is what makes
 * the two clearing rules fall out for free rather than needing a second
 * read of the row —
 *   - the change took effect (`announcedProductId === writtenProductId`), and
 *   - the store reverted it (the announcement is simply gone).
 *
 * A pending change NEVER touches access. The old row is retired only when
 * the store reports it was actually superseded (Apple's upgrade
 * notification, Google's `linkedPurchaseToken`) — never on intent, or a
 * scheduled downgrade would revoke a paid-up subscriber's entitlement
 * weeks early.
 */
export function pendingPlanChangeFields(args: {
  /** The product being written onto the purchase row by this sync. */
  writtenProductId: string;
  /** The product the store says will apply later, or null if it says none. */
  announcedProductId: string | null;
  changeType: PlanChangeType | null;
  effectiveAt: Date | null;
}): PendingPlanChangeFields {
  if (
    args.announcedProductId === null ||
    args.announcedProductId === args.writtenProductId
  ) {
    return {
      pendingProductId: null,
      pendingChangeType: null,
      pendingChangeEffectiveAt: null,
    };
  }
  return {
    pendingProductId: args.announcedProductId,
    pendingChangeType: args.changeType,
    pendingChangeEffectiveAt: args.effectiveAt,
  };
}

/**
 * Emit the public `subscription.product_changed` key. Called by all three
 * stores from the one place each has the before-image: the guard result
 * (`GuardStatusWriteResult.previous`, read under the same FOR UPDATE lock
 * as the write).
 *
 * `db` must be the caller's transaction handle — the outbox row and the
 * purchase write commit together or not at all (outbox is the only path
 * to Kafka; never write a domain table and Kafka in the same code path).
 *
 * No-ops when the product did not actually move, so callers may call it
 * unconditionally on any guarded upsert.
 */
export async function emitProductChanged(args: {
  db: Db;
  projectId: string;
  subscriberId: string;
  purchaseId: string;
  previousProductId: string;
  productId: string;
  changeType: PlanChangeType | null;
  now: Date;
}): Promise<void> {
  if (args.previousProductId === args.productId) return;
  await drizzle.outboxRepo.insert(args.db, {
    aggregateType: SUBSCRIPTION_AGGREGATE,
    aggregateId: args.subscriberId,
    eventType: PRODUCT_CHANGED_EVENT_KEY,
    payload: {
      projectId: args.projectId,
      subscriberId: args.subscriberId,
      purchaseId: args.purchaseId,
      previousProductId: args.previousProductId,
      productId: args.productId,
      changeType: args.changeType,
      // Distinguishes this row from the outbox bridge's ANNOUNCEMENT row
      // for the same key — one real plan change can deliver both, and
      // without a discriminator a consumer cannot tell "a change is
      // coming" from "the change happened". See the two-phase contract
      // beside `subscription.product_changed` in
      // packages/shared/src/integrations.ts.
      phase: PRODUCT_CHANGE_PHASE_EFFECTIVE,
      timestamp: args.now.toISOString(),
    },
  });
}

/**
 * The public lifecycle key for a subscription leaving BILLING_ISSUE into a
 * status that grants access again. Already present in
 * `STORE_EVENT_TO_PUBLIC_KEY` for Google's own `SUBSCRIPTION_RECOVERED`
 * event type — this is the SAME key, produced by a second route for the
 * two stores that send no such event type at all.
 */
const SUBSCRIPTION_RECOVERED_EVENT_KEY = "subscription.recovered";

/**
 * Emit the public `subscription.recovered` key for Apple and Stripe, whose
 * webhooks carry no dedicated "you recovered" event type the way Google's
 * `SUBSCRIPTION_RECOVERED` does.
 *
 * `packages/shared/src/store-event-normalization.ts` used to explain why
 * this was NOT done: inferring a recovery from an `invoice.paid` following
 * a `payment_failed` fires on unrelated renewals too. That reasoning no
 * longer applies here, because the predicate below is not an inference —
 * it reads the guard's own before-image
 * (`GuardStatusWriteResult.previous`, taken under the same FOR UPDATE lock
 * as the write) and only fires when the row actually SAT in BILLING_ISSUE
 * immediately before this write. An ordinary renewal on an already-ACTIVE
 * row has no BILLING_ISSUE before-image, so it cannot trigger this.
 *
 * "Grants access again" is read off `SUBSCRIPTION_STATUS_SEMANTICS` rather
 * than hand-listing statuses, so a future status addition inherits the
 * right behavior instead of silently missing it.
 *
 * `db` must be the caller's transaction handle — same invariant as
 * `emitProductChanged`: the outbox row and the purchase write commit
 * together or not at all. Callers must also gate on `apply` being true
 * themselves before relying on `status` — this function additionally
 * checks it so a caller can never accidentally announce a withheld write.
 *
 * `previousStatus` is the guard's before-image (`guard.previous?.status`)
 * for every store whose recovering delivery lands on the SAME key that
 * held the failure — Stripe (stable subscription id) and Google. Apple is
 * the exception: it mints a new transactionId for the renewal that
 * recovers a failed one, so the recovering delivery's own before-image is
 * null and the BILLING_ISSUE lives on a SIBLING row in the same chain.
 * The parameter is therefore a plain status rather than the whole guard
 * result, so the Apple path can supply the status it established
 * chain-wide (see `retireChainBillingIssue`) instead of being silently
 * inert.
 */
export async function emitSubscriptionRecovered(args: {
  db: Db;
  projectId: string;
  subscriberId: string;
  purchaseId: string;
  apply: boolean;
  previousStatus: PurchaseStatus | null;
  status: PurchaseStatus;
  now: Date;
}): Promise<void> {
  if (
    !args.apply ||
    args.previousStatus !== PurchaseStatus.BILLING_ISSUE ||
    !SUBSCRIPTION_STATUS_SEMANTICS[args.status].grantsAccess
  ) {
    return;
  }
  await drizzle.outboxRepo.insert(args.db, {
    aggregateType: SUBSCRIPTION_AGGREGATE,
    aggregateId: args.subscriberId,
    eventType: SUBSCRIPTION_RECOVERED_EVENT_KEY,
    payload: {
      projectId: args.projectId,
      subscriberId: args.subscriberId,
      purchaseId: args.purchaseId,
      previousStatus: args.previousStatus,
      status: args.status,
      timestamp: args.now.toISOString(),
    },
  });
}
