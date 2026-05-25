// =============================================================
// Types shared between the API (Zod-validated inputs + Prisma
// outputs) and the dashboard (TanStack Query hooks).
// Kept hand-written instead of inferred so the wire contract
// is explicit and safe to evolve.
// =============================================================

export type MemberRoleName = "OWNER" | "ADMIN" | "VIEWER";

export type ApiKeyEnvironment = "PRODUCTION" | "SANDBOX";

export interface ProjectSummary {
  id: string;
  name: string;
  role: MemberRoleName;
  createdAt: string; // ISO
}

export interface ProjectApiKey {
  id: string;
  label: string;
  publicKey: string; // the keyPublic column — plaintext identifier, safe to expose
  environment: ApiKeyEnvironment;
  createdAt: string;
}

export interface ProjectDetail {
  id: string;
  name: string;
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  counts: {
    subscribers: number;
    experiments: number;
    featureFlags: number;
    activeApiKeys: number;
  };
  apiKeys: ProjectApiKey[];
}

/**
 * Reporting defaults captured at project-create time and stored
 * inside `projects.settings`. The dashboard wizard collects these
 * on the Currency step; the FX source is fixed to "ECB" today.
 */
export interface ProjectReportingSettings {
  reportingCurrency: string;
  fxSource: "ecb";
  timezone: string;
  weekStart: "monday" | "sunday" | "saturday";
  fiscalMonth:
    | "jan"
    | "feb"
    | "mar"
    | "apr"
    | "may"
    | "jun"
    | "jul"
    | "aug"
    | "sep"
    | "oct"
    | "nov"
    | "dec";
}

export interface CreateProjectRequest {
  name: string;
  reporting?: Partial<ProjectReportingSettings>;
}

export interface CreateProjectResponse {
  project: ProjectDetail;
  apiKey: {
    publicKey: string; // plaintext — same as ProjectApiKey.publicKey, also readable from detail
    secretKey: string; // plaintext — shown once, only in this response
  };
}

export interface UpdateProjectRequest {
  name?: string;
  webhookUrl?: string | null;
  settings?: Record<string, unknown>;
}

export interface RotateWebhookSecretResponse {
  webhookSecret: string; // plaintext, shown once
}

// =============================================================
// Store credentials (apple / google / stripe)
// =============================================================
// Responses never carry plaintext secret material. Only a
// `configured` flag plus a small allowlist of safe-to-display
// fields (bundleId, packageName, etc.).

export type CredentialStore = "apple" | "google" | "stripe";

export interface CredentialStatus {
  store: CredentialStore;
  configured: boolean;
  safeFields?: Record<string, string>;
}

export interface CredentialsListResponse {
  credentials: {
    apple: CredentialStatus;
    google: CredentialStatus;
    stripe: CredentialStatus;
  };
}

export interface UpdateAppleCredentialsRequest {
  bundleId: string;
  appAppleId?: number;
  keyId?: string;
  issuerId?: string;
  privateKey?: string;
}

export interface UpdateGoogleCredentialsRequest {
  packageName: string;
  serviceAccount: {
    client_email: string;
    private_key: string;
    [key: string]: unknown;
  };
}

export interface UpdateStripeCredentialsRequest {
  secretKey: string;
  webhookSecret: string;
}

// =============================================================
// Project members
// =============================================================

export interface ProjectMemberRow {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: MemberRoleName;
  createdAt: string;
}

export interface ListMembersResponse {
  members: ProjectMemberRow[];
}

export interface AddMemberRequest {
  /** User must have signed in at least once so the User row exists. */
  email: string;
  role: MemberRoleName;
}

export interface AddMemberResponse {
  member: ProjectMemberRow;
}

export interface UpdateMemberRoleRequest {
  role: MemberRoleName;
}

export interface SubscriberListItem {
  id: string;
  appUserId: string;
  attributes: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  purchaseCount: number;
  activeEntitlementKeys: string[];
}

export interface SubscriberListResponse {
  subscribers: SubscriberListItem[];
  nextCursor: string | null;
}

