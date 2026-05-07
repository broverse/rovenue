export type EventCategoryKey = "all" | "subscription" | "billing" | "entitlement" | "ledger";

export type EventTypeKey =
  | "new_subscription"
  | "renewal"
  | "trial_started"
  | "trial_converted"
  | "cancellation"
  | "billing_issue"
  | "refund"
  | "expiration"
  | "entitlement_granted"
  | "credit_debited";

export type EventPlatform = "ios" | "android";

export type EventTypeMeta = {
  key: EventTypeKey;
  label: string;
  color: string;
  category: Exclude<EventCategoryKey, "all">;
};

export type LiveEvent = {
  id: string;
  type: EventTypeKey;
  typeMeta: EventTypeMeta;
  user: string;
  product: string;
  productId: string;
  productSku: string;
  amount: number | null;
  currency: string;
  platform: EventPlatform;
  country: string;
  store: string;
  txnId: string;
  receivedAt: Date;
  environment: string;
  sdkVersion: string;
  appVersion: string;
  isNew?: boolean;
};

export type EventCategory = {
  key: EventCategoryKey;
  label: string;
  types: ReadonlyArray<EventTypeKey> | null;
};
