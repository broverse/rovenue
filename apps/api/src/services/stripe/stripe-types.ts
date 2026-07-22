import type Stripe from "stripe";

// =============================================================
// Event types we handle
// =============================================================

export const STRIPE_EVENT_TYPE = {
  CUSTOMER_SUBSCRIPTION_CREATED: "customer.subscription.created",
  CUSTOMER_SUBSCRIPTION_UPDATED: "customer.subscription.updated",
  CUSTOMER_SUBSCRIPTION_DELETED: "customer.subscription.deleted",
  INVOICE_PAID: "invoice.paid",
  INVOICE_PAYMENT_FAILED: "invoice.payment_failed",
  CHARGE_REFUNDED: "charge.refunded",
  /**
   * Carries no subscription and no invoice, so it drives no purchase
   * state — it exists for the funnel backstop alone. A funnel package on
   * a ONE-TIME price is charged through a bare PaymentIntent, and that
   * intent is the only object in the flow carrying
   * `rovenue_funnel_session_id`. Without this event a buyer who closes
   * the tab after a one-time purchase would never be completed by
   * anything.
   *
   * Operational prerequisite: the platform's Connect webhook endpoint
   * must have this event type selected, alongside the subscription and
   * invoice ones.
   */
  PAYMENT_INTENT_SUCCEEDED: "payment_intent.succeeded",
  /**
   * The trial path's card, made durable.
   *
   * A trial package attaches a card through the subscription's
   * `pending_setup_intent`, and Stripe CLEARS that field the moment the
   * intent succeeds. The two settlement signals are therefore not
   * simultaneous: if the field clears before Stripe has written
   * `default_payment_method`, a `/confirm` landing in that window sees
   * neither and refuses a buyer who genuinely did attach a card.
   *
   * Handling this event closes that window by writing the confirmed
   * payment method onto the subscription ourselves — which is also
   * Stripe's own documented recommendation for this deferred-payment
   * flow. It turns a transient object into a durable field, so the
   * signal can no longer evaporate between the two reads.
   *
   * Operational prerequisite: the platform's Connect webhook endpoint
   * must have this event type selected — see connect-endpoint-check.ts,
   * which says so at boot rather than leaving it to be discovered from
   * a buyer's complaint.
   */
  SETUP_INTENT_SUCCEEDED: "setup_intent.succeeded",
} as const;
export type StripeEventType =
  (typeof STRIPE_EVENT_TYPE)[keyof typeof STRIPE_EVENT_TYPE];

// =============================================================
// Funnel metadata keys
// =============================================================
//
// Written by the funnel's payment endpoint onto the Stripe objects it
// creates, and read back by the Connect webhook. One endpoint serves
// every connected account, so metadata is how an inbound event says
// which funnel session — if any — it is about.
//
// Shared constants rather than string literals at each end because that
// is exactly the class of bug this session has already produced three
// times (a settings key renamed on one side, an email hash derived
// twice, a Postgres error shape matched twice). A key that drifts here
// does not fail loudly: the webhook simply stops recognising its own
// objects.

export const FUNNEL_METADATA_KEY = {
  /** The funnel session an object belongs to. */
  SESSION_ID: "rovenue_funnel_session_id",
  /**
   * The subscription a stamped SetupIntent was created for.
   *
   * Stripe's SetupIntent object has no pointer back to the subscription
   * whose `pending_setup_intent` it is (`customer`, `payment_method` and
   * `metadata` are the whole of what links it to anything), so without
   * this the `setup_intent.succeeded` handler could not tell which
   * subscription to write the card onto — nor that the intent is even a
   * funnel one rather than something the account owner set up for their
   * own purposes.
   */
  SUBSCRIPTION_ID: "rovenue_funnel_subscription_id",
} as const;

// =============================================================
// Subscription statuses (mirror of Stripe.Subscription.Status)
// =============================================================

export const STRIPE_SUBSCRIPTION_STATUS = {
  INCOMPLETE: "incomplete",
  INCOMPLETE_EXPIRED: "incomplete_expired",
  TRIALING: "trialing",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  UNPAID: "unpaid",
  PAUSED: "paused",
} as const satisfies Record<string, Stripe.Subscription.Status>;
export type StripeSubscriptionStatus =
  (typeof STRIPE_SUBSCRIPTION_STATUS)[keyof typeof STRIPE_SUBSCRIPTION_STATUS];

// =============================================================
// Invoice billing reasons (mirror of Stripe.Invoice.BillingReason)
// =============================================================

export const STRIPE_INVOICE_BILLING_REASON = {
  SUBSCRIPTION_CREATE: "subscription_create",
  SUBSCRIPTION_CYCLE: "subscription_cycle",
  SUBSCRIPTION_UPDATE: "subscription_update",
  SUBSCRIPTION_THRESHOLD: "subscription_threshold",
  SUBSCRIPTION: "subscription",
  MANUAL: "manual",
  UPCOMING: "upcoming",
  QUOTE_ACCEPT: "quote_accept",
  AUTOMATIC_PENDING_INVOICE_ITEM_INVOICE: "automatic_pending_invoice_item_invoice",
} as const;
export type StripeInvoiceBillingReason =
  (typeof STRIPE_INVOICE_BILLING_REASON)[keyof typeof STRIPE_INVOICE_BILLING_REASON];
