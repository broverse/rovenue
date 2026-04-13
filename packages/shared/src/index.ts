export const SUBSCRIPTION_STATES = [
  "TRIAL",
  "ACTIVE",
  "GRACE_PERIOD",
  "EXPIRED",
  "PAUSED",
  "REFUNDED",
] as const;

export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

export type ApiResponse<T> =
  | { data: T }
  | { error: { code: string; message: string } };
