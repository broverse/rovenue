import type { AppleJwsTransactionPayload } from "./apple-types";

// =============================================================
// Is this Apple transaction an auto-renewal charge?
// =============================================================
//
// The answer gates the PURCHASE-trigger credit grant on `/v1/receipts`:
// Apple mints a NEW transactionId per renewal, so a renewal reposted to
// that route creates a fresh purchase row with a fresh referenceId, which
// addCredits' (referenceType, referenceId) dedupe cannot catch. A renewal
// misread as a purchase therefore double-grants on every billing period,
// silently and unrecoverably — `credit_ledger` is append-only and its
// balance carries a `>= 0` CHECK, so the erroneous credits cannot simply
// be reversed.
//
// Apple's own `transactionReason` answers this directly and is present on
// every payload the current App Store Server API produces. It is optional
// only because payloads predating it exist.
//
// When it IS absent, the honest move is to derive the answer rather than
// pick a default. Both defaults are wrong in one direction: assuming
// "purchase" double-grants every renewal, assuming "renewal" withholds a
// legitimate first grant. `originalTransactionId` gives the structural
// answer instead, and unlike `transactionReason` it is required on every
// JWS transaction payload Apple has ever issued: Apple sets it to the id
// of the FIRST transaction in the chain, so a transaction whose own id
// differs from it is not that first transaction.
//
// The one case this reads conservatively is an upgrade on a legacy
// payload — a new transactionId in an existing chain, which Apple itself
// labels `transactionReason: "PURCHASE"`. On any current payload the
// explicit field decides and the fallback never runs; on a legacy one the
// grant is withheld rather than duplicated. That direction is deliberate:
// a withheld grant is a support ticket an operator can settle by posting
// the credit, while a recurring double-grant is a balance leak nobody
// reports.
export function isAppleRenewalCharge(
  transaction: Pick<
    AppleJwsTransactionPayload,
    "transactionId" | "originalTransactionId" | "transactionReason"
  >,
): boolean {
  if (transaction.transactionReason !== undefined) {
    return transaction.transactionReason === "RENEWAL";
  }
  return transaction.transactionId !== transaction.originalTransactionId;
}
