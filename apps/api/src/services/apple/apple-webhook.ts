import {
  Environment,
  PurchaseStatus,
  RevenueEventType,
  Store,
  WebhookEventStatus,
  WebhookSource,
  drizzle,
  revenueDedupeKind,
} from "@rovenue/db";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import {
  incRefundShieldOutcomeApproved,
  incRefundShieldOutcomeDeclined,
  incRefundShieldOutcomeReversed,
  incRefundShieldReceived,
} from "../../lib/metrics-refund-shield";
import { loadAppleCredentials } from "../../lib/project-credentials";
import { convertToUsd } from "../fx";
import { maybeEmitRefundDetected } from "../notifications/refund-emit";
import { appleStorefrontToCountry } from "./apple-country";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_SUBTYPE,
  APPLE_NOTIFICATION_TYPE,
  APPLE_OFFER_TYPE,
  type AppleEnvironment,
  type AppleJwsRenewalInfoPayload,
  type AppleJwsTransactionPayload,
  type AppleNotificationType,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import {
  createAppleVerifier,
  decodeUnverifiedJws,
  JoseAppleNotificationVerifier,
  type AppleKeyLookup,
  type AppleNotificationVerifier,
} from "./apple-verify";
import { guardStatusWrite } from "../subscription-transition-guard";
import {
  applePlanChangeType,
  emitProductChanged,
  emitSubscriptionRecovered,
  pendingPlanChangeFields,
} from "../subscription-plan-change";
import { billingIssueStamp } from "../subscription-state";
import { entitlementExpiry } from "../access-engine";
import { audit } from "../../lib/audit";
import { expireSupersededApplePurchases } from "./apple-supersede";
import { retireChainBillingIssue } from "./apple-recovery";
import type { StoreEventContext } from "@rovenue/shared";
import {
  SUBSCRIPTION_STATUS_SEMANTICS,
  TERMINAL_STATUSES,
} from "@rovenue/shared/subscription-status";
// Type-only: no runtime cycle with webhook-processor (which imports us).
import type { WebhookPostProcess } from "../webhook-processor";

const log = logger.child("apple-webhook");

/**
 * Chain-wide status write that refuses to resurrect a terminal row.
 *
 * The three non-refund chain transitions (DID_FAIL_TO_RENEW,
 * EXPIRED, REVOKE) propagate across the whole transaction chain via
 * `updatePurchasesByOriginalTransaction`, which has no per-row guard.
 * A late / replayed one of these on a chain whose row is already
 * REFUNDED / REVOKED would silently overwrite that terminal state
 * (e.g. a failed-renewal resurrecting a refunded purchase). This
 * routes the write through the data-layer guard
 * (`updateChainStatusGuarded`, `WHERE status NOT IN
 * ('REFUNDED','REVOKED')`) and writes one
 * `subscription.transition_rejected` audit row per skipped terminal
 * row so the withheld transition is tamper-evidently recorded.
 *
 * The single-transaction REFUND chain-revoke in `applyRefund` is the
 * spec's intentional non-goal and does NOT route through here.
 */
async function guardedChainStatusWrite(
  ctx: DispatchContext,
  patch: { status: PurchaseStatus; [key: string]: unknown },
): Promise<{ updatedCount: number; skippedCount: number }> {
  const { updatedIds, skippedTerminalIds } =
    await drizzle.purchaseRepo.updateChainStatusGuarded(
      drizzle.db,
      ctx.projectId,
      ctx.transaction.originalTransactionId,
      patch,
    );

  if (skippedTerminalIds.length === 0) {
    return { updatedCount: updatedIds.length, skippedCount: 0 };
  }

  log.warn("withheld chain status write on terminal rows", {
    projectId: ctx.projectId,
    originalTransactionId: ctx.transaction.originalTransactionId,
    attemptedStatus: patch.status,
    source: `apple:${ctx.notification.notificationType}`,
    skipped: skippedTerminalIds.length,
  });

  for (const id of skippedTerminalIds) {
    await audit({
      projectId: ctx.projectId,
      userId: "system",
      action: "subscription.transition_rejected",
      resource: "purchase",
      resourceId: id,
      before: null,
      after: {
        status: patch.status,
        originalTransactionId: ctx.transaction.originalTransactionId,
        source: `apple:${ctx.notification.notificationType}`,
      },
      ipAddress: null,
      userAgent: null,
    });
  }

  return {
    updatedCount: updatedIds.length,
    skippedCount: skippedTerminalIds.length,
  };
}

export interface HandleAppleNotificationOptions {
  projectId: string;
  signedPayload: string;
  /**
   * Explicit verifier. If omitted, the handler builds a
   * LibraryAppleNotificationVerifier using project.appleCredentials +
   * APPLE_ROOT_CERTS_DIR. In production, missing credentials throw.
   */
  verifier?: AppleNotificationVerifier;
  keyLookup?: AppleKeyLookup;
  /**
   * Side effects (access sync, consumable credit, outgoing webhook),
   * injected by webhook-processor. Runs AFTER dispatch but BEFORE the
   * row is marked PROCESSED: a failure lands in the catch below
   * (row → FAILED, re-claimable) and rethrows so BullMQ retries —
   * marking PROCESSED first would dedupe the retry to `duplicate` and
   * lose the side effect permanently.
   */
  postProcess?: WebhookPostProcess;
}

export type HandleAppleNotificationResult =
  | {
      status: "processed";
      notificationType: AppleNotificationType;
      webhookEventId: string;
      subscriberId?: string;
      purchaseId?: string;
    }
  | {
      status: "duplicate";
      notificationType: AppleNotificationType;
    };

interface DispatchOutcome {
  subscriberId?: string;
  purchaseId?: string;
  /**
   * Disambiguating fact for `postProcess`'s bridge to the outbox (see
   * `WebhookPostProcess.eventContext`, webhook-processor.ts). Set by the
   * two handlers whose Apple event type means two different real-world
   * facts: `applyRenewalStatusChange` (auto-renew direction) and
   * `applyFailedRenewal` (whether the retry keeps access). Every other
   * handler leaves this undefined and the bridge behaves exactly as
   * before this field existed.
   */
  eventContext?: StoreEventContext;
}

interface DispatchContext {
  projectId: string;
  notification: AppleResponseBodyV2DecodedPayload;
  transaction: AppleJwsTransactionPayload;
  renewalInfo?: AppleJwsRenewalInfoPayload;
  outcome: DispatchOutcome;
}

// =============================================================
// Main entry
// =============================================================

