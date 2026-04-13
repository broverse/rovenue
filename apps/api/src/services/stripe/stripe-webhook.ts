import Stripe from "stripe";
import { HTTPException } from "hono/http-exception";
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
  STRIPE_EVENT_TYPE,
  STRIPE_INVOICE_BILLING_REASON,
  STRIPE_SUBSCRIPTION_STATUS,
  type StripeProjectCredentials,
} from "./stripe-types";

const log = logger.child("stripe-webhook");

// =============================================================
// Stripe client cache
// =============================================================

const clientCache = new Map<string, Stripe>();

export function getStripeClient(secretKey: string): Stripe {
  const existing = clientCache.get(secretKey);
  if (existing) return existing;

  const client = new Stripe(secretKey);
  clientCache.set(secretKey, client);
  log.debug("provisioned stripe client");
  return client;
}

// =============================================================
// Public API
// =============================================================

export interface HandleStripeNotificationOptions {
  projectId: string;
  rawBody: string;
  signature: string;
  credentials: StripeProjectCredentials;
}

export type HandleStripeNotificationResult =
  | { status: "processed"; eventType: string; webhookEventId: string }
  | { status: "duplicate"; eventType: string };

export async function handleStripeNotification(
  opts: HandleStripeNotificationOptions,
): Promise<HandleStripeNotificationResult> {
  const stripe = getStripeClient(opts.credentials.secretKey);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      opts.rawBody,
      opts.signature,
      opts.credentials.webhookSecret,
    );
  } catch (err) {
    log.warn("signature verification failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(400, { message: "Invalid Stripe signature" });
  }

  const existing = await prisma.webhookEvent.findUnique({
    where: {
      source_storeEventId: {
        source: WebhookSource.STRIPE,
        storeEventId: event.id,
      },
    },
  });

  if (existing && existing.status === WebhookEventStatus.PROCESSED) {
    log.info("duplicate event, skipping", {
      id: event.id,
      type: event.type,
    });
    return { status: "duplicate", eventType: event.type };
  }

  const webhookEvent =
    existing ??
    (await prisma.webhookEvent.create({
      data: {
        projectId: opts.projectId,
        source: WebhookSource.STRIPE,
        eventType: event.type,
        storeEventId: event.id,
        payload: JSON.parse(JSON.stringify(event)),
        status: WebhookEventStatus.PROCESSING,
      },
    }));

  try {
    await dispatch({ projectId: opts.projectId, event, stripe });

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: WebhookEventStatus.PROCESSED, processedAt: new Date() },
    });

    return {
      status: "processed",
      eventType: event.type,
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
    log.error("event processing failed", {
      id: event.id,
      type: event.type,
      err: message,
    });
    throw err;
  }
}

// =============================================================
// Dispatch
// =============================================================

interface DispatchContext {
  projectId: string;
  event: Stripe.Event;
  stripe: Stripe;
}

async function dispatch(ctx: DispatchContext): Promise<void> {
  switch (ctx.event.type) {
    case STRIPE_EVENT_TYPE.CUSTOMER_SUBSCRIPTION_CREATED:
    case STRIPE_EVENT_TYPE.CUSTOMER_SUBSCRIPTION_UPDATED:
      return syncSubscription(ctx);
    case STRIPE_EVENT_TYPE.CUSTOMER_SUBSCRIPTION_DELETED:
      return applySubscriptionDeleted(ctx);
    case STRIPE_EVENT_TYPE.INVOICE_PAID:
      return applyInvoicePaid(ctx);
    case STRIPE_EVENT_TYPE.INVOICE_PAYMENT_FAILED:
      return applyInvoicePaymentFailed(ctx);
    case STRIPE_EVENT_TYPE.CHARGE_REFUNDED:
      return applyChargeRefunded(ctx);
    default:
      log.debug("no state change for event type", { type: ctx.event.type });
  }
}

// =============================================================
// Per-event handlers
// =============================================================

async function syncSubscription(ctx: DispatchContext): Promise<void> {
  const subscription = ctx.event.data.object as Stripe.Subscription;
  const subscriber = await resolveSubscriber(ctx, subscription);
  const status = mapStripeSubscriptionStatus(subscription.status);
  const { product, purchase } = await upsertPurchaseFromSubscription(
    ctx,
    subscription,
    subscriber.id,
    status,
  );

  if (ENTITLEMENT_GRANTING_STATUSES.has(status)) {
    await grantAccess({
      subscriberId: subscriber.id,
      purchaseId: purchase.id,
      entitlementKeys: product.entitlementKeys,
      expiresDate: purchase.expiresDate,
    });
  } else {
    await prisma.subscriberAccess.updateMany({
      where: { purchaseId: purchase.id },
      data: { isActive: false },
    });
  }
}

