import type { ApiError } from "../../lib/api";

// The placements dashboard route (apps/api/src/routes/dashboard/placements.ts)
// wraps some 400s in a JSON-encoded `{ code, message }` payload — e.g.
// INVALID_ROW_REF when a row's audienceId/paywallId/experimentId doesn't
// belong to the project — while others (identifier-immutable, missing
// body) are a plain string. Mirrors paywall-errors.ts's JSON-unwrap, but
// generalized: we only care about surfacing a readable message here, not
// discriminating on a specific code.
export function extractPlacementApiErrorMessage(err: ApiError): string {
  try {
    const parsed: unknown = JSON.parse(err.message);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { message?: unknown }).message === "string"
    ) {
      return (parsed as { message: string }).message;
    }
  } catch {
    // Not JSON — err.message is already the human-readable string.
  }
  return err.message;
}
