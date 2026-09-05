// =============================================================
// Types shared between the API (Zod-validated inputs + Prisma
// outputs) and the dashboard (TanStack Query hooks).
// Kept hand-written instead of inferred so the wire contract
// is explicit and safe to evolve.
// =============================================================

import { z } from "zod";

import type { AttributeMap, SubscriberAttributes } from "./attributes";
import type { WebhookEventCategory } from "./webhook-events";
import type { PlacementRows } from "./placements";
import type { CurrencyGrantTrigger } from "./virtual-currencies";

export type MemberRoleName =
  | "OWNER"
  | "ADMIN"
  | "DEVELOPER"
  | "GROWTH"
  | "CUSTOMER_SUPPORT";

/** Roles a user can be invited or reassigned to via the UI. */
export const ASSIGNABLE_ROLES = [
  "ADMIN",
  "DEVELOPER",
  "GROWTH",
  "CUSTOMER_SUPPORT",
] as const satisfies ReadonlyArray<MemberRoleName>;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

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
  /**
   * Browser origins permitted to use this key. Empty means the key cannot be
   * used from a web page at all — which is the default, so every key that
   * predates the Web SDK is unaffected.
   */
  allowedOrigins: string[];
}

export interface CreateApiKeyRequest {
  label: string;
}

export interface CreateApiKeyResponse {
  apiKey: ProjectApiKey;
  secretKey: string; // plaintext — shown once, only in this response
}

export interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
  webhookEventCategories: WebhookEventCategory[];
  /** 0..100. Project-level experiment holdout (spec §4.4) — this
   *  percentage of subscribers is withheld from every experiment and
   *  receives control everywhere, so the experimentation programme's
   *  cumulative value can be measured against everyone else. Raising it
   *  only adds members; lowering it retroactively mixes cohorts (see
   *  `SettingsForm`'s lowering warning). */
  holdoutPercentage: number;
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
  description?: string | null;
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
  description?: string | null;
  webhookUrl?: string | null;
  webhookEventCategories?: WebhookEventCategory[];
  settings?: Record<string, unknown>;
  /** 0..100. See `ProjectDetail.holdoutPercentage`. */
  holdoutPercentage?: number;
}

export interface RotateWebhookSecretResponse {
  webhookSecret: string; // plaintext, shown once
}

// =============================================================
// Store credentials (apple / google)
// =============================================================
// Responses never carry plaintext secret material. Only a
// `configured` flag plus a small allowlist of safe-to-display
// fields (bundleId, packageName, etc.). Stripe used to live here
// too (pasted secret + webhook key) — Stripe Connect replaced it,
// so this type no longer names a "stripe" store; see
// StripeConnectionStatus (useStripeConnection) for Stripe's own
// connected-account status.

export type CredentialStore = "apple" | "google";

export interface CredentialStatus {
  store: CredentialStore;
  configured: boolean;
  safeFields?: Record<string, string>;
}

