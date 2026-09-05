import { describe, expect, it } from "vitest";
import { isAppleRenewalCharge } from "./renewal-charge";

// =============================================================
// isAppleRenewalCharge
// =============================================================
//
// This gates the PURCHASE-trigger grant on /v1/receipts. Getting it wrong
// in one direction double-grants credits on every renewal forever; in the
// other it withholds a legitimate first grant. Both halves are pinned
// here, including the legacy path where Apple's own field is absent and
// the answer has to come from the transaction chain instead.
// =============================================================

const FIRST_ID = "2000000111111111";
const LATER_ID = "2000000999999999";

describe("isAppleRenewalCharge", () => {
  describe("when Apple states the reason", () => {
    it("is a renewal when transactionReason is RENEWAL", () => {
      expect(
        isAppleRenewalCharge({
          transactionId: LATER_ID,
          originalTransactionId: FIRST_ID,
          transactionReason: "RENEWAL",
        }),
      ).toBe(true);
    });

    it("is not a renewal when transactionReason is PURCHASE", () => {
      expect(
        isAppleRenewalCharge({
          transactionId: FIRST_ID,
          originalTransactionId: FIRST_ID,
          transactionReason: "PURCHASE",
        }),
      ).toBe(false);
    });

    it("trusts PURCHASE even mid-chain, where the fallback would disagree", () => {
      // An upgrade: a new transactionId inside an existing chain, which
      // Apple labels PURCHASE. The explicit field must win, otherwise the
      // fallback would silently withhold a grant Apple says to make.
      expect(
        isAppleRenewalCharge({
          transactionId: LATER_ID,
          originalTransactionId: FIRST_ID,
          transactionReason: "PURCHASE",
        }),
      ).toBe(false);
    });
  });

  describe("when transactionReason is absent (legacy payload)", () => {
    it("reads a transaction that starts its own chain as a purchase", () => {
      expect(
        isAppleRenewalCharge({
          transactionId: FIRST_ID,
          originalTransactionId: FIRST_ID,
        }),
      ).toBe(false);
    });

    it("reads a transaction later in an existing chain as a renewal", () => {
      // The case that used to double-grant: no transactionReason, so the
      // old code returned false and fired the PURCHASE-trigger grant with
      // a brand-new referenceId that dedupe could not catch.
      expect(
        isAppleRenewalCharge({
          transactionId: LATER_ID,
          originalTransactionId: FIRST_ID,
        }),
      ).toBe(true);
    });
  });
});
