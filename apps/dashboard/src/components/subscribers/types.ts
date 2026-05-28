export type SubscriberStatus =
  | "active"
  | "trial"
  | "grace"
  | "churned"
  | "canceled";

export type SubscriberPlatform = "ios" | "android" | "web";

export type CountryCode =
  | "US"
  | "DE"
  | "TR"
  | "JP"
  | "BR"
  | "GB"
  | "FR"
  | "IN"
  | "CA"
  | "AU"
  | "NL"
  | "KR";

export type SubscriberScope =
  | "all"
  | "active"
  | "trial"
  | "grace"
  | "churn"
  | "vip"
  | "risk";

export type Subscriber = {
  /** Truncated id displayed in the table cell. */
  id: string;
  /** Full canonical user id (used for avatar + detail). */
  full: string;
  /** Display alias (e.g. masked email). */
  alias: string;
  country: CountryCode;
  /** Active or last-known access identifiers for this subscriber. */
  access: ReadonlyArray<string>;
  /** Last-purchased product key. */
  product: string;
  status: SubscriberStatus;
  /** Lifetime value in USD. */
  ltv: number;
  /** Monthly recurring revenue contribution in USD. `0` means no MRR. */
  mrr: number;
  /** Date the subscriber first purchased / started a trial. */
  created: string;
  /** Next renewal date, or `—` for non-renewing. */
  renew: string;
  platforms: ReadonlyArray<SubscriberPlatform>;
  /** Churn risk score, 0–100. */
  risk: number;
  /** Display label for the plan column. */
  plan: string;
  /** True if the user is flagged as VIP (amber dot on avatar). */
  vip?: boolean;
  /** Active billing issue — surfaces an extra danger pill in status cell. */
  billingIssue?: boolean;
  /** Short relative countdown shown when the renewal is imminent. */
  renewsIn?: string;
};

export type TimelineEntryKind = "purchase" | "renewal" | "cancel" | "fail" | "trial";

export type TimelineEntry = {
  kind: TimelineEntryKind;
  /** i18n key under `subscribers.timeline.events`. */
  typeKey: string;
  /** Relative or absolute time string for display. */
  at: string;
  /** Product key associated with the event. */
  product: string;
  /** Amount string ("$79.99", "—", …). */
  amount: string;
};

export type FilterPillKey = "access" | "platform" | "country" | "ltv";

export type FilterPillState = {
  key: FilterPillKey;
  value: string;
  active: boolean;
};