export interface CredentialsListResponse {
  credentials: {
    apple: CredentialStatus;
    google: CredentialStatus;
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

export interface UpdateMemberRoleRequest {
  role: AssignableRole;
}

export interface TransferOwnershipRequest {
  toUserId: string;
}

// =============================================================
// Project invitations
// =============================================================

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";
export type InvitationDeliveryStatusName =
  | "PENDING"
  | "DELIVERED"
  | "BOUNCED"
  | "COMPLAINED"
  | "SUPPRESSED";

export interface InvitationRow {
  id: string;
  email: string;
  role: MemberRoleName;
  status: InvitationStatus;
  deliveryStatus: InvitationDeliveryStatusName;
  deliveryError: string | null;
  invitedByName: string | null;
  expiresAt: string;
  lastSentAt: string | null;
  createdAt: string;
}

export interface ListInvitationsResponse {
  invitations: InvitationRow[];
}

export interface CreateInvitationRequest {
  email: string;
  role: AssignableRole;
}

export interface CreateInvitationResponse {
  invitation: InvitationRow;
  /** Returned exactly once on create. Subsequent GETs do not include this. */
  inviteUrl: string;
}

export interface InvitationPreviewResponse {
  projectId: string;
  projectName: string;
  inviterName: string | null;
  role: MemberRoleName;
  email: string;
  status: InvitationStatus;
  expiresAt: string;
}

export interface AcceptInvitationResponse {
  projectId: string;
  role: MemberRoleName;
}

export type SubscriberListPlatform = "ios" | "android" | "web";

export type SubscriberListStatusFilter =
  | "active"
  | "trial"
  | "grace"
  | "churned";

/** Sort modes accepted by the subscribers list endpoint. Every mode
 *  is DESC on its primary key with `id DESC` as tiebreaker. */
export type SubscriberListSortMode =
  | "last_activity"
  | "created"
  | "ltv"
  | "purchases";

export interface SubscriberListItem {
  id: string;
  appUserId: string | null;
  attributes: AttributeMap;
  firstSeenAt: string;
  lastSeenAt: string;
  purchaseCount: number;
  activeAccessIds: string[];
  /** Lifetime gross from `purchases.priceAmount`, decimal-as-string. */
  ltvUsd: string;
  /** Distinct platforms across all purchases. */
  platforms: SubscriberListPlatform[];
  /** Heuristic churn-risk score, 0–100. */
  churnRisk: number;
}

export interface SubscriberListFilters {
  /** Free-text substring (case-insensitive) over appUserId / rovenueId /
   *  the subscriber's Rovenue ID. */
  q?: string;
  /** Derived lifecycle status — drives the dashboard scope tabs. */
  status?: SubscriberListStatusFilter;
  /** Access identifier the subscriber must currently hold. */
  access?: string;
  /** Any-of platform filter (`ios`/`android`/`web`). */
  platforms?: ReadonlyArray<SubscriberListPlatform>;
  /** 2-letter country code (case-insensitive). */
  country?: string;
  /** Minimum lifetime gross in USD. */
  ltvMin?: number;
}

export interface SubscriberListResponse {
  subscribers: SubscriberListItem[];
  nextCursor: string | null;
}

export interface SubscriberPurchase {
  id: string;
  productId: string;
  productIdentifier: string;
  store: "APP_STORE" | "PLAY_STORE" | "STRIPE" | "MANUAL";
  status: string;
  priceAmount: string | null;
  priceCurrency: string | null;
  purchaseDate: string;
  expiresDate: string | null;
  autoRenewStatus: boolean | null;
}

export interface SubscriberAccessRow {
  accessId: string;
  isActive: boolean;
  expiresDate: string | null;
  store: "APP_STORE" | "PLAY_STORE" | "STRIPE" | "MANUAL";
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

/**
 * One outgoing webhook delivery attempt, project-scoped. Mirrors a
 * row from `outgoing_webhooks` with timestamps serialised to ISO
 * strings. Returned by GET /dashboard/webhooks/deliveries — covers
 * ALL statuses (PENDING/DELIVERING/SENT/FAILED/DEAD/DISMISSED), unlike
 * the dead-letter list.
 */
export interface WebhookDelivery {
  id: string;
  eventType: string;
  url: string;
  /** OutgoingWebhookStatus as a string. */
  status: string;
  /** HTTP status of the last attempt; null before the first attempt. */
  httpStatus: number | null;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  lastErrorMessage: string | null;
}

export interface ListWebhookDeliveriesResponse {
  webhooks: WebhookDelivery[];
  pagination: OffsetPagination;
}

export interface SubscriberDetail {
  id: string;
  appUserId: string | null;
  attributes: SubscriberAttributes;
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
  | "OFFERING"
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
  /** The metric the decision engine's stopping rule is evaluated on. */
  primaryMetric: ExperimentPrimaryMetric;
  /** The smallest RELATIVE effect the experiment is powered to detect,
   *  as a fraction (0.1 = 10%). `numeric(5,4)` in Postgres, so it arrives
   *  over the wire as a STRING ("0.1000") — convert at the boundary. */
  minimumDetectableEffect: string;
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

export interface DeleteExperimentResponse {
  id: string;
}

export interface DuplicateExperimentResponse {
  experiment: ExperimentListItem;
}

// =============================================================
// Experiment results (live, ClickHouse-backed)
// =============================================================
//
// Wire shape for `/dashboard/experiments/:id/results`. Mirrors
// `ExperimentResults` from apps/api/src/services/experiment-results.ts
// (and the analysis types from lib/experiment-stats.ts it composes),
// so the dashboard doesn't hand-duplicate the shape and can rely on
// `unwrap<ExperimentResultsResponse>` like every other typed hook.

export type ExperimentConfidenceLabel =
  | "99%"
  | "95%"
  | "90%"
  | "not significant";

export interface ExperimentConversionAnalysis {
  controlRate: number;
  variantRate: number;
  absoluteLift: number;
  relativeLift: number;
  zScore: number;
  pValue: number;
  isSignificant: boolean;
  confidenceLevel: number;
  confidenceLabel: ExperimentConfidenceLabel;
}

export interface ExperimentRevenueAnalysis {
  controlMean: number;
  variantMean: number;
  lift: number;
  tStatistic: number;
  pValue: number;
  isSignificant: boolean;
}

export interface ExperimentSRMResult {
  chi2: number;
  df: number;
  pValue: number;
  isMismatch: boolean;
  message: string;
}

/** The metric the decision engine evaluates. Mirrors the
 *  `ExperimentPrimaryMetric` Postgres enum. The API's request schema and
 *  the dashboard's picker both derive from this one list, so a metric
 *  added to the enum cannot be settable in one place and not the other. */
export const EXPERIMENT_PRIMARY_METRICS = [
  "CONVERSION",
  "ARPU",
  "PROCEEDS_PER_USER",
] as const;

export type ExperimentPrimaryMetric = (typeof EXPERIMENT_PRIMARY_METRICS)[number];

/**
 * Why there is no shippable recommendation. Every clause of the stopping
 * rule that failed is listed, ordered by evaluation, so `blockedBy[0]` is
 * the primary reason and an operator asking "why is there no
 * recommendation?" gets the answer from the payload rather than from
 * reading the service.
 *
 *  - `SAMPLE_SIZE`  — an arm has not reached `sampleSize.required`, or the
 *                     required size could not be estimated at all.
 *  - `RUNTIME`      — fewer than the minimum number of whole weekly cycles
 *                     have elapsed since the experiment started. NOT
 *                     implied by the sample gate: a high-traffic app can
 *                     clear any sample threshold inside one weekday.
 *  - `EXPECTED_LOSS`— the leader's expected loss, as a fraction of the
 *                     control's posterior mean, is still above the
 *                     caution threshold.
 *  - `NO_LEADER`    — fewer than two variants have enough data for the
 *                     primary metric, so there is nothing to compare.
 *  - `PROCEEDS_RATE_UNCONFIGURED`
 *                   — the primary metric is PROCEEDS_PER_USER and at least
 *                     one store contributing revenue has no configured
 *                     commission rate, which makes the metric unknown for
 *                     the WHOLE experiment (substituting gross revenue for
 *                     the unpriced store would silently misreport it).
 *
 * The last three SUPPRESS rather than annotate — when any of them fires,
 * `leadingVariantId` is withheld entirely:
 *  - `SRM`               — sample ratio mismatch on the exposed-user split.
 *  - `CROSSOVER`         — contamination above the named tolerance.
 *  - `REFUND_GUARDRAIL`  — the leader's refund rate is materially worse
 *                          than control's.
 */
export type ExperimentDecisionGate =
  | "SAMPLE_SIZE"
  | "RUNTIME"
  | "EXPECTED_LOSS"
  | "NO_LEADER"
  | "PROCEEDS_RATE_UNCONFIGURED"
  | "SRM"
  | "CROSSOVER"
  | "REFUND_GUARDRAIL";

export interface ExperimentResultsVariant {
  variantId: string;

  // ----- un-windowed exposure figures (SRM + back-compat) -----
  exposures: number;
  /** Distinct exposed subscribers, un-windowed and not crossover-excluded.
   *  This is the SRM denominator ONLY — never the metric denominator. */
  uniqueUsers: number;
  /** Precisely-attributed conversions (raw_revenue_events.experimentKey/
   *  variantId) — 0 for non-PAYWALL experiment types, which don't carry
   *  presentedContext. */
  attributedConversions: number;

  // ----- windowed, crossover-excluded figures (the metric) -----
  /** Exposed subscribers whose maturation window has fully elapsed and who
   *  were never exposed to another variant of this experiment. This is the
   *  denominator for every metric below. */
  matureUsers: number;
  /** Mature subscribers whose NET revenue over their own window is
   *  strictly positive. A subscriber who purchased and was then fully
   *  refunded is deliberately not a converter here — a semantic
   *  correction relative to `attributedConversions`, not an accident. */
  converters: number;
  /** `converters / matureUsers`, or `null` when no mature users exist —
   *  never 0, which would read as "nobody converted". */
  conversionRate: number | null;
  /** Mature-window gross revenue and refunds, in USD. */
  revenueUsd: number;
  refundsUsd: number;
  /** `refundsUsd / revenueUsd`, or `null` when there is no revenue to take
   *  a ratio of. The guardrail metric. */
  refundRate: number | null;
  /** Subscribers excluded from every windowed figure above because their
   *  window has not elapsed yet. */
  excludedImmature: number;
  /** Subscribers excluded because they were exposed to more than one
   *  variant of this experiment. */
  excludedCrossover: number;

  // ----- posterior (Bayesian, on the primary metric) -----
  /** Posterior mean of the primary metric, or `null` when this variant
   *  lacks the data to fit it. */
  posteriorMean: number | null;
  /** Equal-tailed credible interval bounds at the engine's named level. */
  credibleIntervalLow: number | null;
  credibleIntervalHigh: number | null;
  /** Fraction of posterior draws in which this variant is best. */
  probabilityBest: number | null;
  /** Expected regret, in the metric's own units, of shipping this variant
   *  when another is truly better. */
  expectedLoss: number | null;
  /** `false` when the posterior could not be fitted for this variant — the
   *  four fields above are then all `null` rather than fabricated. */
  sufficientData: boolean;
}

/**
 * The assumption-free cross-check (spec §4.1). Welch's t-test on RAW
 * per-subscriber net revenue makes no distributional assumption, so
 * agreement with the log-normal value model is informative and
 * disagreement is a signal about the model's fit. It is SHOWN, never
 * resolved — the engine does not pick a winner between the two.
 */
export interface ExperimentCrossCheck {
  /**
   * Relative lift (treatment − control) / control taken from the BAYESIAN
   * posterior on the primary metric.
   *
   * `null` unless the comparison is meaningful: exactly two variants, both
   * with a fitted posterior, a non-zero control mean, and a REVENUE-VALUED
   * primary metric. For a CONVERSION experiment the posterior estimates a
   * rate while Welch estimates revenue per user — different quantities, so
   * no sign comparison is made rather than one that would look like a
   * cross-check and not be one.
   */
  posteriorRelativeLift: number | null;
  /** Relative lift from Welch's t-test on raw per-subscriber net revenue.
   *  `null` when it could not be computed. Populated for every metric,
   *  including CONVERSION, where it is still worth seeing on its own. */
  welchRelativeLift: number | null;
  /**
   * True when the model-based and assumption-free estimates disagree about
   * the SIGN of treatment − control. It does not suppress the
   * recommendation and does not alter any gate — the stopping rule is
   * unchanged. It is a flag for the operator that the log-normal fit and
   * the raw data point opposite ways, which usually means a heavy tail.
   */
  signDisagreement: boolean;
}

/**
 * The project-level holdout cohort's observed figures for ONE experiment.
 *
 * Held-out subscribers are still exposed — against the reserved holdout
 * cohort id — because a holdout that is not measured is just a smaller
 * audience. But the cohort is NOT an arm of the experiment: it was
 * withheld from it. It therefore never enters SRM (whose expected split
 * comes from the experiment's declared weights, which do not mention it),
 * never gets a posterior, and never gates the sample size. It is reported
 * here, beside `variants`, so a holdout-vs-treated comparison has the
 * numbers without a synthetic third arm riding inside the variant list.
 */
export interface ExperimentHoldoutCohort {
  /** The reserved synthetic variant id the exposures were written under. */
  cohortId: string;
  /** Un-windowed exposure figures, same meaning as on a variant. */
  exposures: number;
  uniqueUsers: number;
  /** Windowed, crossover-excluded figures — same definitions as
   *  `ExperimentResultsVariant`'s. */
  matureUsers: number;
  converters: number;
  conversionRate: number | null;
  revenueUsd: number;
  refundsUsd: number;
  refundRate: number | null;
  excludedImmature: number;
  excludedCrossover: number;
}

export interface ExperimentIntegrity {
  /** Sample-ratio-mismatch check over the EXPOSED-user split
   *  (`uniqueUsers`), never over the windowed denominator. `null` with
   *  fewer than two variants. */
  srm: ExperimentSRMResult | null;
  /** Fraction of exposed subscribers seen under more than one variant, or
   *  `null` when nobody was exposed. */
  crossoverRate: number | null;
}

export interface ExperimentRecommendation {
  /** The variant with the highest `probabilityBest`, or `null` when a
   *  suppression gate fired (SRM / crossover / refund guardrail) or no
   *  leader could be identified. Suppression WITHHOLDS the leader; it does
   *  not annotate a recommendation that still renders. */
  leadingVariantId: string | null;
  /** True only when every clause of the stopping rule passed. */
  shipRecommended: boolean;
  /** Empty when nothing blocks. See `ExperimentDecisionGate`. */
  blockedBy: ExperimentDecisionGate[];
}

export interface ExperimentResultsResponse {
  experimentId: string;
  status: DashboardExperimentStatus;
  /** The metric the recommendation is made on. */
  primaryMetric: ExperimentPrimaryMetric;
  /** Empty when ClickHouse is unconfigured or no exposures were
   *  recorded yet — never a zero-filled row per configured variant. */
  variants: ExperimentResultsVariant[];
  /** The project holdout cohort's figures for this experiment, or `null`
   *  when no holdout is configured (or nobody in it was exposed). Never an
   *  entry in `variants` — it is not an arm of this experiment. */
  holdout: ExperimentHoldoutCohort | null;
  /** Fixed-horizon frequentist cross-checks. Valid at the planned sample
   *  size and only there — the recommendation is never made on these. */
  conversion: ExperimentConversionAnalysis | null;
  /** Welch's t-test on raw per-subscriber NET revenue over mature
   *  subscribers, computed from sufficient statistics. `null` when either
   *  arm has fewer than two mature subscribers, or there are not exactly
   *  two variants (Welch is a two-sample test). */
  revenue: ExperimentRevenueAnalysis | null;
  crossCheck: ExperimentCrossCheck;
  integrity: ExperimentIntegrity;
  sampleSize: {
    required: number;
    reached: boolean;
  } | null;
  /** Whole days since the experiment started, or `null` if it never did. */
  runtimeDays: number | null;
  recommendation: ExperimentRecommendation;
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

export type DashboardFlagEnv = "PROD" | "STAGING" | "DEVELOPMENT";

export const DASHBOARD_FLAG_ENVS: ReadonlyArray<DashboardFlagEnv> = [
  "PROD",
  "STAGING",
  "DEVELOPMENT",
];

export interface DashboardFlagRule {
  /**
   * Reference to a pre-built audience. Optional now that rules
   * can carry inline targeting conditions instead.
   */
  audienceId?: string;
  /**
   * MongoDB-style targeting document evaluated by `matchesAudience`.
   * Combined with the audience (logical AND) when both are present.
   * Empty / undefined = matches all subscribers.
   */
  conditions?: Record<string, unknown>;
  value: unknown;
  rolloutPercentage?: number | null;
}

export interface FeatureFlagListItem {
  id: string;
  projectId: string;
  key: string;
  type: DashboardFlagType;
  env: DashboardFlagEnv;
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
  refundsUsd: string; // decimal-as-string; refunds + chargebacks for the day
  netUsd: string; // decimal-as-string; grossUsd - refundsUsd
  eventCount: number;
  activeSubscribers: number;
}

export interface MrrSeriesResponse {
  from: string;
  to: string;
  points: MrrSeriesPoint[];
}

// =============================================================
// Charts — generic per-chart daily series
// =============================================================
//
// One shape for every catalog chart, so the dashboard can render
// any id without a per-chart response type. `supported` is false
// for a catalog id that has no reader yet: the panel then shows an
// empty state instead of another chart's data.

export interface ChartSeriesPoint {
  /** ISO timestamp at start-of-day UTC. */
  bucket: string;
  /**
   * null when the metric is undefined for that day — a ratio whose
   * denominator is zero. Distinct from 0, which means "measured, and
   * it was zero".
   */
  value: number | null;
  /** Ratio inputs, exposed so a reader can show "3 of 120". */
  numerator?: number;
  denominator?: number;
}

/**
 * What a series' x-axis MEANS.
 *
 * `"date"` — one point per calendar day; `bucket` is an ISO
 * start-of-day. Every daily metric.
 *
 * `"period"` — one point per period SINCE COHORT START; `period` is a
 * 0-based index and there is no date involved at all. Cohort-shaped
 * metrics (`retention_curve`, `ltv`) are lines, but not lines over
 * dates: until this discriminator existed they could only have been
 * served by inventing calendar dates for periods-since-join, which is
 * why they shipped `supported: false` instead.
 *
 * Required, never optional-with-a-default: a period-shaped reader that
 * forgot to declare itself would claim to be dated and be plotted as
 * dates — the exact bug this field exists to prevent.
 */
export type ChartSeriesAxis = "date" | "period";

export type ChartSeriesPeriodGranularity = "day" | "week" | "month";

export interface ChartSeriesPeriodPoint {
  /** 0-based periods since cohort start. Not a date. */
  period: number;
  /**
   * null when the metric is undefined for that period — e.g. an empty
   * cohort, whose retention is undefined rather than 0%.
   */
  value: number | null;
  /** Ratio inputs, exposed so a reader can show "82 of 200". */
  numerator?: number;
  denominator?: number;
}

interface ChartSeriesBase {
  chartId: string;
  /**
   * `"money"` is USD — the pipeline normalises to `amountUsd`
   * (summary.ts / proceeds.ts both rely on that), so there is no
   * currency selector here or anywhere downstream of it.
   */
  unit: "count" | "percent" | "money";
  from: string;
  to: string;
  /** false when this chart id has no reader — an unknown or custom id. */
  supported: boolean;
}

export interface ChartSeriesDateResponse extends ChartSeriesBase {
  axis: "date";
  points: ChartSeriesPoint[];
}

export interface ChartSeriesPeriodResponse extends ChartSeriesBase {
  axis: "period";
  /** Whether a period is a day, a week, or a month. */
  periodGranularity: ChartSeriesPeriodGranularity;
  points: ChartSeriesPeriodPoint[];
}

export type ChartSeriesResponse =
  | ChartSeriesDateResponse
  | ChartSeriesPeriodResponse;

// =============================================================
// Revenue summary — window KPIs (analytics surfacing Phase 1)
// =============================================================
//
// Pure-ClickHouse window aggregate. ARPU (net ÷ active base) is
// intentionally absent — it lands in Phase 2 with the active-base
// source decision. All monetary fields are decimal-as-string.

export interface RevenueSummaryResponse {
  from: string;
  to: string;
  grossUsd: string;
  refundsUsd: string;
  netUsd: string;
  /** refundsUsd / grossUsd in [0,1]; null when grossUsd is 0. */
  refundRate: number | null;
  /** Distinct subscribers with a non-refund revenue event in the window. */
  payingSubscribers: number;
  /** netUsd / payingSubscribers; null when payingSubscribers is 0. */
  arppu: string | null;
  /** Lifetime net (purchased - refunded) per subscriber, in USD. */
  avgLtvUsd: string;
  medianLtvUsd: string;
  p90LtvUsd: string;
  /** Subscribers contributing to the LTV aggregate. */
  ltvSubscribers: number;
  /** Distinct subscribers with an ACTIVE purchase right now (ARPU denominator). */
  activeSubscriberBase: number;
  /** netUsd / activeSubscriberBase; null when base is 0. */
  arpu: string | null;
  /** Distinct subscribers whose subscription went terminal within the window. */
  churnedInWindow: number;
  /** churnedInWindow / (activeSubscriberBase + churnedInWindow); null when both 0. */
  churnRate: number | null;
  /** Distinct subscribers who started a trial within the window. */
  trialStarts: number;
  /** Distinct subscribers who converted a trial to paid within the window. */
  trialConversions: number;
  /** trialConversions / trialStarts; null when trialStarts is 0. */
  trialConversionRate: number | null;
}

// =============================================================
// LTV distribution — lifetime-value histogram (Phase 2)
// =============================================================

export interface LtvHistogramBucket {
  /** Inclusive lower bound in USD. */
  lowerUsd: number;
  /** Exclusive upper bound in USD; null for the open-ended top bucket. */
  upperUsd: number | null;
  count: number;
}

export interface LtvDistributionResponse {
  avgUsd: string;
  medianUsd: string;
  p90Usd: string;
  totalSubscribers: number;
  histogram: LtvHistogramBucket[];
}

// =============================================================
// Predictive LTV — Level 1 (cohort curve scaling)
// =============================================================

export interface LtvSegment {
  /** store code, productId, or "__all__". */
  key: string;
  label: string;
  size: number;
  observedLtvUsd: string;
  predictedLtvUsd: string;
  /** thin-segment / cold-start flag. */
  warning: string | null;
}

export interface LtvPredictionCohort {
  cohortMonth: string;
  size: number;
  observedLtvUsd: string;
  predictedLtvUsd: string;
  maturity: number;
  isMature: boolean;
}

export interface LtvPredictionResponse {
  horizonMonths: number;
  blendedPredictedLtvUsd: string;
  maturityCurve: Array<{ ageMonth: number; fraction: number }>;
  cohorts: LtvPredictionCohort[];
  byStore: LtvSegment[];
  byProduct: LtvSegment[];
  warning: string | null;
}

export interface MrrDecompositionResponse {
  from: string;
  to: string;
  /** INITIAL + TRIAL_CONVERSION, decimal-as-string USD. */
  newUsd: string;
  /** RENEWAL, decimal-as-string USD. */
  retainedUsd: string;
  /** REACTIVATION (winback), decimal-as-string USD. */
  reactivationUsd: string;
  /** REFUND + CHARGEBACK (money out), positive magnitude, decimal-as-string USD. */
  churnedUsd: string;
}

export interface EngagementPoint {
  bucket: string;
  sessionCount: number;
  avgSessionMs: number;
  activeSubscribers: number;
}

export interface EngagementResponse {
  from: string;
  to: string;
  points: EngagementPoint[];
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
  | "CREDIT_PURCHASE"
  | "NON_RENEWING_PURCHASE";

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

/** UI store buckets — mapped server-side to the raw `store` column. */
export type TransactionStoreFilter = "ios" | "play" | "stripe" | "web" | "manual";

/** Sort key accepted by the transactions list endpoint. */
export type TransactionsListSort =
  | "newest"
  | "oldest"
  | "amount_desc"
  | "amount_asc";

export interface TransactionsListFilters {
  /** Free-text substring against subscriberId / purchaseId / productId. */
  q?: string;
  /** Any-of store filter (`ios`/`play`/`stripe`/`web`). */
  stores?: ReadonlyArray<TransactionStoreFilter>;
  /** Any-of ISO-4217 currency codes (case-insensitive). */
  currencies?: ReadonlyArray<string>;
  /** Minimum gross USD across the row. */
  amountMin?: number;
  /** Inclusive `eventDate` lower bound, ISO date or full ISO timestamp. */
  from?: string;
  /** Inclusive `eventDate` upper bound, ISO date or full ISO timestamp. */
  to?: string;
}

export interface TransactionsSyncResponse {
  /** ISO-8601 UTC timestamp when the sync was acknowledged. */
  syncedAt: string;
  /** Outbox events not yet published to ClickHouse. */
  pendingOutbox: number;
}

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
  /**
   * Estimated store fee USD across the window — derived from
   * known per-store rates (15% iOS / 15% Play / 2.9% Stripe /
   * 0% web). Decimal-as-string. We don't record actual fees in
   * `revenue_events`, so this is an estimate.
   */
  estimatedFeeUsd: string;
  /** Estimated fee rate, 0–100 with one decimal. */
  estimatedFeePct: number;
}

export interface TransactionsStoreBreakdownResponse {
  windowDays: number;
  rows: TransactionsStoreBreakdownRow[];
  totalUsd: string;
  /** Decimal-as-string total event count across the window. */
  eventCount: number;
  /** Refunds USD across the same window. Decimal-as-string. */
  refundsUsd: string;
  /** Gross USD across the previous window of equal length. */
  previousTotalUsd: string;
  /** (current − previous) / previous × 100. null when previous is 0. */
  deltaPct: number | null;
  /** Estimated mix-weighted store fee USD, sum of per-store estimates. */
  estimatedFeesUsd: string;
  /** Average estimated fee rate, weighted by gross. 0–100 with one decimal. */
  estimatedFeePct: number;
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

// =============================================================
// Subscriptions list — sort key + filter union
// =============================================================
//
// `SubscriptionSortKey` is the canonical sort identifier the API
// accepts via `?sort=…`. The dashboard maps `<Th>` column clicks to
// these keys (see SubscriptionsTable.sortableColumns).
//
//   started_desc (default) — purchaseDate DESC, id DESC
//   started_asc            — purchaseDate ASC,  id ASC
//   renews_asc             — expiresDate ASC NULLS LAST, id ASC
//   renews_desc            — expiresDate DESC NULLS LAST, id DESC
//   price_desc             — priceAmount DESC NULLS LAST, id DESC
//   price_asc              — priceAmount ASC NULLS LAST, id ASC
//   status                 — status ASC, id ASC

export const subscriptionSortKeys = [
  "started_desc",
  "started_asc",
  "renews_asc",
  "renews_desc",
  "price_desc",
  "price_asc",
  "status",
] as const;

export type SubscriptionSortKey = (typeof subscriptionSortKeys)[number];

export const subscriptionStoreCodes = [
  "APP_STORE",
  "PLAY_STORE",
  "STRIPE",
  "MANUAL",
] as const;

export type SubscriptionStoreCode = (typeof subscriptionStoreCodes)[number];

// All optional client-side query fields the list endpoint accepts.
// Mirrors the URL search-param shape used by the dashboard route.
export interface SubscriptionsListQuery {
  scope?: SubscriptionScopeName;
  search?: string;
  cursor?: string;
  limit?: number;
  store?: ReadonlyArray<SubscriptionStoreCode>;
  productId?: ReadonlyArray<string>;
  autoRenew?: boolean;
  isTrial?: boolean;
  isIntro?: boolean;
  hasIssue?: boolean;
  purchasedFrom?: string;
  purchasedTo?: string;
  expiresFrom?: string;
  expiresTo?: string;
  sort?: SubscriptionSortKey;
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

/**
 * Per-scope row counts powering the subscriptions scope tabs. Each key
 * matches a `SubscriptionScopeName` and counts the rows the list endpoint
 * returns for that scope (so the chip totals always agree with the table).
 */
export type SubscriptionsScopeCounts = Record<SubscriptionScopeName, number>;

export interface SubscriptionsScopeCountsResponse {
  counts: SubscriptionsScopeCounts;
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
  /** Distinct subscribers with a positive latest balance. */
  outstandingWalletCount: number;
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
  currencyId: string;
  type: CreditLedgerType;
  /** Signed delta; positive = grant, negative = burn. */
  amount: number;
  balance: number;
  referenceType: string | null;
  referenceId: string | null;
  description: string | null;
  createdAt: string;
}

/**
 * Window-scoped sums by ledger type. Inflow values are positive
 * deltas (`amount > 0`); outflow values are the absolute value of
 * negative deltas, so every member is non-negative and safe to
 * pass straight into UI formatters.
 */
export interface CreditsFlowByType {
  purchase: number;
  bonus: number;
  refund: number;
  transferIn: number;
  spend: number;
  expire: number;
  transferOut: number;
}

/**
 * Three-card "Inflow → Balance → Outflow" payload. `balanceByType`
 * splits the outstanding total into paid / promo / transfer shares
 * via lifetime inflow ratios — per-batch attribution isn't tracked,
 * so it's an approximation, not a true LIFO/FIFO accounting.
 */
export interface CreditsFlow {
  inflow: number;
  outflow: number;
  balance: number;
  inflowByType: CreditsFlowByType;
  outflowByType: CreditsFlowByType;
  balanceByType: {
    paid: number;
    promo: number;
    transfer: number;
  };
}

export interface CreditsLiability {
  /** Paid (revenue-backed) share of outstanding, 0–1. */
  paidShare: number;
  /** Bonus / promo share of outstanding, 0–1. */
  promoShare: number;
  /** Transfer-in share of outstanding, 0–1. */
  transferShare: number;
  /** Decimal-as-string USD reserve suggestion: paid × avg credit price. */
  paidReserveUsd: string;
  /** % change in paidReserveUsd vs the previous equal-length window. null when prev was 0. */
  reserveDeltaPct: number | null;
  /** Average age of positive credit_ledger rows in days. null when none. */
  averageAgeDays: number | null;
}

export interface CreditsRollupResponse {
  window: {
    from: string;
    to: string;
    days: number;
  };
  kpis: CreditsKpis;
  flow: CreditsFlow;
  liability: CreditsLiability;
  volume: CreditsVolumePoint[];
  packages: CreditsPackageRow[];
  topBurners: CreditsTopBurnerRow[];
  ledger: CreditsLedgerRow[];
}

// =============================================================
// Credits — dashboard grant (manual ledger entry)
// =============================================================

export const grantCreditsRequestSchema = z.object({
  subscriberId: z.string().min(1),
  currencyId: z.string().min(1),
  amount: z.number().int().positive(),
  type: z.enum(["BONUS", "PURCHASE", "REFUND"]).default("BONUS"),
  referenceType: z.string().trim().max(60).optional(),
  referenceId: z.string().trim().max(120).optional(),
  description: z.string().trim().max(200).optional(),
});
export type GrantCreditsRequest = z.infer<typeof grantCreditsRequestSchema>;

export interface GrantCreditsResponse {
  entry: CreditsLedgerRow;
  balance: number;
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

// =============================================================
// Charts — estimated proceeds after store commission (Task 5,
// 2026-09-01 analytics-integrity-and-proceeds plan)
// =============================================================
//
// A per-store breakdown, deliberately NOT a single blended figure: a
// project can have a configured rate for one store and none for
// another, and folding those into one number would hide which part is
// a real estimate and which part is undefined. `rate`/`proceedsUsd`
// are `null` together when the store has no configured commission
// rate — never a silently-assumed 0%. See
// apps/api/src/services/metrics/proceeds.ts for the arithmetic.

export interface ChartProceedsRow {
  store: string;
  /** Decimal-as-string gross USD in the window, before refunds. */
  grossUsd: string;
  /** Decimal-as-string; refunds + chargebacks (always non-negative). */
  refundsUsd: string;
  /** Decimal-as-string; grossUsd - refundsUsd. */
  netUsd: string;
  /**
   * The commission rate actually applied for this store, or `null`
   * when nothing is configured — the caller's signal to render "no
   * estimate available", never a store that takes nothing.
   */
  rate: number | null;
  /**
   * Decimal-as-string ESTIMATED proceeds (netUsd * (1 - rate)). Always
   * `null` when `rate` is `null`. Any caller presenting this MUST
   * label it an estimate with `rate` visible next to it — never as an
   * actual store payout (see proceeds.ts's header comment).
   */
  proceedsUsd: string | null;
}

export interface ChartProceedsResponse {
  windowDays: number;
  rows: ChartProceedsRow[];
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
// Chart catalog (Phase 3.5 — extended)
// =============================================================
//
// The chart catalog is the left-rail library on /charts. System
// entries are hard-coded server-side (non-deletable) and ship with
// every project; custom entries are per-project, user-authored
// rows stored in `custom_charts` and editable by ADMIN+ members.

export type ChartCategory =
  | "revenue"
  | "growth"
  | "retention"
  | "conversion"
  | "credits"
  | "custom";

export type ChartType = "line" | "area" | "bar";

export type ChartRangeOption = "1M" | "3M" | "6M" | "12M" | "YTD" | "All";

export interface ChartCatalogEntry {
  /** Stable id — system slug or DB cuid. */
  id: string;
  /** "system" entries cannot be deleted. */
  kind: "system" | "custom";
  category: ChartCategory;
  /**
   * For system entries this is a translation key under
   * `charts.items.<id>`; for custom entries it's the literal
   * user-provided label.
   */
  name: string;
  chartType: ChartType;
  range: ChartRangeOption;
  /** Filters / group-by / extra config — opaque JSON. */
  config: Record<string, unknown>;
  /** Null for system entries. */
  createdAt: string | null;
  /** Null for system entries. */
  updatedAt: string | null;
}

export interface ChartCatalogResponse {
  entries: ChartCatalogEntry[];
}

// =============================================================
// Chart filter options (Phase 3.5 — extended)
// =============================================================
//
// Drives the right-rail Filters card. The dashboard previously
// hard-coded chip values; this endpoint surfaces the distinct
// values actually present in the project's revenue stream so
// teams only see filters that can match data.

export interface ChartFilterOption {
  /** Machine value — e.g. `ios`, `US`, `premium`. */
  value: string;
  /** Display label. Mirrors `value` when no friendlier name exists. */
  label: string;
  /** Event count in the window — used for sort + diagnostics. */
  count: number;
}

/**
 * Country coverage over the SAME window as the filter options, counted
 * without any row cap.
 *
 * Deliberately not derived from `country[]`: that list feeds a dropdown
 * and is truncated to the top values by count, so summing it understates
 * coverage for any project selling in more storefronts than the cap — and
 * a coverage statistic that silently under-reports is the exact failure
 * the feature exists to prevent. These two integers come from their own
 * `countIf(country != '')` / `count()` aggregate.
 */
export interface ChartCountryCoverage {
  /** Events in the window whose store supplied a country. */
  eventsWithCountry: number;
  /** All revenue events in the window, country or not. */
  totalEvents: number;
}

export interface ChartFilterOptionsResponse {
  windowDays: number;
  platform: ChartFilterOption[];
  // Distinct store-supplied countries in the window, top values first.
  // Backed by `raw_revenue_events.country` (migration 0023), sourced from
  // the store's own per-transaction value — Apple's `storefront`,
  // normalised to ISO 3166-1 alpha-2 — never the subscriber's last-known
  // SDK-reported country, which is a different fact. See
  // docs/superpowers/specs/2026-09-01-analytics-integrity-and-proceeds-design.md
  // §4.2.
  //
  // Capped server-side (top 50 by count) because this feeds a dropdown.
  // Never compute a coverage statistic from it — use `countryCoverage`,
  // which is counted without a cap.
  country: ChartFilterOption[];
  /** Uncapped coverage counts for the same window — see `ChartCountryCoverage`. */
  countryCoverage: ChartCountryCoverage;
  // `productGroup` was removed: `productGroupId` never existed in the
  // ClickHouse schema (see the same spec §4.2) and had no consumer anywhere
  // in the dashboard.
}

// =============================================================
// Products + Product Groups dashboard CRUD (Phase 4.1)
// =============================================================

export type ProductTypeName = "SUBSCRIPTION" | "CONSUMABLE" | "NON_CONSUMABLE";

export interface DashboardProductCurrencyGrant {
  currencyId: string;
  amount: number;
  /**
   * Which lifecycle event fires this grant. Omitted on write defaults to
   * PURCHASE server-side; RENEWAL/BOTH are only valid on a SUBSCRIPTION
   * product (a non-subscription never renews, so the grant would
   * silently never fire).
   */
  grantOn?: CurrencyGrantTrigger;
}

export interface DashboardProductRow {
  id: string;
  identifier: string;
  type: ProductTypeName;
  displayName: string;
  storeIds: Record<string, string>;
  accessIds: string[];
  /**
   * Currency grants associated with this product.
   * NOTE: the products LIST endpoint (GET /) does NOT populate this field —
   * it always returns `[]`. Use the create (POST /), update (PATCH /:id),
   * or detail (GET /:id) endpoints to obtain the populated grants.
   */
  currencyGrants: DashboardProductCurrencyGrant[];
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  /** Google Play base plan identifier for server-configured default offer selection. */
  androidBasePlanId: string | null;
  /** Google Play offer identifier; requires androidBasePlanId to be set. */
  androidOfferId: string | null;
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
  accessIds?: string[];
  creditAmount?: number | null;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
  currencyGrants?: DashboardProductCurrencyGrant[];
  androidBasePlanId?: string | null;
  androidOfferId?: string | null;
}

export interface DashboardProductUpdateInput {
  identifier?: string;
  type?: ProductTypeName;
  displayName?: string;
  storeIds?: Record<string, string>;
  accessIds?: string[];
  creditAmount?: number | null;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
  currencyGrants?: DashboardProductCurrencyGrant[];
  androidBasePlanId?: string | null;
  androidOfferId?: string | null;
}

/** Per-row input for bulk import from a store. */
export interface DashboardProductImportItem {
  /** Per-store SKU as it lives in App Store Connect / Play / Stripe. */
  storeId: string;
  /** Optional override; defaults to `storeId` when omitted. */
  identifier?: string;
  /** Optional override; defaults to `storeId` when omitted. */
  displayName?: string;
  type: ProductTypeName;
  accessIds?: string[];
  creditAmount?: number | null;
  /** Optional metadata blob (e.g. `{ period: "P1M" }` for subscriptions). */
  metadata?: Record<string, unknown>;
}

export interface DashboardProductImportInput {
  /** Which store the SKUs were copied from. Persisted under `storeIds[store]`. */
  store: "ios" | "android" | "web";
  items: DashboardProductImportItem[];
}

export type DashboardProductImportSkipReason =
  | "duplicate-identifier"
  | "duplicate-store-id"
  | "invalid";

export interface DashboardProductImportResultRow {
  storeId: string;
  identifier: string;
  status: "created" | "skipped";
  reason?: DashboardProductImportSkipReason;
  productId?: string;
}

export interface DashboardProductImportResponse {
  created: number;
  skipped: number;
  results: DashboardProductImportResultRow[];
}

/** One product as listed by a store's catalog API. */
export interface StoreCatalogItem {
  /** Per-store SKU / product id (e.g. App Store Connect `productId`). */
  storeId: string;
  /** Mapped product type. */
  type: ProductTypeName;
  /** Human-readable reference name from the store. */
  name: string;
  /** Optional formatted price, when the store API surfaces one. */
  priceLabel?: string;
  /** True when a product with this `storeId` already exists for the store. */
  alreadyImported: boolean;
}

export interface DashboardStoreCatalogResponse {
  items: StoreCatalogItem[];
}

// =============================================================
// Dashboard: Access catalog
// =============================================================

export interface DashboardAccessRow {
  id: string;
  identifier: string;
  displayName: string;
  description: string | null;
  productCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardAccessCreateInput {
  identifier: string;
  displayName: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export type DashboardAccessUpdateInput = Partial<DashboardAccessCreateInput>;

export interface DashboardAccessListResponse {
  rows: DashboardAccessRow[];
}

/** A package inside an offering's `packages` JSONB column. */
export interface OfferingPackage {
  /** Standard ($rov_monthly/$rov_annual/...) or custom slug, unique within the offering. */
  identifier: string;
  productId: string;
  order: number;
  isPromoted: boolean;
  metadata?: Record<string, unknown>;
}

export interface DashboardOfferingRow {
  id: string;
  identifier: string;
  isDefault: boolean;
  packages: OfferingPackage[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// =============================================================
// Resolved store prices — offering price resolver (P6 commerce binding)
// =============================================================

export type ResolvedStoreStatus = "ok" | "not_configured" | "no_mapping" | "error";

export interface ResolvedStorePrice {
  status: "ok";
  amountMinor: number;
  currency: string;
  period: string | null;
  trialDays: number | null;
}

export type ResolvedStoreEntry =
  | ResolvedStorePrice
  | { status: Exclude<ResolvedStoreStatus, "ok"> };

export interface ResolvedPackageInfo {
  packageIdentifier: string;
  productId: string;
  displayName: string;
  /** products.metadata.period convention, the offline fallback. */
  metadataPeriod: string | null;
  stores: { apple?: ResolvedStoreEntry; google?: ResolvedStoreEntry; stripe?: ResolvedStoreEntry };
}

export interface OfferingResolvedPrices {
  offeringId: string;
  packages: ResolvedPackageInfo[];
  /**
   * The OLDEST `fetchedAt` among the store price payloads this response
   * drew on (Apple/Google, each independently Redis-cached for
   * `RESOLVED_PRICE_CACHE_TTL_SECONDS`): a fresh live fetch stamps "now",
   * a cache hit reuses the timestamp the cached payload was fetched at.
   * Read it as "no store price in this response is older than this" —
   * NOT "this response was generated at this time". Stripe prices are
   * resolved through their own internal cache and don't contribute (no
   * fetchedAt is exposed for them), so a Stripe-only offering's value
   * falls back to the response-generation time.
   */
  fetchedAt: string;
}

export interface DashboardOfferingsListResponse {
  offerings: DashboardOfferingRow[];
}

export interface DashboardOfferingCreateInput {
  identifier: string;
  isDefault?: boolean;
  packages?: OfferingPackage[];
  metadata?: Record<string, unknown>;
}

export interface DashboardOfferingUpdateInput {
  identifier?: string;
  isDefault?: boolean;
  packages?: OfferingPackage[];
  metadata?: Record<string, unknown>;
}

/** @deprecated use OfferingPackage */
export type OfferingMembership = OfferingPackage;

// =============================================================
// Paywalls — dashboard wire types
// =============================================================
//
// A paywall is a named, versioned remote-config document rendered
// by the SDK against a specific offering (see /v1/placements).
// `identifier` is immutable after creation (mirrors offerings).

/** `{ defaultLocale, locales: { [locale]: object } }` — every locale
 *  value must be a JSON object, and `defaultLocale` must be one of
 *  the `locales` keys (enforced by the API's Zod schema). */
export interface PaywallRemoteConfig {
  defaultLocale: string;
  locales: Record<string, Record<string, unknown>>;
}

export interface DashboardPaywallRow {
  id: string;
  projectId: string;
  identifier: string;
  name: string;
  offeringId: string;
  remoteConfig: PaywallRemoteConfig;
  configFormatVersion: number;
  builderConfig: unknown;
  isActive: boolean;
  status: "draft" | "published" | "archived";
  publishedVersionId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardPaywallsListResponse {
  paywalls: DashboardPaywallRow[];
}

/** One row of a paywall's publish history. `builderConfig`/`remoteConfig`
 * are omitted from the list shape — the version menu only needs metadata;
 * the full snapshot comes from the detail endpoint. */
export interface DashboardPaywallVersionRow {
  id: string;
  versionNo: number;
  label: string | null;
  offeringId: string;
  configFormatVersion: number;
  publishedAt: string;
  publishedBy: string | null;
  /** True when `paywalls.publishedVersionId` points at this row. */
  isLive: boolean;
}

export interface DashboardPaywallVersionsResponse {
  versions: DashboardPaywallVersionRow[];
}

export interface DashboardPaywallVersionDetailResponse {
  version: DashboardPaywallVersionRow & {
    builderConfig: unknown;
    remoteConfig: PaywallRemoteConfig;
  };
}

/** One field-level change between two builder configs. Mirrors
 * `BuilderConfigDiffEntry` from `@rovenue/shared/paywall`. */
export interface DashboardPaywallDiffResponse {
  from: { versionNo: number | null; label: string | null };
  to: { versionNo: number | null; label: string | null };
  entries: Array<{
    kind: "added" | "removed" | "changed";
    scope: "config" | "node" | "localization";
    nodeId: string | null;
    nodeType: string | null;
    field: string;
    from: string | null;
    to: string | null;
  }>;
}

export interface DashboardPaywallCreateInput {
  identifier: string;
  name: string;
  offeringId: string;
  remoteConfig: PaywallRemoteConfig;
  configFormatVersion?: number;
  builderConfig?: unknown;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

export interface DashboardPaywallUpdateInput {
  name?: string;
  offeringId?: string;
  remoteConfig?: PaywallRemoteConfig;
  configFormatVersion?: number;
  builderConfig?: unknown;
  isActive?: boolean;
  metadata?: Record<string, unknown>;
}

// =============================================================
// Placements — dashboard wire types
// =============================================================
//
// A placement is an ordered list of audience-targeted rows the SDK
// evaluates to resolve which paywall (or experiment, or nothing) a
// subscriber sees (see `./placements/schema` for `rows`' shape).
// `identifier` is immutable after creation (mirrors paywalls);
// `revision` is bumped server-side every time `rows` changes.

export interface DashboardPlacementRow {
  id: string;
  projectId: string;
  identifier: string;
  name: string;
  revision: number;
  rows: PlacementRows;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardPlacementsListResponse {
  placements: DashboardPlacementRow[];
}

export interface DashboardPlacementCreateInput {
  identifier: string;
  name: string;
  rows?: PlacementRows;
  isActive?: boolean;
}

export interface DashboardPlacementUpdateInput {
  name?: string;
  rows?: PlacementRows;
  isActive?: boolean;
}

/**
 * `GET /dashboard/projects/:projectId/placements/:id/metrics` —
 * replay-safe view count (uniqExact over `raw_paywall_events`), the
 * unique-viewer HLL from the daily rollup (`mv_paywall_daily_target`),
 * plus a query-time
 * purchase join (subscriber's first placement view -> their next
 * purchase-class revenue event), mirroring the exposure->conversion
 * join `analytics-router.ts` already runs for experiment results.
 * Zeroed out (not omitted) when ClickHouse is unconfigured so the
 * dashboard card always has a shape to render.
 */
export interface DashboardPlacementMetricsResponse {
  views: number;
  uniqueViews: number;
  purchases: number;
  /** `purchases / uniqueViews`, or `null` when `uniqueViews` is 0. */
  conversionRate: number | null;
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
  /** Human-readable reason for the error state (integrations overlay). */
  errorReason?: string;
  /** Redacted credential hint surfaced alongside the error (integrations overlay). */
  credentialsHint?: string;
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
// channel — regardless of aggregate type — so this union must cover
// every aggregate the dispatcher emits, not just the analytics ones.
// The SSE endpoint replays them as JSON.

export type LiveEventAggregateType =
  | "EXPOSURE"
  | "REVENUE_EVENT"
  | "CREDIT_LEDGER"
  | "BILLING"
  | "NOTIFICATION"
  | "FUNNEL";

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

export interface AuditLogEntryUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

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
  user: AuditLogEntryUser;
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
  /** Better Auth twoFactor plugin — true after the user verified
   *  their first TOTP code; false on disable. */
  twoFactorEnabled: boolean;
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
  /**
   * Profile-page fields that don't live on Better Auth's `user`
   * row: displayName, phone, role, company, bio, avatarColor.
   * Shape is owned by the dashboard; the backend is opaque.
   */
  profile: Record<string, unknown>;
  updatedAt: string;
}

export interface MyPreferencesResponse {
  preferences: MyPreferences;
}

export interface UpdatePreferencesRequest {
  notifications?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
  profile?: Record<string, unknown>;
}

// =============================================================
// Subscriptions — header actions (grant / schedule / export)
// =============================================================

export const grantDurationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("preset"),
    preset: z.enum(["1d", "1w", "1mo", "3mo", "6mo", "1yr", "lifetime"]),
  }),
  z.object({ kind: z.literal("custom"), expiresAt: z.string().datetime() }),
]);

export const grantSubscriptionRequestSchema = z.object({
  subscriberId: z.string().min(1),
  productId: z.string().min(1),
  duration: grantDurationSchema,
  note: z.string().trim().max(200).optional(),
});
export type GrantSubscriptionRequest = z.infer<
  typeof grantSubscriptionRequestSchema
>;

export const scheduleActionRequestSchema = z.object({
  action: z.literal("CANCEL"),
  dueAt: z.string().datetime(),
  revokeImmediately: z.boolean().optional().default(false),
});
export type ScheduleActionRequest = z.infer<
  typeof scheduleActionRequestSchema
>;

export type ScheduledActionStatus =
  | "PENDING"
  | "EXECUTED"
  | "CANCELED"
  | "FAILED";

export type ScheduledActionRow = {
  id: string;
  purchaseId: string;
  subscriberId: string;
  action: "CANCEL";
  status: ScheduledActionStatus;
  dueAt: string;
  payload: { revokeImmediately?: boolean };
  createdAt: string;
  executedAt: string | null;
  error: string | null;
  // joined for display
  productName: string | null;
  store: string;
};

export type ListScheduledActionsResponse = {
  rows: ScheduledActionRow[];
};

// =============================================================
// Virtual Currencies
// =============================================================

export interface VirtualCurrency {
  id: string;
  projectId: string;
  code: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
}

export type VirtualCurrencyBalances = Record<string, number>;

const currencyCode = z
  .string()
  .trim()
  .min(2)
  .max(8)
  .regex(/^[A-Z][A-Z0-9]*$/, "code must be uppercase alphanumeric");

export const createVirtualCurrencyRequestSchema = z.object({
  code: currencyCode,
  name: z.string().trim().min(1).max(60),
});
export type CreateVirtualCurrencyRequest = z.infer<
  typeof createVirtualCurrencyRequestSchema
>;

export const updateVirtualCurrencyRequestSchema = z.object({
  name: z.string().trim().min(1).max(60),
});
export type UpdateVirtualCurrencyRequest = z.infer<
  typeof updateVirtualCurrencyRequestSchema
>;

export const spendVirtualCurrencyRequestSchema = z.object({
  amount: z.number().int().positive(),
  // Required: the caller's idempotency key for this spend. A retried
  // request with the same referenceId is a no-op (returns the original
  // SPEND row) instead of double-debiting the wallet.
  referenceId: z.string().trim().min(1).max(120),
  referenceType: z.string().trim().max(60).optional(),
  description: z.string().trim().max(200).optional(),
});
export type SpendVirtualCurrencyRequest = z.infer<
  typeof spendVirtualCurrencyRequestSchema
>;