export async function handleAppleNotification(
  opts: HandleAppleNotificationOptions,
): Promise<HandleAppleNotificationResult> {
  const verifier = await resolveVerifier(opts);
  const notification = await verifier.verifyNotification(opts.signedPayload);

  // Atomic single-flight claim — exactly one concurrent worker wins.
  const claim = await drizzle.webhookEventRepo.claimWebhookEvent(drizzle.db, {
    projectId: opts.projectId,
    source: WebhookSource.APPLE,
    eventType: notification.notificationType,
    storeEventId: notification.notificationUUID,
    // signedPayload is stored alongside the decoded notification so the
    // webhook reaper can rebuild and re-enqueue the processing job for
    // a stranded row (the replay re-verifies the JWS like any delivery).
    payload: {
      signedPayload: opts.signedPayload,
      notification: JSON.parse(JSON.stringify(notification)),
    },
  });

  if (claim.outcome === "duplicate") {
    log.info("notification already processed, skipping", {
      uuid: notification.notificationUUID,
      type: notification.notificationType,
    });
    return {
      status: "duplicate",
      notificationType: notification.notificationType,
    };
  }
  if (claim.outcome === "in_progress") {
    // Another worker holds a fresh claim. Throw so BullMQ retries with
    // backoff instead of acking — prevents the historical bug where a
    // retry of our own crashed attempt silently dropped the event.
    throw new Error(
      `webhook ${notification.notificationUUID} claim in progress; retry`,
    );
  }
  const webhookEvent = claim.row;

  try {
    const transaction = notification.data?.signedTransactionInfo
      ? await verifier.verifyTransaction(
          notification.data.signedTransactionInfo,
        )
      : undefined;
    const renewalInfo = notification.data?.signedRenewalInfo
      ? await verifier.verifyRenewalInfo(notification.data.signedRenewalInfo)
      : undefined;

    const outcome: DispatchOutcome = {};
    if (transaction) {
      await dispatch({
        projectId: opts.projectId,
        notification,
        transaction,
        renewalInfo,
        outcome,
      });
    } else if (
      notification.notificationType ===
      APPLE_NOTIFICATION_TYPE.EXTERNAL_PURCHASE_TOKEN
    ) {
      // EU DMA / US link entitlement. This is the ONLY notification we act
      // on without a transaction, and it is handled here rather than in
      // `dispatch()` because dispatch requires one — Apple sends
      // `externalPurchaseToken` INSTEAD of `data`, never alongside it.
      //
      // Recorded as a PROJECT-level fact. No subscriber is resolved,
      // because the payload contains nothing that identifies one:
      // `appAppleId` is the app and `externalPurchaseId` is Apple's opaque
      // id for the purchase. No revenue event either — Apple did not
      // process this purchase and we have no amount for it. Inferring
      // either from timing or recency is the shape this codebase refuses.
      await recordExternalPurchaseToken(
        opts.projectId,
        notification,
        webhookEvent.id,
      );
    } else {
      log.info("notification without transaction info, acknowledging", {
        uuid: notification.notificationUUID,
        type: notification.notificationType,
      });
    }

    // Side effects BEFORE the PROCESSED mark — see postProcess docs.
    if (opts.postProcess) {
      await opts.postProcess({
        webhookEventId: webhookEvent.id,
        eventType: notification.notificationType,
        subscriberId: outcome.subscriberId,
        purchaseId: outcome.purchaseId,
        eventContext: outcome.eventContext,
      });
    }

    await drizzle.webhookEventRepo.updateWebhookEvent(
      drizzle.db,
      webhookEvent.id,
      {
        status: WebhookEventStatus.PROCESSED,
        processedAt: new Date(),
        subscriberId: outcome.subscriberId,
        purchaseId: outcome.purchaseId,
      },
    );

    return {
      status: "processed",
      notificationType: notification.notificationType,
      webhookEventId: webhookEvent.id,
      subscriberId: outcome.subscriberId,
      purchaseId: outcome.purchaseId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await drizzle.webhookEventRepo.updateWebhookEvent(
      drizzle.db,
      webhookEvent.id,
      {
        status: WebhookEventStatus.FAILED,
        errorMessage: message,
        incrementRetryCount: true,
      },
    );
    log.error("notification processing failed", {
      uuid: notification.notificationUUID,
      type: notification.notificationType,
      err: message,
    });
    throw err;
  }
}

async function resolveVerifier(
  opts: HandleAppleNotificationOptions,
): Promise<AppleNotificationVerifier> {
  if (opts.verifier) return opts.verifier;

  let environment: AppleEnvironment | undefined;
  try {
    const peek =
      decodeUnverifiedJws<AppleResponseBodyV2DecodedPayload>(opts.signedPayload);
    environment = peek.data?.environment;
  } catch {
    // Malformed JWS — verification will fail downstream with a clearer
    // error; fall through to the default environment.
  }

  const creds = await loadAppleCredentials(opts.projectId);
  if (creds) {
    return createAppleVerifier({
      projectId: opts.projectId,
      bundleId: creds.bundleId,
      appAppleId: creds.appAppleId,
      environment,
    });
  }

  if (env.NODE_ENV === "production") {
    throw new Error(
      `Apple credentials not configured for project ${opts.projectId}; refusing to verify notification in production`,
    );
  }

  log.warn("no project Apple credentials; falling back to jose verifier", {
    projectId: opts.projectId,
  });
  return new JoseAppleNotificationVerifier(opts.keyLookup);
}

// =============================================================
// Dispatch
// =============================================================

async function dispatch(ctx: DispatchContext): Promise<void> {
  switch (ctx.notification.notificationType) {
    case APPLE_NOTIFICATION_TYPE.SUBSCRIBED:
      return applySubscribed(ctx);
    case APPLE_NOTIFICATION_TYPE.DID_RENEW:
      return applyRenewal(ctx);
    case APPLE_NOTIFICATION_TYPE.DID_CHANGE_RENEWAL_PREF:
      return applyRenewalPrefChange(ctx);
    case APPLE_NOTIFICATION_TYPE.DID_CHANGE_RENEWAL_STATUS:
      return applyRenewalStatusChange(ctx);
    case APPLE_NOTIFICATION_TYPE.OFFER_REDEEMED:
      return applyOfferRedeemed(ctx);
    case APPLE_NOTIFICATION_TYPE.DID_FAIL_TO_RENEW:
      return applyFailedRenewal(ctx);
    case APPLE_NOTIFICATION_TYPE.GRACE_PERIOD_EXPIRED:
    case APPLE_NOTIFICATION_TYPE.EXPIRED:
      return applyExpired(ctx);
    case APPLE_NOTIFICATION_TYPE.REFUND:
      return applyRefund(ctx);
    case APPLE_NOTIFICATION_TYPE.REFUND_DECLINED:
      return applyRefundDeclined(ctx);
    case APPLE_NOTIFICATION_TYPE.REFUND_REVERSED:
      return applyRefundReversed(ctx);
    case APPLE_NOTIFICATION_TYPE.REVOKE:
      return applyRevoke(ctx);
    case APPLE_NOTIFICATION_TYPE.CONSUMPTION_REQUEST:
      return applyConsumptionRequest(ctx);
    default:
      log.debug("no state change for notification type", {
        type: ctx.notification.notificationType,
      });
      return;
  }
}

// =============================================================
// Per-type handlers
// =============================================================

async function applySubscribed(ctx: DispatchContext): Promise<void> {
  const subscriber = await resolveSubscriber(ctx);
  const { product, purchase, statusApplied } = await upsertPurchase({
    ctx,
    subscriberId: subscriber.id,
    status: isTrial(ctx.transaction)
      ? PurchaseStatus.TRIAL
      : PurchaseStatus.ACTIVE,
    autoRenewStatus: ctx.renewalInfo?.autoRenewStatus === 1,
  });
  ctx.outcome.subscriberId = subscriber.id;
  ctx.outcome.purchaseId = purchase.id;
  // A rejected transition means the row is already terminal
  // (REFUNDED / REVOKED). Don't re-grant access or re-add revenue
  // off a late / replayed notification.
  if (!statusApplied) return;
  await grantAccess({ subscriber, purchase, product, ctx });
  await emitRevenueEvent({
    ctx,
    subscriberId: subscriber.id,
    purchaseId: purchase.id,
    productId: product.id,
    type:
      ctx.notification.subtype === APPLE_NOTIFICATION_SUBTYPE.RESUBSCRIBE
        ? RevenueEventType.REACTIVATION
        : RevenueEventType.INITIAL,
    // Same charge, possibly a different label than `applyOfferRedeemed`
    // would pick for it — filed under the one canonical key so whichever
    // notification arrives second loses the claim.
    firstChargeOfTransaction: true,
  });
}

async function applyRenewal(ctx: DispatchContext): Promise<void> {
  const subscriber = await resolveSubscriber(ctx);
  const { product, purchase, statusApplied } = await upsertPurchase({
    ctx,
    subscriberId: subscriber.id,
    status: PurchaseStatus.ACTIVE,
    autoRenewStatus: ctx.renewalInfo?.autoRenewStatus === 1,
  });
  ctx.outcome.subscriberId = subscriber.id;
  ctx.outcome.purchaseId = purchase.id;
  if (!statusApplied) return;
  await grantAccess({ subscriber, purchase, product, ctx });
  await emitRevenueEvent({
    ctx,
    subscriberId: subscriber.id,
    purchaseId: purchase.id,
    productId: product.id,
    type: RevenueEventType.RENEWAL,
  });
}

/**
 * DID_CHANGE_RENEWAL_PREF: the subscriber changed which product renews.
 *
 * Subtype UPGRADE is the only variant with an IMMEDIATE money/entitlement
 * effect: Apple charges the user right away and `signedTransactionInfo`
 * carries the NEW transaction (new productId / transactionId / price).
 * Ignoring it left the subscriber paying for the higher tier while still
 * entitled to the old one until the next DID_RENEW — weeks of misgranted
 * entitlement and uncounted upgrade revenue. Handle it exactly like a
 * SUBSCRIBED/DID_RENEW for the new transaction; the shared dedupe key on
 * the new transactionId makes replays no-ops.
 *
 * Subtype DOWNGRADE and the no-subtype "reverted the pending change" case
 * take effect at the NEXT renewal (that DID_RENEW carries the new
 * product), so they change no status, no access and no revenue now — but
 * they are the ONLY notifications that announce a pending change, so they
 * do record it (see `recordApplePendingChange`). Skipping them entirely,
 * as this path used to, meant Apple's pending columns were never written
 * by anything: the UPGRADE arm below writes a brand-new transaction row,
 * and by the following DID_RENEW `autoRenewProductId` already equals the
 * transaction's own product, so nothing is pending any more.
 */
async function applyRenewalPrefChange(ctx: DispatchContext): Promise<void> {
  if (ctx.notification.subtype !== APPLE_NOTIFICATION_SUBTYPE.UPGRADE) {
    log.debug("renewal pref change with no immediate effect", {
      subtype: ctx.notification.subtype ?? null,
    });
    // Record the announcement; take no effect. A scheduled downgrade must
    // NOT retire the paid-up term — the old row is retired only when the
    // store says it was actually superseded.
    await recordApplePendingChange(ctx);
    return;
  }

  // Apple has already charged and applied this upgrade, so the bridge's
  // ANNOUNCEMENT phase of `subscription.product_changed` ("the store says
  // a change is coming") is simply false here — and the effective-phase
  // row emitted below via `onSuperseded` is the true one. Suppress the
  // announcement so one instant does not produce two contradictory
  // deliveries of the same key. See the two-phase contract beside
  // `PRODUCT_CHANGE_PHASE_EFFECTIVE` in packages/shared/src/integrations.ts.
  ctx.outcome.eventContext = { applePrefChangeAlreadyApplied: true };

  const subscriber = await resolveSubscriber(ctx);
  const { product, purchase, statusApplied } = await upsertPurchase({
    ctx,
    subscriberId: subscriber.id,
    status: PurchaseStatus.ACTIVE,
    autoRenewStatus: ctx.renewalInfo?.autoRenewStatus === 1,
  });
  ctx.outcome.subscriberId = subscriber.id;
  ctx.outcome.purchaseId = purchase.id;
  // Rejected transition = the row is already terminal (REFUNDED/REVOKED);
  // a late/replayed upgrade must not re-grant access or re-add revenue.
  if (!statusApplied) return;
  // Retire the tier this upgrade replaced BEFORE granting the new one:
  // syncAccess recomputes the whole desired set inside one transaction
  // under the per-subscriber advisory lock, so ordering it this way
  // means no gap and no double-grant.
  //
  // The plan change itself rides along INSIDE that helper's transaction
  // (`onSuperseded`), not after it. `upsertPurchase` cannot emit it for an
  // Apple upgrade: Apple mints a NEW transactionId, so the guard locks a
  // key that has no row and its before-image is null. The row being
  // retired is the honest previous side, and the callback fires only for
  // rows this call actually MOVED — so a redelivered upgrade retires
  // nothing and emits nothing. Because that gate keys on movement, the
  // outbox row must commit with the retirement: a crash between the two
  // would make the redelivery suppress an event that was never written.
  // Apple is the one store that states a direction, so this is also the
  // only path on which `changeType` is ever non-null.
  await expireSupersededApplePurchases({
    projectId: ctx.projectId,
    originalTransactionId: ctx.transaction.originalTransactionId,
    currentStoreTransactionId: ctx.transaction.transactionId,
    now: appleNotificationEventTime(ctx),
    source: `apple:${ctx.notification.notificationType}`,
    onSuperseded: async (tx, retired) => {
      await emitProductChanged({
        db: tx,
        projectId: ctx.projectId,
        subscriberId: subscriber.id,
        purchaseId: purchase.id,
        previousProductId: retired.productId,
        productId: product.id,
        changeType: applePlanChangeType(ctx.notification.subtype),
        now: appleNotificationEventTime(ctx),
      });
    },
  });

  await grantAccess({ subscriber, purchase, product, ctx });
  await emitRevenueEvent({
    ctx,
    subscriberId: subscriber.id,
    purchaseId: purchase.id,
    productId: product.id,
    // First charge for the upgraded product — INITIAL keeps it in the
    // purchased-revenue bucket every analytics view already sums.
    type: RevenueEventType.INITIAL,
    // An upgrade can also arrive as OFFER_REDEEMED/UPGRADE, which labels
    // the same charge from the chain's status instead.
    firstChargeOfTransaction: true,
  });
}

/**
 * OFFER_REDEEMED: the subscriber redeemed a promotional offer, an offer
 * code, or a win-back offer.
 *
 * Until now this notification type was absent from `dispatch` altogether
 * and fell through the default branch, so a subscriber could come back
 * from a fully lapsed subscription on a win-back offer and produce no
 * state change, no revenue event and no lifecycle event. One handler has
 * to cover both a resurrection and an ordinary new paid term, because one
 * notification type carries both.
 *
 * THE REVENUE TYPE TURNS ON WHERE THE CHAIN WAS, not on the subtype: a
 * redemption against an EXPIRED chain is a genuine resurrection
 * (REACTIVATION); one against a live chain is a new paid term (INITIAL).
 * The subtype is not load-bearing here because it is OPTIONAL on the
 * envelope (`AppleResponseBodyV2DecodedPayload.subtype`) — a delivery
 * that carries none would silently classify as the not-RESUBSCRIBE case,
 * which is precisely the wrong answer for the win-back this exists for.
 * The chain's own status is always present and is the fact the revenue
 * rollups depend on.
 */
async function applyOfferRedeemed(ctx: DispatchContext): Promise<void> {
  // The chain's state BEFORE this delivery writes anything.
  //
  // `guard.previous` (the before-image `upsertPurchase`'s guard takes) is
  // keyed on (store, storeTransactionId), and Apple mints a NEW
  // transactionId for a redemption that charges — precisely the delivery
  // whose revenue type depends on where the subscription was. On those the
  // guard's before-image is null by construction, so the chain's latest
  // row is the only honest previous side. Read first, before anything
  // writes: `upsertPurchase` below is what creates the row that would
  // otherwise answer this query.
  const chainBefore =
    await drizzle.purchaseExtRepo.findPurchaseByOriginalTransaction(
      drizzle.db,
      ctx.projectId,
      ctx.transaction.originalTransactionId,
      // Scoped and ordered deterministically: an `originalTransactionId`
      // is Apple's, but the column is shared by every store and the CSV
      // importer can create a whole chain inside one statement, leaving
      // `createdAt` tied across rows. An arbitrary winner here would pick
      // the revenue label at random.
      { store: Store.APP_STORE },
    );

  // A DOWNGRADE redemption takes effect at the NEXT renewal and carries
  // the transaction currently in force — there is no new money and no new
  // entitlement, only an announcement. Writing ACTIVE for it is not the
  // no-op it looks like: if the row sits in GRACE_PERIOD or BILLING_ISSUE
  // the guard would APPLY that transition and `grantAccess` would re-grant
  // entitlement on the strength of an announcement, with nothing paid.
  //
  // Same ruling, same helper, as `applyRenewalPrefChange`'s non-UPGRADE
  // arm: record the pending change, take no effect. That helper stamps
  // `ctx.outcome` itself, so the `subscription.offer_redeemed` lifecycle
  // key still reaches the outbox — a campaign wants to know the offer was
  // redeemed even when the plan does not move until renewal.
  if (ctx.notification.subtype === APPLE_NOTIFICATION_SUBTYPE.DOWNGRADE) {
    log.debug("offer redeemed with no immediate effect", {
      subtype: ctx.notification.subtype,
    });
    await recordApplePendingChange(ctx);
    return;
  }

  // Apple has already charged and applied this upgrade, so the bridge's
  // ANNOUNCEMENT phase of `subscription.product_changed` ("the store says
  // a change is coming") is simply false here — and the effective-phase
  // row emitted below via `onSuperseded` is the true one. Suppress the
  // announcement so one instant does not produce two contradictory
  // deliveries of the same key. See the two-phase contract beside
  // `PRODUCT_CHANGE_PHASE_EFFECTIVE` in packages/shared/src/integrations.ts.
  ctx.outcome.eventContext = { applePrefChangeAlreadyApplied: true };

  const subscriber = await resolveSubscriber(ctx);
  const { product, purchase, statusApplied } = await upsertPurchase({
    ctx,
    subscriberId: subscriber.id,
    status: isTrial(ctx.transaction)
      ? PurchaseStatus.TRIAL
      : PurchaseStatus.ACTIVE,
    autoRenewStatus: ctx.renewalInfo?.autoRenewStatus === 1,
  });
  ctx.outcome.subscriberId = subscriber.id;
  ctx.outcome.purchaseId = purchase.id;
  // A rejected transition means the row is already terminal
  // (REFUNDED / REVOKED); a late or replayed redemption must not re-grant
  // access or re-add revenue.
  if (!statusApplied) return;

  if (ctx.notification.subtype === APPLE_NOTIFICATION_SUBTYPE.UPGRADE) {
    // An upgrade offer charges immediately on a NEW transaction and Apple
    // sends nothing at all for the one it replaced — the same shape
    // `applyRenewalPrefChange`'s UPGRADE arm handles, so it uses the same
    // helper rather than a second retirement implementation. The plan
    // change rides INSIDE that helper's transaction for the reason its
    // `onSuperseded` doc gives: the emit is gated on a row having MOVED,
    // so a crash between the retirement and a separate outbox write would
    // make the redelivery suppress an event that was never written.
    await expireSupersededApplePurchases({
      projectId: ctx.projectId,
      originalTransactionId: ctx.transaction.originalTransactionId,
      currentStoreTransactionId: ctx.transaction.transactionId,
      now: appleNotificationEventTime(ctx),
      source: `apple:${ctx.notification.notificationType}`,
      onSuperseded: async (tx, retired) => {
        await emitProductChanged({
          db: tx,
          projectId: ctx.projectId,
          subscriberId: subscriber.id,
          purchaseId: purchase.id,
          previousProductId: retired.productId,
          productId: product.id,
          changeType: applePlanChangeType(ctx.notification.subtype),
          now: appleNotificationEventTime(ctx),
        });
      },
    });
  }

  await grantAccess({ subscriber, purchase, product, ctx });

  await emitRevenueEvent({
    ctx,
    subscriberId: subscriber.id,
    purchaseId: purchase.id,
    productId: product.id,
    // EXPIRED specifically, not "any non-granting status": a redemption
    // against a chain that lapsed at end of term is the resurrection a
    // win-back offer exists to produce. REFUNDED/REVOKED chains are
    // terminal for a different reason (money reversed, access pulled) and
    // a new paid term there is an INITIAL, not the recovery of one.
    type:
      chainBefore?.status === PurchaseStatus.EXPIRED
        ? RevenueEventType.REACTIVATION
        : RevenueEventType.INITIAL,
    // This IS the first charge of this transaction, and the label above
    // can disagree with the one `applySubscribed` would pick for the same
    // transaction — so it is filed under the canonical first-charge key
    // and the unique index keeps whichever notification lands first. See
    // APPLE_FIRST_CHARGE_DEDUPE_KIND.
    firstChargeOfTransaction: true,
  });
}

async function applyRenewalStatusChange(ctx: DispatchContext): Promise<void> {
  const autoRenewStatus = ctx.renewalInfo?.autoRenewStatus === 1;
  await drizzle.purchaseRepo.updatePurchasesByOriginalTransaction(
    drizzle.db,
    ctx.projectId,
    ctx.transaction.originalTransactionId,
    { autoRenewStatus },
  );

  // Thread the direction through to postProcess's bridge (see
  // WebhookPostProcess.eventContext / resolveStorePublicKey in
  // store-event-normalization.ts) instead of leaving it stranded on the
  // autoRenewStatus column write above. This requires resolving the
  // subscriber the chain-wide write above didn't need — the bridge can't
  // run at all without one (postProcess bails when subscriberId is
  // unset), so a chain with no matching purchase row simply produces no
  // lifecycle key, same as before this change.
  const purchase =
    await drizzle.purchaseExtRepo.findPurchaseByOriginalTransaction(
      drizzle.db,
      ctx.projectId,
      ctx.transaction.originalTransactionId,
    );
  if (!purchase) return;

  ctx.outcome.subscriberId = purchase.subscriberId;
  ctx.outcome.purchaseId = purchase.id;
  ctx.outcome.eventContext = { autoRenewEnabled: autoRenewStatus };
}

async function applyFailedRenewal(ctx: DispatchContext): Promise<void> {
  // OD-1 revisited (Task 4, 2026-09-04): Apple sends subtype GRACE_PERIOD
  // only when the app has a billing grace period configured — that is the
  // ONLY case where the subscriber keeps access during the retry. Without
  // it, Apple has already withdrawn access on its side, so reporting
  // GRACE_PERIOD here (the pre-2026-09-04 choice, which mapped every
  // DID_FAIL_TO_RENEW to GRACE_PERIOD regardless of subtype) granted
  // entitlement Apple itself had withdrawn. Mirrors
  // normalizeAppleStatus(DID_FAIL_TO_RENEW).
  const isGracePeriodSubtype =
    ctx.notification.subtype === APPLE_NOTIFICATION_SUBTYPE.GRACE_PERIOD;
  const status = isGracePeriodSubtype
    ? PurchaseStatus.GRACE_PERIOD
    : PurchaseStatus.BILLING_ISSUE;

  // The same split has to reach the outbox bridge, or the two halves
  // disagree: the purchase would say GRACE_PERIOD (access retained) while
  // every integration was told `subscription.billing_issue`. The bridge
  // keys on the bare event-type string, and `DID_FAIL_TO_RENEW` covers
  // both cases — so thread the subtype through the same
  // `StoreEventContext` channel `applyRenewalStatusChange` uses for
  // auto-renew direction. See `resolveStorePublicKey`.
  ctx.outcome.eventContext = { appleGracePeriodSubtype: isGracePeriodSubtype };

  const gracePeriodExpires = ctx.renewalInfo?.gracePeriodExpiresDate
    ? new Date(ctx.renewalInfo.gracePeriodExpiresDate)
    : null;

  const eventTime = appleNotificationEventTime(ctx);
  // billingIssueStamp needs the row's status BEFORE this write, but this
  // write is chain-wide (guardedChainStatusWrite has no single `from` —
  // see its docstring), so read the chain's current row directly. Same
  // lookup applyRevoke/applyRenewalStatusChange already use for their own
  // post-write subscriber resolution.
  const current =
    await drizzle.purchaseExtRepo.findPurchaseByOriginalTransaction(
      drizzle.db,
      ctx.projectId,
      ctx.transaction.originalTransactionId,
    );

  await guardedChainStatusWrite(ctx, {
    status,
    gracePeriodExpires,
    ...billingIssueStamp(current?.status ?? null, status, eventTime),
  });
}

async function applyExpired(ctx: DispatchContext): Promise<void> {
  const { updatedCount } = await guardedChainStatusWrite(ctx, {
    status: PurchaseStatus.EXPIRED,
  });
  // Access revoke stays unconditional (idempotent / conservative,
  // matches the spec's intentional full-chain revoke).
  await revokeAccessForTransaction(ctx);
  // FINDING 2: only emit the $0 CANCELLATION lifecycle event when the
  // EXPIRED write actually applied to at least one row. A fully
  // withheld EXPIRED (every chain row already REFUNDED/REVOKED) must
  // NOT produce a spurious churn event on a refunded subscription.
  if (updatedCount === 0) return;
  await emitCancellationEvent(ctx);
}

async function applyRefund(ctx: DispatchContext): Promise<void> {
  // Refund Shield outcome linkage (T11): Apple's REFUND notification
  // is the "refund approved" signal that closes out the
  // CONSUMPTION_REQUEST loop started earlier. The WHERE clause on
  // (projectId, originalTransactionId, outcome IS NULL) silently
  // matches zero rows when no prior CONSUMPTION_REQUEST was seen
  // (e.g. Refund Shield wasn't enabled at the time), which is the
  // desired no-op — the revenue-events path below still runs.
  const approvedRecorded =
    await drizzle.refundShieldResponseRepo.updateOutcomeByOriginalTransactionIdIfNull(
      drizzle.db,
      {
        projectId: ctx.projectId,
        originalTransactionId: ctx.transaction.originalTransactionId,
        outcome: "REFUND_APPROVED",
      },
    );
  // Count once, on the transition only — a failed-then-retried webhook finds
  // the outcome already set and must not re-increment the approval counter.
  if (approvedRecorded) incRefundShieldOutcomeApproved(ctx.projectId);

  const refundDate = new Date(ctx.transaction.signedDate);
  // Refund targets the specific transaction by (store, storeTxnId),
  // not the whole chain. updatePurchasesByOriginalTransaction is the
  // chain-wide helper; we need a scoped write, so use the upsert's
  // update branch via a tiny inline repo call. In practice only one
  // purchase row shares this (store, storeTxnId) because the column
  // pair has a unique index.
  const found = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
    ctx.projectId,
    Store.APP_STORE,
    ctx.transaction.transactionId,
  );
  if (found) {
    // FINDING 1: guarded read + status write in one tx (a); the
    // updatePurchase also CASE-guards the terminal status (b).
    await drizzle.db.transaction(async (dbTx) => {
      const guard = await guardStatusWrite({
        db: dbTx,
        projectId: ctx.projectId,
        store: Store.APP_STORE,
        storeTransactionId: ctx.transaction.transactionId,
        to: PurchaseStatus.REFUNDED,
        source: `apple:${ctx.notification.notificationType}`,
        eventTime: appleNotificationEventTime(ctx),
      });
      await drizzle.purchaseRepo.updatePurchase(dbTx, found.id, {
        // refundDate rides with the guarded status: a withheld transition
        // (row already REVOKED) must not leave a REVOKED row carrying a
        // refundDate that disagrees with its status.
        ...(guard.apply
          ? {
              status: PurchaseStatus.REFUNDED,
              refundDate,
              lastStoreEventAt: appleNotificationEventTime(ctx),
            }
          : {}),
      });
    });
    // Scope the access revoke to the refunded transaction only. The status
    // write above touches just this (store, transactionId) row, so revoking
    // the whole originalTransactionId chain would strip entitlement from
    // sibling still-active purchases — leaving an ACTIVE purchase with no
    // access. REVOKE/EXPIRE remain chain-wide (handled in their own paths).
    await drizzle.accessRepo.revokeAccessByPurchaseId(drizzle.db, found.id);
  }

  const purchase = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
    ctx.projectId,
    Store.APP_STORE,
    ctx.transaction.transactionId,
  );
  if (!purchase) return;

  const subscriber = await drizzle.subscriberRepo.findSubscriberById(
    drizzle.db,
    purchase.subscriberId,
  );
  if (!subscriber) return;

  ctx.outcome.subscriberId = subscriber.id;
  ctx.outcome.purchaseId = purchase.id;

  await emitRevenueEvent({
    ctx,
    subscriberId: subscriber.id,
    purchaseId: purchase.id,
    productId: purchase.productId,
    type: RevenueEventType.REFUND,
  });
}

