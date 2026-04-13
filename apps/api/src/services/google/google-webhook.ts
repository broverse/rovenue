import prisma, {
  Environment,
  PurchaseStatus,
  RevenueEventType,
  Store,
  WebhookEventStatus,
  WebhookSource,
} from "@rovenue/db";
import { logger } from "../../lib/logger";
import {
  GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE,
  GOOGLE_SUBSCRIPTION_STATE,
  type GooglePubSubPushBody,
  type GoogleRtdnPayload,
  type GoogleRtdnSubscriptionNotification,
  type GoogleSubscriptionNotificationType,
  type GoogleSubscriptionPurchaseV2,
  type GoogleSubscriptionState,
} from "./google-types";
import {
  verifyGoogleSubscription,
  type GoogleVerifyConfig,
} from "./google-verify";

const log = logger.child("google-webhook");

// =============================================================
// Public API
// =============================================================

export interface HandleGoogleNotificationOptions {
  projectId: string;
  pushBody: GooglePubSubPushBody;
  /**
   * Credentials + packageName for calling the Android Publisher API. If
   * omitted, the notification is persisted without fetching authoritative
   * state from Google (useful during initial setup before credentials are
   * configured).
   */
  verifyConfig?: GoogleVerifyConfig;
}

export type HandleGoogleNotificationResult =
  | { status: "processed"; kind: string; webhookEventId: string }
  | { status: "duplicate"; kind: string }
  | { status: "test" }
  | { status: "persisted-no-verify"; kind: string; webhookEventId: string };

export async function handleGoogleNotification(
  opts: HandleGoogleNotificationOptions,
): Promise<HandleGoogleNotificationResult> {
  const payload = parsePushBody(opts.pushBody);

  if (payload.testNotification) {
    log.info("received test notification", {
      packageName: payload.packageName,
      version: payload.testNotification.version,
    });
    return { status: "test" };
  }

  const storeEventId =
    payload.subscriptionNotification?.purchaseToken ??
    payload.oneTimeProductNotification?.purchaseToken ??
    payload.voidedPurchaseNotification?.purchaseToken ??
    opts.pushBody.message.messageId;

  const kind = classifyNotification(payload);

  const existing = await prisma.webhookEvent.findUnique({
    where: {
      source_storeEventId: {
        source: WebhookSource.GOOGLE,
        storeEventId,
      },
    },
  });

  if (existing && existing.status === WebhookEventStatus.PROCESSED) {
    log.info("duplicate notification, skipping", { storeEventId, kind });
    return { status: "duplicate", kind };
  }

  const webhookEvent =
    existing ??
    (await prisma.webhookEvent.create({
      data: {
        projectId: opts.projectId,
        source: WebhookSource.GOOGLE,
        eventType: kind,
        storeEventId,
        payload: JSON.parse(JSON.stringify(payload)),
        status: WebhookEventStatus.PROCESSING,
      },
    }));

  if (!opts.verifyConfig) {
    log.warn("no verify config, persisting without API verification", {
      projectId: opts.projectId,
      kind,
    });
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: WebhookEventStatus.PROCESSED,
        processedAt: new Date(),
      },
    });
    return {
      status: "persisted-no-verify",
      kind,
      webhookEventId: webhookEvent.id,
    };
  }

  try {
    if (payload.subscriptionNotification) {
      await processSubscriptionNotification({
        projectId: opts.projectId,
        notification: payload.subscriptionNotification,
        verifyConfig: opts.verifyConfig,
      });
    } else if (payload.voidedPurchaseNotification) {
      await processVoidedPurchase({
        projectId: opts.projectId,
        purchaseToken: payload.voidedPurchaseNotification.purchaseToken,
      });
    } else if (payload.oneTimeProductNotification) {
      log.info("one-time product notification, acknowledging", {
        sku: payload.oneTimeProductNotification.sku,
      });
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: WebhookEventStatus.PROCESSED, processedAt: new Date() },
    });

    return {
      status: "processed",
      kind,
      webhookEventId: webhookEvent.id,
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
      storeEventId,
      kind,
      err: message,
    });
    throw err;
  }
}

// =============================================================
// Pub/Sub envelope parsing
// =============================================================

function parsePushBody(body: GooglePubSubPushBody): GoogleRtdnPayload {
  const dataJson = Buffer.from(body.message.data, "base64").toString("utf8");
  return JSON.parse(dataJson) as GoogleRtdnPayload;
}

