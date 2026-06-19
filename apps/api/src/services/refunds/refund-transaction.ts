import { google } from "googleapis";
import type { Purchase } from "@rovenue/db";
import { getStripeClient } from "../stripe/stripe-webhook";
import {
  loadStripeCredentials,
  loadGoogleCredentials,
} from "../../lib/project-credentials";
import { getGoogleAccessToken } from "../google/google-auth";

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

  try {
    if (purchase.store === "STRIPE") {
      const creds = await loadStripeCredentials(projectId);
      if (!creds) {
        return {
          ok: false,
          code: "store_error",
          message: "Stripe credentials not configured for this project.",
        };
      }
      const client = getStripeClient(creds.secretKey);
      const params = ref.startsWith("pi_")
        ? { payment_intent: ref }
        : { charge: ref };
      const refund = await client.refunds.create(params, {
        idempotencyKey: `refund_${purchase.id}`,
      });
      return { ok: true, store: "stripe", reference: refund.id };
    }

    if (purchase.store === "PLAY_STORE") {
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
      return { ok: true, store: "play", reference: ref };
    }

    return {
      ok: false,
      code: "store_error",
      message: `Refund unsupported for store "${purchase.store}".`,
    };
  } catch (err) {
    return {
      ok: false,
      code: "store_error",
      message:
        err instanceof Error ? err.message : "Store refund failed.",
    };
  }
}