async function applySubscriptionDeleted(ctx: DispatchContext): Promise<void> {
  const subscription = ctx.event.data.object as Stripe.Subscription;

  const purchase = await prisma.purchase.findUnique({
    where: {
      store_storeTransactionId: {
        store: Store.STRIPE,
        storeTransactionId: subscription.id,
      },
    },
  });
  if (!purchase) return;

  await prisma.purchase.update({
    where: { id: purchase.id },
    data: {
      status: PurchaseStatus.EXPIRED,
      cancellationDate: subscription.canceled_at
        ? new Date(subscription.canceled_at * 1000)
        : new Date(),
      autoRenewStatus: false,
    },
  });

  await prisma.subscriberAccess.updateMany({
    where: { purchaseId: purchase.id },
    data: { isActive: false },
  });

  await prisma.revenueEvent.create({
    data: {
      projectId: ctx.projectId,
      subscriberId: purchase.subscriberId,
      purchaseId: purchase.id,
      productId: purchase.productId,
      type: RevenueEventType.CANCELLATION,
      amount: 0,
      currency: purchase.priceCurrency ?? "USD",
      amountUsd: 0,
      store: Store.STRIPE,
      eventDate: new Date(),
    },
  });
}

async function applyInvoicePaid(ctx: DispatchContext): Promise<void> {
  const invoice = ctx.event.data.object as Stripe.Invoice;
  const subscriptionId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id;

  if (!subscriptionId) {
    log.debug("invoice.paid without subscription, skipping");
    return;
  }

  const purchase = await prisma.purchase.findUnique({
    where: {
      store_storeTransactionId: {
        store: Store.STRIPE,
        storeTransactionId: subscriptionId,
      },
    },
  });
  if (!purchase) {
    log.warn("invoice.paid for unknown purchase", { subscriptionId });
    return;
  }

  const amount = (invoice.amount_paid ?? 0) / 100;
  const currency = invoice.currency?.toUpperCase() ?? "USD";
  const isFirstInvoice =
    invoice.billing_reason === STRIPE_INVOICE_BILLING_REASON.SUBSCRIPTION_CREATE;

  let type: RevenueEventType;
  if (purchase.isTrial && !isFirstInvoice) {
    type = RevenueEventType.TRIAL_CONVERSION;
  } else if (isFirstInvoice) {
    type = RevenueEventType.INITIAL;
  } else {
    type = RevenueEventType.RENEWAL;
  }

  // Once the first paid invoice clears the trial flag should drop so
  // subsequent renewals are classified as RENEWAL instead of TRIAL_CONVERSION.
  if (purchase.isTrial) {
    await prisma.purchase.update({
      where: { id: purchase.id },
      data: { isTrial: false },
    });
  }

  const eventDate = invoice.created
    ? new Date(invoice.created * 1000)
    : new Date();

  await prisma.revenueEvent.create({
    data: {
      projectId: ctx.projectId,
      subscriberId: purchase.subscriberId,
      purchaseId: purchase.id,
      productId: purchase.productId,
      type,
      amount,
      currency,
      amountUsd: amount,
      store: Store.STRIPE,
      eventDate,
    },
  });
}

async function applyInvoicePaymentFailed(
  ctx: DispatchContext,
): Promise<void> {
  const invoice = ctx.event.data.object as Stripe.Invoice;
  const subscriptionId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id;
  if (!subscriptionId) return;

  await prisma.purchase.updateMany({
    where: {
      store: Store.STRIPE,
      storeTransactionId: subscriptionId,
    },
    data: { status: PurchaseStatus.GRACE_PERIOD },
  });

  log.info("moved purchase to grace period after invoice payment failure", {
    subscriptionId,
  });
}

async function applyChargeRefunded(ctx: DispatchContext): Promise<void> {
  const charge = ctx.event.data.object as Stripe.Charge;
  const invoiceId =
    typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id;
  if (!invoiceId) {
    log.debug("charge.refunded without invoice, ignored");
    return;
  }

  const invoice = await ctx.stripe.invoices.retrieve(invoiceId);
  const subscriptionId =
    typeof invoice.subscription === "string"
      ? invoice.subscription
      : invoice.subscription?.id;
  if (!subscriptionId) {
    log.debug("refunded invoice without subscription, ignored");
    return;
  }

  const purchase = await prisma.purchase.findUnique({
    where: {
      store_storeTransactionId: {
        store: Store.STRIPE,
        storeTransactionId: subscriptionId,
      },
    },
  });
  if (!purchase) {
    log.warn("charge.refunded for unknown purchase", { subscriptionId });
    return;
  }

  await prisma.purchase.update({
    where: { id: purchase.id },
    data: {
      status: PurchaseStatus.REFUNDED,
      refundDate: new Date(),
    },
  });

  await prisma.subscriberAccess.updateMany({
    where: { purchaseId: purchase.id },
    data: { isActive: false },
  });

  const amount = (charge.amount_refunded ?? 0) / 100;
  const currency =
    charge.currency?.toUpperCase() ?? purchase.priceCurrency ?? "USD";

  await prisma.revenueEvent.create({
    data: {
      projectId: ctx.projectId,
      subscriberId: purchase.subscriberId,
      purchaseId: purchase.id,
      productId: purchase.productId,
      type: RevenueEventType.REFUND,
      amount: -amount,
      currency,
      amountUsd: -amount,
      store: Store.STRIPE,
      eventDate: new Date(),
    },
  });
}

