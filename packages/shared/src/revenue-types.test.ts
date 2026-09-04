import { describe, expect, it } from "vitest";
import {
  ALL_REVENUE_TYPES,
  REVENUE_TYPES_LIFETIME_PURCHASED,
  REVENUE_TYPES_MONEY_OUT,
  REVENUE_TYPES_NEW_RECURRING,
  REVENUE_TYPES_PURCHASE_COUNT,
  sqlTypeList,
} from "./revenue-types";

describe("revenue type groupings", () => {
  it("counts a one-time purchase as a purchase", () => {
    expect(REVENUE_TYPES_PURCHASE_COUNT).toContain("NON_RENEWING_PURCHASE");
    expect(REVENUE_TYPES_PURCHASE_COUNT).toContain("CREDIT_PURCHASE");
  });

  it("keeps one-time revenue OUT of the recurring decomposition", () => {
    // The entire reason NON_RENEWING_PURCHASE exists. If this ever passes
    // by accident, the decomposition silently starts reporting one-time
    // sales as new MRR again.
    expect(REVENUE_TYPES_NEW_RECURRING).not.toContain("NON_RENEWING_PURCHASE");
    expect(REVENUE_TYPES_NEW_RECURRING).not.toContain("CREDIT_PURCHASE");
  });

  it("counts money the subscriber actually paid toward lifetime value", () => {
    expect(REVENUE_TYPES_LIFETIME_PURCHASED).toContain("NON_RENEWING_PURCHASE");
    // CANCELLATION is a $0 marker, not money in.
    expect(REVENUE_TYPES_LIFETIME_PURCHASED).not.toContain("CANCELLATION");
  });

  it("lists every enum value exactly once", () => {
    expect(new Set(ALL_REVENUE_TYPES).size).toBe(ALL_REVENUE_TYPES.length);
    expect(ALL_REVENUE_TYPES).toContain("NON_RENEWING_PURCHASE");
  });

  it("renders a quoted SQL list", () => {
    expect(sqlTypeList(["REFUND", "CHARGEBACK"])).toBe("'REFUND','CHARGEBACK'");
  });

  it("keeps CHARGEBACK in the money-out set although the enum has never had it", () => {
    // Not a mistake to clean up silently: CHARGEBACK appears in eight
    // predicates and has never been a RevenueEventType, so no row can
    // carry it. It is retained so behaviour is byte-identical, and
    // declared here so the next reader does not "fix" it into a real
    // value or copy it into a new predicate.
    expect(REVENUE_TYPES_MONEY_OUT).toContain("CHARGEBACK");
    expect(ALL_REVENUE_TYPES).not.toContain("CHARGEBACK");
  });
});
