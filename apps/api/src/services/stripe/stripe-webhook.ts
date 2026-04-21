import Stripe from "stripe";
import { HTTPException } from "hono/http-exception";
import prisma, {
  Environment,
  Prisma,
  PurchaseStatus,
  RevenueEventType,
  Store,
  WebhookEventStatus,
  WebhookSource,
  drizzle,
} from "@rovenue/db";
import { logger } from "../../lib/logger";
import { convertToUsd } from "../fx";
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
  | {
      status: "processed";
      eventType: string;
      webhookEventId: string;
      subscriberId?: string;
      purchaseId?: string;
    }
  | { status: "duplicate"; eventType: string };

interface StripeDispatchOutcome {
  subscriberId?: string;
  purchaseId?: string;
}

/**
 * Verify + process a Stripe webhook from the raw request body. Preferred
 * for synchronous route handlers.
 */
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

  return processStripeEvent({
    projectId: opts.projectId,
    event,
    stripe,
  });
}

export interface ProcessStripeEventOptions {
  projectId: string;
  event: Stripe.Event;
  stripe: Stripe;
}

/**
 * Process an already-verified Stripe event. Called by the BullMQ worker
 * after the route has verified the signature synchronously, so the job
 * payload never includes raw webhook bodies.
 */
export async function processStripeEvent(
  opts: ProcessStripeEventOptions,
): Promise<HandleStripeNotificationResult> {
  const { event, projectId, stripe } = opts;

  const webhookEvent = await prisma.webhookEvent.upsert({
    where: {
      source_storeEventId: {
        source: WebhookSource.STRIPE,
        storeEventId: event.id,
      },
    },
    create: {
      projectId,
      source: WebhookSource.STRIPE,
      eventType: event.type,
      storeEventId: event.id,
      payload: JSON.parse(JSON.stringify(event)),
      status: WebhookEventStatus.PROCESSING,
    },
    update: {},
  });

  if (webhookEvent.status === WebhookEventStatus.PROCESSED) {
    log.info("duplicate event, skipping", {
      id: event.id,
      type: event.type,
    });
    return { status: "duplicate", eventType: event.type };
  }

  try {
    const outcome: StripeDispatchOutcome = {};
    await dispatch({ projectId, event, stripe, outcome });

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
      eventType: event.type,
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
  outcome: StripeDispatchOutcome;
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

  ctx.outcome.subscriberId = subscriber.id;
  ctx.outcome.purchaseId = purchase.id;

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

  const purchase = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
    Store.STRIPE,
    subscription.id,
  );
  if (!purchase) return;

  ctx.outcome.subscriberId = purchase.subscriberId;
  ctx.outcome.purchaseId = purchase.id;

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
      amount: new Prisma.Decimal(0),
      currency: purchase.priceCurrency ?? "USD",
      amountUsd: new Prisma.Decimal(0),
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

  const purchase = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
    Store.STRIPE,
    subscriptionId,
  );
  if (!purchase) {
    log.warn("invoice.paid for unknown purchase", { subscriptionId });
    return;
  }

  ctx.outcome.subscriberId = purchase.subscriberId;
  ctx.outcome.purchaseId = purchase.id;

  const amount = (invoice.amount_paid ?? 0) / 100;
  const currency = invoice.currency?.toUpperCase() ?? "USD";
  const amountUsd = await convertToUsd(amount, currency);
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
      amount: new Prisma.Decimal(amount),
      currency,
      amountUsd: new Prisma.Decimal(amountUsd),
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

  const purchase = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
    Store.STRIPE,
    subscriptionId,
  );
  if (!purchase) {
    log.warn("charge.refunded for unknown purchase", { subscriptionId });
    return;
  }

  ctx.outcome.subscriberId = purchase.subscriberId;
  ctx.outcome.purchaseId = purchase.id;

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
  const amountUsd = await convertToUsd(-amount, currency);

  await prisma.revenueEvent.create({
    data: {
      projectId: ctx.projectId,
      subscriberId: purchase.subscriberId,
      purchaseId: purchase.id,
      productId: purchase.productId,
      type: RevenueEventType.REFUND,
      amount: new Prisma.Decimal(-amount),
      currency,
      amountUsd: new Prisma.Decimal(amountUsd),
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

  const product = await drizzle.productGroupRepo.findProductByStoreId(
    drizzle.db,
    ctx.projectId,
    "stripe",
    priceId,
  );
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
    const existing = await drizzle.accessRepo.findAccessByPurchaseAndKey(
      drizzle.db,
      args.subscriberId,
      args.purchaseId,
      key,
    );
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
