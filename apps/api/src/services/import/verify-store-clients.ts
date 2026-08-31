// Production store clients for Task 9's Phase B re-validation
// (services/import/verify.ts). Wired into the real worker
// (workers/import-runner.ts); `verify.ts`'s own tests never import this
// file — they inject fakes directly, per the task-9 brief ("a real one
// would be a self-confirming test of nothing").
//
// Every call here reuses this repo's EXISTING store integrations rather
// than a second implementation of them:
//   - Apple: the same credential loader, circuit breaker, and JWS
//     verifier chain services/receipt-verify.ts uses for a live receipt
//     — only the TRANSPORT (Get All Subscription Statuses, keyed by
//     originalTransactionId instead of a client-submitted receipt) is
//     new, mirroring apple-server-api.ts's existing sendConsumptionInfo.
//   - Google: `verifyGoogleSubscription` + `mapSubscriptionStateToStatus`
//     (services/google/*) — the exact functions the live Google webhook
//     path already calls.
//   - Stripe: `requireConnectedStripe` (the same project-scoped,
//     Connect-aware client every other Stripe call in this repo uses) +
//     `mapStripeSubscriptionStatus` (services/stripe/stripe-webhook.ts).
import { logger } from "../../lib/logger";
import { appleCircuit, googleCircuit, stripeCircuit } from "../../lib/circuit-breaker";
import {
  loadAppleCredentials,
  loadGoogleCredentials,
} from "../../lib/project-credentials";
import { requireConnectedStripe } from "../../lib/stripe-platform";
import {
  APPLE_ENVIRONMENT,
  type AppleJwsRenewalInfoPayload,
} from "../apple/apple-types";
import { createAppleVerifier } from "../apple/apple-verify";
import {
  AppleServerApiError,
  APPLE_SUBSCRIPTION_STATUS,
  APPLE_TOO_MANY_REQUESTS_STATUS,
  APPLE_TRANSACTION_NOT_FOUND_STATUS,
  getAppleSubscriptionStatuses,
} from "../apple/apple-server-api";
import type { GoogleServiceAccountCredentials, GoogleVerifyConfig } from "../google";
import { verifyGoogleSubscription } from "../google/google-verify";
import { mapSubscriptionStateToStatus } from "../google/google-mappers";
import type { GoogleSubscriptionState } from "../google/google-types";
import { mapStripeSubscriptionStatus } from "../stripe/stripe-webhook";
import { PurchaseStatus } from "@rovenue/db";
import type {
  ImportVerifyDeps,
  StoreAnchorVerificationResult,
  VerifyAppleAnchorInput,
  VerifyGoogleAnchorInput,
  VerifyStripeAnchorInput,
} from "./verify";

const log = logger.child("import-verify-store-clients");

// =============================================================
// Apple
// =============================================================

function mapAppleSubscriptionStatus(status: number): PurchaseStatus {
  switch (status) {
    case APPLE_SUBSCRIPTION_STATUS.ACTIVE:
      return PurchaseStatus.ACTIVE;
    case APPLE_SUBSCRIPTION_STATUS.BILLING_RETRY:
    case APPLE_SUBSCRIPTION_STATUS.BILLING_GRACE_PERIOD:
      return PurchaseStatus.GRACE_PERIOD;
    case APPLE_SUBSCRIPTION_STATUS.EXPIRED:
      return PurchaseStatus.EXPIRED;
    case APPLE_SUBSCRIPTION_STATUS.REVOKED:
      // Apple's own enum does not distinguish a money-back refund from a
      // family-sharing-loss revocation the way this app's REFUNDED vs
      // REVOKED split does (that distinction, in the live webhook path,
      // comes from the NOTIFICATION TYPE — REFUND vs REVOKE — which this
      // status-only endpoint does not carry). REVOKED is the honest,
      // undistorted read of Apple's own label; both are terminal/absorbing
      // in the state machine, so access-granting behaviour is identical
      // either way — only the reported reason could differ.
      return PurchaseStatus.REVOKED;
    default:
      log.warn("unrecognized Apple subscription status; defaulting to EXPIRED", {
        status,
      });
      return PurchaseStatus.EXPIRED;
  }
}

