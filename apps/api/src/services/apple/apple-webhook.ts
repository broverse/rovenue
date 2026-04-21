import {
  Environment,
  PurchaseStatus,
  RevenueEventType,
  Store,
  WebhookEventStatus,
  WebhookSource,
  drizzle,
} from "@rovenue/db";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { loadAppleCredentials } from "../../lib/project-credentials";
import { convertToUsd } from "../fx";
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

const log = logger.child("apple-webhook");

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

  // Idempotent insert — concurrent workers see the same row and we check
  // the claimed status below.
  const webhookEvent = await drizzle.webhookEventRepo.upsertWebhookEvent(
    drizzle.db,
    {
      projectId: opts.projectId,
      source: WebhookSource.APPLE,
      eventType: notification.notificationType,
      storeEventId: notification.notificationUUID,
      payload: JSON.parse(JSON.stringify(notification)),
      status: WebhookEventStatus.PROCESSING,
    },
  );

  if (webhookEvent.status === WebhookEventStatus.PROCESSED) {
    log.info("duplicate notification, skipping", {
      uuid: notification.notificationUUID,
      type: notification.notificationType,
    });
    return {
      status: "duplicate",
      notificationType: notification.notificationType,
    };
  }

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
    case APPLE_NOTIFICATION_TYPE.REVOKE:
      return applyRevoke(ctx);
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
  const { product, purchase } = await upsertPurchase({
    ctx,
    subscriberId: subscriber.id,
    status: isTrial(ctx.transaction)
      ? PurchaseStatus.TRIAL
      : PurchaseStatus.ACTIVE,
    autoRenewStatus: ctx.renewalInfo?.autoRenewStatus === 1,
  });
  ctx.outcome.subscriberId = subscriber.id;
  ctx.outcome.purchaseId = purchase.id;
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
  const { product, purchase } = await upsertPurchase({
    ctx,
    subscriberId: subscriber.id,
    status: PurchaseStatus.ACTIVE,
    autoRenewStatus: ctx.renewalInfo?.autoRenewStatus === 1,
  });
  ctx.outcome.subscriberId = subscriber.id;
  ctx.outcome.purchaseId = purchase.id;
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
  const inGrace =
    ctx.notification.subtype === APPLE_NOTIFICATION_SUBTYPE.GRACE_PERIOD;
  const gracePeriodExpires = ctx.renewalInfo?.gracePeriodExpiresDate
    ? new Date(ctx.renewalInfo.gracePeriodExpiresDate)
    : null;

  await drizzle.purchaseRepo.updatePurchasesByOriginalTransaction(
    drizzle.db,
    ctx.projectId,
    ctx.transaction.originalTransactionId,
    {
      status: inGrace ? PurchaseStatus.GRACE_PERIOD : PurchaseStatus.ACTIVE,
      gracePeriodExpires,
    },
  );
}

async function applyExpired(ctx: DispatchContext): Promise<void> {
  await drizzle.purchaseRepo.updatePurchasesByOriginalTransaction(
    drizzle.db,
    ctx.projectId,
    ctx.transaction.originalTransactionId,
    { status: PurchaseStatus.EXPIRED },
  );
  await revokeAccessForTransaction(ctx);
  await emitCancellationEvent(ctx);
}

async function applyRefund(ctx: DispatchContext): Promise<void> {
  const refundDate = new Date(ctx.transaction.signedDate);
  // Refund targets the specific transaction by (store, storeTxnId),
  // not the whole chain. updatePurchasesByOriginalTransaction is the
  // chain-wide helper; we need a scoped write, so use the upsert's
  // update branch via a tiny inline repo call. In practice only one
  // purchase row shares this (store, storeTxnId) because the column
  // pair has a unique index.
  const found = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
    Store.APP_STORE,
    ctx.transaction.transactionId,
  );
  if (found) {
    await drizzle.purchaseRepo.updatePurchase(drizzle.db, found.id, {
      status: PurchaseStatus.REFUNDED,
      refundDate,
    });
  }
  await revokeAccessForTransaction(ctx);

  const purchase = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
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
    negative: true,
  });
}

async function applyRevoke(ctx: DispatchContext): Promise<void> {
  await drizzle.purchaseRepo.updatePurchasesByOriginalTransaction(
    drizzle.db,
    ctx.projectId,
    ctx.transaction.originalTransactionId,
    { status: PurchaseStatus.REVOKED },
  );
  await revokeAccessForTransaction(ctx);
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

  if (transaction.appAccountToken) {
    return drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
      projectId,
      appUserId: transaction.appAccountToken,
    });
  }

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

  return drizzle.subscriberRepo.createSubscriber(drizzle.db, {
    projectId,
    appUserId: `apple:${transaction.originalTransactionId}`,
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

  const product = await drizzle.productGroupRepo.findProductByStoreId(
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
  const purchase = await drizzle.purchaseRepo.upsertPurchase(drizzle.db, {
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
      status,
      autoRenewStatus,
      expiresDate: tx.expiresDate ? new Date(tx.expiresDate) : null,
      verifiedAt: new Date(),
    },
  });

  return { product, purchase };
}

interface GrantAccessArgs {
  ctx: DispatchContext;
  subscriber: { id: string };
  purchase: { id: string };
  product: { id: string; entitlementKeys: string[] };
}

async function grantAccess(args: GrantAccessArgs): Promise<void> {
  const { ctx, subscriber, purchase, product } = args;
  const expiresDate = ctx.transaction.expiresDate
    ? new Date(ctx.transaction.expiresDate)
    : null;

  for (const key of product.entitlementKeys) {
    const existing = await drizzle.accessRepo.findAccessByPurchaseAndKey(
      drizzle.db,
      subscriber.id,
      purchase.id,
      key,
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
        entitlementKey: key,
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
  negative?: boolean;
}

async function emitRevenueEvent(args: EmitRevenueArgs): Promise<void> {
  const { ctx, subscriberId, purchaseId, productId, type, negative } = args;
  const tx = ctx.transaction;

  if (tx.price == null || !tx.currency) {
    log.debug("skipping revenue event: no price", {
      transactionId: tx.transactionId,
      type,
    });
    return;
  }

  const amount = tx.price / 1_000_000;
  const signed = negative ? -amount : amount;
  const amountUsd = await convertToUsd(signed, tx.currency);

  await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
    projectId: ctx.projectId,
    subscriberId,
    purchaseId,
    productId,
    type,
    amount: signed.toString(),
    currency: tx.currency,
    amountUsd: amountUsd.toString(),
    store: Store.APP_STORE,
    eventDate: new Date(tx.purchaseDate),
  });
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
