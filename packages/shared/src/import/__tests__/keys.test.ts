import { describe, expect, it } from "vitest";
import {
  IMPORT_DEDUPE_PREFIX,
  IMPORT_SYNTHETIC_TXN_PREFIX,
  buildRevenueDedupeKey,
  buildSyntheticTransactionId,
} from "../keys";

describe("buildRevenueDedupeKey", () => {
  it("is stable across repeated calls with the same input", () => {
    const input = { store: "APP_STORE", storeTransactionId: "txn_1", renewalNumber: "3" };
    expect(buildRevenueDedupeKey(input)).toBe(buildRevenueDedupeKey({ ...input }));
  });

  it("matches the fixed shape from spec §4.5", () => {
    expect(buildRevenueDedupeKey({ store: "APP_STORE", storeTransactionId: "txn_1", renewalNumber: "3" })).toBe(
      `${IMPORT_DEDUPE_PREFIX}:APP_STORE:txn_1:3`,
    );
  });

  it("defaults a null renewalNumber to a fixed slot rather than omitting it", () => {
    expect(buildRevenueDedupeKey({ store: "APP_STORE", storeTransactionId: "txn_1", renewalNumber: null })).toBe(
      `${IMPORT_DEDUPE_PREFIX}:APP_STORE:txn_1:0`,
    );
  });

  it("differs when renewalNumber differs (each renewal in a chain gets its own revenue event)", () => {
    const base = { store: "APP_STORE", storeTransactionId: "txn_1" };
    expect(buildRevenueDedupeKey({ ...base, renewalNumber: "1" })).not.toBe(
      buildRevenueDedupeKey({ ...base, renewalNumber: "2" }),
    );
  });

  it("differs when storeTransactionId differs", () => {
    const base = { store: "APP_STORE", renewalNumber: "1" };
    expect(buildRevenueDedupeKey({ ...base, storeTransactionId: "txn_1" })).not.toBe(
      buildRevenueDedupeKey({ ...base, storeTransactionId: "txn_2" }),
    );
  });

  // This documents WHY, not just what: the parameter type below has exactly
  // three fields (store, storeTransactionId, renewalNumber) and nothing else.
  // There is structurally no way to pass an import-job id, a run timestamp,
  // or any other value that would differ between two attempts at importing
  // the identical source row. That is deliberate: a job id in this key would
  // make every re-run of the same file mint a fresh dedupe key and double
  // the customer's lifetime revenue on the second attempt.
  it("cannot be made to change across two import attempts over the same source row, by construction", () => {
    const sourceRow = { store: "STRIPE", storeTransactionId: "ch_1", renewalNumber: "1" };
    const firstAttempt = buildRevenueDedupeKey(sourceRow);
    const secondAttemptSameRow = buildRevenueDedupeKey(sourceRow);
    expect(firstAttempt).toBe(secondAttemptSameRow);
  });
});

describe("buildSyntheticTransactionId", () => {
  const input = {
    projectId: "proj_1",
    subscriberExternalId: "user_1",
    productIdentifier: "pro_monthly",
    purchaseDateIso: "2026-01-01T00:00:00.000Z",
  };

  it("is deterministic across repeated calls (a re-run resolves to the same purchase)", () => {
    expect(buildSyntheticTransactionId(input)).toBe(buildSyntheticTransactionId({ ...input }));
  });

  it("is prefixed with the synthetic-transaction namespace, mirroring grantComp's comp_<id> convention", () => {
    expect(buildSyntheticTransactionId(input).startsWith(`${IMPORT_SYNTHETIC_TXN_PREFIX}_`)).toBe(true);
  });

  it("differs when the subscriber differs", () => {
    expect(buildSyntheticTransactionId(input)).not.toBe(
      buildSyntheticTransactionId({ ...input, subscriberExternalId: "user_2" }),
    );
  });

  it("differs when the product differs", () => {
    expect(buildSyntheticTransactionId(input)).not.toBe(
      buildSyntheticTransactionId({ ...input, productIdentifier: "pro_annual" }),
    );
  });

  it("differs when the project differs (ids never leak across projects)", () => {
    expect(buildSyntheticTransactionId(input)).not.toBe(
      buildSyntheticTransactionId({ ...input, projectId: "proj_2" }),
    );
  });

  // Same reasoning as the revenue key: the input type carries only
  // source-row identity plus the project scope — no job id, no randomness.
  // A random id here (e.g. createId()) would duplicate every anchorless
  // (promotional) row's MANUAL purchase on a second import attempt.
  it("cannot be made to change across two import attempts over the same source row, by construction", () => {
    expect(buildSyntheticTransactionId(input)).toBe(buildSyntheticTransactionId(input));
  });

  // Golden vector (fix round 1, FIX 2): pins the literal digest for a
  // fixed input, computed independently with `node -e` against this
  // exact join/hash (space-separated sha256 hex, comp_import_ prefix)
  // and checked in as a value, not just an f(x) === f(x) tautology.
  // Without this, an edit to the separator, the field order, or the
  // hash algorithm would silently remint every synthetic transaction id
  // on the next code change — and on the next real import run, that
  // reminting would duplicate every anchorless purchase already written
  // under the old id, which is exactly the failure this deterministic
  // design exists to prevent.
  it("matches a pinned golden digest for a fixed input", () => {
    expect(buildSyntheticTransactionId(input)).toBe(
      "comp_import_426a9e62d3d2501c157b96ba5a5e35161c73925cf991d65c29965433d048bd3d",
    );
  });
});