export interface SubscriberPurchase {
  id: string;
  productId: string;
  productIdentifier: string;
  store: "APP_STORE" | "PLAY_STORE" | "STRIPE";
  status: string;
  priceAmount: string | null;
  priceCurrency: string | null;
  purchaseDate: string;
  expiresDate: string | null;
  autoRenewStatus: boolean | null;
}

export interface SubscriberAccessRow {
  entitlementKey: string;
  isActive: boolean;
  expiresDate: string | null;
  store: "APP_STORE" | "PLAY_STORE" | "STRIPE";
  purchaseId: string;
}

export interface SubscriberCreditLedgerRow {
  id: string;
  type: string;
  amount: string;
  balance: string;
  referenceType: string | null;
  description: string | null;
  createdAt: string;
}

export interface SubscriberAssignment {
  experimentId: string;
  experimentKey: string;
  variantId: string;
  assignedAt: string;
  convertedAt: string | null;
  revenue: string | null;
}

export interface SubscriberOutgoingWebhook {
  id: string;
  eventType: string;
  url: string;
  status: string;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  lastErrorMessage: string | null;
}

export interface SubscriberDetail {
  id: string;
  appUserId: string;
  attributes: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  deletedAt: string | null;
  mergedInto: string | null;
  access: SubscriberAccessRow[];
  purchases: SubscriberPurchase[];
  creditBalance: string;
  creditLedger: SubscriberCreditLedgerRow[];
  assignments: SubscriberAssignment[];
  outgoingWebhooks: SubscriberOutgoingWebhook[];
}

// =============================================================
// Experiments
// =============================================================
//
// Wire shape for `/dashboard/experiments`. Mirrors the drizzle row
// with timestamps serialised to ISO strings. `variants` is opaque
// JSON on the backend; we narrow to the runtime shape the engine
// actually writes so the dashboard can map weights + ids without
// guessing.

export type DashboardExperimentType =
  | "FLAG"
  | "PRODUCT_GROUP"
  | "PAYWALL"
  | "ELEMENT";

export type DashboardExperimentStatus =
  | "DRAFT"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED";

export interface DashboardExperimentVariant {
  id: string;
  name: string;
  value: unknown;
  weight: number;
}