function classifyNotification(payload: GoogleRtdnPayload): string {
  if (payload.subscriptionNotification) {
    return `SUBSCRIPTION_${payload.subscriptionNotification.notificationType}`;
  }
  if (payload.oneTimeProductNotification) {
    return `ONE_TIME_${payload.oneTimeProductNotification.notificationType}`;
  }
  if (payload.voidedPurchaseNotification) {
    return "VOIDED_PURCHASE";
  }
  return "UNKNOWN";
}

// =============================================================
// Subscription notification processing
// =============================================================

interface SubscriptionCtx {
  projectId: string;
  notification: GoogleRtdnSubscriptionNotification;
  verifyConfig: GoogleVerifyConfig;
}

const ENTITLEMENT_GRANTING_STATUSES = new Set<PurchaseStatus>([
  PurchaseStatus.ACTIVE,
  PurchaseStatus.TRIAL,
  PurchaseStatus.GRACE_PERIOD,
]);

async function processSubscriptionNotification(
  ctx: SubscriptionCtx,
): Promise<void> {
  const purchase = await verifyGoogleSubscription(
    ctx.verifyConfig,
    ctx.notification.purchaseToken,
  );

  const subscriber = await resolveSubscriber(ctx, purchase);

  const productId =
    purchase.lineItems?.[0]?.productId ?? ctx.notification.subscriptionId;
  const product = await prisma.product.findFirst({
    where: {
      projectId: ctx.projectId,
      storeIds: { path: ["google"], equals: productId },
    },
  });
  if (!product) {
    throw new Error(
      `No product mapped for Google productId ${productId} in project ${ctx.projectId}`,
    );
  }

  const status = mapStatus(
    purchase.subscriptionState,
    ctx.notification.notificationType,
  );
  const expiresDate = purchase.lineItems?.[0]?.expiryTime
    ? new Date(purchase.lineItems[0].expiryTime)
    : null;
  const startTime = purchase.startTime
    ? new Date(purchase.startTime)
    : new Date();
  const autoRenewStatus =
    purchase.lineItems?.[0]?.autoRenewingPlan?.autoRenewEnabled ?? null;
  const cancellationDate = extractCancelTime(purchase);

  const persisted = await prisma.purchase.upsert({
    where: {
      store_storeTransactionId: {
        store: Store.PLAY_STORE,
        storeTransactionId: ctx.notification.purchaseToken,
      },
    },
    create: {
      projectId: ctx.projectId,
      subscriberId: subscriber.id,
      productId: product.id,
      store: Store.PLAY_STORE,
      storeTransactionId: ctx.notification.purchaseToken,
      originalTransactionId:
        purchase.linkedPurchaseToken ?? ctx.notification.purchaseToken,
      status,
      purchaseDate: startTime,
      originalPurchaseDate: startTime,
      expiresDate,
      environment: Environment.PRODUCTION,
      autoRenewStatus,
      cancellationDate,
      verifiedAt: new Date(),
    },
    update: {
      status,
      expiresDate,
      autoRenewStatus,
      cancellationDate,
      verifiedAt: new Date(),
    },
  });

  if (ENTITLEMENT_GRANTING_STATUSES.has(status)) {
    await grantAccess({
      subscriberId: subscriber.id,
      purchaseId: persisted.id,
      entitlementKeys: product.entitlementKeys,
      expiresDate,
    });
  } else {
    await prisma.subscriberAccess.updateMany({
      where: { purchaseId: persisted.id },
      data: { isActive: false },
    });
  }

  const revenueEventType = mapRevenueEventType(ctx.notification.notificationType);
  if (revenueEventType) {
    // TODO: enrich amount/currency by fetching basePlan pricing from the
    // Monetization API. For now the event fires with 0 so downstream
    // analytics see the lifecycle transition.
    await prisma.revenueEvent.create({
      data: {
        projectId: ctx.projectId,
        subscriberId: subscriber.id,
        purchaseId: persisted.id,
        productId: product.id,
        type: revenueEventType,
        amount: 0,
        currency: "USD",
        amountUsd: 0,
        store: Store.PLAY_STORE,
        eventDate: new Date(),
      },
    });
  }
}

