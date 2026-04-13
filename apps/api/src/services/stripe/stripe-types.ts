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
} as const;
export type StripeEventType =
  (typeof STRIPE_EVENT_TYPE)[keyof typeof STRIPE_EVENT_TYPE];

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

// =============================================================
// Headers
// =============================================================

export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

// =============================================================
// Per-project credentials stored under Project.stripeCredentials.
// Intended to be AES-256-GCM encrypted at the application layer;
// this interface is the plaintext shape the handler consumes.
// =============================================================

export interface StripeProjectCredentials {
  secretKey: string;
  webhookSecret: string;
}
