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
import { audit } from "../../lib/audit";

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
    payload: JSON.parse(JSON.stringify(notification)),
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
    } else {
      log.info("notification without transaction info, acknowledging", {
        uuid: notification.notificationUUID,
        type: notification.notificationType,
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
    case APPLE_NOTIFICATION_TYPE.DID_CHANGE_RENEWAL_STATUS:
      return applyRenewalStatusChange(ctx);
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

async function applyRenewalStatusChange(ctx: DispatchContext): Promise<void> {
  const autoRenewStatus = ctx.renewalInfo?.autoRenewStatus === 1;
  await drizzle.purchaseRepo.updatePurchasesByOriginalTransaction(
    drizzle.db,
    ctx.projectId,
    ctx.transaction.originalTransactionId,
    { autoRenewStatus },
  );
}

async function applyFailedRenewal(ctx: DispatchContext): Promise<void> {
  // OD-1: a failed renewal is billing-retry limbo, not active revenue —
  // keep access during Apple's retry window. This holds whether or not
  // the GRACE_PERIOD subtype is present: the non-grace variant is the
  // same retry limbo, so it must NOT map to ACTIVE (which would treat a
  // non-renewing subscription as a healthy paid one). Mirrors
  // normalizeAppleStatus(DID_FAIL_TO_RENEW) -> GRACE_PERIOD.
  const gracePeriodExpires = ctx.renewalInfo?.gracePeriodExpiresDate
    ? new Date(ctx.renewalInfo.gracePeriodExpiresDate)
    : null;

  await guardedChainStatusWrite(ctx, {
    status: PurchaseStatus.GRACE_PERIOD,
    gracePeriodExpires,
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
      });
      await drizzle.purchaseRepo.updatePurchase(dbTx, found.id, {
        ...(guard.apply ? { status: PurchaseStatus.REFUNDED } : {}),
        refundDate,
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

  // FINDING 1: guarded read + upsert in one tx so the FOR UPDATE lock
  // is held across the write (mechanism (a)); upsertPurchase also
  // CASE-guards the terminal status at SQL level (mechanism (b)).
  const { purchase, statusApplied } = await drizzle.db.transaction(
    async (dbTx) => {
      const guard = await guardStatusWrite({
        db: dbTx,
        projectId: ctx.projectId,
        store: Store.APP_STORE,
        storeTransactionId: tx.transactionId,
        to: status,
        source: `apple:${ctx.notification.notificationType}`,
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
        },
        update: {
          ...(guard.apply ? { status } : {}),
          autoRenewStatus,
          expiresDate: tx.expiresDate ? new Date(tx.expiresDate) : null,
          verifiedAt: new Date(),
        },
      });
      return { purchase: persisted, statusApplied: guard.apply };
    },
  );

  return { product, purchase, statusApplied };
}

interface GrantAccessArgs {
  ctx: DispatchContext;
  subscriber: { id: string };
  purchase: { id: string };
  product: { id: string; accessIds: string[] };
}

async function grantAccess(args: GrantAccessArgs): Promise<void> {
  const { ctx, subscriber, purchase, product } = args;
  const expiresDate = ctx.transaction.expiresDate
    ? new Date(ctx.transaction.expiresDate)
    : null;

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

interface EmitRevenueArgs {
  ctx: DispatchContext;
  subscriberId: string;
  purchaseId: string;
  productId: string;
  type: RevenueEventType;
}

async function emitRevenueEvent(args: EmitRevenueArgs): Promise<void> {
  const { ctx, subscriberId, purchaseId, productId, type } = args;
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
    eventDate: new Date(tx.purchaseDate),
    // transactionId is unique per Apple transaction (renewals get a new
    // one); the coarse kind lets the receipt-verify path converge on the
    // same key for this transaction. Idempotent across replays.
    dedupeKey: `apple:${tx.transactionId}:${revenueDedupeKind(type)}`,
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