// =============================================================
// Helpers
// =============================================================

const ENTITLEMENT_GRANTING_STATUSES: ReadonlySet<PurchaseStatus> =
  new Set<PurchaseStatus>([
    PurchaseStatus.ACTIVE,
    PurchaseStatus.TRIAL,
    PurchaseStatus.GRACE_PERIOD,
  ]);

function mapStripeSubscriptionStatus(
  status: Stripe.Subscription.Status,
): PurchaseStatus {
  switch (status) {
    case STRIPE_SUBSCRIPTION_STATUS.ACTIVE:
      return PurchaseStatus.ACTIVE;
    case STRIPE_SUBSCRIPTION_STATUS.TRIALING:
      return PurchaseStatus.TRIAL;
    case STRIPE_SUBSCRIPTION_STATUS.PAST_DUE:
    case STRIPE_SUBSCRIPTION_STATUS.UNPAID:
    case STRIPE_SUBSCRIPTION_STATUS.INCOMPLETE:
      return PurchaseStatus.GRACE_PERIOD;
    case STRIPE_SUBSCRIPTION_STATUS.INCOMPLETE_EXPIRED:
    case STRIPE_SUBSCRIPTION_STATUS.CANCELED:
      return PurchaseStatus.EXPIRED;
    case STRIPE_SUBSCRIPTION_STATUS.PAUSED:
      return PurchaseStatus.PAUSED;
    default:
      return PurchaseStatus.ACTIVE;
  }
}

async function resolveSubscriber(
  ctx: DispatchContext,
  subscription: Stripe.Subscription,
) {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;

  const appUserId =
    subscription.metadata?.app_user_id ??
    subscription.metadata?.appUserId ??
    `stripe:${customerId}`;

  return prisma.subscriber.upsert({
    where: {
      projectId_appUserId: { projectId: ctx.projectId, appUserId },
    },
    update: { lastSeenAt: new Date() },
    create: {
      projectId: ctx.projectId,
      appUserId,
      attributes: { stripe_customer_id: customerId },
    },
  });
}

async function upsertPurchaseFromSubscription(
  ctx: DispatchContext,
  subscription: Stripe.Subscription,
  subscriberId: string,
  status: PurchaseStatus,
) {
  const item = subscription.items.data[0];
  if (!item) {
    throw new Error(`Stripe subscription ${subscription.id} has no items`);
  }
  const priceId = item.price.id;

  const product = await prisma.product.findFirst({
    where: {
      projectId: ctx.projectId,
      storeIds: { path: ["stripe"], equals: priceId },
    },
  });
  if (!product) {
    throw new Error(
      `No product mapped for Stripe price ${priceId} in project ${ctx.projectId}`,
    );
  }

  const expiresDate = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000)
    : null;
  const startDate = subscription.start_date
    ? new Date(subscription.start_date * 1000)
    : new Date();
  const priceAmount =
    item.price.unit_amount != null ? item.price.unit_amount / 100 : null;
  const priceCurrency = item.price.currency?.toUpperCase() ?? null;
  const isTrial = subscription.status === STRIPE_SUBSCRIPTION_STATUS.TRIALING;
  const cancellationDate = subscription.canceled_at
    ? new Date(subscription.canceled_at * 1000)
    : null;

  const purchase = await prisma.purchase.upsert({
    where: {
      store_storeTransactionId: {
        store: Store.STRIPE,
        storeTransactionId: subscription.id,
      },
    },
    create: {
      projectId: ctx.projectId,
      subscriberId,
      productId: product.id,
      store: Store.STRIPE,
      storeTransactionId: subscription.id,
      originalTransactionId: subscription.id,
      status,
      isTrial,
      purchaseDate: startDate,
      originalPurchaseDate: startDate,
      expiresDate,
      environment: Environment.PRODUCTION,
      priceAmount,
      priceCurrency,
      autoRenewStatus: !subscription.cancel_at_period_end,
      cancellationDate,
      verifiedAt: new Date(),
    },
    update: {
      status,
      isTrial,
      expiresDate,
      priceAmount: priceAmount ?? undefined,
      priceCurrency: priceCurrency ?? undefined,
      autoRenewStatus: !subscription.cancel_at_period_end,
      cancellationDate,
      verifiedAt: new Date(),
    },
  });

  return { product, purchase };
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
          store: Store.STRIPE,
        },
      });
    }
  }
}
