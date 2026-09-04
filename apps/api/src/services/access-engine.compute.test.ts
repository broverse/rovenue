import { describe, expect, it } from "vitest";
import { computeDesiredAccess } from "./access-engine";

const now = new Date("2026-09-03T00:00:00Z");
const future = new Date("2026-10-01T00:00:00Z");
const past = new Date("2026-08-01T00:00:00Z");

describe("computeDesiredAccess", () => {
  it("grants nothing for a non-granting status", () => {
    const desired = computeDesiredAccess(
      [{ id: "p1", status: "BILLING_ISSUE", expiresDate: future, store: "APP_STORE", accessIds: ["pro"] }],
      now,
    );
    expect(desired.size).toBe(0);
  });

  it("ignores a granting purchase whose period has ended", () => {
    const desired = computeDesiredAccess(
      [{ id: "p1", status: "ACTIVE", expiresDate: past, store: "APP_STORE", accessIds: ["pro"] }],
      now,
    );
    expect(desired.size).toBe(0);
  });

  it("keeps the latest expiry when two purchases grant the same access", () => {
    const desired = computeDesiredAccess(
      [
        { id: "p1", status: "ACTIVE", expiresDate: future, store: "APP_STORE", accessIds: ["pro"] },
        { id: "p2", status: "ACTIVE", expiresDate: new Date("2026-09-15T00:00:00Z"), store: "STRIPE", accessIds: ["pro"] },
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
        { id: "p1", status: "ACTIVE", expiresDate: future, store: "APP_STORE", accessIds: ["pro"] },
        { id: "p2", status: "ACTIVE", expiresDate: null, store: "APP_STORE", accessIds: ["pro"] },
      ],
      now,
    );
    expect(desired.get("pro")?.purchaseId).toBe("p2");
  });
});
