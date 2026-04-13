import prisma, {
  Environment,
  WebhookEventStatus,
  WebhookSource,
  Store,
  PurchaseStatus,
} from "@rovenue/db";
import { logger } from "../../lib/logger";
import {
  GOOGLE_ACKNOWLEDGEMENT_STATE,
  type GooglePubSubPushBody,
  type GoogleRtdnSubscriptionNotification,
  type GoogleSubscriptionPurchaseV2,
} from "./google-types";
import {
  classifyNotification,
  extractCancelTime,
  isEntitlementGranting,
  mapRevenueEventType,
  mapStatus,
  parsePushBody,
} from "./google-mappers";
import {
  acknowledgeGoogleSubscription,
  getSubscriptionBasePlanPricing,
  verifyGoogleSubscription,
  type BasePlanPricing,
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
  | {
      status: "processed";
      kind: string;
      webhookEventId: string;
      subscriberId?: string;
      purchaseId?: string;
    }
  | { status: "duplicate"; kind: string }
  | { status: "test" }
  | { status: "persisted-no-verify"; kind: string; webhookEventId: string };

interface GoogleDispatchOutcome {
  subscriberId?: string;
  purchaseId?: string;
}

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
    let outcome: GoogleDispatchOutcome = {};

    if (payload.subscriptionNotification) {
      outcome =
        (await processSubscriptionNotification({
          projectId: opts.projectId,
          notification: payload.subscriptionNotification,
          verifyConfig: opts.verifyConfig,
        })) ?? {};
    } else if (payload.voidedPurchaseNotification) {
      outcome =
        (await processVoidedPurchase({
          projectId: opts.projectId,
          purchaseToken: payload.voidedPurchaseNotification.purchaseToken,
        })) ?? {};
    } else if (payload.oneTimeProductNotification) {
      log.info("one-time product notification, acknowledging", {
        sku: payload.oneTimeProductNotification.sku,
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
      kind,
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
      storeEventId,
      kind,
      err: message,
    });
    throw err;
  }
}

// =============================================================
// Subscription notification processing
// =============================================================

interface SubscriptionCtx {
  projectId: string;
  notification: GoogleRtdnSubscriptionNotification;
  verifyConfig: GoogleVerifyConfig;
}

async function processSubscriptionNotification(
  ctx: SubscriptionCtx,
): Promise<GoogleDispatchOutcome> {
  const purchase = await verifyGoogleSubscription(
    ctx.verifyConfig,
    ctx.notification.purchaseToken,
  );

  const subscriber = await resolveSubscriber(ctx, purchase);

  const lineItem = purchase.lineItems?.[0];
  const productId = lineItem?.productId ?? ctx.notification.subscriptionId;
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
  const expiresDate = lineItem?.expiryTime ? new Date(lineItem.expiryTime) : null;
  const startTime = purchase.startTime
    ? new Date(purchase.startTime)
    : new Date();
  const autoRenewStatus = lineItem?.autoRenewingPlan?.autoRenewEnabled ?? null;
  const cancellationDate = extractCancelTime(purchase);

  const pricing = await resolvePricing({
    verifyConfig: ctx.verifyConfig,
    productId,
    basePlanId: lineItem?.offerDetails?.basePlanId,
    regionCode: purchase.regionCode,
  });

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
      priceAmount: pricing?.amount ?? null,
      priceCurrency: pricing?.currency ?? null,
      verifiedAt: new Date(),
    },
    update: {
      status,
      expiresDate,
      autoRenewStatus,
      cancellationDate,
      priceAmount: pricing?.amount ?? undefined,
      priceCurrency: pricing?.currency ?? undefined,
      verifiedAt: new Date(),
    },
  });

  if (isEntitlementGranting(status)) {
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

  await ensureAcknowledged(ctx, purchase);

  const revenueEventType = mapRevenueEventType(
    ctx.notification.notificationType,
  );
  if (revenueEventType) {
    await prisma.revenueEvent.create({
      data: {
        projectId: ctx.projectId,
        subscriberId: subscriber.id,
        purchaseId: persisted.id,
        productId: product.id,
        type: revenueEventType,
        amount: pricing?.amount ?? 0,
        currency: pricing?.currency ?? "USD",
        // Same-currency pass-through: non-USD revenue is reported in its
        // native units until an FX normalisation service is wired in.
        amountUsd: pricing?.amount ?? 0,
        store: Store.PLAY_STORE,
        eventDate: new Date(),
      },
    });
  }

  return { subscriberId: subscriber.id, purchaseId: persisted.id };
}

interface ResolvePricingArgs {
  verifyConfig: GoogleVerifyConfig;
  productId: string;
  basePlanId: string | undefined;
  regionCode: string | undefined;
}

async function resolvePricing(
  args: ResolvePricingArgs,
): Promise<BasePlanPricing | null> {
  if (!args.basePlanId) return null;

  try {
    return await getSubscriptionBasePlanPricing(
      args.verifyConfig,
      args.productId,
      args.basePlanId,
      args.regionCode ?? "US",
    );
  } catch (err) {
    log.warn("basePlan pricing lookup failed", {
      productId: args.productId,
      basePlanId: args.basePlanId,
      regionCode: args.regionCode,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function ensureAcknowledged(
  ctx: SubscriptionCtx,
  purchase: GoogleSubscriptionPurchaseV2,
): Promise<void> {
  if (purchase.acknowledgementState !== GOOGLE_ACKNOWLEDGEMENT_STATE.PENDING) {
    return;
  }

  try {
    await acknowledgeGoogleSubscription(
      ctx.verifyConfig,
      ctx.notification.subscriptionId,
      ctx.notification.purchaseToken,
    );
  } catch (err) {
    // Don't fail the whole notification over an ack hiccup — Google retries
    // the RTDN, and a subsequent event will trigger another ack attempt.
    log.warn("acknowledge failed", {
      subscriptionId: ctx.notification.subscriptionId,
      tokenPrefix: ctx.notification.purchaseToken.slice(0, 12),
      err: err instanceof Error ? err.message : String(err),
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

// =============================================================
// Voided purchase handling
// =============================================================

interface VoidedPurchaseArgs {
  projectId: string;
  purchaseToken: string;
}

async function processVoidedPurchase(
  args: VoidedPurchaseArgs,
): Promise<GoogleDispatchOutcome> {
  const purchase = await prisma.purchase.findUnique({
    where: {
      store_storeTransactionId: {
        store: Store.PLAY_STORE,
        storeTransactionId: args.purchaseToken,
      },
    },
    select: { id: true, subscriberId: true },
  });

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

  return purchase
    ? { subscriberId: purchase.subscriberId, purchaseId: purchase.id }
    : {};
}
