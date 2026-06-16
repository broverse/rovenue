import type {
  EventCategory,
  EventCategoryKey,
  EventTypeKey,
  EventTypeMeta,
} from "./types";

// One colour per category keeps the stream legible without hand-tuning a
// hue for every one of the ~18 concrete event types.
const CATEGORY_COLOR: Record<Exclude<EventCategoryKey, "all">, string> = {
  subscription: "var(--color-rv-accent-500)",
  billing: "var(--color-rv-warning)",
  ledger: "#EC4899",
  experiment: "var(--color-rv-violet)",
};

// Concrete event key → category. The label shown in the stream is the key
// itself (mono), matching the rest of the platform's event nomenclature.
const TYPE_CATEGORY: Record<
  Exclude<EventTypeKey, "unknown">,
  Exclude<EventCategoryKey, "all">
> = {
  new_subscription: "subscription",
  renewal: "subscription",
  trial_converted: "subscription",
  reactivation: "subscription",
  cancellation: "subscription",
  refund: "billing",
  credit_purchase: "billing",
  invoice_paid: "billing",
  payment_method_added: "billing",
  plan_activated: "billing",
  credit_purchased: "ledger",
  credit_spent: "ledger",
  credit_refunded: "ledger",
  credit_bonus: "ledger",
  credit_expired: "ledger",
  credit_transfer_in: "ledger",
  credit_transfer_out: "ledger",
  experiment_exposure: "experiment",
};

const makeMeta = (
  key: EventTypeKey,
  category: Exclude<EventCategoryKey, "all">,
): EventTypeMeta => ({ key, label: key, color: CATEGORY_COLOR[category], category });

export const EVENT_TYPES: ReadonlyArray<EventTypeMeta> = (
  Object.entries(TYPE_CATEGORY) as Array<
    [Exclude<EventTypeKey, "unknown">, Exclude<EventCategoryKey, "all">]
  >
).map(([key, category]) => makeMeta(key, category));

// Fallback meta for an unrecognised wire event — rendered, never dropped.
export const UNKNOWN_TYPE_META: EventTypeMeta = {
  key: "unknown",
  label: "unknown",
  color: "#A1A1AA",
  category: "subscription",
};

const BY_KEY = new Map<EventTypeKey, EventTypeMeta>(
  [...EVENT_TYPES, UNKNOWN_TYPE_META].map((m) => [m.key, m]),
);

export const metaFor = (key: EventTypeKey): EventTypeMeta =>
  BY_KEY.get(key) ?? UNKNOWN_TYPE_META;

const typesIn = (
  category: Exclude<EventCategoryKey, "all">,
): ReadonlyArray<EventTypeKey> => EVENT_TYPES.filter((m) => m.category === category).map((m) => m.key);

export const EVENT_CATEGORIES: ReadonlyArray<EventCategory> = [
  { key: "all", label: "All", types: null },
  { key: "subscription", label: "Subscriptions", types: typesIn("subscription") },
  { key: "billing", label: "Billing", types: typesIn("billing") },
  { key: "ledger", label: "Ledger", types: typesIn("ledger") },
  { key: "experiment", label: "Experiments", types: typesIn("experiment") },
];
