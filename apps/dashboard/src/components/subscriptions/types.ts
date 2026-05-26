export type SubscriptionStatus =
  | "active"
  | "trial"
  | "grace"
  | "canceling"
  | "churned";

export type SubscriptionStore = "ios" | "play" | "stripe" | "web" | "manual";

export type SubscriptionScope =
  | "all"
  | "active"
  | "trial"
  | "grace"
  | "canceling"
  | "issues"
  | "churned";

export type BillingCycle = "weekly" | "monthly" | "yearly";

export type Subscription = {
  /** Canonical subscription id (sub_…). */
  id: string;
  /** Full user id this billing relationship belongs to (user_…). */
  user: string;
  /** Product key referenced from the catalog. */
  product: string;
  status: SubscriptionStatus;
  store: SubscriptionStore;
  /** Recurring price in USD. */
  price: number;
  billingCycle: BillingCycle;
  /** ISO date the subscription was first created. */
  started: string;
  /**
   * Days until the next renewal. Negative when the subscription has
   * already ended; `0` triggers the "retry today" rendering.
   */
  renewsIn: number;
  /** Position along the lifecycle strip, 0–100. */
  renewsPct: number;
  autoRenew: boolean;
  /** Free-text term descriptor (`12 mo`, `7d trial`, `ends Apr 02`). */
  term: string;
  /** Trial length in days; `0` for non-trial subscriptions. */
  trialDays: number;
  /** Whether the active cycle is using an introductory offer. */
  intro: boolean;
  /** Reason a subscription is winding down — drives the Billing kv list. */
  cancelPolicy:
    | "none"
    | "user_canceled"
    | "billing_retry"
    | "grace_expired";
  cancelReason?: string;
  /** Active entitlement keys at the time of last sync. */
  entitlements: ReadonlyArray<string>;
  /** Latest billing issue note shown as the row's danger pill. */
  lastIssue?: string;
};

export type CalendarDay = {
  /**
   * Offset relative to "today". Negative values are in the past.
   */
  day: number;
  today: boolean;
  past: boolean;
  renewals: number;
  trials: number;
  grace: number;
  /** Failed events are only populated for past days. */
  failed: number;
};

export type CompositionSegment = {
  key: "active" | "trial" | "canceling" | "grace" | "paused";
  /** Headcount used for both flex weight and label rendering. */
  count: number;
  /** Pre-computed share of the total, displayed as `90.9%`. */
  share: string;
  /** CSS color token. */
  color: string;
};

export type IssueSeverity = "high" | "medium" | "low" | "resolved";

export type BillingIssue = {
  user: string;
  /** Subscription id the issue is attached to. */
  id: string;
  /** Short description (`Card declined`, `Insufficient funds`). */
  issue: string;
  product: string;
  /** Number of retry attempts so far. */
  attempts: number;
  /** Free-text countdown for the next action. */
  next: string;
  severity: IssueSeverity;
  /** Recurring revenue at risk in USD. */
  mrr: number;
};

export type CohortRow = {
  /** Cohort label (e.g. `Apr 2026`). */
  label: string;
  /**
   * Six monthly retention values M0–M5. `null` means the cohort is too
   * young to have data for that month.
   */
  values: ReadonlyArray<number | null>;
};
