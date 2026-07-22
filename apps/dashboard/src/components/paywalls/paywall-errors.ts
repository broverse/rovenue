import type { ApiError } from "../../lib/api";

// The API returns 409 with `error.message` holding a JSON-encoded
// `{ code: "PAYWALL_IN_USE", message }` payload (see
// apps/api/src/routes/dashboard/paywalls.ts `deletePaywall` handler —
// the envelope's top-level `code` is the generic `HTTP_ERROR` since
// 409 isn't one of the statuses `mapHttpStatus` special-cases).
export function isPaywallInUse(err: ApiError): boolean {
  if (err.status !== 409) return false;
  try {
    const parsed: unknown = JSON.parse(err.message);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { code?: unknown }).code === "PAYWALL_IN_USE"
    );
  } catch {
    return false;
  }
}
