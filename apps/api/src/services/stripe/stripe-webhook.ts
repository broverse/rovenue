import type Stripe from "stripe";
import {
  type Db,
  Environment,
  PurchaseStatus,
  RevenueEventType,
  Store,
  WebhookEventStatus,
  WebhookSource,
  drizzle,
  revenueDedupeKind,
} from "@rovenue/db";
import { logger } from "../../lib/logger";
import type { AccountScopedStripe } from "../../lib/stripe-account-scoped";
import { parsePresentedContextMetadata } from "../../lib/presented-context";
import { convertToUsd } from "../fx";
import { completeFunnelPurchase } from "../funnel/complete-purchase";
import { maybeEmitRefundDetected } from "../notifications/refund-emit";
import {
  STRIPE_EVENT_TYPE,
  STRIPE_INVOICE_BILLING_REASON,
  STRIPE_SUBSCRIPTION_STATUS,
} from "./stripe-types";
import { hasPaidOrAttachedACard } from "./payment-settled";
import { guardStatusWrite } from "../subscription-transition-guard";

const log = logger.child("stripe-webhook");

// =============================================================
// Public API
// =============================================================

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

export interface ProcessStripeEventOptions {
  projectId: string;
  event: Stripe.Event;
  /**
   * Stripe surface already bound to this project's connected account.
   *
   * Deliberately NOT a raw `Stripe` client: that one is Rovenue's
   * platform client, and a call missing `{ stripeAccount }` does not
   * fail — it quietly runs against Rovenue's own account. The facade
   * carries the header on every method, so dispatch has no way to make
   * that mistake. See lib/stripe-account-scoped.ts.
   */
  account: AccountScopedStripe;
}

/**
 * Process an already-verified Stripe event. Called by the BullMQ worker
 * after the route has verified the signature synchronously, so the job
 * payload never includes raw webhook bodies.
 */
