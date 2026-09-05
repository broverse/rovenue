import { describe, expect, it } from "vitest";
import { computeDesiredAccess } from "./access-engine";

const now = new Date("2026-09-03T00:00:00Z");
const future = new Date("2026-10-01T00:00:00Z");
const past = new Date("2026-08-01T00:00:00Z");

describe("computeDesiredAccess", () => {
  it("grants nothing for a non-granting status", () => {
    const desired = computeDesiredAccess(
      [{ id: "p1", status: "BILLING_ISSUE", expiresDate: future, gracePeriodExpires: null, store: "APP_STORE", accessIds: ["pro"] }],
      now,
    );
    expect(desired.size).toBe(0);
  });

  it("ignores a granting purchase whose period has ended", () => {
    const desired = computeDesiredAccess(
      [{ id: "p1", status: "ACTIVE", expiresDate: past, gracePeriodExpires: null, store: "APP_STORE", accessIds: ["pro"] }],
      now,
    );
    expect(desired.size).toBe(0);
  });

  it("keeps the latest expiry when two purchases grant the same access", () => {
    const desired = computeDesiredAccess(
      [
        { id: "p1", status: "ACTIVE", expiresDate: future, gracePeriodExpires: null, store: "APP_STORE", accessIds: ["pro"] },
        { id: "p2", status: "ACTIVE", expiresDate: new Date("2026-09-15T00:00:00Z"), gracePeriodExpires: null, store: "STRIPE", accessIds: ["pro"] },
      ],
      now,
    );
    expect(desired.get("pro")).toEqual({
      purchaseId: "p1",
      expiresDate: future,
      store: "APP_STORE",
    });
  });

  it("treats a null expiry as the longest-lived grant", () => {
    const desired = computeDesiredAccess(
      [
        { id: "p1", status: "ACTIVE", expiresDate: future, gracePeriodExpires: null, store: "APP_STORE", accessIds: ["pro"] },
        { id: "p2", status: "ACTIVE", expiresDate: null, gracePeriodExpires: null, store: "APP_STORE", accessIds: ["pro"] },
      ],
      now,
    );
    expect(desired.get("pro")?.purchaseId).toBe("p2");
  });

  // -------------------------------------------------------------
  // GRACE_PERIOD — entitlement runs to `gracePeriodExpires`
  // -------------------------------------------------------------
  //
  // A grace purchase's `expiresDate` is ALWAYS in the past (a
  // subscription only enters grace once its paid period lapsed), so the
  // `expiresDate < now` skip used to drop every one of them and
  // `grantsAccess: true` in the shared status table granted nothing.
  //
  // The expiry these cases assert is not cosmetic: `syncAccess` writes it
  // straight onto `subscriber_access`, and `findActiveAccess` serves a row
  // only while `expiresDate > now`. A grant carrying the purchase's past
  // expiry would be invisible to every entitlement check.

  it("grants access to a GRACE_PERIOD purchase until gracePeriodExpires", () => {
    const desired = computeDesiredAccess(
      [{ id: "p1", status: "GRACE_PERIOD", expiresDate: past, gracePeriodExpires: future, store: "APP_STORE", accessIds: ["pro"] }],
      now,
    );
    expect(desired.get("pro")).toEqual({
      purchaseId: "p1",
      // The grace expiry, NOT the purchase's lapsed `expiresDate` — the
      // read path filters on this value.
      expiresDate: future,
      store: "APP_STORE",
    });
  });

  it("grants nothing once gracePeriodExpires has passed", () => {
    const desired = computeDesiredAccess(
      [{ id: "p1", status: "GRACE_PERIOD", expiresDate: past, gracePeriodExpires: new Date("2026-08-15T00:00:00Z"), store: "APP_STORE", accessIds: ["pro"] }],
      now,
    );
    expect(desired.size).toBe(0);
  });

  // A null grace window is UNKNOWN, never infinite: the purchase falls
  // back to its own `expiresDate`, which is what it did before this rule
  // existed. Granting unbounded access off a missing field would entitle
  // someone who has not paid, indefinitely.
  it("falls back to expiresDate when gracePeriodExpires is null", () => {
    const desired = computeDesiredAccess(
      [{ id: "p1", status: "GRACE_PERIOD", expiresDate: past, gracePeriodExpires: null, store: "APP_STORE", accessIds: ["pro"] }],
      now,
    );
    expect(desired.size).toBe(0);
  });

  // The additive guarantee, pinned: a store that flags grace BEFORE the
  // paid period ends (Stripe `past_due` on a renewal invoice) must not
  // have its entitlement shortened to the earlier grace date.
  it("keeps the longer window when a grace purchase has not lapsed yet", () => {
    const graceBeforeExpiry = new Date("2026-09-10T00:00:00Z");
    const desired = computeDesiredAccess(
      [{ id: "p1", status: "GRACE_PERIOD", expiresDate: future, gracePeriodExpires: graceBeforeExpiry, store: "APP_STORE", accessIds: ["pro"] }],
      now,
    );
    expect(desired.get("pro")?.expiresDate).toEqual(future);
  });

  // A lifetime purchase in grace stays perpetual; a grace window cannot
  // put an end date on a grant that never had one.
  it("leaves a null expiry null for a GRACE_PERIOD purchase", () => {
    const desired = computeDesiredAccess(
      [{ id: "p1", status: "GRACE_PERIOD", expiresDate: null, gracePeriodExpires: future, store: "APP_STORE", accessIds: ["pro"] }],
      now,
    );
    expect(desired.get("pro")?.expiresDate).toBeNull();
  });
});
