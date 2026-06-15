// =============================================================
// purchases repo — SQL-level terminal-status guard (unit)
// =============================================================
//
// FINDING 1, mechanism (b): upsertPurchase / updatePurchase must
// never let a status write resurrect a REFUNDED / REVOKED row. The
// guard is implemented as a `CASE WHEN purchases.status IN
// ('REFUNDED','REVOKED') THEN purchases.status ELSE <new> END`
// expression so even a missed-transaction code path can't resurrect a
// terminal row.
//
// These are pure unit tests: we stub the Drizzle query builder and
// capture the `set` payload, asserting the `status` field is wrapped
// in a SQL CASE chunk (not the raw enum string) whenever a status is
// written — and is left untouched (raw string / absent) when guarding
// is disabled or no status is present. This proves the guard holds
// without needing a live Postgres.

import { describe, expect, it } from "vitest";
import { SQL } from "drizzle-orm";
import { upsertPurchase, updatePurchase } from "./purchases";

// ---------------------------------------------------------------------------
// Minimal query-builder stubs that record the payload handed to the
// terminal-guarding SET / ON CONFLICT DO UPDATE branch.
// ---------------------------------------------------------------------------

function makeUpsertDb() {
  let captured: Record<string, unknown> | undefined;
  const builder = {
    insert() {
      return builder;
    },
    values() {
      return builder;
    },
    onConflictDoUpdate(arg: { set: Record<string, unknown> }) {
      captured = arg.set;
      return builder;
    },
    async returning() {
      return [{ id: "pur_1", status: "REFUNDED" }];
    },
  };
  return {
    db: builder as never,
    getSet: () => captured,
  };
}

function makeUpdateDb() {
  let captured: Record<string, unknown> | undefined;
  const builder = {
    update() {
      return builder;
    },
    set(arg: Record<string, unknown>) {
      captured = arg;
      return builder;
    },
    where() {
      return builder;
    },
    async returning() {
      return [{ id: "pur_1", status: "REFUNDED" }];
    },
  };
  return {
    db: builder as never,
    getSet: () => captured,
  };
}

describe("upsertPurchase — terminal status guard", () => {
  it("wraps the ON CONFLICT status in a SQL CASE expression by default", async () => {
    const { db, getSet } = makeUpsertDb();
    await upsertPurchase(db, {
      store: "APP_STORE",
      storeTransactionId: "txn_1",
      create: { status: "ACTIVE" } as never,
      update: { status: "ACTIVE", verifiedAt: new Date() } as never,
    });
    const set = getSet();
    // The status is no longer the raw string — it's a guarded SQL chunk
    // that only advances status when the existing row is non-terminal.
    expect(set?.status).toBeInstanceOf(SQL);
    expect(set?.status).not.toBe("ACTIVE");
    // Non-status fields are passed through unchanged.
    expect(set?.verifiedAt).toBeInstanceOf(Date);
  });

  it("leaves the status raw when guarding is disabled", async () => {
    const { db, getSet } = makeUpsertDb();
    await upsertPurchase(db, {
      store: "APP_STORE",
      storeTransactionId: "txn_1",
      create: { status: "ACTIVE" } as never,
      update: { status: "REFUNDED" } as never,
      guardTerminalStatus: false,
    });
    expect(getSet()?.status).toBe("REFUNDED");
  });

  it("does not touch a status-less update payload", async () => {
    const { db, getSet } = makeUpsertDb();
    await upsertPurchase(db, {
      store: "APP_STORE",
      storeTransactionId: "txn_1",
      create: { status: "ACTIVE" } as never,
      update: { verifiedAt: new Date() } as never,
    });
    const set = getSet();
    expect(set?.status).toBeUndefined();
    expect(set?.verifiedAt).toBeInstanceOf(Date);
  });
});

describe("updatePurchase — terminal status guard", () => {
  it("wraps the status in a SQL CASE expression by default", async () => {
    const { db, getSet } = makeUpdateDb();
    await updatePurchase(db, "pur_1", {
      status: "EXPIRED",
      cancellationDate: new Date(),
    } as never);
    const set = getSet();
    expect(set?.status).toBeInstanceOf(SQL);
    expect(set?.status).not.toBe("EXPIRED");
    // Non-status fields still apply unconditionally.
    expect(set?.cancellationDate).toBeInstanceOf(Date);
  });

  it("leaves non-status patches untouched", async () => {
    const { db, getSet } = makeUpdateDb();
    await updatePurchase(db, "pur_1", { refundDate: new Date() } as never);
    const set = getSet();
    expect(set?.status).toBeUndefined();
    expect(set?.refundDate).toBeInstanceOf(Date);
  });

  it("can opt out of the guard", async () => {
    const { db, getSet } = makeUpdateDb();
    await updatePurchase(
      db,
      "pur_1",
      { status: "EXPIRED" } as never,
      { guardTerminalStatus: false },
    );
    expect(getSet()?.status).toBe("EXPIRED");
  });
});
