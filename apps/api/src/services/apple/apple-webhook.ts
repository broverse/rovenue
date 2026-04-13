import prisma from "@rovenue/db";
import {
  Environment,
  PurchaseStatus,
  RevenueEventType,
  Store,
  WebhookEventStatus,
  WebhookSource,
} from "@rovenue/db";
import { logger } from "../../lib/logger";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_SUBTYPE,
  APPLE_NOTIFICATION_TYPE,
  APPLE_OFFER_TYPE,
  type AppleJwsRenewalInfoPayload,
  type AppleJwsTransactionPayload,
  type AppleNotificationType,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import {
  JoseAppleNotificationVerifier,
  type AppleKeyLookup,
  type AppleNotificationVerifier,
} from "./apple-verify";

const log = logger.child("apple-webhook");

export interface HandleAppleNotificationOptions {
  projectId: string;
  signedPayload: string;
  /**
   * Verifier used to decode the notification + embedded JWS payloads. In
   * production this should be a {@link LibraryAppleNotificationVerifier}
   * configured with Apple root certs, bundleId, and environment. If omitted,
   * a {@link JoseAppleNotificationVerifier} is constructed from `keyLookup`.
   */
  verifier?: AppleNotificationVerifier;
  /** Legacy key lookup path — ignored if `verifier` is provided. */
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
  const verifier =
    opts.verifier ?? new JoseAppleNotificationVerifier(opts.keyLookup);

  const notification = await verifier.verifyNotification(opts.signedPayload);

  const existing = await prisma.webhookEvent.findUnique({
    where: {
      source_storeEventId: {
        source: WebhookSource.APPLE,
        storeEventId: notification.notificationUUID,
      },
    },
  });

  if (existing && existing.status === WebhookEventStatus.PROCESSED) {
    log.info("duplicate notification, skipping", {
      uuid: notification.notificationUUID,
      type: notification.notificationType,
    });
    return {
      status: "duplicate",
      notificationType: notification.notificationType,
    };
  }

  const webhookEvent =
    existing ??
    (await prisma.webhookEvent.create({
      data: {
        projectId: opts.projectId,
        source: WebhookSource.APPLE,
        eventType: notification.notificationType,
        storeEventId: notification.notificationUUID,
        payload: JSON.parse(JSON.stringify(notification)),
        status: WebhookEventStatus.PROCESSING,
      },
    }));

  try {
    const transaction = notification.data?.signedTransactionInfo
      ? await verifier.verifyTransaction(notification.data.signedTransactionInfo)
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

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: WebhookEventStatus.PROCESSED,
        processedAt: new Date(),
        subscriberId: outcome.subscriberId,
        purchaseId: outcome.purchaseId,
      },
    });

    return {
      status: "processed",
      notificationType: notification.notificationType,
      webhookEventId: webhookEvent.id,
      subscriberId: outcome.subscriberId,
      purchaseId: outcome.purchaseId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: WebhookEventStatus.FAILED,
        errorMessage: message,
        retryCount: { increment: 1 },
      },
    });
    log.error("notification processing failed", {
      uuid: notification.notificationUUID,
      type: notification.notificationType,
      err: message,
    });
    throw err;
  }
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
    status: isTrial(ctx.transaction) ? PurchaseStatus.TRIAL : PurchaseStatus.ACTIVE,
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
  await prisma.purchase.updateMany({
    where: {
      projectId: ctx.projectId,
      originalTransactionId: ctx.transaction.originalTransactionId,
    },
    data: { autoRenewStatus },
  });
}

async function applyFailedRenewal(ctx: DispatchContext): Promise<void> {
  const inGrace =
    ctx.notification.subtype === APPLE_NOTIFICATION_SUBTYPE.GRACE_PERIOD;
  const gracePeriodExpires = ctx.renewalInfo?.gracePeriodExpiresDate
    ? new Date(ctx.renewalInfo.gracePeriodExpiresDate)
    : null;

  await prisma.purchase.updateMany({
    where: {
      projectId: ctx.projectId,
      originalTransactionId: ctx.transaction.originalTransactionId,
    },
    data: {
      status: inGrace ? PurchaseStatus.GRACE_PERIOD : PurchaseStatus.ACTIVE,
      gracePeriodExpires,
    },
  });
}

async function applyExpired(ctx: DispatchContext): Promise<void> {
  await prisma.purchase.updateMany({
    where: {
      projectId: ctx.projectId,
      originalTransactionId: ctx.transaction.originalTransactionId,
    },
    data: { status: PurchaseStatus.EXPIRED },
  });
  await revokeAccessForTransaction(ctx);
  await emitCancellationEvent(ctx);
}