async function resolveSubscriber(
  ctx: SubscriptionCtx,
  purchase: GoogleSubscriptionPurchaseV2,
) {
  const externalId =
    purchase.externalAccountIdentifiers?.externalAccountId ??
    purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId;

  if (externalId) {
    return prisma.subscriber.upsert({
      where: {
        projectId_appUserId: {
          projectId: ctx.projectId,
          appUserId: externalId,
        },
      },
      update: { lastSeenAt: new Date() },
      create: {
        projectId: ctx.projectId,
        appUserId: externalId,
      },
    });
  }

  const existing = await prisma.purchase.findFirst({
    where: {
      projectId: ctx.projectId,
      store: Store.PLAY_STORE,
      storeTransactionId: ctx.notification.purchaseToken,
    },
    include: { subscriber: true },
  });
  if (existing?.subscriber) return existing.subscriber;

  return prisma.subscriber.create({
    data: {
      projectId: ctx.projectId,
      appUserId: `google:${ctx.notification.purchaseToken.slice(0, 24)}`,
    },
  });
}

interface GrantAccessArgs {
  subscriberId: string;
  purchaseId: string;
  entitlementKeys: string[];
  expiresDate: Date | null;
}

async function grantAccess(args: GrantAccessArgs): Promise<void> {
  for (const key of args.entitlementKeys) {
    const existing = await prisma.subscriberAccess.findFirst({
      where: {
        subscriberId: args.subscriberId,
        purchaseId: args.purchaseId,
        entitlementKey: key,
      },
    });
    if (existing) {
      await prisma.subscriberAccess.update({
        where: { id: existing.id },
        data: { isActive: true, expiresDate: args.expiresDate },
      });
    } else {
      await prisma.subscriberAccess.create({
        data: {
          subscriberId: args.subscriberId,
          purchaseId: args.purchaseId,
          entitlementKey: key,
          isActive: true,
          expiresDate: args.expiresDate,
          store: Store.PLAY_STORE,
        },
      });
    }
  }
}

function mapStatus(
  state: GoogleSubscriptionState,
  type: GoogleSubscriptionNotificationType,
): PurchaseStatus {
  switch (state) {
    case GOOGLE_SUBSCRIPTION_STATE.ACTIVE:
    case GOOGLE_SUBSCRIPTION_STATE.CANCELED:
      // CANCELED means auto-renew is off; access runs until expiry.
      return PurchaseStatus.ACTIVE;
    case GOOGLE_SUBSCRIPTION_STATE.IN_GRACE_PERIOD:
      return PurchaseStatus.GRACE_PERIOD;
    case GOOGLE_SUBSCRIPTION_STATE.ON_HOLD:
    case GOOGLE_SUBSCRIPTION_STATE.PAUSED:
      return PurchaseStatus.PAUSED;
    case GOOGLE_SUBSCRIPTION_STATE.EXPIRED:
      return PurchaseStatus.EXPIRED;
    case GOOGLE_SUBSCRIPTION_STATE.PENDING:
    case GOOGLE_SUBSCRIPTION_STATE.PENDING_PURCHASE_CANCELED:
      return PurchaseStatus.TRIAL;
    default:
      if (type === GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED) {
        return PurchaseStatus.REVOKED;
      }
      return PurchaseStatus.ACTIVE;
  }
}

function mapRevenueEventType(
  type: GoogleSubscriptionNotificationType,
): RevenueEventType | null {
  switch (type) {
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_PURCHASED:
      return RevenueEventType.INITIAL;
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RENEWED:
      return RevenueEventType.RENEWAL;
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RECOVERED:
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_RESTARTED:
      return RevenueEventType.REACTIVATION;
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_CANCELED:
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_EXPIRED:
      return RevenueEventType.CANCELLATION;
    case GOOGLE_SUBSCRIPTION_NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED:
      return RevenueEventType.REFUND;
    default:
      return null;
  }
}

function extractCancelTime(
  purchase: GoogleSubscriptionPurchaseV2,
): Date | null {
  const cancelTime =
    purchase.canceledStateContext?.userInitiatedCancellation?.cancelTime;
  return cancelTime ? new Date(cancelTime) : null;
}

// =============================================================
// Voided purchase handling
// =============================================================

interface VoidedPurchaseArgs {
  projectId: string;
  purchaseToken: string;
}

async function processVoidedPurchase(
  args: VoidedPurchaseArgs,
): Promise<void> {
  await prisma.purchase.updateMany({
    where: {
      projectId: args.projectId,
      store: Store.PLAY_STORE,
      storeTransactionId: args.purchaseToken,
    },
    data: {
      status: PurchaseStatus.REFUNDED,
      refundDate: new Date(),
    },
  });
  await prisma.subscriberAccess.updateMany({
    where: {
      purchase: {
        projectId: args.projectId,
        store: Store.PLAY_STORE,
        storeTransactionId: args.purchaseToken,
      },
    },
    data: { isActive: false },
  });
}
