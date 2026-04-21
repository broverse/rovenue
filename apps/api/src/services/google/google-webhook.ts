import {
  Environment,
  WebhookEventStatus,
  WebhookSource,
  Store,
  PurchaseStatus,
  drizzle,
} from "@rovenue/db";
import { logger } from "../../lib/logger";
import { convertToUsd } from "../fx";
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

  const webhookEvent = await drizzle.webhookEventRepo.upsertWebhookEvent(
    drizzle.db,
    {
      projectId: opts.projectId,
      source: WebhookSource.GOOGLE,
      eventType: kind,
      storeEventId,
      payload: JSON.parse(JSON.stringify(payload)),
      status: WebhookEventStatus.PROCESSING,
    },
  );

  if (webhookEvent.status === WebhookEventStatus.PROCESSED) {
    log.info("duplicate notification, skipping", { storeEventId, kind });
    return { status: "duplicate", kind };
  }

  if (!opts.verifyConfig) {
    log.warn("no verify config, persisting without API verification", {
      projectId: opts.projectId,
      kind,
    });
    await drizzle.webhookEventRepo.updateWebhookEvent(
      drizzle.db,
      webhookEvent.id,
      {
        status: WebhookEventStatus.PROCESSED,
        processedAt: new Date(),
      },
    );
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
      kind,
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
  const product = await drizzle.productGroupRepo.findProductByStoreId(
    drizzle.db,
    ctx.projectId,
    "google",
    productId,
  );
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

  const persisted = await drizzle.purchaseRepo.upsertPurchase(drizzle.db, {
    store: Store.PLAY_STORE,
    storeTransactionId: ctx.notification.purchaseToken,
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
      // Drizzle decimal columns round-trip as strings.
      priceAmount: pricing?.amount != null ? pricing.amount.toString() : null,
      priceCurrency: pricing?.currency ?? null,
      verifiedAt: new Date(),
    },
    update: {
      status,
      expiresDate,
      autoRenewStatus,
      cancellationDate,
      ...(pricing?.amount != null && {
        priceAmount: pricing.amount.toString(),
      }),
      ...(pricing?.currency != null && { priceCurrency: pricing.currency }),
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
    await drizzle.accessRepo.revokeAccessByPurchaseId(drizzle.db, persisted.id);
  }

  await ensureAcknowledged(ctx, purchase);

  const revenueEventType = mapRevenueEventType(
    ctx.notification.notificationType,
  );
  if (revenueEventType) {
    const amount = pricing?.amount ?? 0;
    const currency = pricing?.currency ?? "USD";
    await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
      projectId: ctx.projectId,
      subscriberId: subscriber.id,
      purchaseId: persisted.id,
      productId: product.id,
      type: revenueEventType,
      amount: amount.toString(),
      currency,
      amountUsd: (await convertToUsd(amount, currency)).toString(),
      store: Store.PLAY_STORE,
      eventDate: new Date(),
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
    return drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
      projectId: ctx.projectId,
      appUserId: externalId,
    });
  }

  const existingPurchase =
    await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
      drizzle.db,
      Store.PLAY_STORE,
      ctx.notification.purchaseToken,
    );
  if (existingPurchase && existingPurchase.projectId === ctx.projectId) {
    const existingSubscriber = await drizzle.subscriberRepo.findSubscriberById(
      drizzle.db,
      existingPurchase.subscriberId,
    );
    if (existingSubscriber) return existingSubscriber;
  }

  return drizzle.subscriberRepo.createSubscriber(drizzle.db, {
    projectId: ctx.projectId,
    appUserId: `google:${ctx.notification.purchaseToken.slice(0, 24)}`,
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
    const existing = await drizzle.accessRepo.findAccessByPurchaseAndKey(
      drizzle.db,
      args.subscriberId,
      args.purchaseId,
      key,
    );
    if (existing) {
      await drizzle.accessRepo.setAccessActiveAndExpiry(
        drizzle.db,
        existing.id,
        true,
        args.expiresDate,
      );
    } else {
      await drizzle.accessRepo.createAccess(drizzle.db, {
        subscriberId: args.subscriberId,
        purchaseId: args.purchaseId,
        entitlementKey: key,
        isActive: true,
        expiresDate: args.expiresDate,
        store: Store.PLAY_STORE,
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
  const purchase = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
    Store.PLAY_STORE,
    args.purchaseToken,
  );

  if (purchase) {
    await drizzle.purchaseRepo.updatePurchase(drizzle.db, purchase.id, {
      status: PurchaseStatus.REFUNDED,
      refundDate: new Date(),
    });
    await drizzle.accessRepo.revokeAccessByPurchaseId(drizzle.db, purchase.id);
  }

  return purchase
    ? { subscriberId: purchase.subscriberId, purchaseId: purchase.id }
    : {};
}
