import { google } from "googleapis";
import { PurchaseStatus, Store, drizzle, type Purchase } from "@rovenue/db";
import { getConnectedStripe } from "../../lib/stripe-platform";
import { loadGoogleCredentials } from "../../lib/project-credentials";
import { getGoogleAccessToken } from "../google/google-auth";
import { guardStatusWrite } from "../subscription-transition-guard";
import { logger } from "../../lib/logger";

const log = logger.child("refund-transaction");

export type RefundResult =
  | { ok: true; store: "stripe" | "play"; reference: string }
  | {
      ok: false;
      code:
        | "apple_unsupported"
        | "already_refunded"
        | "missing_store_ref"
        | "store_error";
      message: string;
    };

const TERMINAL = new Set(["REFUNDED", "REVOKED"]);

/**
 * Best-effort optimistic access revocation after a successful merchant refund.
 *
 * The store webhook (charge.refunded / Play RTDN) remains the source of truth
 * for the REFUND revenue event, but waiting solely for it means a subscriber
 * keeps entitlement until the webhook lands — and it may be delayed,
 * misconfigured, or missed entirely, leaving the customer refunded-but-still-
 * entitled. So we optimistically flip the purchase to REFUNDED and revoke the
 * denormalized access here, using the SAME idempotent `guardStatusWrite` the
 * webhook uses. If the webhook arrives later it reconciles without conflict;
 * if this revocation fails we swallow the error (the store refund already
 * succeeded and the webhook will still reconcile).
 */
async function revokeAccessAfterRefund(input: {
  projectId: string;
  purchase: Pick<Purchase, "id" | "store" | "storeTransactionId">;
}): Promise<void> {
  const { projectId, purchase } = input;
  if (!purchase.storeTransactionId) return;
  try {
    const guard = await guardStatusWrite({
      db: drizzle.db,
      projectId,
      store: purchase.store as Store,
      storeTransactionId: purchase.storeTransactionId,
      to: PurchaseStatus.REFUNDED,
      source: "operator-refund",
    });
    if (guard.apply) {
      await drizzle.purchaseRepo.updatePurchase(drizzle.db, purchase.id, {
        status: PurchaseStatus.REFUNDED,
        refundDate: new Date(),
      });
      await drizzle.accessRepo.revokeAccessByPurchaseId(
        drizzle.db,
        purchase.id,
      );
    }
  } catch (err) {
    log.warn("optimistic access revocation after refund failed", {
      projectId,
      purchaseId: purchase.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Issues a merchant-initiated refund against the originating store, then
 * optimistically revokes the subscriber's local access (see
 * {@link revokeAccessAfterRefund}). The incoming store webhook
 * (charge.refunded / Play RTDN) remains the source of truth for the REFUND
 * revenue event and reconciles idempotently.
 *
 * Double-submit safety (two refund calls before the webhook lands and flips
 * status): the `TERMINAL` precheck below catches the common case, and each store
 * is independently dedupe-safe at the API level —
 *   - Stripe: the `refund_<purchaseId>` idempotency key makes a duplicate
 *     `refunds.create` return the SAME refund object, never a second charge-back.
 *   - Google Play: `orders.refund({ revoke: true })` is idempotent on Google's
 *     side; a second call against an already-revoked order is rejected and
 *     surfaces here as `store_error` (502) rather than refunding twice.
 * Neither store can double-refund; the asymmetry is only in the error surface.
 */
export async function refundTransaction(input: {
  projectId: string;
  purchase: Pick<Purchase, "id" | "store" | "storeTransactionId" | "status">;
}): Promise<RefundResult> {
  const { projectId, purchase } = input;

  if (purchase.store === "APP_STORE") {
    return {
      ok: false,
      code: "apple_unsupported",
      message:
        "Apple processes App Store refunds; no merchant-initiated refund is available.",
    };
  }

  if (TERMINAL.has(String(purchase.status))) {
    return {
      ok: false,
      code: "already_refunded",
      message: "This transaction is already refunded or revoked.",
    };
  }

  const ref = purchase.storeTransactionId;
  if (!ref) {
    return {
      ok: false,
      code: "missing_store_ref",
      message: "No store transaction reference on this purchase.",
    };
  }

  let success: Extract<RefundResult, { ok: true }>;
  try {
    if (purchase.store === "STRIPE") {
      const connected = await getConnectedStripe(projectId);
      if (!connected) {
        return {
          ok: false,
          code: "store_error",
          message: "No Stripe connection for this project.",
        };
      }
      const params = ref.startsWith("pi_")
        ? { payment_intent: ref }
        : { charge: ref };
      const refund = await connected.stripe.refunds.create(params, {
        idempotencyKey: `refund_${purchase.id}`,
        stripeAccount: connected.accountId,
      });
      success = { ok: true, store: "stripe", reference: refund.id };
    } else if (purchase.store === "PLAY_STORE") {
      const creds = await loadGoogleCredentials(projectId);
      if (!creds) {
        return {
          ok: false,
          code: "store_error",
          message: "Google Play credentials not configured for this project.",
        };
      }
      const token = await getGoogleAccessToken(creds.serviceAccount);
      const publisher = google.androidpublisher({
        version: "v3",
        headers: { Authorization: `Bearer ${token}` },
      });
      await publisher.orders.refund({
        packageName: creds.packageName,
        orderId: ref,
        revoke: true,
      });
      success = { ok: true, store: "play", reference: ref };
    } else {
      return {
        ok: false,
        code: "store_error",
        message: `Refund unsupported for store "${purchase.store}".`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      code: "store_error",
      message:
        err instanceof Error ? err.message : "Store refund failed.",
    };
  }

  // Store refund succeeded — revoke local access now rather than waiting
  // solely for the store webhook.
  await revokeAccessAfterRefund({ projectId, purchase });
  return success;
}
