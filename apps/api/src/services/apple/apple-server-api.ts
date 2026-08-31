import { getAppleAuthToken, type ProjectAppleContext } from "./apple-auth";
import type { ConsumptionRequest } from "./refund-shield-buckets";

const PROD_BASE = "https://api.storekit.itunes.apple.com";
const SANDBOX_BASE = "https://api.storekit-sandbox.itunes.apple.com";

/** HTTP status Apple returns for a 429/"you're calling this too fast"
 *  response. Used by Task 9's Phase B re-validation client to tell
 *  "the store doesn't know this anchor" apart from "ask again later" —
 *  the two are never interchangeable (see services/import/verify.ts). */
export const APPLE_TOO_MANY_REQUESTS_STATUS = 429;
export const APPLE_TRANSACTION_NOT_FOUND_STATUS = 404;

export class AppleServerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyPreview: string,
  ) {
    super(`Apple Server API ${status}: ${bodyPreview.slice(0, 200)}`);
    this.name = "AppleServerApiError";
  }
}

/**
 * POST consumption info for a refunded transaction to Apple's App Store Server
 * API. Apple responds with 202 Accepted on success; any other status is
 * surfaced as an {@link AppleServerApiError} so callers can decide whether to
 * retry, alert, or drop the signal.
 *
 * Endpoint: `PUT /inApps/v1/transactions/consumption/{transactionId}`
 * Docs: https://developer.apple.com/documentation/appstoreserverapi/send_consumption_information
 */
export async function sendConsumptionInfo(
  ctx: ProjectAppleContext,
  transactionId: string,
  payload: ConsumptionRequest,
): Promise<{ status: 202 }> {
  const token = await getAppleAuthToken(ctx);
  const base = ctx.environment === "PRODUCTION" ? PROD_BASE : SANDBOX_BASE;
  const res = await fetch(
    `${base}/inApps/v1/transactions/consumption/${transactionId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    },
  );
  if (res.status !== 202) {
    const body = await res.text().catch(() => "");
    throw new AppleServerApiError(res.status, body);
  }
  return { status: 202 };
}

// =============================================================
// Get All Subscription Statuses (Task 9 — Phase B re-validation)
// =============================================================
//
// Docs: https://developer.apple.com/documentation/appstoreserverapi/get_all_subscription_statuses
//
// Apple's numeric `status` on each `lastTransactions` entry — the public
// `Status` enum from the same docs page. Distinct from
// `purchases.status` (this repo's own enum); mapped onto it by the
// caller (services/import/verify-store-clients.ts). This unsigned status
// code IS what drives that mapping — Apple does not sign it. The
// accompanying `signedTransactionInfo` is separately verified through the
// SAME verifier chain `services/receipt-verify.ts` uses for a live
// receipt, but only to source `expiresDate` (and, via
// `signedRenewalInfo`, `autoRenewStatus`) — it does not corroborate or
// replace the status code above.
export const APPLE_SUBSCRIPTION_STATUS = {
  ACTIVE: 1,
  EXPIRED: 2,
  BILLING_RETRY: 3,
  BILLING_GRACE_PERIOD: 4,
  REVOKED: 5,
} as const;

export interface AppleSubscriptionStatusTransaction {
  originalTransactionId: string;
  status: number;
  signedTransactionInfo: string;
  signedRenewalInfo?: string;
}

export interface AppleSubscriptionStatusGroup {
  subscriptionGroupIdentifier: string;
  lastTransactions: AppleSubscriptionStatusTransaction[];
}

export interface AppleSubscriptionStatusesResponse {
  data: AppleSubscriptionStatusGroup[];
  environment: "Sandbox" | "Production";
  bundleId: string;
}

/**
 * Fetches the live status of every transaction in an originalTransactionId's
 * subscription group. Apple responds 404 when the id is unknown to this
 * app (`APPLE_TRANSACTION_NOT_FOUND_STATUS`) and 429 when the caller is
 * rate-limited (`APPLE_TOO_MANY_REQUESTS_STATUS`) — callers distinguish
 * those via `AppleServerApiError.status` rather than a thrown message.
 *
 * Endpoint: `GET /inApps/v1/subscriptions/{originalTransactionId}`
 */
export async function getAppleSubscriptionStatuses(
  ctx: ProjectAppleContext,
  originalTransactionId: string,
): Promise<AppleSubscriptionStatusesResponse> {
  const token = await getAppleAuthToken(ctx);
  const base = ctx.environment === "PRODUCTION" ? PROD_BASE : SANDBOX_BASE;
  const res = await fetch(
    `${base}/inApps/v1/subscriptions/${encodeURIComponent(originalTransactionId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    },
  );
  if (res.status !== 200) {
    const body = await res.text().catch(() => "");
    throw new AppleServerApiError(res.status, body);
  }
  return (await res.json()) as AppleSubscriptionStatusesResponse;
}
