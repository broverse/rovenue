import { describe, expect, it } from "vitest";
import type { CanonicalRow } from "../canonical";
import {
  STORE_VALUE_MAP,
  deriveStatus,
  normalizeMoney,
  normalizeRow,
  parseSourceTimestamp,
  type NormalizedRow,
} from "../normalize";

const NOW = new Date("2026-08-31T00:00:00Z");
const d = (s: string) => new Date(s);

// A minimal, realistic canonical row: a live App Store subscription, one
// row into its chain, not a trial, no refund/cancellation/grace. Every
// test below overrides only the fields it's exercising.
//
// NOTE (ruling 1 of the task-3 controller context): normalizeRow consumes
// CanonicalRow, keyed by the canonical field names from Task 1 — never
// source column names. The mapping layer (Task 2) is the only place
// source column names exist.
const rcRow: CanonicalRow = {
  subscriberExternalId: "user_1",
  store: "app_store",
  storeTransactionId: "txn_base",
  productIdentifier: "pro_monthly",
  purchaseDate: "2026-01-01 00:00:00",
  expiresDate: "2026-12-01 00:00:00",
  isTrial: "false",
};

describe("STORE_VALUE_MAP", () => {
  it("maps every documented source store value", () => {
    expect(STORE_VALUE_MAP.app_store).toBe("APP_STORE");
    expect(STORE_VALUE_MAP.play_store).toBe("PLAY_STORE");
    expect(STORE_VALUE_MAP.stripe).toBe("STRIPE");
    expect(STORE_VALUE_MAP.promotional).toBe("MANUAL");
  });
});

describe("deriveStatus", () => {
  const base = { isTrial: false, refundedAt: null, gracePeriodEndDate: null };

  it("uses effective_end_time in preference to end_time", () => {
    expect(
      deriveStatus(
        { ...base, expiresDate: d("2030-01-01T00:00:00Z"), effectiveEndDate: d("2020-01-01T00:00:00Z") },
        NOW,
      ),
    ).toBe("EXPIRED");
  });

  it("treats a refund as terminal regardless of dates", () => {
    expect(
      deriveStatus(
        {
          ...base,
          refundedAt: d("2026-01-01T00:00:00Z"),
          expiresDate: d("2030-01-01T00:00:00Z"),
          effectiveEndDate: null,
        },
        NOW,
      ),
    ).toBe("REFUNDED");
  });

  it("reports grace period only while the grace window is still open", () => {
    expect(
      deriveStatus(
        {
          ...base,
          expiresDate: d("2026-08-01T00:00:00Z"),
          effectiveEndDate: d("2026-08-01T00:00:00Z"),
          gracePeriodEndDate: d("2026-09-30T00:00:00Z"),
        },
        NOW,
      ),
    ).toBe("GRACE_PERIOD");
    expect(
      deriveStatus(
        {
          ...base,
          expiresDate: d("2026-08-01T00:00:00Z"),
          effectiveEndDate: d("2026-08-01T00:00:00Z"),
          gracePeriodEndDate: d("2026-08-10T00:00:00Z"),
        },
        NOW,
      ),
    ).toBe("EXPIRED");
  });

  it("treats a lifetime purchase (no end date at all) as live", () => {
    expect(deriveStatus({ ...base, expiresDate: null, effectiveEndDate: null }, NOW)).toBe("ACTIVE");
    expect(deriveStatus({ ...base, isTrial: true, expiresDate: null, effectiveEndDate: null }, NOW)).toBe("TRIAL");
  });

  // Fix round 1, FIX 3: the real-world RC billing-grace shape. expiresDate
  // (the actual billing expiry) is in the past; effectiveEndDate is set to
  // the grace window's own end (RC's documented behavior — effective_end_time
  // already accounts for grace), matching gracePeriodEndDate; both are in
  // the future. The earlier `effectiveEndDate ?? expiresDate` grace check
  // would read `end` as future here and wrongly return ACTIVE, making
  // GRACE_PERIOD unreachable for exactly the shape a real export produces.
  // The pre-existing grace tests above always set
  // effectiveEndDate === expiresDate, which is why they didn't catch this.
  it("reports GRACE_PERIOD for the real RC billing-grace shape (expiresDate past, effectiveEndDate/gracePeriodEndDate future)", () => {
    expect(
      deriveStatus(
        {
          ...base,
          expiresDate: d("2026-08-01T00:00:00Z"),
          effectiveEndDate: d("2026-09-30T00:00:00Z"),
          gracePeriodEndDate: d("2026-09-30T00:00:00Z"),
        },
        NOW,
      ),
    ).toBe("GRACE_PERIOD");
  });

  it("reports TRIAL instead of ACTIVE while a trial's end date is still in the future", () => {
    expect(
      deriveStatus(
        { ...base, isTrial: true, expiresDate: d("2030-01-01T00:00:00Z"), effectiveEndDate: null },
        NOW,
      ),
    ).toBe("TRIAL");
  });
});