async function applyRefund(ctx: DispatchContext): Promise<void> {
  const refundDate = new Date(ctx.transaction.signedDate);
  await prisma.purchase.updateMany({
    where: {
      projectId: ctx.projectId,
      store: Store.APP_STORE,
      storeTransactionId: ctx.transaction.transactionId,
    },
    data: {
      status: PurchaseStatus.REFUNDED,
      refundDate,
    },
  });
  await revokeAccessForTransaction(ctx);

  const subscriber = await prisma.subscriber.findFirst({
    where: {
      projectId: ctx.projectId,
      purchases: {
        some: {
          store: Store.APP_STORE,
          storeTransactionId: ctx.transaction.transactionId,
        },
      },
    },
  });
  const purchase = await prisma.purchase.findUnique({
    where: {
      store_storeTransactionId: {
        store: Store.APP_STORE,
        storeTransactionId: ctx.transaction.transactionId,
      },
    },
  });
  if (!subscriber || !purchase) return;

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
  await prisma.purchase.updateMany({
    where: {
      projectId: ctx.projectId,
      originalTransactionId: ctx.transaction.originalTransactionId,
    },
    data: { status: PurchaseStatus.REVOKED },
  });
  await revokeAccessForTransaction(ctx);
}

// =============================================================
// Helpers
// =============================================================

function isTrial(transaction: AppleJwsTransactionPayload): boolean {
  return transaction.offerType === APPLE_OFFER_TYPE.INTRODUCTORY;
}

function mapEnvironment(tx: AppleJwsTransactionPayload): Environment {
  return tx.environment === APPLE_ENVIRONMENT.PRODUCTION
    ? Environment.PRODUCTION
    : Environment.SANDBOX;
}

async function resolveSubscriber(ctx: DispatchContext) {
  const { projectId, transaction } = ctx;

  if (transaction.appAccountToken) {
    return prisma.subscriber.upsert({
      where: {
        projectId_appUserId: {
          projectId,
          appUserId: transaction.appAccountToken,
        },
      },
      update: { lastSeenAt: new Date() },
      create: {
        projectId,
        appUserId: transaction.appAccountToken,
      },
    });
  }

  const existing = await prisma.purchase.findFirst({
    where: {
      projectId,
      originalTransactionId: transaction.originalTransactionId,
    },
    include: { subscriber: true },
    orderBy: { createdAt: "desc" },
  });
  if (existing?.subscriber) {
    return existing.subscriber;
  }

  return prisma.subscriber.create({
    data: {
      projectId,
      appUserId: `apple:${transaction.originalTransactionId}`,
    },
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

  const product = await prisma.product.findFirst({
    where: {
      projectId: ctx.projectId,
      storeIds: { path: ["apple"], equals: tx.productId },
    },
  });
  if (!product) {
    throw new Error(
      `No product mapped for Apple productId ${tx.productId} in project ${ctx.projectId}`,
    );
  }

  const environment = mapEnvironment(tx);
  const purchase = await prisma.purchase.upsert({
    where: {
      store_storeTransactionId: {
        store: Store.APP_STORE,
        storeTransactionId: tx.transactionId,
      },
    },
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
      priceAmount: tx.price != null ? tx.price / 1_000_000 : null,
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
    const existing = await prisma.subscriberAccess.findFirst({
      where: {
        subscriberId: subscriber.id,
        purchaseId: purchase.id,
        entitlementKey: key,
      },
    });
    if (existing) {
      await prisma.subscriberAccess.update({
        where: { id: existing.id },
        data: { isActive: true, expiresDate },
      });
    } else {
      await prisma.subscriberAccess.create({
        data: {
          subscriberId: subscriber.id,
          purchaseId: purchase.id,
          entitlementKey: key,
          isActive: true,
          expiresDate,
          store: Store.APP_STORE,
        },
      });
    }
  }
}

async function revokeAccessForTransaction(ctx: DispatchContext): Promise<void> {
  await prisma.subscriberAccess.updateMany({
    where: {
      purchase: {
        projectId: ctx.projectId,
        originalTransactionId: ctx.transaction.originalTransactionId,
      },
    },
    data: { isActive: false },
  });
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

  await prisma.revenueEvent.create({
    data: {
      projectId: ctx.projectId,
      subscriberId,
      purchaseId,
      productId,
      type,
      amount: signed,
      currency: tx.currency,
      // TODO: plug real FX conversion; for now treat price currency as USD-equivalent.
      amountUsd: signed,
      store: Store.APP_STORE,
      eventDate: new Date(tx.purchaseDate),
    },
  });
}

async function emitCancellationEvent(ctx: DispatchContext): Promise<void> {
  const purchase = await prisma.purchase.findFirst({
    where: {
      projectId: ctx.projectId,
      originalTransactionId: ctx.transaction.originalTransactionId,
    },
  });
  if (!purchase) return;

  const subscriber = await prisma.subscriber.findUnique({
    where: { id: purchase.subscriberId },
  });
  if (!subscriber) return;

  await emitRevenueEvent({
    ctx,
    subscriberId: subscriber.id,
    purchaseId: purchase.id,
    productId: purchase.productId,
    type: RevenueEventType.CANCELLATION,
  });
}
