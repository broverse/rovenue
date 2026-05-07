import type { EventCategory, EventTypeKey, EventTypeMeta } from "./types";

export const EVENT_TYPES: ReadonlyArray<EventTypeMeta> = [
  { key: "new_subscription", label: "new_subscription", color: "var(--color-rv-accent-500)", category: "subscription" },
  { key: "renewal", label: "renewal", color: "var(--color-rv-success)", category: "subscription" },
  { key: "trial_started", label: "trial_started", color: "var(--color-rv-cyan)", category: "subscription" },
  { key: "trial_converted", label: "trial_converted", color: "var(--color-rv-accent-500)", category: "subscription" },
  { key: "cancellation", label: "cancellation", color: "var(--color-rv-warning)", category: "subscription" },
  { key: "billing_issue", label: "billing_issue", color: "var(--color-rv-danger)", category: "billing" },
  { key: "refund", label: "refund", color: "#A1A1AA", category: "billing" },
  { key: "expiration", label: "expiration", color: "#A1A1AA", category: "subscription" },
  { key: "entitlement_granted", label: "entitlement_granted", color: "var(--color-rv-violet)", category: "entitlement" },
  { key: "credit_debited", label: "credit_debited", color: "#EC4899", category: "ledger" },
];

const SUBSCRIPTION_TYPES: ReadonlyArray<EventTypeKey> = [
  "new_subscription",
  "renewal",
  "trial_started",
  "trial_converted",
  "cancellation",
  "expiration",
];

export const EVENT_CATEGORIES: ReadonlyArray<EventCategory> = [
  { key: "all", label: "All", types: null },
  { key: "subscription", label: "Subscriptions", types: SUBSCRIPTION_TYPES },
  { key: "billing", label: "Billing", types: ["billing_issue", "refund"] },
  { key: "entitlement", label: "Entitlements", types: ["entitlement_granted"] },
  { key: "ledger", label: "Ledger", types: ["credit_debited"] },
];
