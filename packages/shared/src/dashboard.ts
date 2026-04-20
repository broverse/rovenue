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
