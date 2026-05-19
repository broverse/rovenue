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
  slug: string;
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
  slug: string;
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

export interface CreateProjectRequest {
  name: string;
  slug: string;
  environment?: ApiKeyEnvironment; // default PRODUCTION
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
