import { describe, it, expect } from "vitest";
import { normalizeEnrichmentRow } from "../normalize-enrichment";

describe("normalizeEnrichmentRow", () => {
  const valid = {
    subscriberExternalId: "user-1",
    productIdentifier: "com.acme.pro_monthly",
    googlePurchaseToken: "tok_abc",
  };

  it("accepts a complete row", () => {
    const r = normalizeEnrichmentRow(valid);
    expect(r).toEqual({ ok: true, row: valid });
  });

  it("trims surrounding whitespace", () => {
    const r = normalizeEnrichmentRow({ ...valid, googlePurchaseToken: "  tok_abc  " });
    expect(r.ok && r.row.googlePurchaseToken).toBe("tok_abc");
  });

  it.each(["subscriberExternalId", "productIdentifier", "googlePurchaseToken"])(
    "rejects a row missing %s",
    (field) => {
      const r = normalizeEnrichmentRow({ ...valid, [field]: undefined });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toEqual({ code: "MISSING_REQUIRED_FIELD", field });
    },
  );

  it("rejects a whitespace-only value as missing", () => {
    const r = normalizeEnrichmentRow({ ...valid, googlePurchaseToken: "   " });
    expect(r.ok).toBe(false);
  });

  it("never invents store or purchaseDate", () => {
    const r = normalizeEnrichmentRow(valid);
    expect(Object.keys(r.ok ? r.row : {})).toEqual([
      "subscriberExternalId",
      "productIdentifier",
      "googlePurchaseToken",
    ]);
  });
});