async function applyRevoke(ctx: DispatchContext): Promise<void> {
  await guardedChainStatusWrite(ctx, { status: PurchaseStatus.REVOKED });
  await revokeAccessForTransaction(ctx);

  // Same latent gap Task 2 found in applyRenewalStatusChange: the two
  // writes above are chain-wide and never needed a subscriber, so
  // `outcome.subscriberId` stayed unset — and postProcess bails without
  // one. A REVOKE therefore emitted NOTHING at all: no revenue event, no
  // lifecycle key. Resolving the subscriber here is what lets the
  // `REVOKE -> subscription.revoked` row in STORE_EVENT_TO_PUBLIC_KEY
  // actually fire. A chain with no matching purchase row still produces
  // no key, exactly as before.
  const purchase =
    await drizzle.purchaseExtRepo.findPurchaseByOriginalTransaction(
      drizzle.db,
      ctx.projectId,
      ctx.transaction.originalTransactionId,
    );
  if (!purchase) return;

  ctx.outcome.subscriberId = purchase.subscriberId;
  ctx.outcome.purchaseId = purchase.id;
}

// REFUND_DECLINED: Apple rejected the customer's refund request.
// Only the refund_shield_responses outcome moves — no revenue impact
// because no money was returned. First-wins: don't overwrite an
// existing outcome (a duplicate redelivery shouldn't flip the
// record).
async function applyRefundDeclined(ctx: DispatchContext): Promise<void> {
  const declinedRecorded =
    await drizzle.refundShieldResponseRepo.updateOutcomeByOriginalTransactionIdIfNull(
      drizzle.db,
      {
        projectId: ctx.projectId,
        originalTransactionId: ctx.transaction.originalTransactionId,
        outcome: "REFUND_DECLINED",
      },
    );
  if (declinedRecorded) incRefundShieldOutcomeDeclined(ctx.projectId);
}

