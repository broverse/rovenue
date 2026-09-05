// Row gate for GOOGLE_TOKEN_ENRICHMENT imports.
//
// Deliberately NOT a branch inside normalizeRow: that function is the
// history gate, its store/purchaseDate requirements are correct there,
// and it is shared by plan.ts, write.ts and verify.ts. An enrichment row
// legitimately has neither field, and synthesizing placeholder values to
// squeeze it through the history gate would put fabricated data one
// refactor away from the purchase writer.
import { GOOGLE_TOKEN_ENRICHMENT_REQUIRED_FIELDS } from "./canonical";

export type EnrichmentRow = {
  subscriberExternalId: string;
  productIdentifier: string;
  googlePurchaseToken: string;
};

export type EnrichmentRowError = { code: "MISSING_REQUIRED_FIELD"; field: string };

export function normalizeEnrichmentRow(
  raw: Record<string, string | undefined>,
): { ok: true; row: EnrichmentRow } | { ok: false; error: EnrichmentRowError } {
  const out: Record<string, string> = {};
  for (const field of GOOGLE_TOKEN_ENRICHMENT_REQUIRED_FIELDS) {
    const value = raw[field]?.trim();
    if (!value) {
      return { ok: false, error: { code: "MISSING_REQUIRED_FIELD", field } };
    }
    out[field] = value;
  }
  return { ok: true, row: out as EnrichmentRow };
}