describe("normalizeMoney", () => {
  it("maps price_in_usd to a USD amount", () => {
    expect(normalizeMoney({ priceUsd: "9.99" })).toEqual({
      priceAmount: "9.99",
      priceCurrency: "USD",
      moneyDropped: false,
    });
  });

  it("stores a refund amount positive", () => {
    expect(normalizeMoney({ priceUsd: "-9.99" })).toEqual({
      priceAmount: "9.99",
      priceCurrency: "USD",
      moneyDropped: false,
    });
  });

  it("emits no money at all rather than guessing a currency, and does not flag it as dropped (nothing was there to drop)", () => {
    expect(normalizeMoney({})).toEqual({ priceAmount: null, priceCurrency: null, moneyDropped: false });
  });

  // Fix round 1, FIX 4a: a value that WAS present but unusable must be
  // distinguishable from a row that simply had no price — otherwise a
  // customer whose export uses thousands separators or a currency symbol
  // imports with silently zeroed revenue and nothing surfaces it.
  it("flags a value that doesn't parse as a decimal as dropped, rather than passing garbage through or treating it as merely absent", () => {
    expect(normalizeMoney({ priceUsd: "not-a-number" })).toEqual({
      priceAmount: null,
      priceCurrency: null,
      moneyDropped: true,
    });
  });

  it("flags a currency-symbol amount as dropped", () => {
    expect(normalizeMoney({ priceUsd: "$9.99" })).toEqual({
      priceAmount: null,
      priceCurrency: null,
      moneyDropped: true,
    });
  });

  it("flags a thousands-separated amount as dropped", () => {
    expect(normalizeMoney({ priceUsd: "1,234.56" })).toEqual({
      priceAmount: null,
      priceCurrency: null,
      moneyDropped: true,
    });
  });
});

describe("parseSourceTimestamp", () => {
  it("parses RevenueCat's space-separated UTC timestamps as UTC", () => {
    expect(parseSourceTimestamp("2023-01-01 08:27:06")).toEqual(new Date("2023-01-01T08:27:06Z"));
  });

  it("rejects an ambiguous timestamp instead of guessing a zone", () => {
    expect(() => parseSourceTimestamp("01/02/2023")).toThrow();
  });
});

