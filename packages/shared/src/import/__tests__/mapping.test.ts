import { describe, expect, it } from "vitest";
import { validateMapping } from "../mapping";
import { REQUIRED_FIELDS_BY_KIND } from "../canonical";

describe("validateMapping", () => {
  it("blocks a mapping that is missing a required field", () => {
    const res = validateMapping({ some_col: "subscriberExternalId" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missingRequired).toContain("productIdentifier");
    }
  });

  it("never maps two source columns onto the same canonical field", () => {
    const res = validateMapping({ a: "productIdentifier", b: "productIdentifier" });
    expect(res.ok).toBe(false);
  });

  it("accepts a mapping that covers every required field with no duplicates", () => {
    const res = validateMapping({
      subscriber_id: "subscriberExternalId",
      store_col: "store",
      product_col: "productIdentifier",
      date_col: "purchaseDate",
    });
    expect(res.ok).toBe(true);
  });
});

describe("validateMapping — per job kind", () => {
  const googleTokenMapping = {
    user_id: "subscriberExternalId",
    google_purchase_token: "googlePurchaseToken",
    google_product_id: "productIdentifier",
  } as const;

  it("rejects the 3-column google-token mapping as a HISTORY import", () => {
    const r = validateMapping({ ...googleTokenMapping }, "HISTORY");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingRequired).toEqual(["store", "purchaseDate"]);
  });

  it("accepts the same mapping as a GOOGLE_TOKEN_ENRICHMENT import", () => {
    const r = validateMapping({ ...googleTokenMapping }, "GOOGLE_TOKEN_ENRICHMENT");
    expect(r.ok).toBe(true);
  });

  it("defaults to HISTORY when no kind is supplied", () => {
    expect(validateMapping({ ...googleTokenMapping }).ok).toBe(false);
  });

  it("requires the token for an enrichment import", () => {
    const r = validateMapping(
      { user_id: "subscriberExternalId", google_product_id: "productIdentifier" },
      "GOOGLE_TOKEN_ENRICHMENT",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingRequired).toEqual(["googlePurchaseToken"]);
  });

  it("declares a required-field set for every kind", () => {
    // Guards the failure mode where a new kind silently inherits the
    // wrong set: Record<ImportJobKind, ...> makes omission a compile
    // error, and this asserts none is empty.
    for (const [kind, fields] of Object.entries(REQUIRED_FIELDS_BY_KIND)) {
      expect(fields.length, `${kind} has no required fields`).toBeGreaterThan(0);
    }
  });
});