// REFUND_REVERSED: Apple reversed a previously-approved refund (e.g.
// chargeback successfully disputed by the developer). This is the
// only outcome that legitimately OVERWRITES an earlier value —
// typically REFUND_APPROVED → REFUND_REVERSED — so it routes through
// the unconditional overwrite method.
async function applyRefundReversed(ctx: DispatchContext): Promise<void> {
  await drizzle.refundShieldResponseRepo.updateOutcomeByOriginalTransactionIdOverwrite(
    drizzle.db,
    {
      projectId: ctx.projectId,
      originalTransactionId: ctx.transaction.originalTransactionId,
      outcome: "REFUND_REVERSED",
    },
  );
  incRefundShieldOutcomeReversed(ctx.projectId);

  // Emit a compensating REACTIVATION revenue_events row to undo the
  // prior REFUND's effect in MRR / lifetime revenue analytics. Apple's
  // REFUND_REVERSED means the customer keeps the charge after all, so
  // the negative REFUND row needs a positive counterpart. We reuse the
  // REACTIVATION type (the canonical "back to paying state" event in
  // RevenueEventType) rather than introducing a new enum value — no
  // schema migration, and downstream ClickHouse MVs already sum
  // REACTIVATION into lifetime revenue.
  //
  // Idempotency: duplicate REFUND_REVERSED notifications short-circuit
  // at the outer webhook_events dispatch (PROCESSED → "duplicate"),
  // so this branch only runs once per Apple notification UUID.
  const purchase = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
    ctx.projectId,
    Store.APP_STORE,
    ctx.transaction.transactionId,
  );
  if (!purchase) {
    log.warn("REFUND_REVERSED with no matching purchase — skipping compensation", {
      projectId: ctx.projectId,
      originalTransactionId: ctx.transaction.originalTransactionId,
      transactionId: ctx.transaction.transactionId,
    });
    return;
  }

  // Restore the purchase itself. The prior REFUND put this row into
  // REFUNDED (terminal — no TRANSITIONS edge leaves it) and revoked
  // its access; REFUND_REVERSED means Apple undid that refund, so the
  // customer keeps the charge AND the entitlement. Invariant: REFUNDED
  // is absorbing for every other path — this is the ONLY code path
  // allowed to exit it, and only because the store itself reversed the
  // terminal event. Both guard layers are bypassed explicitly and
  // narrowly: `allowFrom: [REFUNDED]` for the state machine (REVOKED
  // stays unresurrectable) and `guardTerminalStatus: false` for the
  // SQL CASE backstop in `updatePurchase`. Access is NOT granted here:
  // post-processing runs `syncAccess(subscriberId)` after every
  // webhook, and the access engine re-grants for ACTIVE on its own.
  // Consumable credits are never clawed back on REFUND, so there is
  // nothing to re-grant on reversal.
  const restoredStatus =
    ctx.transaction.expiresDate === undefined ||
    ctx.transaction.expiresDate > Date.now()
      ? PurchaseStatus.ACTIVE // still in-term, or lifetime (no expiry)
      : PurchaseStatus.EXPIRED; // term already over — no access returns
  await drizzle.db.transaction(async (dbTx) => {
    const guard = await guardStatusWrite({
      db: dbTx,
      projectId: ctx.projectId,
      store: Store.APP_STORE,
      storeTransactionId: ctx.transaction.transactionId,
      to: restoredStatus,
      source: `apple:${ctx.notification.notificationType}`,
      allowFrom: [PurchaseStatus.REFUNDED],
      eventTime: appleNotificationEventTime(ctx),
    });
    await drizzle.purchaseRepo.updatePurchase(
      dbTx,
      purchase.id,
      {
        ...(guard.apply
          ? {
              status: restoredStatus,
              lastStoreEventAt: appleNotificationEventTime(ctx),
            }
          : {}),
        // The refund no longer stands — clear its timestamp so reads
        // (and a later re-refund) start from a clean slate.
        refundDate: null,
      },
      // No-op when the guard withheld the status (patch then carries
      // no `status` field for the CASE backstop to act on).
      { guardTerminalStatus: false },
    );
  });

  const subscriber = await drizzle.subscriberRepo.findSubscriberById(
    drizzle.db,
    purchase.subscriberId,
  );
  if (!subscriber) {
    log.warn("REFUND_REVERSED with no matching subscriber — skipping compensation", {
      projectId: ctx.projectId,
      purchaseId: purchase.id,
    });
    return;
  }

  ctx.outcome.subscriberId = subscriber.id;
  ctx.outcome.purchaseId = purchase.id;

  await emitRevenueEvent({
    ctx,
    subscriberId: subscriber.id,
    purchaseId: purchase.id,
    productId: purchase.productId,
    type: RevenueEventType.REACTIVATION,
    // REACTIVATION means two different things. This one is an accounting
    // reversal, not a subscriber coming back — a consumer that treats it
    // as a win-back would fire a "welcome back" campaign at someone whose
    // refund was simply declined. `metadata` flows into the outbox
    // payload and nowhere else, which is exactly what it is for; the
    // precedent is subscription.product_changed's `phase`.
    metadata: { reason: REACTIVATION_REVERSAL_REASON },
  });
}