async function verifyAppleAnchor(
  input: VerifyAppleAnchorInput,
): Promise<StoreAnchorVerificationResult> {
  const creds = await loadAppleCredentials(input.projectId);
  if (!creds?.keyId || !creds.issuerId || !creds.privateKey) {
    throw new Error(
      `verifyAppleAnchor: project ${input.projectId} has no App Store Server API credentials configured (keyId/issuerId/privateKey)`,
    );
  }

  const ctx = {
    keyId: creds.keyId,
    issuerId: creds.issuerId,
    bundleId: creds.bundleId,
    privateKey: creds.privateKey,
    environment: input.isSandbox ? ("SANDBOX" as const) : ("PRODUCTION" as const),
  };

  try {
    const response = await appleCircuit.exec(() =>
      getAppleSubscriptionStatuses(ctx, input.originalTransactionId),
    );

    const txn = response.data
      .flatMap((group) => group.lastTransactions)
      .find((t) => t.originalTransactionId === input.originalTransactionId);
    if (!txn) return { kind: "notFound" };

    const verifier = createAppleVerifier({
      projectId: input.projectId,
      bundleId: creds.bundleId,
      appAppleId: creds.appAppleId,
      environment: input.isSandbox
        ? APPLE_ENVIRONMENT.SANDBOX
        : APPLE_ENVIRONMENT.PRODUCTION,
    });
    const decoded = await verifier.verifyTransaction(txn.signedTransactionInfo);

    let autoRenewStatus: boolean | null = null;
    if (txn.signedRenewalInfo) {
      try {
        const renewal: AppleJwsRenewalInfoPayload = await verifier.verifyRenewalInfo(
          txn.signedRenewalInfo,
        );
        autoRenewStatus = renewal.autoRenewStatus === 1;
      } catch (err) {
        // Renewal info is supplementary (autoRenewStatus only) — a failure
        // decoding it must not sink the whole verification.
        log.warn("apple renewal info decode failed; autoRenewStatus left null", {
          projectId: input.projectId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      kind: "verified",
      status: mapAppleSubscriptionStatus(txn.status),
      expiresDate:
        decoded.expiresDate !== undefined ? new Date(decoded.expiresDate) : null,
      autoRenewStatus,
    };
  } catch (err) {
    if (err instanceof AppleServerApiError) {
      if (err.status === APPLE_TRANSACTION_NOT_FOUND_STATUS) return { kind: "notFound" };
      if (err.status === APPLE_TOO_MANY_REQUESTS_STATUS) return { kind: "throttled" };
    }
    if (appleCircuit.state === "OPEN") return { kind: "throttled" };
    throw err;
  }
}

// =============================================================
// Google
// =============================================================

async function loadGoogleVerifyConfig(projectId: string): Promise<GoogleVerifyConfig> {
  const creds = await loadGoogleCredentials(projectId);
  if (!creds) {
    throw new Error(
      `verifyGoogleAnchor: project ${projectId} has no Google Play credentials configured`,
    );
  }
  return {
    packageName: creds.packageName,
    credentials: creds.serviceAccount as GoogleServiceAccountCredentials,
  };
}

const GOOGLE_TOO_MANY_REQUESTS_STATUS = 429;
const GOOGLE_QUOTA_FORBIDDEN_STATUS = 403;
const GOOGLE_NOT_FOUND_STATUS = 404;

async function verifyGoogleAnchor(
  input: VerifyGoogleAnchorInput,
): Promise<StoreAnchorVerificationResult> {
  const config = await loadGoogleVerifyConfig(input.projectId);
  try {
    const subscription = await googleCircuit.exec(() =>
      verifyGoogleSubscription(config, input.purchaseToken),
    );
    const state = subscription.subscriptionState as GoogleSubscriptionState;
    return {
      kind: "verified",
      status: mapSubscriptionStateToStatus(state),
      expiresDate: subscription.lineItems?.[0]?.expiryTime
        ? new Date(subscription.lineItems[0].expiryTime)
        : null,
      autoRenewStatus:
        subscription.lineItems?.[0]?.autoRenewingPlan?.autoRenewEnabled ?? null,
    };
  } catch (err) {
    const status = (err as { code?: number; response?: { status?: number } })
      ?.response?.status ?? (err as { code?: number })?.code;
    if (status === GOOGLE_NOT_FOUND_STATUS) return { kind: "notFound" };
    if (status === GOOGLE_TOO_MANY_REQUESTS_STATUS || status === GOOGLE_QUOTA_FORBIDDEN_STATUS) {
      return { kind: "throttled" };
    }
    if (googleCircuit.state === "OPEN") return { kind: "throttled" };
    throw err;
  }
}

// =============================================================
// Stripe
// =============================================================

async function verifyStripeAnchor(
  input: VerifyStripeAnchorInput,
): Promise<StoreAnchorVerificationResult> {
  const connected = await requireConnectedStripe(input.projectId);
  try {
    const subscription = await stripeCircuit.exec(() =>
      connected.account.subscriptions.retrieve(input.subscriptionId),
    );
    return {
      kind: "verified",
      status: mapStripeSubscriptionStatus(subscription.status),
      expiresDate: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null,
      autoRenewStatus: !subscription.cancel_at_period_end,
    };
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status === 404) return { kind: "notFound" };
    if (status === 429) return { kind: "throttled" };
    if (stripeCircuit.state === "OPEN") return { kind: "throttled" };
    throw err;
  }
}

// =============================================================
// Public factory
// =============================================================

export function createProductionImportVerifyDeps(): ImportVerifyDeps {
  return { verifyAppleAnchor, verifyGoogleAnchor, verifyStripeAnchor };
}