export async function processStripeEvent(
  opts: ProcessStripeEventOptions,
): Promise<HandleStripeNotificationResult> {
  const { event, projectId, account } = opts;

  // Atomic single-flight claim — exactly one concurrent worker wins.
  const claim = await drizzle.webhookEventRepo.claimWebhookEvent(drizzle.db, {
    projectId,
    source: WebhookSource.STRIPE,
    eventType: event.type,
    storeEventId: event.id,
    payload: JSON.parse(JSON.stringify(event)),
  });

  if (claim.outcome === "duplicate") {
    log.info("duplicate event, skipping", {
      id: event.id,
      type: event.type,
    });
    return { status: "duplicate", eventType: event.type };
  }
  if (claim.outcome === "in_progress") {
    // Another worker holds a fresh claim. Throw so BullMQ retries with
    // backoff instead of acking — prevents the historical bug where a
    // retry of our own crashed attempt silently dropped the event.
    throw new Error(`webhook ${event.id} claim in progress; retry`);
  }
  const webhookEvent = claim.row;

  try {
    const outcome: StripeDispatchOutcome = {};
    await dispatch({ projectId, event, account, outcome });

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
      eventType: event.type,
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
  /** See {@link ProcessStripeEventOptions.account}. */
  account: AccountScopedStripe;
  outcome: StripeDispatchOutcome;
}

async function dispatch(ctx: DispatchContext): Promise<void> {
  // Deliberately BEFORE the domain sync, not after it. The sync throws
  // when the paid price maps to no Rovenue product, and `applyInvoicePaid`
  // returns early when the subscription maps to no purchase row — either
  // would swallow the backstop for a buyer who has genuinely paid and
  // closed the tab, which is the one case this exists for. Nothing below
  // depends on it having run, and it is idempotent, so the ordering costs
  // nothing on the ordinary path.
  //
  // Running first must not mean running *instead*. An unhandled throw
  // here propagates out of `processStripeEvent`, marks the event FAILED
  // and skips the switch below — so a funnel-side failure would take the
  // account owner's purchase/revenue sync down with it, for an event that
  // has nothing to do with the funnel beyond arriving on the same
  // subscription. The buyer keeps two other routes to their token
  // (`/confirm`, and the next event on this subscription), so the
  // asymmetric cost is clear: log loudly and carry on.
  try {
    await backstopFunnelSession(ctx);
  } catch (err) {
    log.error("funnel backstop failed; continuing with the domain sync", {
      eventId: ctx.event.id,
      eventType: ctx.event.type,
      projectId: ctx.projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

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
    case STRIPE_EVENT_TYPE.PAYMENT_INTENT_SUCCEEDED:
      // Handled entirely by the backstop above: a bare PaymentIntent
      // carries no subscription and no invoice, so there is no purchase
      // state to sync from it.
      return;
    default:
      log.debug("no state change for event type", { type: ctx.event.type });
  }
}

// =============================================================
// Funnel backstop
// =============================================================
//
// A visitor pays on a funnel page and the browser calls
// `/funnel-sessions/:id/confirm`, which mints their claim token. A buyer
// who closes the tab before that request lands has still paid, and would
// otherwise be left with a charge, no token and no entitlement. The
// Connect webhook already receives their events, so it performs the same
// transition through the same service.
//
// What this is NOT: a second idempotency mechanism. Racing `confirm` is
// settled inside `completeFunnelPurchase` (one unique index on
// `funnel_claim_tokens.session_id` decides who mints); event-level replay
// is settled by `claimWebhookEvent` above. Everything below is about one
// question only — has this buyer actually paid?

const FUNNEL_SESSION_METADATA_KEY = "rovenue_funnel_session_id";

/**
 * How to find the funnel purchase row this event is about.
 *
 * The subscription and the one-time PaymentIntent both carry the session
 * id in their own metadata. An invoice carries neither it nor anything
 * Stripe copies it onto, so that path resolves through the subscription
 * id the purchase row already persists.
 */
type FunnelPurchaseLookup =
  | { by: "session"; sessionId: string; stripeObjectId: string }
  | { by: "subscription"; subscriptionId: string };

// Whether a subscription proves payment is decided by
// `hasPaidOrAttachedACard` in ./payment-settled — the SAME function
// `/confirm`'s `isSettled` calls, imported rather than reimplemented so
// the browser's path and this one cannot answer differently. See that
// module for why `trialing` alone is not proof of anything.

function funnelLookupFor(event: Stripe.Event): FunnelPurchaseLookup | null {
  switch (event.type) {
    case STRIPE_EVENT_TYPE.CUSTOMER_SUBSCRIPTION_CREATED:
    case STRIPE_EVENT_TYPE.CUSTOMER_SUBSCRIPTION_UPDATED: {
      const subscription = event.data.object as Stripe.Subscription;
      const sessionId = subscription.metadata?.[FUNNEL_SESSION_METADATA_KEY];
      if (!sessionId) return null;
      if (!hasPaidOrAttachedACard(subscription)) {
        log.info("funnel subscription not settled yet; not completing", {
          sessionId,
          subscriptionId: subscription.id,
          status: subscription.status,
        });
        return null;
      }
      return { by: "session", sessionId, stripeObjectId: subscription.id };
    }

    case STRIPE_EVENT_TYPE.INVOICE_PAID: {
      const invoice = event.data.object as Stripe.Invoice;
      // A subscription that starts on a trial is invoiced for 0 and that
      // invoice is marked paid immediately — `invoice.paid` fires before
      // the visitor has entered a card, exactly like the `trialing`
      // subscription event does. Only an invoice that actually moved
      // money says anything about this buyer.
      if ((invoice.amount_paid ?? 0) <= 0) return null;
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id;
      if (!subscriptionId) return null;
      return { by: "subscription", subscriptionId };
    }

    case STRIPE_EVENT_TYPE.PAYMENT_INTENT_SUCCEEDED: {
      // The one-time path. `succeeded` is the money actually captured,
      // and the intent is the object the payment-intent endpoint put the
      // metadata on. Invoice-driven intents (the recurring path) do not
      // carry it — Stripe does not copy subscription metadata onto them —
      // so they fall out here and are completed by their own events.
      const intent = event.data.object as Stripe.PaymentIntent;
      const sessionId = intent.metadata?.[FUNNEL_SESSION_METADATA_KEY];
      if (!sessionId) return null;
      return { by: "session", sessionId, stripeObjectId: intent.id };
    }

    default:
      return null;
  }
}

async function backstopFunnelSession(ctx: DispatchContext): Promise<void> {
  const lookup = funnelLookupFor(ctx.event);
  if (!lookup) return;

  const purchase =
    lookup.by === "session"
      ? await drizzle.funnelPurchaseRepo.findBySession(
          drizzle.db,
          lookup.sessionId,
        )
      : await drizzle.funnelPurchaseRepo.findByStripeSubscriptionId(
          drizzle.db,
          lookup.subscriptionId,
        );

  // Overwhelmingly the ordinary case on the invoice path: a paid invoice
  // for a subscription no funnel ever sold. Nothing to say about it.
  if (!purchase) return;

  // One endpoint serves every connected account, and metadata is written
  // by the account, not by us. A project must not be able to complete
  // another project's session by naming it.
  if (purchase.projectId !== ctx.projectId) {
    log.warn("funnel purchase belongs to another project; ignoring", {
      sessionId: purchase.sessionId,
      eventProjectId: ctx.projectId,
    });
    return;
  }

  // Already completed — by `/confirm`, by an earlier event, or by the
  // previous delivery of this one. `completeFunnelPurchase` reads the
  // same status and returns `alreadyIssued`, so this changes no outcome;
  // it is here to stop paying for that answer. Without it EVERY renewal
  // invoice of EVERY funnel-sold subscription opens a transaction and
  // reads the partitioned `funnel_sessions` table for the whole life of
  // that subscription, before the billing sync below even starts. The row
  // is already in hand, so the check is free.
  if (purchase.status === "paid") return;

  // The event has to be about the very Stripe object this row records.
  // A visitor who changes package leaves the superseded subscription or
  // intent live for a moment; without this, a late event from that
  // abandoned object would complete the session against a package the
  // buyer no longer chose (`upsertPending` has already replaced the ids).
  if (
    lookup.by === "session" &&
    lookup.stripeObjectId !== purchase.stripeSubscriptionId &&
    lookup.stripeObjectId !== purchase.stripePaymentIntentId
  ) {
    // `warn`, not `info`. Reaching here on a settlement-proving event
    // means someone's money moved on a Stripe object this session no
    // longer references, and nothing downstream will complete them: the
    // row above is still `pending` and points elsewhere. That is a human
    // to refund or reconcile by hand, so every id needed to find them is
    // in the line.
    log.warn("paid stripe object does not match the session's current attempt", {
      sessionId: purchase.sessionId,
      projectId: purchase.projectId,
      funnelPurchaseId: purchase.id,
      eventId: ctx.event.id,
      eventType: ctx.event.type,
      stripeObjectId: lookup.stripeObjectId,
      stripeCustomerId: purchase.stripeCustomerId,
      rowSubscriptionId: purchase.stripeSubscriptionId,
      rowPaymentIntentId: purchase.stripePaymentIntentId,
    });
    return;
  }

  // Only the dev-mode stub in routes/public/funnels.ts writes a purchase
  // with no customer, and that path mints its own token. Same guard the
  // `/confirm` handler applies.
  if (!purchase.stripeCustomerId) return;

  // The row's own ids, not the event's — byte for byte what `/confirm`
  // passes. Handing over the event's ids instead would let a
  // subscription event null out the payment-intent column the row
  // already holds (`markPaid` writes what it is given).
  const result = await completeFunnelPurchase({
    sessionId: purchase.sessionId,
    stripeCustomerId: purchase.stripeCustomerId,
    stripeSubscriptionId: purchase.stripeSubscriptionId,
    stripePaymentIntentId: purchase.stripePaymentIntentId,
  });

  log.info("funnel session completed from the connect webhook", {
    sessionId: purchase.sessionId,
    eventType: ctx.event.type,
    // The token itself is never logged; whether one was minted here is
    // the only interesting half.
    alreadyIssued: result.alreadyIssued,
  });
}

// =============================================================
// Per-event handlers
// =============================================================

async function syncSubscription(ctx: DispatchContext): Promise<void> {
  const subscription = ctx.event.data.object as Stripe.Subscription;
  const subscriber = await resolveSubscriber(ctx, subscription);
  const status = mapStripeSubscriptionStatus(subscription.status);

  // FINDING 1: guarded read + upsert in one tx so the FOR UPDATE lock
  // is held across the write (mechanism (a)); upsertPurchase also
  // CASE-guards the terminal status at SQL level (mechanism (b)).
  const { product, purchase, statusApplied } = await drizzle.db.transaction(
    async (dbTx) => {
      const guard = await guardStatusWrite({
        db: dbTx,
        projectId: ctx.projectId,
        store: Store.STRIPE,
        storeTransactionId: subscription.id,
        to: status,
        source: `stripe:${ctx.event.type}`,
      });

      const result = await upsertPurchaseFromSubscription(
        dbTx,
        ctx,
        subscription,
        subscriber.id,
        status,
        guard.apply,
      );
      return { ...result, statusApplied: guard.apply };
    },
  );

  ctx.outcome.subscriberId = subscriber.id;
  ctx.outcome.purchaseId = purchase.id;

  // A rejected transition means the row stays terminal; access must
  // follow the prior state, not the replayed event.
  if (statusApplied && ACCESS_GRANTING_STATUSES.has(status)) {
    await grantAccess({
      subscriberId: subscriber.id,
      purchaseId: purchase.id,
      accessIds: product.accessIds,
      expiresDate: purchase.expiresDate,
    });
  } else {
    await drizzle.accessRepo.revokeAccessByPurchaseId(drizzle.db, purchase.id);
  }
}

async function applySubscriptionDeleted(ctx: DispatchContext): Promise<void> {
  const subscription = ctx.event.data.object as Stripe.Subscription;

  const purchase = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
    ctx.projectId,
    Store.STRIPE,
    subscription.id,
  );
  if (!purchase) return;

  ctx.outcome.subscriberId = purchase.subscriberId;
  ctx.outcome.purchaseId = purchase.id;

  // FINDING 1: guarded read + status write in one tx (a); the
  // updatePurchase also CASE-guards the terminal status (b).
  const statusApplied = await drizzle.db.transaction(async (dbTx) => {
    const guard = await guardStatusWrite({
      db: dbTx,
      projectId: ctx.projectId,
      store: Store.STRIPE,
      storeTransactionId: subscription.id,
      to: PurchaseStatus.EXPIRED,
      source: `stripe:${ctx.event.type}`,
    });

    await drizzle.purchaseRepo.updatePurchase(dbTx, purchase.id, {
      ...(guard.apply ? { status: PurchaseStatus.EXPIRED } : {}),
      cancellationDate: subscription.canceled_at
        ? new Date(subscription.canceled_at * 1000)
        : new Date(),
      autoRenewStatus: false,
    });
    return guard.apply;
  });

  // Access revoke stays unconditional (idempotent / conservative).
  await drizzle.accessRepo.revokeAccessByPurchaseId(drizzle.db, purchase.id);

  // FINDING 2: only emit the $0 CANCELLATION lifecycle event when the
  // EXPIRED write actually applied. A withheld EXPIRED on an already
  // terminal (REFUNDED/REVOKED) row must NOT produce a spurious churn
  // event on a refunded subscription.
  if (!statusApplied) return;

  await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
    projectId: ctx.projectId,
    subscriberId: purchase.subscriberId,
    purchaseId: purchase.id,
    productId: purchase.productId,
    type: RevenueEventType.CANCELLATION,
    amount: "0",
    currency: purchase.priceCurrency ?? "USD",
    amountUsd: "0",
    store: Store.STRIPE,
    eventDate: ctx.event.created ? new Date(ctx.event.created * 1000) : new Date(),
    dedupeKey: `stripe:${ctx.event.id}:cancel`,
    metadata: purchase.presentedContext
      ? { presentedContext: purchase.presentedContext }
      : undefined,
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
    ctx.projectId,
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
    await drizzle.purchaseRepo.updatePurchase(drizzle.db, purchase.id, {
      isTrial: false,
    });
  }

  const eventDate = invoice.created
    ? new Date(invoice.created * 1000)
    : new Date();

  await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
    projectId: ctx.projectId,
    subscriberId: purchase.subscriberId,
    purchaseId: purchase.id,
    productId: purchase.productId,
    type,
    amount: amount.toString(),
    currency,
    amountUsd: amountUsd.toString(),
    store: Store.STRIPE,
    eventDate,
    // One paid invoice → one purchase-class revenue event; dedups replay.
    dedupeKey: `stripe:${invoice.id}:${revenueDedupeKind(type)}`,
    metadata: purchase.presentedContext
      ? { presentedContext: purchase.presentedContext }
      : undefined,
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

  const guard = await guardStatusWrite({
    db: drizzle.db,
    projectId: ctx.projectId,
    store: Store.STRIPE,
    storeTransactionId: subscriptionId,
    to: PurchaseStatus.GRACE_PERIOD,
    source: `stripe:${ctx.event.type}`,
  });
  if (!guard.apply) return;

  await drizzle.purchaseRepo.updatePurchaseByStoreTransaction(
    drizzle.db,
    Store.STRIPE,
    subscriptionId,
    { status: PurchaseStatus.GRACE_PERIOD },
  );

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

  const invoice = await ctx.account.invoices.retrieve(invoiceId);
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
    ctx.projectId,
    Store.STRIPE,
    subscriptionId,
  );
  if (!purchase) {
    log.warn("charge.refunded for unknown purchase", { subscriptionId });
    return;
  }

  ctx.outcome.subscriberId = purchase.subscriberId;
  ctx.outcome.purchaseId = purchase.id;

  const captured = charge.amount_captured ?? charge.amount ?? 0;
  // `amount_refunded` is the charge's CUMULATIVE refunded total. It is the
  // right signal for "is the charge now fully refunded?" but the WRONG amount
  // to record per event: each `charge.refunded` delivery (one per refund)
  // carries the growing cumulative, so summing them across serial partial
  // refunds over-counts (e.g. $3 then $4 on a $10 charge would record $3 + $7
  // = $10 refunded after only $7 was returned). Record the delta — this
  // refund's own amount — taken from the newest refund object (Stripe orders
  // `refunds.data` most-recent-first). Fall back to cumulative only when the
  // refunds sub-list isn't present on the event payload.
  const cumulativeRefunded = charge.amount_refunded ?? 0;
  const isFullRefund = captured > 0 && cumulativeRefunded >= captured;
  const latestRefund = charge.refunds?.data?.[0];
  const refunded = latestRefund?.amount ?? cumulativeRefunded;

  const eventDate = ctx.event.created
    ? new Date(ctx.event.created * 1000)
    : new Date();

  // Only flip to REFUNDED + revoke entitlement on a FULL refund. A partial
  // refund still records the refunded amount below but must not strip the
  // subscriber's access or mark the purchase terminal.
  if (isFullRefund) {
    const guard = await guardStatusWrite({
      db: drizzle.db,
      projectId: ctx.projectId,
      store: Store.STRIPE,
      storeTransactionId: subscriptionId,
      to: PurchaseStatus.REFUNDED,
      source: `stripe:${ctx.event.type}`,
    });

    await drizzle.purchaseRepo.updatePurchase(drizzle.db, purchase.id, {
      ...(guard.apply
        ? { status: PurchaseStatus.REFUNDED, refundDate: eventDate }
        : {}),
    });

    if (guard.apply) {
      await drizzle.accessRepo.revokeAccessByPurchaseId(drizzle.db, purchase.id);
    }
  }

  // `refunded` is this event's refund delta (see above), in minor units.
  const amount = refunded / 100;
  const currency =
    charge.currency?.toUpperCase() ?? purchase.priceCurrency ?? "USD";
  // Positive magnitude: refunds are stored as positive `amountUsd` (the
  // platform convention every analytics query nets via `gross - refunds`).
  const amountUsd = await convertToUsd(amount, currency);

  await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
    projectId: ctx.projectId,
    subscriberId: purchase.subscriberId,
    purchaseId: purchase.id,
    productId: purchase.productId,
    type: RevenueEventType.REFUND,
    amount: amount.toString(),
    currency,
    amountUsd: amountUsd.toString(),
    store: Store.STRIPE,
    eventDate,
    // Stripe redelivers the same event id; this dedups replay while letting
    // distinct refund events (each a new event id) record independently.
    dedupeKey: `stripe:${ctx.event.id}:refund`,
    metadata: purchase.presentedContext
      ? { presentedContext: purchase.presentedContext }
      : undefined,
  });

  await maybeEmitRefundDetected(drizzle.db, {
    projectId: ctx.projectId,
    purchaseId: purchase.id,
    productId: purchase.productId,
    amountUsdCents: Math.round(Math.abs(amountUsd) * 100),
    currency,
  });
}