// =============================================================
// Refund Shield: CONSUMPTION_REQUEST
// =============================================================
//
// Apple sends CONSUMPTION_REQUEST when a customer files a refund
// request through the App Store. Apple gives us a 12-hour window
// to reply via `PUT /inApps/v1/transactions/consumption/{id}` with
// a signal payload describing the user's engagement / refund
// history. We don't send that reply synchronously here: instead
// we enqueue a row in `refund_shield_responses` and let the
// polling responder worker (T14) compute the payload + dispatch
// it after the configured delay window.
//
// Decision tree for the inserted row's status:
//   - project.refundShieldEnabled = false  → SKIPPED_DISABLED
//   - subscriber unresolvable             → SKIPPED_NOT_FOUND
//   - else                                 → PENDING
//
// Idempotency: `apple_notification_uuid` has a unique index and
// the insert uses ON CONFLICT DO NOTHING — Apple retrying the
// same notification is safe.

async function applyConsumptionRequest(ctx: DispatchContext): Promise<void> {
  const { projectId, transaction, notification } = ctx;

  const project = await drizzle.projectRepo.findProjectById(
    drizzle.db,
    projectId,
  );
  if (!project) {
    // Project deleted between webhook receipt and dispatch — drop
    // silently; the outer webhook_event row is still marked
    // PROCESSED so Apple doesn't retry endlessly.
    log.warn("CONSUMPTION_REQUEST for unknown project", { projectId });
    return;
  }

  const detectedAt = new Date();
  const scheduledFor = project.refundShieldEnabled
    ? new Date(
        detectedAt.getTime() +
          project.refundShieldResponseDelayMinutes * 60_000,
      )
    : detectedAt;

  // Subscriber lookup: appAccountToken first (set on the
  // subscribers row by T9's upsert path), then fall back to a
  // chain lookup via purchases.original_transaction_id.
  let subscriberId: string | null = null;
  if (transaction.appAccountToken) {
    const byToken =
      await drizzle.subscriberRepo.findSubscriberByAppleAppAccountToken(
        drizzle.db,
        projectId,
        transaction.appAccountToken,
      );
    subscriberId = byToken?.id ?? null;
  }
  if (subscriberId === null) {
    const purchase =
      await drizzle.purchaseExtRepo.findPurchaseByOriginalTransaction(
        drizzle.db,
        projectId,
        transaction.originalTransactionId,
      );
    subscriberId = purchase?.subscriberId ?? null;
  }

  const status: "PENDING" | "SKIPPED_DISABLED" | "SKIPPED_NOT_FOUND" =
    !project.refundShieldEnabled
      ? "SKIPPED_DISABLED"
      : subscriberId === null
        ? "SKIPPED_NOT_FOUND"
        : "PENDING";

  // Capture the Apple environment off the JWS *now*, so the responder
  // worker (which runs hours later, after Apple's signed payload is
  // gone from memory) can hit the right App Store Server API base
  // URL without falling back to NODE_ENV. We prefer the top-level
  // notification.data.environment over transaction.environment —
  // they should agree, but the notification envelope is the source
  // of truth for this delivery. Default to PRODUCTION on the off
  // chance Apple omits the field; matches the column default and
  // is the safer of the two failure modes (sandbox API rejects a
  // prod transactionId cleanly, while a sandbox transactionId hits
  // an opaque 404 against the prod API).
  const appleEnvironment: "PRODUCTION" | "SANDBOX" =
    notification.data?.environment === APPLE_ENVIRONMENT.SANDBOX ||
    transaction.environment === APPLE_ENVIRONMENT.SANDBOX
      ? "SANDBOX"
      : "PRODUCTION";

  const requestRecorded =
    await drizzle.refundShieldResponseRepo.insertConsumptionRequest(
      drizzle.db,
      {
        projectId,
        subscriberId,
        appleNotificationUuid: notification.notificationUUID,
        appleOriginalTransactionId: transaction.originalTransactionId,
        appleTransactionId: transaction.transactionId,
        detectedAt,
        scheduledFor,
        status,
        appleEnvironment,
      },
    );
  // Count once per distinct CONSUMPTION_REQUEST. A duplicate notification
  // UUID (ON CONFLICT DO NOTHING) or a failed-then-retried webhook must not
  // re-increment the received counter.
  if (requestRecorded) incRefundShieldReceived(projectId);

  if (subscriberId) ctx.outcome.subscriberId = subscriberId;

  log.info("CONSUMPTION_REQUEST enqueued", {
    projectId,
    uuid: notification.notificationUUID,
    status,
    subscriberId,
  });
}

