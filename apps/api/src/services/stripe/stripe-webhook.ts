import type Stripe from "stripe";
import {
  type Db,
  type Subscriber,
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
  FUNNEL_METADATA_KEY,
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

/**
 * The work an event carries BESIDES the funnel backstop, by event type.
 * For every event but one that work is the account owner's own billing
 * sync, which is what this table was named for.
 *
 * A lookup rather than a `switch` so that "does this event have work of
 * its own to protect?" is answered by the same table that runs it. The
 * containment rule below turns on that question, and a `switch` would let
 * the two drift apart the first time a case was added — the failure mode
 * being silent, permanent loss of a buyer's completion.
 *
 * `payment_intent.succeeded` is deliberately absent: a bare PaymentIntent
 * carries no subscription and no invoice, so there is no purchase state
 * to sync from it. The funnel backstop is the entire work for that event.
 *
 * `setup_intent.succeeded` is present although it syncs no billing state
 * either, and the entry is honest on the table's own terms: it is work
 * that must still run when the backstop fails. That direction never
 * arises in practice — the backstop's lookup has no case for the event,
 * so it returns before touching anything and cannot fail, which makes
 * the swallow branch above unreachable for it.
 *
 * The converse direction is NOT contained: a failure inside
 * `persistFunnelPaymentMethod` fails the event, deliberately. Everything
 * that would make the write pointless is checked before it, so a failure
 * at the write is retryable by construction — and swallowing it would
 * mark the event PROCESSED, which consumes Stripe's redelivery and loses
 * the write for good.
 */
const DOMAIN_SYNC: Readonly<
  Partial<Record<string, (ctx: DispatchContext) => Promise<void>>>
> = {
  [STRIPE_EVENT_TYPE.CUSTOMER_SUBSCRIPTION_CREATED]: syncSubscription,
  [STRIPE_EVENT_TYPE.CUSTOMER_SUBSCRIPTION_UPDATED]: syncSubscription,
  [STRIPE_EVENT_TYPE.CUSTOMER_SUBSCRIPTION_DELETED]: applySubscriptionDeleted,
  [STRIPE_EVENT_TYPE.INVOICE_PAID]: applyInvoicePaid,
  [STRIPE_EVENT_TYPE.INVOICE_PAYMENT_FAILED]: applyInvoicePaymentFailed,
  [STRIPE_EVENT_TYPE.CHARGE_REFUNDED]: applyChargeRefunded,
  [STRIPE_EVENT_TYPE.SETUP_INTENT_SUCCEEDED]: persistFunnelPaymentMethod,
};

async function dispatch(ctx: DispatchContext): Promise<void> {
  const sync = DOMAIN_SYNC[ctx.event.type];

  // Deliberately BEFORE the domain sync, not after it. The sync throws
  // when the paid price maps to no Rovenue product, and `applyInvoicePaid`
  // returns early when the subscription maps to no purchase row — either
  // would swallow the backstop for a buyer who has genuinely paid and
  // closed the tab, which is the one case this exists for. Nothing below
  // depends on it having run, and it is idempotent, so the ordering costs
  // nothing on the ordinary path.
  //
  // Running first must not mean running *instead* — but only where there
  // is something to run instead OF. The containment below is therefore
  // conditional on `sync`:
  //
  //   With a sync: swallow. A funnel-side throw would otherwise take the
  //   account owner's purchase/revenue sync down with it, for an event
  //   that has nothing to do with the funnel beyond arriving on the same
  //   subscription — and this buyer really does keep other routes to
  //   their token, because more events are coming on that subscription
  //   and `/confirm` can still read its state.
  //
  //   Without one (`payment_intent.succeeded`): RETHROW. The backstop is
  //   the whole job, so swallowing marks the event PROCESSED — and a
  //   PROCESSED row makes `claimWebhookEvent` answer `duplicate`, which
  //   consumes Stripe's redelivery AND BullMQ's retry in one go. One
  //   transient database blip would permanently strand a one-time buyer
  //   who paid and closed the tab: no subscription, no later event, no
  //   browser to call `/confirm`. Failing the event is what keeps the
  //   retries alive, and a retried event is idempotent all the way down.
  try {
    await backstopFunnelSession(ctx);
  } catch (err) {
    if (!sync) {
      log.error("funnel backstop failed and nothing else handles this event", {
        eventId: ctx.event.id,
        eventType: ctx.event.type,
        projectId: ctx.projectId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    log.error("funnel backstop failed; continuing with the domain sync", {
      eventId: ctx.event.id,
      eventType: ctx.event.type,
      projectId: ctx.projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (!sync) {
    log.debug("no state change for event type", { type: ctx.event.type });
    return;
  }
  return sync(ctx);
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

// The key itself lives in ./stripe-types alongside the event types,
// because the funnel's payment endpoint writes it and this file reads
// it: a literal at each end is a rename away from a webhook that
// silently stops recognising its own objects.
const FUNNEL_SESSION_METADATA_KEY = FUNNEL_METADATA_KEY.SESSION_ID;

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

  // The event has to be about the very Stripe object this row records.
  // A visitor who changes package leaves the superseded subscription or
  // intent live for a moment; without this, a late event from that
  // abandoned object would complete the session against a package the
  // buyer no longer chose (`upsertPending` has already replaced the ids).
  //
  // Checked BEFORE the already-paid short-circuit below. A mismatch on an
  // already-paid row is the double-charge case — money moved on a
  // superseded object *and* on the current one — and short-circuiting
  // first would make the loudest signal we have for it return silently.
  // Both checks read the row already in hand, so the ordering is free.
  if (
    lookup.by === "session" &&
    lookup.stripeObjectId !== purchase.stripeSubscriptionId &&
    lookup.stripeObjectId !== purchase.stripePaymentIntentId
  ) {
    // `warn`, not `info`. Reaching here on a settlement-proving event
    // means someone's money moved on a Stripe object this session no
    // longer references, and nothing downstream will complete them: the
    // row points elsewhere. That is a human to refund or reconcile by
    // hand, so every id needed to find them is in the line — including
    // the row's status, which says which of the two cases this is
    // (`pending` = a stranded payment, `paid` = a probable double charge).
    log.warn("paid stripe object does not match the session's current attempt", {
      sessionId: purchase.sessionId,
      projectId: purchase.projectId,
      funnelPurchaseId: purchase.id,
      purchaseStatus: purchase.status,
      eventId: ctx.event.id,
      eventType: ctx.event.type,
      stripeObjectId: lookup.stripeObjectId,
      stripeCustomerId: purchase.stripeCustomerId,
      rowSubscriptionId: purchase.stripeSubscriptionId,
      rowPaymentIntentId: purchase.stripePaymentIntentId,
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
// Setup-intent persistence
// =============================================================
//
// What this is for. A trial package's card is attached through the
// subscription's `pending_setup_intent`, and Stripe's own
// `save_default_payment_method: "on_subscription"` writes it onto the
// subscription only when a subscription PAYMENT succeeds — which on a
// trial is weeks away. Until then the subscription has no
// `default_payment_method`, which is a problem on its own terms long
// before any gate reads it: that is the field the trial converts
// against, and `trial_settings.end_behavior.missing_payment_method` is
// what acts on its absence. So the card Stripe just confirmed is written
// onto the subscription here, which is Stripe's own documented
// recommendation for this deferred-payment flow.
//
// What this is NOT for, any more: making `/confirm` able to answer. That
// path settles a trial on the setup intent id the purchase row stores at
// create time (see routes/public/funnel-payment.ts) and depends on
// neither this handler nor the operator having configured the event.
// This write still moves the shared predicate's first input EARLIER and
// more reliably; it does not lower the bar, and nothing waits on it.
//
// Completion is left to the events that already do it: writing
// `default_payment_method` produces a `customer.subscription.updated`,
// which the backstop above reads through the same shared predicate. This
// handler mints nothing.

/** Statuses on which a subscription can no longer usefully be written. */
const SUBSCRIPTION_TERMINAL: ReadonlySet<string> = new Set([
  STRIPE_SUBSCRIPTION_STATUS.CANCELED,
  STRIPE_SUBSCRIPTION_STATUS.INCOMPLETE_EXPIRED,
]);

/**
 * Persist a funnel trial's confirmed card as the subscription's default
 * payment method.
 *
 * Rethrows, deliberately. This handler is the whole work of the event, so
 * swallowing a failure marks the row PROCESSED — and a PROCESSED row
 * makes `claimWebhookEvent` answer `duplicate` on Stripe's redelivery,
 * consuming that redelivery and BullMQ's retry in one go. The write is
 * then lost for good, and with it the thing that lets a converted trial
 * actually bill.
 *
 * Nothing is lost by retrying instead. Every reason the write would be
 * WRONG rather than merely failed — a default payment method already
 * present, a canceled or expired subscription, an intent belonging to
 * another project or a superseded attempt — is checked above the write
 * and returns early, so what reaches the write is retryable by
 * construction. And every check is a read, so a redelivered event that
 * has since become one of those cases simply returns early too.
 */
async function persistFunnelPaymentMethod(ctx: DispatchContext): Promise<void> {
  try {
    await writeConfirmedCardOntoSubscription(ctx);
  } catch (err) {
    // The generic failure log upstream has the event id and type; this
    // one says which handler, which is the part that is not obvious from
    // a `setup_intent.succeeded` that failed.
    log.error("could not persist the funnel setup intent's payment method", {
      eventId: ctx.event.id,
      projectId: ctx.projectId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function writeConfirmedCardOntoSubscription(
  ctx: DispatchContext,
): Promise<void> {
  const intent = ctx.event.data.object as Stripe.SetupIntent;

  // Ours-ness, established by metadata WE stamped onto this very object
  // when the subscription was created (see routes/public/funnel-payment).
  // A SetupIntent carries no pointer back to the subscription it belongs
  // to, so the alternative would be inferring the link from a shared
  // customer — and this endpoint receives every SetupIntent on every
  // connected account, including ones an account owner created for their
  // own purposes. Writing a default payment method onto a subscription
  // on the strength of an inference is an intrusion into a customer's
  // account, so an unstamped intent is simply not ours and we leave it
  // alone. This is also the entire filter: nothing below runs for one.
  const sessionId = intent.metadata?.[FUNNEL_METADATA_KEY.SESSION_ID];
  const subscriptionId = intent.metadata?.[FUNNEL_METADATA_KEY.SUBSCRIPTION_ID];
  if (!sessionId || !subscriptionId) return;

  // The event type is Stripe's claim about the object; the object's own
  // status is the fact. They agree today, but this handler is registered
  // by type in one table and reads the object in another file, so the
  // day a second event type is pointed here — or a replayed body is
  // handed to it — the only thing that keeps it from writing a card off
  // an unconfirmed intent is this line.
  if (intent.status !== "succeeded") {
    log.warn("funnel setup intent is not succeeded; not writing its card", {
      sessionId,
      setupIntentId: intent.id,
      status: intent.status,
    });
    return;
  }

  const paymentMethodId =
    typeof intent.payment_method === "string"
      ? intent.payment_method
      : intent.payment_method?.id;
  if (!paymentMethodId) {
    // A succeeded SetupIntent with no payment method should not exist.
    log.warn("funnel setup intent succeeded with no payment method", {
      sessionId,
      setupIntentId: intent.id,
    });
    return;
  }

  const purchase = await drizzle.funnelPurchaseRepo.findBySession(
    drizzle.db,
    sessionId,
  );
  if (!purchase) return;

  // Same rule the backstop applies: metadata is written by the account,
  // not by us, so a project must not be able to name another project's
  // session and have us act on its subscription.
  if (purchase.projectId !== ctx.projectId) {
    log.warn("funnel setup intent names another project's session; ignoring", {
      sessionId,
      eventProjectId: ctx.projectId,
    });
    return;
  }

  // Whose card is this? The intent's metadata says which subscription to
  // write to, and metadata is a string map the account can edit — so
  // without this the buyer behind the card is inferred from nothing at
  // all. The customer is the one link Stripe itself maintains between
  // the intent and the purchase this row records, and a mismatch means
  // the card being written belongs to somebody else.
  const intentCustomerId =
    typeof intent.customer === "string" ? intent.customer : intent.customer?.id;
  if (intentCustomerId !== purchase.stripeCustomerId) {
    log.warn("funnel setup intent's customer is not the purchase's; ignoring", {
      sessionId,
      setupIntentId: intent.id,
      intentCustomerId,
      rowCustomerId: purchase.stripeCustomerId,
    });
    return;
  }

  // The intent must be about the attempt the row still records. A
  // visitor who changed package leaves the superseded subscription's
  // setup intent live for a moment, and confirming it there must not
  // put that card on the subscription they actually chose — the
  // superseded one is cancelled by the payment endpoint's cleanup.
  if (purchase.stripeSubscriptionId !== subscriptionId) {
    log.info("funnel setup intent belongs to a superseded attempt; ignoring", {
      sessionId,
      setupIntentId: intent.id,
      intentSubscriptionId: subscriptionId,
      rowSubscriptionId: purchase.stripeSubscriptionId,
    });
    return;
  }

  // Read before write, for the two cases where writing is wrong rather
  // than merely redundant: the subscription may already carry a default
  // payment method (this event is redeliverable for days, and by then
  // the customer may have moved to a different card — replaying an old
  // intent must not roll that back), and it may have been cancelled
  // (the funnel's own cleanup cancels superseded attempts), where Stripe
  // would reject the update anyway. Both make this a no-op, which is
  // what idempotent means here.
  const subscription = await ctx.account.subscriptions.retrieve(subscriptionId);
  if (subscription.default_payment_method != null) return;
  if (SUBSCRIPTION_TERMINAL.has(subscription.status)) return;

  await ctx.account.subscriptions.update(subscriptionId, {
    default_payment_method: paymentMethodId,
  });

  log.info("persisted the funnel trial's card on the subscription", {
    sessionId,
    subscriptionId,
    projectId: ctx.projectId,
  });
}

// =============================================================
// Per-event handlers
// =============================================================

async function syncSubscription(ctx: DispatchContext): Promise<void> {
  const subscription = ctx.event.data.object as Stripe.Subscription;
  const subscriber = await resolveSubscriber(ctx, subscription);
  if (!subscriber) {
    // Dead-ended anchor (GDPR erasure / broken merge chain). Writing a
    // purchase or granting access would re-populate a subscriber that must
    // stay gone. resolveSubscriber has already logged why.
    return;
  }
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
  //
  // A funnel subscription is created speculatively at package selection —
  // `default_incomplete`, before any card — so `customer.subscription.created`
  // fires while it sits at `incomplete` (→ GRACE_PERIOD) or `trialing`
  // (→ TRIAL). Granting then would put entitlement on the pre-payment
  // (synthetic) subscriber before a single cent or card exists, inflating
  // trial/grace counts on every abandoned click and — if `cancelSuperseded`
  // later fails on a package switch — risking the abandoned package's access
  // being merged onto the buyer at claim time. For those two initial states
  // require the same proof of payment `/confirm` and the backstop require
  // (`hasPaidOrAttachedACard`): the grant then lands on the
  // `customer.subscription.updated` that `setup_intent.succeeded` triggers
  // once the card is attached. `past_due`/`unpaid` are NOT gated — they only
  // occur after a subscription was active, so their GRACE_PERIOD access is a
  // real lapse to keep, not a speculative grant to withhold.
  const isSpeculativeInitialState =
    subscription.status === STRIPE_SUBSCRIPTION_STATUS.INCOMPLETE ||
    subscription.status === STRIPE_SUBSCRIPTION_STATUS.TRIALING;
  const grantsAccess =
    statusApplied &&
    ACCESS_GRANTING_STATUSES.has(status) &&
    (!isSpeculativeInitialState || hasPaidOrAttachedACard(subscription));

  if (grantsAccess) {
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
): Promise<Subscriber | null> {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;

  const appUserId =
    subscription.metadata?.app_user_id ??
    subscription.metadata?.appUserId ??
    `stripe:${customerId}`;

  // Resolve FIRST, create only when there is no row at all — the same
  // order routes/v1/funnel-claim.ts uses on the way in.
  //
  // `upsertSubscriber` conflicts on (projectId, rovenueId) and returns the
  // matching row REGARDLESS of `deletedAt`. `stripe:<customer>` is exactly
  // the anchor a funnel purchase's synthetic subscriber is created with,
  // and the claim merges that synthetic into the buyer's installed
  // subscriber and soft-deletes it. Upserting straight onto the anchor
  // would therefore resolve every later subscription event — renewal,
  // trial conversion, status change — back to the retired row and grant
  // its access there, while the buyer's real subscriber never gets
  // another one. `resolveSubscriberByRovenueId` walks the `mergedInto`
  // chain to the live survivor instead.
  const resolved = await drizzle.subscriberRepo.resolveSubscriberByRovenueId(
    drizzle.db,
    { projectId: ctx.projectId, rovenueId: appUserId },
  );
  if (resolved) return resolved;

  // `resolveSubscriberByRovenueId` returns null in two very different
  // cases, and the difference decides whether we may write here:
  //
  //   - No row exists at all → the first subscription event for a fresh
  //     funnel purchase. Create the anchor.
  //   - A row exists but is soft-deleted and dead-ended — no live
  //     `mergedInto` survivor. `upsertSubscriber` conflicts on
  //     (projectId, rovenueId) and hands that dead row straight back, so
  //     granting onto it would resurrect a GDPR-erased subscriber (erasure
  //     soft-deletes with rovenueId intact and no `mergedInto`) or write
  //     onto a retired anchor whose chain is broken. Skip the sync; a
  //     forgotten subscriber must not be re-populated by a renewal, and
  //     failing the event would only retry forever.
  const existing = await drizzle.subscriberRepo.findSubscriberByRovenueId(
    drizzle.db,
    { projectId: ctx.projectId, rovenueId: appUserId },
  );
  if (existing) {
    log.warn("stripe subscription resolves to a dead subscriber; skipping", {
      projectId: ctx.projectId,
      rovenueId: appUserId,
      subscriberId: existing.id,
      subscriptionId: subscription.id,
    });
    return null;
  }

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