describe("normalizeRow", () => {
  it("normalizes a plain live App Store row to ACTIVE", () => {
    const row = normalizeRow(rcRow, { now: NOW }) as NormalizedRow;
    expect("error" in row).toBe(false);
    expect(row.status).toBe("ACTIVE");
    expect(row.store).toBe("APP_STORE");
    expect(row.storeTransactionId).toBe("txn_base");
    expect(row.priceAmount).toBeNull();
    expect(row.priceCurrency).toBeNull();
  });

  // Ruling 1: written against canonical keys (purchaseDate / expiresDate),
  // not the brief's source-column name (start_time_mapped) — that was a
  // defect in the brief per the task-3 controller context.
  it("treats Google's end_time-before-start_time as expired, not malformed", () => {
    const row = normalizeRow(
      { ...rcRow, store: "play_store", purchaseDate: "2026-05-01 00:00:00", expiresDate: "2026-04-01 00:00:00" },
      { now: NOW },
    );
    expect("error" in row).toBe(false);
    expect((row as NormalizedRow).status).toBe("EXPIRED");
  });

  it("keeps a cancelled-but-unexpired subscription ACTIVE and records auto-renew off", () => {
    const row = normalizeRow(
      { ...rcRow, unsubscribeDetectedAt: "2026-08-01 00:00:00", expiresDate: "2026-12-01 00:00:00" },
      { now: NOW },
    ) as NormalizedRow;
    expect(row.status).toBe("ACTIVE");
    expect(row.autoRenewStatus).toBe(false);
    expect(row.cancellationDate).toEqual(d("2026-08-01T00:00:00Z"));
  });

  it("marks FAMILY_SHARED rows as revenue-excluded", () => {
    const row = normalizeRow({ ...rcRow, ownershipType: "FAMILY_SHARED" }, { now: NOW }) as NormalizedRow;
    expect(row.excludeFromRevenue).toBe(true);
  });

  // Fix round 1, FIX 4b: the comparison must be case-insensitive, or a
  // source using different casing silently counts family-shared access
  // as revenue.
  it("marks a lower-cased family_shared ownershipType as revenue-excluded too", () => {
    const row = normalizeRow({ ...rcRow, ownershipType: "family_shared" }, { now: NOW }) as NormalizedRow;
    expect(row.excludeFromRevenue).toBe(true);
  });

  it("does not mark an ordinary row as revenue-excluded", () => {
    const row = normalizeRow(rcRow, { now: NOW }) as NormalizedRow;
    expect(row.excludeFromRevenue).toBe(false);
  });

  it("maps price_in_usd through to the normalized row", () => {
    const row = normalizeRow({ ...rcRow, priceUsd: "9.99" }, { now: NOW }) as NormalizedRow;
    expect(row.priceAmount).toBe("9.99");
    expect(row.priceCurrency).toBe("USD");
    expect(row.moneyDropped).toBe(false);
  });

  it("flags moneyDropped on the normalized row when priceUsd is unparseable", () => {
    const row = normalizeRow({ ...rcRow, priceUsd: "$9.99" }, { now: NOW }) as NormalizedRow;
    expect(row.priceAmount).toBeNull();
    expect(row.moneyDropped).toBe(true);
  });

  it("treats a promotional row with no store transaction id as anchorless: no storeTransactionId is fabricated here", () => {
    const row = normalizeRow(
      { ...rcRow, store: "promotional", storeTransactionId: undefined },
      { now: NOW },
    ) as NormalizedRow;
    expect("error" in row).toBe(false);
    expect(row.store).toBe("MANUAL");
    expect(row.isAnchorless).toBe(true);
    expect(row.storeTransactionId).toBeNull();
  });

  // Fix round 1, FIX 4c: a promotional row that DOES carry a real
  // store_transaction_id must keep it rather than have it discarded —
  // it's the only value that could later match a store webhook. The
  // writer (a later task) only mints a synthetic id when this is null.
  it("keeps a promotional row's real store_transaction_id instead of discarding it", () => {
    const row = normalizeRow(
      { ...rcRow, store: "promotional", storeTransactionId: "txn_real_promo" },
      { now: NOW },
    ) as NormalizedRow;
    expect(row.isAnchorless).toBe(true);
    expect(row.storeTransactionId).toBe("txn_real_promo");
  });

  it("rejects an unknown store value rather than silently dropping the row", () => {
    const row = normalizeRow({ ...rcRow, store: "some_new_store_we_dont_know" }, { now: NOW });
    expect("error" in row).toBe(true);
  });

  // ===========================================================
  // Final-fix-wave FIX 8 — the accepted store values are undocumented
  // nowhere near this normalizer's own behaviour
  // ===========================================================

  it("accepts a case-insensitive match (cheap, safe widening)", () => {
    const row = normalizeRow({ ...rcRow, store: "APP_STORE" }, { now: NOW });
    expect("error" in row).toBe(false);
    if ("error" in row) throw new Error("unreachable");
    expect(row.store).toBe("APP_STORE");

    const mixedCase = normalizeRow({ ...rcRow, store: "Play_Store" }, { now: NOW });
    expect("error" in mixedCase).toBe(false);
  });

  it("does NOT guess synonyms or normalise separators — only case", () => {
    // "App Store" (a space, not an underscore) is a different string
    // entirely, not a casing variant — deliberately still rejected, per
    // STORE_VALUE_MAP's own comment on why this fix stops at case.
    const spaced = normalizeRow({ ...rcRow, store: "App Store" }, { now: NOW });
    expect("error" in spaced).toBe(true);

    const synonym = normalizeRow({ ...rcRow, store: "ios" }, { now: NOW });
    expect("error" in synonym).toBe(true);
  });

  it("names the offending value AND the accepted set in the error message", () => {
    const row = normalizeRow({ ...rcRow, store: "ios" }, { now: NOW });
    expect("error" in row).toBe(true);
    if (!("error" in row)) throw new Error("unreachable");
    expect(row.error.code).toBe("UNKNOWN_STORE_VALUE");
    expect(row.error.message).toContain('"ios"');
    expect(row.error.message).toContain("app_store");
    expect(row.error.message).toContain("play_store");
    expect(row.error.message).toContain("stripe");
    expect(row.error.message).toContain("promotional");
  });

  it("rejects a real (non-anchorless) row with no store transaction id", () => {
    const row = normalizeRow({ ...rcRow, storeTransactionId: undefined }, { now: NOW });
    expect("error" in row).toBe(true);
  });

  it("rejects a row with an unparseable purchase date", () => {
    const row = normalizeRow({ ...rcRow, purchaseDate: "not-a-date" }, { now: NOW });
    expect("error" in row).toBe(true);
  });

  it("rejects a row missing a required field", () => {
    const row = normalizeRow({ ...rcRow, subscriberExternalId: undefined }, { now: NOW });
    expect("error" in row).toBe(true);
  });
});
