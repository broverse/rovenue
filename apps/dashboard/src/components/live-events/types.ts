export type EventCategoryKey =
  | "all"
  | "subscription"
  | "billing"
  | "ledger"
  | "experiment";

// Concrete event keys the live stream can surface. Each maps to a real
// outbox event type fanned out over the SSE channel — there is no
// synthetic data behind these. `unknown` is the fail-open bucket for an
// event type the dashboard doesn't recognise yet (shown verbatim rather
// than dropped).
export type EventTypeKey =
  // subscription (REVENUE_EVENT)
  | "new_subscription"
  | "renewal"
  | "trial_converted"
  | "reactivation"
  | "cancellation"
  // billing (REVENUE_EVENT refund/credit purchase + platform BILLING)
  | "refund"
  | "credit_purchase"
  | "invoice_paid"
  | "payment_method_added"
  | "plan_activated"
  // ledger (CREDIT_LEDGER)
  | "credit_purchased"
  | "credit_spent"
  | "credit_refunded"
  | "credit_bonus"
  | "credit_expired"
  | "credit_transfer_in"
  | "credit_transfer_out"
  // experiment (EXPOSURE)
  | "experiment_exposure"
  // fail-open
  | "unknown";

export type EventPlatform = "ios" | "android";

export type EventTypeMeta = {
  key: EventTypeKey;
  label: string;
  color: string;
  category: Exclude<EventCategoryKey, "all">;
};

// A normalised, render-ready event. Fields the wire payload doesn't carry
// are `null` — the UI renders "—" rather than inventing a value. The raw
// outbox payload is kept on `payload` so the detail panel can show exactly
// what came over the channel.
export type LiveEvent = {
  id: string;
  type: EventTypeKey;
  typeMeta: EventTypeMeta;
  /** Raw outbox eventType string (e.g. "revenue.event.recorded"). */
  eventType: string;
  /** Outbox aggregateType (REVENUE_EVENT, CREDIT_LEDGER, …). */
  aggregateType: string;
  /** Subscriber id when the event is subscriber-scoped, else null. */
  user: string | null;
  /** Product id when present (the wire carries no display name/sku). */
  product: string | null;
  /** Signed monetary amount (refunds negative). null for non-money events. */
  amount: number | null;
  currency: string | null;
  platform: EventPlatform | null;
  country: string | null;
  store: string | null;
  receivedAt: Date;
  /** Raw outbox payload, shown verbatim in the detail panel. */
  payload: Record<string, unknown>;
  isNew?: boolean;
};

export type EventCategory = {
  key: EventCategoryKey;
  label: string;
  types: ReadonlyArray<EventTypeKey> | null;
};