// =============================================================
// Helpers
// =============================================================

function isTrial(transaction: AppleJwsTransactionPayload): boolean {
  // Introductory offer + price 0 = free trial. Paid intro discounts keep
  // ACTIVE status so they're counted as real revenue.
  return (
    transaction.offerType === APPLE_OFFER_TYPE.INTRODUCTORY &&
    (transaction.price ?? 0) === 0
  );
}

function mapEnvironment(tx: AppleJwsTransactionPayload): Environment {
  return tx.environment === APPLE_ENVIRONMENT.PRODUCTION
    ? Environment.PRODUCTION
    : Environment.SANDBOX;
}

async function resolveSubscriber(ctx: DispatchContext) {
  const { projectId, transaction } = ctx;
  // Resolution mirrors the receipt path so both converge on ONE subscriber
  // (RevenueCat/Adapty model): the JWS `appAccountToken` is the client→customer
  // binding, and `originalTransactionId` is the store-authoritative anchor.
  // The token is NEVER used as the rovenueId/appUserId identity — that would
  // fabricate a parallel subscriber divorced from the receipt-created row.
  const appleAppAccountToken = transaction.appAccountToken ?? null;

  // 1. Existing binding: a subscriber already carrying this appAccountToken
  //    (set by the receipt path from the same JWS claim, or a prior webhook).
  if (appleAppAccountToken) {
    const byToken =
      await drizzle.subscriberRepo.findSubscriberByAppleAppAccountToken(
        drizzle.db,
        projectId,
        appleAppAccountToken,
      );
    if (byToken) return byToken;
  }

  // 2. Store-transaction anchor: whoever already owns this originalTransactionId
  //    (typically the receipt-created subscriber when no token binding exists).
  const existingPurchase =
    await drizzle.purchaseExtRepo.findPurchaseByOriginalTransaction(
      drizzle.db,
      projectId,
      transaction.originalTransactionId,
    );
  if (existingPurchase) {
    const existingSubscriber = await drizzle.subscriberRepo.findSubscriberById(
      drizzle.db,
      existingPurchase.subscriberId,
    );
    if (existingSubscriber) return existingSubscriber;
  }

  // 3. First sighting (webhook arrived before any receipt). Key the row by the
  //    stable transaction anchor and stash the token in its dedicated column so
  //    a later receipt converges onto this exact row. Upsert (not create) keeps
  //    duplicate notifications for the same transaction idempotent.
  const syntheticId = `apple:${transaction.originalTransactionId}`;
  return drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
    projectId,
    rovenueId: syntheticId,
    appUserId: syntheticId,
    appleAppAccountToken,
  });
}

interface UpsertPurchaseArgs {
  ctx: DispatchContext;
  subscriberId: string;
  status: PurchaseStatus;
  autoRenewStatus: boolean;
}

/**
 * The store-side timestamp of this notification, for the guard's
 * event-time ordering: `signedDate` on the envelope is when Apple signed
 * (i.e. generated) the notification.
 */
function appleNotificationEventTime(ctx: DispatchContext): Date {
  return new Date(ctx.notification.signedDate);
}

async function upsertPurchase(args: UpsertPurchaseArgs) {
  const { ctx, subscriberId, status, autoRenewStatus } = args;
  const tx = ctx.transaction;

  const product = await drizzle.offeringRepo.findProductByStoreId(
    drizzle.db,
    ctx.projectId,
    "apple",
    tx.productId,
  );
  if (!product) {
    throw new Error(
      `No product mapped for Apple productId ${tx.productId} in project ${ctx.projectId}`,
    );
  }

  const environment = mapEnvironment(tx);

  // Apple announces a scheduled plan change on `renewalInfo`: once the
  // subscriber picks a different tier, `autoRenewProductId` names the
  // product the NEXT renewal will charge for, while `transaction.productId`
  // stays on the tier they are currently entitled to. That announcement is
  // recorded, never acted on — a scheduled downgrade must not revoke the
  // paid-up term (see `pendingPlanChangeFields`). An unmapped
  // autoRenewProductId (the developer added a product to App Store Connect
  // but not to Rovenue) leaves the pending columns null rather than
  // violating the FK — the real change still lands at renewal.
  const announcedProductId = await resolveAutoRenewProduct(ctx, tx.productId);
  const changeType = applePlanChangeType(ctx.notification.subtype);
  const pendingFields = pendingPlanChangeFields({
    writtenProductId: product.id,
    announcedProductId,
    changeType,
    // Apple applies the change when the current term ends.
    effectiveAt: tx.expiresDate ? new Date(tx.expiresDate) : null,
  });

  // FINDING 1: guarded read + upsert in one tx so the FOR UPDATE lock
  // is held across the write (mechanism (a)); upsertPurchase also
  // CASE-guards the terminal status at SQL level (mechanism (b)).
  const eventTime = appleNotificationEventTime(ctx);
  const { purchase, statusApplied } = await drizzle.db.transaction(
    async (dbTx) => {
      const guard = await guardStatusWrite({
        db: dbTx,
        projectId: ctx.projectId,
        store: Store.APP_STORE,
        storeTransactionId: tx.transactionId,
        to: status,
        source: `apple:${ctx.notification.notificationType}`,
        eventTime,
      });

      const persisted = await drizzle.purchaseRepo.upsertPurchase(dbTx, {
        store: Store.APP_STORE,
        storeTransactionId: tx.transactionId,
        create: {
          projectId: ctx.projectId,
          subscriberId,
          productId: product.id,
          store: Store.APP_STORE,
          storeTransactionId: tx.transactionId,
          originalTransactionId: tx.originalTransactionId,
          status,
          isTrial: isTrial(tx),
          isIntroOffer: tx.offerType !== undefined,
          // The offer this transaction came from, kept at full fidelity
          // beside the boolean that collapses all four kinds into one.
          offerType: tx.offerType ?? null,
          offerIdentifier: tx.offerIdentifier ?? null,
          isSandbox: environment === Environment.SANDBOX,
          environment,
          purchaseDate: new Date(tx.purchaseDate),
          originalPurchaseDate: new Date(tx.originalPurchaseDate),
          expiresDate: tx.expiresDate ? new Date(tx.expiresDate) : null,
          // Drizzle decimal columns round-trip as strings.
          priceAmount:
            tx.price != null ? (tx.price / 1_000_000).toString() : null,
          priceCurrency: tx.currency ?? null,
          autoRenewStatus,
          ownershipType: tx.inAppOwnershipType,
          verifiedAt: new Date(),
          lastStoreEventAt: eventTime,
          ...pendingFields,
        },
        update: {
          ...(guard.apply
            ? {
                status,
                lastStoreEventAt: eventTime,
                ...billingIssueStamp(guard.from, status, eventTime),
                // Converge the denormalized product onto what the store
                // says this transaction is now for. Without this write the
                // row keeps its first-seen product forever, and the
                // before-image comparison below would re-fire
                // `subscription.product_changed` on every later delivery.
                // Withheld alongside `status`: a replayed event must not
                // repaint the product of a row the guard just protected.
                productId: product.id,
                // Same gate, same reason: the pending columns are a
                // projection of what the store says NOW, so a stale or
                // illegal delivery must not repaint them either.
                ...pendingFields,
                // Likewise the offer columns: they describe what the
                // store says this transaction is, and a withheld write
                // must not repaint them from a stale delivery.
                //
                // Written only when the field is PRESENT. `?? null` would
                // erase the recorded offer the moment any later delivery
                // for this transaction omitted it — and these columns
                // exist precisely so a win-back cohort stays queryable
                // afterwards. An absent field means "this payload says
                // nothing", never "there was no offer".
                ...(tx.offerType !== undefined
                  ? { offerType: tx.offerType }
                  : {}),
                ...(tx.offerIdentifier !== undefined
                  ? { offerIdentifier: tx.offerIdentifier }
                  : {}),
              }
            : {}),
          autoRenewStatus,
          expiresDate: tx.expiresDate ? new Date(tx.expiresDate) : null,
          verifiedAt: new Date(),
        },
      });

      // A plan change is the product on this purchase actually moving —
      // not the store merely announcing one (that is `pendingFields`).
      // `guard.previous` is the before-image read under the same FOR
      // UPDATE lock as the write, so this cannot race a concurrent
      // delivery. Null `previous` = first write for this transaction,
      // which is a new purchase, not a change.
      if (guard.apply && guard.previous) {
        await emitProductChanged({
          db: dbTx,
          projectId: ctx.projectId,
          subscriberId,
          purchaseId: persisted.id,
          previousProductId: guard.previous.productId,
          productId: product.id,
          changeType,
          now: eventTime,
        });
      }

      // BILLING_ISSUE -> a granting status is a genuine recovery: the
      // store resolved the payment failure. Unlike inferring it from an
      // invoice, this cannot fire on an unrelated renewal, because the
      // before-image says where the row actually was.
      //
      // On Apple that before-image is usually null even for a real
      // recovery: `applyFailedRenewal` stamps BILLING_ISSUE chain-wide onto
      // the transaction that failed, and Apple mints a NEW transactionId
      // for the renewal that recovers it — so THIS key has no row and
      // `guard.previous` says nothing. The chain is the honest scope. When
      // this delivery grants access and its own key was not the one
      // holding the failure, resolve the chain's stale BILLING_ISSUE rows;
      // if any actually moved, the chain WAS in billing trouble and this
      // delivery is what ended it.
      //
      // Exactly-once: the two arms are mutually exclusive. A recovery
      // visible on this key uses `guard.previous`; one visible only on a
      // sibling uses the chain. A replay retires nothing (the rows are
      // already EXPIRED) and emits nothing.
      const recoveredOnThisKey =
        guard.previous?.status === PurchaseStatus.BILLING_ISSUE;
      const recoveredOnChain =
        !recoveredOnThisKey &&
        guard.apply &&
        SUBSCRIPTION_STATUS_SEMANTICS[status].grantsAccess &&
        (
          await retireChainBillingIssue({
            db: dbTx,
            projectId: ctx.projectId,
            originalTransactionId: tx.originalTransactionId,
            excludeStoreTransactionId: tx.transactionId,
            now: eventTime,
            source: `apple:${ctx.notification.notificationType}`,
          })
        ).retired > 0;

      await emitSubscriptionRecovered({
        db: dbTx,
        projectId: ctx.projectId,
        subscriberId,
        purchaseId: persisted.id,
        apply: guard.apply,
        previousStatus:
          recoveredOnThisKey || recoveredOnChain
            ? PurchaseStatus.BILLING_ISSUE
            : (guard.previous?.status ?? null),
        status,
        now: eventTime,
      });

      return { purchase: persisted, statusApplied: guard.apply };
    },
  );

  return { product, purchase, statusApplied };
}