export interface ExperimentListItem {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  type: DashboardExperimentType;
  key: string;
  audienceId: string;
  status: DashboardExperimentStatus;
  variants: DashboardExperimentVariant[];
  metrics: string[] | null;
  mutualExclusionGroup: string | null;
  startedAt: string | null;
  completedAt: string | null;
  winnerVariantId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentListResponse {
  experiments: ExperimentListItem[];
}

export interface ExperimentSummaryStats {
  totalUsers: number;
  conversions: number;
  conversionRate: number;
}

export interface ExperimentDetailResponse {
  experiment: ExperimentListItem;
  summary: ExperimentSummaryStats;
}

export interface ExperimentLifecycleResponse {
  experiment: ExperimentListItem;
  /** Present only on `/stop` when `promoteToFlag: true` was sent. */
  promotedFlag?: { id: string; key: string } | null;
}

export interface StopExperimentRequest {
  winnerVariantId?: string;
  promoteToFlag?: boolean;
}

// =============================================================
// Feature flags
// =============================================================
//
// Wire shape for `/dashboard/feature-flags`. The dashboard maps
// this onto a richer UI type — backend only carries the
// configuration the engine cares about (rules + default value),
// not analytics or environment partitions.

export type DashboardFlagType = "BOOLEAN" | "STRING" | "NUMBER" | "JSON";

export interface DashboardFlagRule {
  audienceId: string;
  value: unknown;
  rolloutPercentage?: number | null;
}

export interface FeatureFlagListItem {
  id: string;
  projectId: string;
  key: string;
  type: DashboardFlagType;
  defaultValue: unknown;
  rules: DashboardFlagRule[];
  isEnabled: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureFlagListResponse {
  flags: FeatureFlagListItem[];
}

export interface FeatureFlagDetailResponse {
  flag: FeatureFlagListItem;
}

// =============================================================
// Subscriber GDPR / credits — dashboard action endpoints
// =============================================================

export type AnonymizeSubscriberReason =
  | "gdpr_request"
  | "kvkk_request"
  | "retention_policy";

export interface AnonymizeSubscriberRequest {
  reason?: AnonymizeSubscriberReason;
}

export interface AnonymizeSubscriberResponse {
  subscriberId: string;
  anonymizedAppUserId: string;
  deletedAt: string;
}

/** Identical wire shape to {@link SubscriberCreditLedgerRow}. */
export type CreditHistoryEntry = SubscriberCreditLedgerRow;

export interface CreditHistoryResponse {
  entries: CreditHistoryEntry[];
  nextCursor: string | null;
}

// =============================================================
// Metrics — MRR daily series
// =============================================================

export interface MrrSeriesPoint {
  bucket: string; // ISO timestamp at start-of-day UTC
  grossUsd: string; // decimal-as-string for precision
  eventCount: number;
  activeSubscribers: number;
}

export interface MrrSeriesResponse {
  from: string;
  to: string;
  points: MrrSeriesPoint[];
}

// =============================================================
// Project overview — KPI summary + panels (Phase 3.1)
// =============================================================
//
// One read fans out into MRR series, active-subscriber count,
// top products, recent activity, and a system-health snapshot.
// The page falls back to mock data while the query is loading,
// so every numeric field carries enough context (current +
// previous window, plus a spark series) to render the KPI card
// without a second roundtrip.

/** ClickHouse-side ordering of revenue event types — matches the PG enum. */
export type RevenueEventTypeName =
  | "INITIAL"
  | "RENEWAL"
  | "TRIAL_CONVERSION"
  | "CANCELLATION"
  | "REFUND"
  | "REACTIVATION"
  | "CREDIT_PURCHASE";

export interface OverviewMrrKpi {
  /** Latest day's gross USD. Decimal-as-string for precision. */
  current: string;
  /** Same-length prior window's last day for delta computation. */
  previous: string;
  /** (current - previous) / previous * 100. null when previous is 0/missing. */
  deltaPct: number | null;
  /** Per-day gross USD (decimal-as-string) for the sparkline. */
  spark: string[];
}

export interface OverviewActiveSubsKpi {
  /** uniqExact(subscriberId) across the current window. */
  current: number;
  previous: number;
  deltaAbs: number;
  /** Per-day uniqExact across the current window. */
  spark: number[];
}

/**
 * Trial→paid conversion rate, percent. The full lifecycle proxy
 * lands in Phase 3.3 once the subscriptions rollup exists; for
 * now the API returns `null` so the UI can keep a placeholder.
 */
export interface OverviewTrialKpi {
  ratePct: number | null;
  previousRatePct: number | null;
  deltaPp: number | null;
  spark: number[];
}

/**
 * Net churn proxy: refunds_usd / gross_usd × 100 across the
 * window. Subscription-lifecycle churn arrives with Phase 3.3.
 */
export interface OverviewNetChurnKpi {
  current: number | null;
  previous: number | null;
  deltaPp: number | null;
  spark: number[];
}

export interface OverviewKpis {
  mrr: OverviewMrrKpi;
  activeSubscribers: OverviewActiveSubsKpi;
  trialToPaid: OverviewTrialKpi;
  netChurnPct: OverviewNetChurnKpi;
}

export interface OverviewTopProduct {
  productId: string;
  /** Project-scoped SKU (`products.identifier`). */
  identifier: string;
  displayName: string;
  /** Decimal-as-string gross USD across the window. */
  grossUsd: string;
  /** Share of total gross in the window, 0–100 with one decimal. */
  pct: number;
  subscriberCount: number;
}

export interface OverviewActivityEvent {
  id: string;
  type: RevenueEventTypeName;
  productId: string;
  productName: string | null;
  subscriberId: string;
  /** Decimal-as-string. null for events where we don't surface an amount. */
  amountUsd: string | null;
  currency: string;
  store: string;
  /** ISO-8601 UTC. */
  eventDate: string;
}

export type SystemHealthStatus = "operational" | "degraded" | "down";

export interface OverviewSystemHealth {
  /** Stable identifier for i18n/test selectors. */
  key: string;
  /** Localizable label suggestion; UI may override. */
  name: string;
  status: SystemHealthStatus;
  /** Short metric line (e.g. "Last sync 4m ago", "12 pending"). */
  metric: string;
}

export interface ProjectOverviewResponse {
  window: {
    from: string;
    to: string;
    days: number;
    prevFrom: string;
    prevTo: string;
  };
  kpis: OverviewKpis;
  topProducts: OverviewTopProduct[];
  recentActivity: OverviewActivityEvent[];
  systemHealth: OverviewSystemHealth[];
}

// =============================================================
// Transactions — list + volume + store breakdown (Phase 3.2)
// =============================================================
//
// `TransactionRow` is the cursor-paginated wire shape served by
// `GET /dashboard/projects/:id/transactions`. The UI's richer
// `Transaction` type (fee/tax/method/status) is derived client-
// side from this minimum core; the lifecycle status (`paid` /
// `failed` / `disputed`) is not separately tracked in the
// `revenue_events` ledger today, so the API returns each row as
// a settled event and the dashboard renders status accordingly.

export type TransactionScope =
  | "all"
  | "purchase"
  | "renewal"
  | "refund"
  | "trial"
  | "failed";

export interface TransactionRow {
  id: string;
  type: RevenueEventTypeName;
  subscriberId: string;
  purchaseId: string;
  productId: string;
  productName: string | null;
  productIdentifier: string | null;
  store: string;
  amountUsd: string;
  currency: string;
  eventDate: string;
}

export interface TransactionsListResponse {
  rows: TransactionRow[];
  /** Opaque cursor for the next page; null when the page is the last one. */
  nextCursor: string | null;
}

export interface TransactionsVolumePoint {
  /** ISO date `YYYY-MM-DD` (UTC). */
  day: string;
  purchases: number;
  renewals: number;
  refunds: number;
}

export interface TransactionsVolumeResponse {
  windowDays: number;
  points: TransactionsVolumePoint[];
}

export interface TransactionsStoreBreakdownRow {
  store: string;
  /** Decimal-as-string gross USD across the window. */
  grossUsd: string;
  /** Share of the window total, 0–100 with one decimal. */
  pct: number;
  eventCount: number;
}

export interface TransactionsStoreBreakdownResponse {
  windowDays: number;
  rows: TransactionsStoreBreakdownRow[];
  totalUsd: string;
}

// =============================================================
// Subscriptions — list + composition + KPIs + calendar (Phase 3.3)
// =============================================================
//
// `SubscriptionRow` is the cursor-paginated wire shape. The page's
// richer `Subscription` UI type (term / lifecycle strip / cancel
// reason copy) is derived client-side from this minimum core.
//
// `SubscriptionUiStatus` mirrors the dashboard's filter scope: the
// DB-side `PurchaseStatus` enum is collapsed/mapped server-side so
// the wire response is already in UI-friendly shape.

export type SubscriptionUiStatus =
  | "active"
  | "trial"
  | "grace"
  | "canceling"
  | "churned";

export type SubscriptionScopeName =
  | "all"
  | "active"
  | "trial"
  | "grace"
  | "canceling"
  | "issues"
  | "churned";

export interface SubscriptionRow {
  id: string;
  subscriberId: string;
  productId: string;
  productName: string | null;
  productIdentifier: string | null;
  store: string;
  status: SubscriptionUiStatus;
  /** Decimal-as-string. May be null when the price wasn't captured. */
  priceAmount: string | null;
  priceCurrency: string | null;
  isTrial: boolean;
  isIntroOffer: boolean;
  autoRenew: boolean | null;
  /** ISO-8601 UTC. */
  purchaseDate: string;
  expiresDate: string | null;
  gracePeriodExpires: string | null;
  cancellationDate: string | null;
  createdAt: string;
  updatedAt: string;
  /** True when there's an issue flag the panel surfaces (grace + auto-renew on). */
  hasIssue: boolean;
}

export interface SubscriptionsListResponse {
  rows: SubscriptionRow[];
  nextCursor: string | null;
}

export interface SubscriptionsKpis {
  totalActive: number;
  renewing7: number;
  graceRetry: number;
  canceling: number;
  /** All-time terminal count, useful for descriptive copy under tiles. */
  churned: number;
}

export interface SubscriptionsCompositionSegment {
  /** UI key used by the page for color / i18n. */
  key: SubscriptionUiStatus;
  count: number;
  /** Share of the live total, 0–100 with one decimal. */
  share: number;
}

export interface SubscriptionsCompositionResponse {
  segments: SubscriptionsCompositionSegment[];
  total: number;
}

export interface RenewalCalendarDay {
  /** ISO date `YYYY-MM-DD`, anchored to UTC midnight. */
  day: string;
  /** Offset relative to the response's `todayIndex`. */
  offset: number;
  today: boolean;
  past: boolean;
  renewals: number;
  trials: number;
  grace: number;
  /** Failed/expired retries — only populated for past days. */
  failed: number;
}

export interface RenewalCalendarResponse {
  /** Inclusive list spanning `pastDays` ago through `futureDays` ahead. */
  days: RenewalCalendarDay[];
  todayIndex: number;
}

export interface BillingIssueRow {
  purchaseId: string;
  subscriberId: string;
  productId: string;
  productName: string | null;
  /** Decimal-as-string of the last known price. */
  priceAmount: string | null;
  priceCurrency: string | null;
  store: string;
  /** ISO-8601 UTC; grace expiry or refund date depending on cause. */
  signalAt: string;
  /** UI-friendly description (e.g. `Card declined`). */
  issue: string;
  severity: "high" | "medium" | "low";
}

export interface BillingIssuesResponse {
  rows: BillingIssueRow[];
}

// =============================================================
// Credits — rollup endpoint (Phase 3.4)
// =============================================================
//
// One response serves the credits page in a single roundtrip:
// KPI tiles, 28-day volume series, credit-pack mix, top burners,
// recent ledger, and the outstanding-liability gauge.

export type CreditLedgerType =
  | "PURCHASE"
  | "SPEND"
  | "REFUND"
  | "BONUS"
  | "EXPIRE"
  | "TRANSFER_IN"
  | "TRANSFER_OUT";

export interface CreditsKpis {
  /** Outstanding credit liability — sum of latest balances per subscriber. */
  outstanding: number;
  issued28d: number;
  burned28d: number;
  /** Decimal-as-string USD revenue from CREDIT_PURCHASE events in window. */
  revenue28dUsd: string;
  /** Approximate breakage rate: EXPIRE / (PURCHASE + BONUS) × 100. */
  breakagePct: number | null;
}

export interface CreditsVolumePoint {
  day: string;
  issued: number;
  burned: number;
  /** issued − burned; can be negative. */
  net: number;
}

export interface CreditsPackageRow {
  productId: string;
  identifier: string | null;
  displayName: string | null;
  /** Decimal-as-string. */
  revenueUsd: string;
  sold: number;
  /** Share of pack revenue in window, 0–100 with one decimal. */
  pct: number;
  /** Credits per unit from `products.creditAmount`; null when unset. */
  creditAmount: number | null;
}

export interface CreditsTopBurnerRow {
  /** Bucket label — `referenceType` from credit_ledger, or "Other". */
  key: string;
  burned: number;
  /** Share of total burned credits in window, 0–100 with one decimal. */
  pct: number;
}

export interface CreditsLedgerRow {
  id: string;
  subscriberId: string;
  type: CreditLedgerType;
  /** Signed delta; positive = grant, negative = burn. */
  amount: number;
  balance: number;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  createdAt: string;
}

export interface CreditsRollupResponse {
  window: {
    from: string;
    to: string;
    days: number;
  };
  kpis: CreditsKpis;
  volume: CreditsVolumePoint[];
  packages: CreditsPackageRow[];
  topBurners: CreditsTopBurnerRow[];
  ledger: CreditsLedgerRow[];
}

// =============================================================
// Charts — channels / funnel / heatmap (Phase 3.5)
// =============================================================

export interface ChartChannelsRow {
  store: string;
  /** Decimal-as-string gross USD in the window. */
  grossUsd: string;
  pct: number;
  eventCount: number;
}

export interface ChartChannelsResponse {
  windowDays: number;
  totalUsd: string;
  rows: ChartChannelsRow[];
}

export interface ChartFunnelStep {
  /** Stable identifier, e.g. `purchase` / `trial` / `renewal`. */
  key: "purchase" | "trial" | "trial_to_paid" | "renewal";
  count: number;
  /** Share of step-0 count, 0–100 with one decimal. */
  pct: number;
}

export interface ChartFunnelResponse {
  windowDays: number;
  steps: ChartFunnelStep[];
}

export interface ChartHeatmapCell {
  /** 0=Sun … 6=Sat (UTC). */
  dow: number;
  /** 0–23 hour bucket (UTC). */
  hour: number;
  /** Event count in the window for that (dow, hour). */
  count: number;
}

export interface ChartHeatmapResponse {
  windowDays: number;
  cells: ChartHeatmapCell[];
}

// =============================================================
// Saved chart views (Phase 3.5)
// =============================================================

export interface SavedChartView {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SavedChartViewsResponse {
  views: SavedChartView[];
}

// =============================================================
// Chart annotations (Phase 3.5)
// =============================================================

export interface ChartAnnotation {
  id: string;
  projectId: string;
  userId: string | null;
  occurredAt: string;
  endsAt: string | null;
  label: string;
  description: string | null;
  color: string | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChartAnnotationsResponse {
  annotations: ChartAnnotation[];
}

// =============================================================
// Products + Product Groups dashboard CRUD (Phase 4.1)
// =============================================================

export type ProductTypeName = "SUBSCRIPTION" | "CONSUMABLE" | "NON_CONSUMABLE";

export interface DashboardProductRow {
  id: string;
  identifier: string;
  type: ProductTypeName;
  displayName: string;
  storeIds: Record<string, string>;
  entitlementKeys: string[];
  creditAmount: number | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardProductsListResponse {
  products: DashboardProductRow[];
  nextCursor: string | null;
}

export interface DashboardProductCreateInput {
  identifier: string;
  type: ProductTypeName;
  displayName: string;
  storeIds?: Record<string, string>;
  entitlementKeys?: string[];
  creditAmount?: number | null;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

export interface DashboardProductUpdateInput {
  identifier?: string;
  type?: ProductTypeName;
  displayName?: string;
  storeIds?: Record<string, string>;
  entitlementKeys?: string[];
  creditAmount?: number | null;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

/** Membership entry inside a `ProductGroup.products` JSONB column. */
export interface ProductGroupMembership {
  productId: string;
  order: number;
  isPromoted: boolean;
  metadata?: Record<string, unknown>;
}

export interface DashboardProductGroupRow {
  id: string;
  identifier: string;
  isDefault: boolean;
  products: ProductGroupMembership[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardProductGroupsListResponse {
  groups: DashboardProductGroupRow[];
}

export interface DashboardProductGroupCreateInput {
  identifier: string;
  isDefault?: boolean;
  products?: ProductGroupMembership[];
  metadata?: Record<string, unknown>;
}

export interface DashboardProductGroupUpdateInput {
  identifier?: string;
  isDefault?: boolean;
  products?: ProductGroupMembership[];
  metadata?: Record<string, unknown>;
}

// =============================================================
// Apps catalog connections overlay (Phase 4.2)
// =============================================================
//
// The apps catalog itself stays static (decision: no
// marketplace). This endpoint reports the *real* connection
// state for catalog entries the platform actually has backing
// for — Apple / Google / Stripe webhooks + outbound webhook
// endpoints — so the page can render `connected` status from
// truth instead of mock.

export type AppConnectionStatus = "connected" | "available" | "error";

export interface AppConnectionRow {
  /** Catalog app id (e.g. "apple-app-store", "google-play"). */
  appId: string;
  status: AppConnectionStatus;
  /** Last activity timestamp (ISO-8601). null when never connected. */
  lastActivityAt: string | null;
  /** Pre-formatted "Last sync 4m ago" hint. */
  lastSyncLabel: string | null;
  /** Short status / account label (e.g. "12 endpoints", "Live"). */
  account: string | null;
}

export interface AppConnectionsResponse {
  connections: AppConnectionRow[];
}

// =============================================================
// Live events SSE (Phase 4.3)
// =============================================================
//
// Wire shape for each `event: live` SSE message. The outbox
// dispatcher fans every published row into a per-project Redis
// channel; the SSE endpoint replays them as JSON.

export type LiveEventAggregateType =
  | "EXPOSURE"
  | "REVENUE_EVENT"
  | "CREDIT_LEDGER";

export interface LiveEventMessage {
  eventId: string;
  eventType: string;
  aggregateType: LiveEventAggregateType;
  aggregateId: string;
  payload: Record<string, unknown>;
  /** ISO-8601 UTC timestamp the OLTP write committed. */
  occurredAt: string;
}

// =============================================================
// Cohorts (Phase 4.4)
// =============================================================
//
// Structured rule DSL. The builder UI emits `CohortRule` shapes;
// the API validates with the same Zod schema before storing, and
// the retention/LTV services compile rules to CH WHERE clauses.
// Fields stay narrowly typed so a typo in the dashboard surfaces
// at compile-time instead of as an opaque CH parse error.

export type CohortFilterField =
  | "country"
  | "store"
  | "productId"
  | "purchaseType"
  | "firstSeenAfter"
  | "firstSeenBefore";

export type CohortOperator = "eq" | "in" | "gte" | "lte" | "between";

export type CohortFilterValue =
  | string
  | string[]
  | number
  | { min: number; max: number };

export interface CohortFilter {
  field: CohortFilterField;
  op: CohortOperator;
  value: CohortFilterValue;
}

export interface CohortRule {
  match: "all" | "any";
  filters: CohortFilter[];
}

export interface CohortSyncDestination {
  /** Display label shown in the sync-destinations panel. */
  label: string;
  /** HTTPS endpoint that receives `cohort.membership` POSTs. */
  url: string;
  /** Optional shared-secret HMAC; null leaves the call unsigned. */
  secret?: string | null;
  /** Wire format. Always `json` today; reserved for future tools. */
  format?: "json";
}

export interface CohortRow {
  id: string;
  projectId: string;
  userId: string | null;
  name: string;
  description: string | null;
  rules: CohortRule;
  syncDestinations: CohortSyncDestination[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CohortsListResponse {
  cohorts: CohortRow[];
}

export interface CohortRetentionPoint {
  /** Period index (0 = activation period, 1 = next, …). */
  period: number;
  /** Number of cohort members active in this period. */
  active: number;
  /** Share of the original cohort size, 0–100 with one decimal. */
  pct: number;
}

export interface CohortRetentionResponse {
  /** Total cohort size (subscribers matched by the rules). */
  size: number;
  /** Period granularity used to bucket retention. */
  granularity: "day" | "week" | "month";
  /** Number of periods returned (including period 0). */
  periods: number;
  points: CohortRetentionPoint[];
}

// =============================================================
// Queries playground (Phase 4.5)
// =============================================================

export interface DashboardSavedQuery {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  description: string | null;
  sql: string;
  mode: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardSavedQueriesListResponse {
  queries: DashboardSavedQuery[];
}

export interface DashboardSavedQueryCreateInput {
  name: string;
  description?: string | null;
  sql: string;
  mode?: string;
  metadata?: Record<string, unknown>;
}

export interface DashboardSavedQueryUpdateInput {
  name?: string;
  description?: string | null;
  sql?: string;
  mode?: string;
  metadata?: Record<string, unknown>;
}

export interface QueryExecuteRequest {
  sql: string;
}

export interface QueryExecuteColumn {
  name: string;
  /** ClickHouse type string, e.g. "Decimal(12,4)". */
  type: string;
}

export interface QueryExecuteResponse {
  columns: QueryExecuteColumn[];
  /** Each row is an ordered array aligned with `columns`. */
  rows: unknown[][];
  /** Total rows returned (may equal the cap if truncated). */
  rowCount: number;
  /** True when result was truncated by the playground cap. */
  truncated: boolean;
  /** Server-side execution time in milliseconds. */
  durationMs: number;
}

export interface QuerySchemaColumn {
  name: string;
  type: string;
}

export interface QuerySchemaTable {
  name: string;
  columns: QuerySchemaColumn[];
  /** Number of rows in the table at sample time; optional. */
  rowEstimate?: number | null;
}

export interface QuerySchemaResponse {
  database: string;
  tables: QuerySchemaTable[];
}

// =============================================================
// Audit logs (read-only viewer)
// =============================================================

export interface AuditLogEntry {
  id: string;
  projectId: string | null;
  userId: string;
  action: string;
  resource: string;
  resourceId: string;
  before: unknown;
  after: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  prevHash: string | null;
  rowHash: string | null;
  createdAt: string;
}

export interface OffsetPagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface AuditLogsListResponse {
  logs: AuditLogEntry[];
  pagination: OffsetPagination;
}

// =============================================================
// Audiences
// =============================================================

export interface AudienceRow {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  rules: Record<string, unknown>;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AudiencesListResponse {
  audiences: AudienceRow[];
}

// =============================================================
// Leaderboards (top spenders / top consumers)
// =============================================================

export interface LeaderboardEntry {
  subscriberId: string;
  /** Decimal-as-string. Negative for top-consumers (credits debited). */
  totalUsd: string;
  eventCount: number;
}

export interface LeaderboardResponse {
  from: string;
  to: string;
  entries: LeaderboardEntry[];
}

// =============================================================
// Authenticated user — /dashboard/me
// =============================================================
//
// Phase 2 — Account / Identity. The shape mirrors the Better
// Auth `user` row that the API reads off the session; locale/
// timezone columns get added in the following commit so callers
// can already key off the field names.

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  /** BCP-47, e.g. "en-US". */
  locale: string;
  /** IANA tz database name, e.g. "Europe/Istanbul". */
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface MeResponse {
  user: CurrentUser;
}

export interface UpdateMeRequest {
  name?: string;
  image?: string | null;
  locale?: string;
  timezone?: string;
}

export interface MySession {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  /** True for the session backing the current request. */
  current: boolean;
}

export interface MySessionsResponse {
  sessions: MySession[];
}

/**
 * OAuth providers recognised by Better Auth on the API today.
 * Apple / SSO are placeholder UI rows — they don't have a
 * matching provider configured server-side yet.
 */
export type OAuthProvider = "github" | "google";

export interface MyLinkedAccount {
  id: string;
  providerId: OAuthProvider | string;
  accountId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MyAccountsResponse {
  accounts: MyLinkedAccount[];
}

// =============================================================
// Personal access tokens — /dashboard/me/pats
// =============================================================

export interface MyPersonalAccessToken {
  id: string;
  name: string;
  /** Public-safe shortform, e.g. "rvn_pat_a82f…d11c". */
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface MyPersonalAccessTokensResponse {
  tokens: MyPersonalAccessToken[];
}

export interface CreatePersonalAccessTokenRequest {
  name: string;
  /** Optional ISO-8601 expiry; omit for non-expiring tokens. */
  expiresAt?: string;
}

export interface CreatePersonalAccessTokenResponse {
  token: MyPersonalAccessToken;
  /**
   * Plaintext token, ONLY returned on create. Display once then
   * discard — there is no read path that recovers it.
   */
  plaintext: string;
}

// =============================================================
// User preferences — /dashboard/me/preferences
// =============================================================
//
// The backend stores both blobs opaquely so the dashboard can
// add keys without a schema change. Each PATCH is a shallow
// merge per blob, so saving from the notifications page never
// clobbers the appearance settings (and vice versa).

export interface MyPreferences {
  notifications: Record<string, unknown>;
  appearance: Record<string, unknown>;
  updatedAt: string;
}

export interface MyPreferencesResponse {
  preferences: MyPreferences;
}

export interface UpdatePreferencesRequest {
  notifications?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
}
