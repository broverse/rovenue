import { describe, it, expect } from "vitest";
import { csvEscape, formatHeader, formatRow } from "./export-csv";
import type { SubscriptionRow } from "@rovenue/shared";

describe("csvEscape", () => {
  it("returns the value unchanged when no special chars", () => {
    expect(csvEscape("hello")).toBe("hello");
  });

  it("wraps values containing a comma in quotes", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });

  it("wraps and doubles quotes when value contains a quote", () => {
    expect(csvEscape('a"b')).toBe('"a""b"');
  });

  it("wraps values containing newlines", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("returns empty string for null", () => {
    expect(csvEscape(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(csvEscape(undefined)).toBe("");
  });

  it("converts number to string", () => {
    expect(csvEscape(0)).toBe("0");
    expect(csvEscape(42)).toBe("42");
  });

  it("converts boolean to string", () => {
    expect(csvEscape(true)).toBe("true");
    expect(csvEscape(false)).toBe("false");
  });
});

describe("formatHeader", () => {
  it("ends with a single trailing newline", () => {
    const out = formatHeader();
    expect(out.endsWith("\n")).toBe(true);
    const parts = out.split("\n");
    expect(parts).toHaveLength(2);
    expect(parts[1]).toBe("");
  });

  it("starts with the canonical column list", () => {
    const header = formatHeader();
    expect(header.startsWith("id,subscriber_id,product,")).toBe(true);
  });

  it("contains all 12 columns in the correct order", () => {
    const header = formatHeader();
    const columns = header.split("\n")[0].split(",");
    expect(columns).toEqual([
      "id",
      "subscriber_id",
      "product",
      "status",
      "store",
      "price_amount",
      "price_currency",
      "purchase_date",
      "expires_date",
      "auto_renew",
      "is_trial",
      "cancellation_date",
    ]);
  });
});

describe("formatRow", () => {
  it("renders cells in column order, terminated by newline", () => {
    const row = makeRow({});
    const out = formatRow(row);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.startsWith(`${row.id},${row.subscriberId},`)).toBe(true);
  });

  it("uses productName when provided, falls back to productIdentifier then productId", () => {
    const withName = formatRow(makeRow({ productName: "Pro Monthly" }));
    expect(withName.split(",")[2]).toBe("Pro Monthly");

    const withId = formatRow(makeRow({ productName: null, productIdentifier: "pro_monthly_id" }));
    expect(withId.split(",")[2]).toBe("pro_monthly_id");

    const withProdId = formatRow(makeRow({ productName: null, productIdentifier: null, productId: "prod_xyz" }));
    expect(withProdId.split(",")[2]).toBe("prod_xyz");
  });

  it("escapes cells containing commas", () => {
    const out = formatRow(makeRow({ productName: "Pro, Monthly" }));
    expect(out.includes('"Pro, Monthly"')).toBe(true);
  });

  it("escapes cells containing quotes", () => {
    const out = formatRow(makeRow({ productName: 'Special "Pro"' }));
    expect(out.includes('"Special ""Pro"""')).toBe(true);
  });

  it("renders null nullable fields as empty cells between commas", () => {
    const out = formatRow(makeRow({ expiresDate: null, cancellationDate: null }));
    // The output should have empty cells for null values
    // expires_date is column 9, cancellation_date is column 12
    const cells = out.trimEnd().split(",");
    expect(cells[8]).toBe(""); // expires_date (0-indexed)
    expect(cells[11]).toBe(""); // cancellation_date (0-indexed)
  });

  it("renders autoRenew and isTrial as boolean strings", () => {
    const out = formatRow(makeRow({ autoRenew: true, isTrial: false }));
    const cells = out.trimEnd().split(",");
    expect(cells[9]).toBe("true"); // auto_renew
    expect(cells[10]).toBe("false"); // is_trial
  });

  it("renders decimal priceAmount as-is", () => {
    const out = formatRow(makeRow({ priceAmount: "9.99" }));
    const cells = out.trimEnd().split(",");
    expect(cells[5]).toBe("9.99"); // price_amount
  });

  it("renders store enum values", () => {
    const out = formatRow(makeRow({ store: "APP_STORE" }));
    const cells = out.trimEnd().split(",");
    expect(cells[4]).toBe("APP_STORE"); // store
  });

  it("renders subscription status", () => {
    const out = formatRow(makeRow({ status: "active" }));
    const cells = out.trimEnd().split(",");
    expect(cells[3]).toBe("active"); // status
  });
});

function makeRow(overrides: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    id: "p_1",
    subscriberId: "s_1",
    productId: "prod_1",
    productName: "Pro Monthly",
    productIdentifier: "pro_monthly",
    store: "APP_STORE",
    status: "active",
    priceAmount: "9.99",
    priceCurrency: "USD",
    isTrial: false,
    isIntroOffer: false,
    autoRenew: true,
    purchaseDate: "2026-01-01T00:00:00.000Z",
    expiresDate: "2026-02-01T00:00:00.000Z",
    gracePeriodExpires: null,
    cancellationDate: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    hasIssue: false,
    ...overrides,
  } as SubscriptionRow;
}