/**
 * Record (or clear) the pending plan change a DID_CHANGE_RENEWAL_PREF
 * announces, without taking any effect.
 *
 * This is the ONLY writer of Apple's pending columns. The subtypes that
 * reach it — DOWNGRADE, and the no-subtype "reverted the pending change"
 * case — deliberately change no status, no access and no revenue: the
 * subscriber keeps the tier they paid for until the term ends. Both
 * directions are handled by one code path because
 * `pendingPlanChangeFields` clears when the store stops naming a future
 * product, so the revert notification (whose `autoRenewProductId` is back
 * to the current product, or absent) clears the columns the downgrade set.
 *
 * The write targets the chain's current row rather than the transaction
 * key, because a renewal-pref notification carries whichever transaction
 * is in force and the announcement belongs to the subscription, not to one
 * billing period.
 */
async function recordApplePendingChange(ctx: DispatchContext): Promise<void> {
  const current =
    await drizzle.purchaseExtRepo.findPurchaseByOriginalTransaction(
      drizzle.db,
      ctx.projectId,
      ctx.transaction.originalTransactionId,
    );
  // No row yet: the announcement arrived before any purchase this project
  // knows about. Nothing to annotate, and inventing a row here would be a
  // purchase Apple never told us was bought.
  if (!current) return;

  // Resolved BEFORE the transaction opens: it is a read of the product
  // catalogue, not of the row, and doing it under the row lock would hold
  // that lock across an unrelated query.
  const announcedProductId = await resolveAutoRenewProduct(
    ctx,
    ctx.transaction.productId,
  );

  // The pending columns are store-announced state, and the same rule
  // applies to them here as on the guarded upsert paths: a terminal row
  // must not be repainted, and a concurrent sync must not interleave.
  // `guardStatusWrite` is not the mechanism — it decides STATUS
  // transitions and would audit a transition this path does not make — so
  // this takes the lock the guard itself uses (mechanism (a),
  // `lockPurchaseStatusByStoreTransaction`) and re-reads the row under it.
  await drizzle.db.transaction(async (tx) => {
    const locked = await drizzle.purchaseRepo.lockPurchaseStatusByStoreTransaction(
      tx,
      Store.APP_STORE,
      current.storeTransactionId,
    );
    // Deleted between the read above and the lock.
    if (!locked) return;
    if (TERMINAL_STATUSES.includes(locked.status)) {
      // REFUNDED / REVOKED. The subscription is over; a renewal-pref
      // announcement against it is stale or illegal, and recording a
      // future product on a terminal row would have every reader believe a
      // change is coming that never can.
      log.debug("ignoring renewal pref change on a terminal purchase", {
        projectId: ctx.projectId,
        purchaseId: locked.id,
        status: locked.status,
      });
      return;
    }
    const pendingFields = pendingPlanChangeFields({
      // Re-read under the lock: the row keeps the tier still in force, and
      // the announcement is about what replaces it.
      writtenProductId: locked.productId,
      announcedProductId,
      changeType: applePlanChangeType(ctx.notification.subtype),
      // Apple applies the change when the current term ends.
      effectiveAt: current.expiresDate,
    });
    await drizzle.purchaseRepo.updatePurchase(tx, locked.id, pendingFields);
  });

  ctx.outcome.subscriberId = current.subscriberId;
  ctx.outcome.purchaseId = current.id;
}

/**
 * Map Apple's `renewalInfo.autoRenewProductId` onto a Rovenue product id,
 * or null when Apple names no future product, names the one already in
 * force, or names one this project has not mapped.
 */
async function resolveAutoRenewProduct(
  ctx: DispatchContext,
  currentStoreProductId: string,
): Promise<string | null> {
  const autoRenewProductId = ctx.renewalInfo?.autoRenewProductId;
  if (!autoRenewProductId || autoRenewProductId === currentStoreProductId) {
    return null;
  }
  const pendingProduct = await drizzle.offeringRepo.findProductByStoreId(
    drizzle.db,
    ctx.projectId,
    "apple",
    autoRenewProductId,
  );
  if (!pendingProduct) {
    log.debug("autoRenewProductId is not mapped to a Rovenue product", {
      projectId: ctx.projectId,
      autoRenewProductId,
    });
    return null;
  }
  return pendingProduct.id;
}

interface GrantAccessArgs {
  ctx: DispatchContext;
  subscriber: { id: string };
  purchase: { id: string; status: PurchaseStatus; gracePeriodExpires: Date | null };
  product: { id: string; accessIds: string[] };
}

async function grantAccess(args: GrantAccessArgs): Promise<void> {
  const { ctx, subscriber, purchase, product } = args;
  // The entitlement date, not the transaction's raw expiresDate: a
  // GRACE_PERIOD purchase's expiresDate is the PRE-grace date, which the
  // read path (`findActiveAccess`, `expiresDate > now`) will not serve.
  // syncAccess overwrites this row moments later with the same rule, but
  // relying on that made the invariant hold by ordering -- a crash in
  // between left a grant that served nothing.
  const expiresDate = entitlementExpiry({
    status: purchase.status,
    expiresDate: ctx.transaction.expiresDate
      ? new Date(ctx.transaction.expiresDate)
      : null,
    gracePeriodExpires: purchase.gracePeriodExpires,
  });

  for (const accessId of product.accessIds) {
    const existing = await drizzle.accessRepo.findAccessByPurchaseAndAccessId(
      drizzle.db,
      subscriber.id,
      purchase.id,
      accessId,
    );
    if (existing) {
      await drizzle.accessRepo.setAccessActiveAndExpiry(
        drizzle.db,
        existing.id,
        true,
        expiresDate,
      );
    } else {
      await drizzle.accessRepo.createAccess(drizzle.db, {
        subscriberId: subscriber.id,
        purchaseId: purchase.id,
        accessId,
        isActive: true,
        expiresDate,
        store: Store.APP_STORE,
      });
    }
  }
}

async function revokeAccessForTransaction(ctx: DispatchContext): Promise<void> {
  await drizzle.accessRepo.revokeAccessByOriginalTransaction(
    drizzle.db,
    ctx.projectId,
    ctx.transaction.originalTransactionId,
  );
}

