/** Per-transaction type — drives the icon and which scope tab matches. */
export type TxType = "purchase" | "renewal" | "refund" | "trial" | "chargeback" | "credit";

/** Lifecycle status of a single transaction. */
export type TxStatus = "paid" | "failed" | "disputed" | "disputing" | "refunded";

/** Source store the transaction was recorded against. */
export type TxStore = "ios" | "play" | "stripe" | "web" | "manual";

/**
 * Scope tabs at the top of the table. `refund` covers both refunds and
 * chargebacks (matches the design's filter behavior); `failed` covers any
 * non-paid status.
 */
export type TxScope = "all" | "purchase" | "renewal" | "refund" | "trial" | "failed";

export type Transaction = {
  id: string;
  type: TxType;
  /** Subscription id, or `"—"` for orphaned events (e.g. credit grants). */
  sub: string;
  user: string;
  product: string;
  store: TxStore;
  gross: number;
  fee: number;
  tax: number;
  net: number;
  currency: string;
  country: string;
  /** Pre-computed humanized "x ago" label — kept static for the prototype. */
  at: string;
  status: TxStatus;
  /** Free-form description of the payment method (e.g. "Stripe · visa 4242"). */
  method: string;
  /** Full subscriber id (un-truncated) for navigation/actions. */
  subscriberId: string;
  /** Full purchase id (un-truncated) for navigation/actions. */
  purchaseId: string;
};

/** A single bar in the 28-day stacked volume timeline. */
export type VolumeBar = {
  day: number;
  purchases: number;
  renewals: number;
  refunds: number;
  /** Highlight as the rightmost / current bar. */
  today: boolean;
};