// =============================================================
// Helpers
// =============================================================

const ACCESS_GRANTING_STATUSES: ReadonlySet<PurchaseStatus> =
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

  return drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
    projectId: ctx.projectId,
    rovenueId: appUserId,
    appUserId,
    createAttributes: { stripe_customer_id: customerId },
  });
}

async function upsertPurchaseFromSubscription(
  db: Db,
  ctx: DispatchContext,
  subscription: Stripe.Subscription,
  subscriberId: string,
  status: PurchaseStatus,
  applyStatus: boolean,
) {
  const item = subscription.items.data[0];
  if (!item) {
    throw new Error(`Stripe subscription ${subscription.id} has no items`);
  }
  const priceId = item.price.id;

  const product = await drizzle.offeringRepo.findProductByStoreId(
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
  // Defensive parse: malformed/absent metadata never fails the webhook —
  // it just means no attribution gets recorded for this purchase.
  const presentedContext = parsePresentedContextMetadata(
    subscription.metadata?.rovenue_presented_context,
  );

  const purchase = await drizzle.purchaseRepo.upsertPurchase(db, {
    store: Store.STRIPE,
    storeTransactionId: subscription.id,
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
      // Drizzle decimal columns round-trip as strings.
      priceAmount: priceAmount != null ? priceAmount.toString() : null,
      priceCurrency,
      autoRenewStatus: !subscription.cancel_at_period_end,
      cancellationDate,
      verifiedAt: new Date(),
      presentedContext,
    },
    update: {
      ...(applyStatus ? { status } : {}),
      isTrial,
      expiresDate,
      ...(priceAmount != null && { priceAmount: priceAmount.toString() }),
      ...(priceCurrency != null && { priceCurrency }),
      autoRenewStatus: !subscription.cancel_at_period_end,
      cancellationDate,
      verifiedAt: new Date(),
      // Only overwrite when this delivery actually carries attribution —
      // a later renewal/status-only update without the metadata must not
      // null out the original purchase's attribution.
      ...(presentedContext && { presentedContext }),
    },
  });

  return { product, purchase };
}

interface GrantAccessArgs {
  subscriberId: string;
  purchaseId: string;
  accessIds: string[];
  expiresDate: Date | null;
}

async function grantAccess(args: GrantAccessArgs): Promise<void> {
  for (const accessId of args.accessIds) {
    const existing = await drizzle.accessRepo.findAccessByPurchaseAndAccessId(
      drizzle.db,
      args.subscriberId,
      args.purchaseId,
      accessId,
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
        accessId,
        isActive: true,
        expiresDate: args.expiresDate,
        store: Store.STRIPE,
      });
    }
  }
}
