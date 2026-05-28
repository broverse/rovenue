import { getAppleAuthToken, type ProjectAppleContext } from "./apple-auth";
import type { ConsumptionRequest } from "./refund-shield-buckets";

const PROD_BASE = "https://api.storekit.itunes.apple.com";
const SANDBOX_BASE = "https://api.storekit-sandbox.itunes.apple.com";

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