/**
 * The ONE dedupe kind the first charge of an Apple transaction is filed
 * under, whichever label the handler that saw it chose.
 *
 * The first charge of a transaction is one economic event. It is
 * legitimately called INITIAL by a handler classifying on Apple's SUBTYPE
 * (`applySubscribed`: RESUBSCRIBE -> REACTIVATION) and REACTIVATION by one
 * classifying on CHAIN STATUS (`applyOfferRedeemed`: EXPIRED ->
 * REACTIVATION), and those two labels carry different
 * `revenueDedupeKind`s. Letting each claim its own key meant a chain
 * sitting in BILLING_ISSUE (the expiry-checker has not caught up), whose
 * win-back arrives as OFFER_REDEEMED and then SUBSCRIBED/RESUBSCRIBE,
 * wrote two rows for one charge.
 *
 * So the KEY answers "which economic event is this", not "what did we call
 * it": all three first-charge handlers claim this one key while the row
 * keeps its own `type`. `(projectId, dedupeKey)` is unique and the claim is
 * an `onConflictDoNothing` insert, so the second handler to arrive loses
 * the claim inside the database. That matters beyond tidiness: the webhook
 * worker runs at concurrency 8 with no per-transaction advisory lock on
 * this path, so a check-then-act read could be passed by both deliveries
 * at once. Nothing to race here — the unique index decides.
 *
 * `revenueDedupeKind` itself is deliberately NOT changed to fold the two
 * kinds: `applyRefundReversed` emits a compensating REACTIVATION for a
 * transaction whose first charge is already recorded, and folding would
 * make that reversal collide with the purchase it exists to reverse.
 * Keeping first-charge on "purchase" is what holds them apart — the
 * reversal keeps claiming "reactivation".
 */
const APPLE_FIRST_CHARGE_DEDUPE_KIND = revenueDedupeKind(
  RevenueEventType.INITIAL,
);

/**
 * `revenue.event.recorded`'s `metadata.reason` for `applyRefundReversed`'s
 * compensating REACTIVATION. REACTIVATION carries two different economic
 * meanings — a lapsed subscriber coming back on a win-back offer, and a
 * refund being undone — and only this file's dedupe key
 * (APPLE_FIRST_CHARGE_DEDUPE_KIND vs. the reactivation kind) ever held
 * them apart. That key never reaches the outbox payload, so without this
 * a consumer of `revenue.REACTIVATION` cannot tell "they came back" from
 * "we un-did a refund" and could fire a win-back campaign at someone
 * whose refund was simply declined.
 *
 * Precedent for the shape: `subscription.product_changed`'s `phase`
 * (packages/shared/src/integrations.ts) — a missing field is the default
 * case, not "unknown". Absence here means a win-back REACTIVATION;
 * presence means the compensating one. Only `applyRefundReversed` sets
 * this — every other REACTIVATION emit leaves `metadata` unset.
 */
export const REACTIVATION_REVERSAL_REASON = "refund_reversed";

interface EmitRevenueArgs {
  ctx: DispatchContext;
  subscriberId: string;
  purchaseId: string;
  productId: string;
  type: RevenueEventType;
  /**
   * Set by the handlers that mean "this is the FIRST charge of
   * `transaction.transactionId`" — SUBSCRIBED, an UPGRADE renewal-pref
   * change, and OFFER_REDEEMED. Those three can each label that one charge
   * INITIAL or REACTIVATION; setting this files it under the canonical
   * first-charge key regardless (see APPLE_FIRST_CHARGE_DEDUPE_KIND).
   *
   * Deliberately opt-in rather than applied to every emit.
   * `applyRefundReversed`'s REACTIVATION is the case that proves it must
   * be: it shares a transaction id with the first charge and is a
   * genuinely different economic event, so it must keep its own key.
   * (`applyRenewal` is not at risk either way — Apple mints a new
   * transactionId per renewal, so a renewal never shares one.)
   */
  firstChargeOfTransaction?: boolean;
  /**
   * Folded into the co-located outbox row's payload only — see
   * `CreateRevenueEventInput.metadata`. Today only
   * `applyRefundReversed` sets `{ reason: REACTIVATION_REVERSAL_REASON }`;
   * every other emit site omits it, so absence is the default and
   * presence is the exception a consumer can branch on.
   */
  metadata?: Record<string, unknown>;
}

async function emitRevenueEvent(args: EmitRevenueArgs): Promise<void> {
  const { ctx, subscriberId, purchaseId, productId, type, metadata } = args;
  const tx = ctx.transaction;

  if (tx.price == null || !tx.currency) {
    log.debug("skipping revenue event: no price", {
      transactionId: tx.transactionId,
      type,
    });
    return;
  }

  // Store the unsigned magnitude for ALL event types, including
  // REFUND/CHARGEBACK. The platform convention is positive `amountUsd`
  // for refunds (matching Google + every analytics query, which net via
  // `gross - sumIf(amountUsd, refund)`); a negative value both overflowed
  // the unsigned cast in v_revenue_lifetime_subscriber and inflated net
  // MRR/LTV. A REFUND_REVERSED emits a positive REACTIVATION counterpart
  // that cancels the refund correctly under this positive convention.
  const amount = tx.price / 1_000_000;
  const amountUsd = await convertToUsd(amount, tx.currency);

  await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
    projectId: ctx.projectId,
    subscriberId,
    purchaseId,
    productId,
    type,
    amount: amount.toString(),
    currency: tx.currency,
    amountUsd: amountUsd.toString(),
    store: Store.APP_STORE,
    // The store's own per-transaction country, normalised from Apple's
    // alpha-3 storefront to the house alpha-2 format (never the
    // subscriber's last-known SDK-reported one — see
    // CreateRevenueEventInput.country). Fails closed to no country on
    // an unrecognised code.
    country: appleStorefrontToCountry(tx.storefront),
    eventDate: new Date(tx.purchaseDate),
    // transactionId is unique per Apple transaction (renewals get a new
    // one); the coarse kind lets the receipt-verify path converge on the
    // same key for this transaction. Idempotent across replays.
    // One economic event, one key. For a first charge that is the
    // canonical kind rather than this row's own label — see
    // APPLE_FIRST_CHARGE_DEDUPE_KIND. It is also what keeps this path
    // converging with receipt-verify.ts, which spells the same
    // `apple:<txn>:purchase` for the transaction it verifies.
    //
    // RESIDUAL, stated rather than papered over: this only dedupes against
    // claims in the `apple:` namespace. The CSV importer claims revenue
    // under its own scheme (`import:<store>:<txnId>:<renewalNumber>`, see
    // packages/shared/src/import/keys.ts), so for a project that migrated
    // history through the importer a live notification whose transaction id
    // matches an imported `storeTransactionId` still writes a second row.
    // That namespace split affects every Apple handler equally and predates
    // this one; closing it means unifying the importer's key scheme, which
    // is a data migration, not a change here.
    dedupeKey: `apple:${tx.transactionId}:${
      args.firstChargeOfTransaction
        ? APPLE_FIRST_CHARGE_DEDUPE_KIND
        : revenueDedupeKind(type)
    }`,
    ...(metadata ? { metadata } : {}),
  });

  if (type === RevenueEventType.REFUND) {
    await maybeEmitRefundDetected(drizzle.db, {
      projectId: ctx.projectId,
      purchaseId,
      productId,
      amountUsdCents: Math.round(Math.abs(amountUsd) * 100),
      currency: tx.currency,
    });
  }
}

async function emitCancellationEvent(ctx: DispatchContext): Promise<void> {
  const purchase =
    await drizzle.purchaseExtRepo.findPurchaseByOriginalTransaction(
      drizzle.db,
      ctx.projectId,
      ctx.transaction.originalTransactionId,
    );
  if (!purchase) return;

  const subscriber = await drizzle.subscriberRepo.findSubscriberById(
    drizzle.db,
    purchase.subscriberId,
  );
  if (!subscriber) return;

  ctx.outcome.subscriberId = subscriber.id;
  ctx.outcome.purchaseId = purchase.id;

  await emitRevenueEvent({
    ctx,
    subscriberId: subscriber.id,
    purchaseId: purchase.id,
    productId: purchase.productId,
    type: RevenueEventType.CANCELLATION,
  });
}

/**
 * Persist an EXTERNAL_PURCHASE_TOKEN notification.
 *
 * Deliberately emits nothing: no outbox event (the outbox keys on
 * subscriberId and there is none), no revenue row (no amount), and no
 * entitlement change (we do not know who bought). A developer who knows
 * which of their users made the purchase reports it through their own
 * flow; that is where money and attribution belong.
 */
async function recordExternalPurchaseToken(
  projectId: string,
  notification: AppleResponseBodyV2DecodedPayload,
  webhookEventId: string,
): Promise<void> {
  const token = notification.externalPurchaseToken;
  if (!token?.externalPurchaseId) {
    // Without Apple's own id there is no dedup key and nothing to
    // reconcile against later, so recording it would create a row nobody
    // can act on.
    log.warn("EXTERNAL_PURCHASE_TOKEN without an externalPurchaseId", {
      uuid: notification.notificationUUID,
    });
    return;
  }

  await drizzle.appleExternalPurchaseRepo.recordExternalPurchase(drizzle.db, {
    projectId,
    externalPurchaseId: token.externalPurchaseId,
    tokenCreationDate: token.tokenCreationDate
      ? new Date(token.tokenCreationDate)
      : null,
    appAppleId: token.appAppleId ?? null,
    webhookEventId,
  });

  log.info("recorded an external purchase token", {
    projectId,
    externalPurchaseId: token.externalPurchaseId,
  });
}
