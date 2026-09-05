import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// guardStatusWrite — event-time ordering (stale-event rejection)
// =============================================================
//
// Stores don't guarantee in-order webhook delivery, and BullMQ retry
// backoff can reorder processing on top of that: an OLDER event whose
// transition is state-machine-LEGAL (e.g. a stale ACTIVE landing after a
// newer GRACE_PERIOD — legal, since billing recovery flows that way) used
// to silently regress state and re-grant access to a delinquent
// subscriber. Contract pinned here: a status write whose eventTime is
// strictly older than the row's lastStoreEventAt is withheld and audited;
// equal timestamps still apply (Stripe's 1s resolution ties legitimate
// successors); rows without ordering info behave as before.
// =============================================================

const { lockMock, auditMock } = vi.hoisted(() => ({
  lockMock: vi.fn(),
  auditMock: vi.fn(async () => undefined),
}));

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      purchaseRepo: {
        ...actual.drizzle.purchaseRepo,
        lockPurchaseStatusByStoreTransaction: lockMock,
      },
    },
  };
});

vi.mock("../lib/audit", () => ({
  audit: (...args: Parameters<typeof auditMock>) => auditMock(...args),
}));

import { PurchaseStatus, Store, type Db } from "@rovenue/db";
import { guardStatusWrite } from "./subscription-transition-guard";

const db = {} as Db;
const T1 = new Date("2026-08-20T10:00:00Z");
const T2 = new Date("2026-08-20T10:05:00Z");

function baseArgs(to: PurchaseStatus, eventTime?: Date) {
  return {
    db,
    projectId: "proj_1",
    store: Store.STRIPE,
    storeTransactionId: "sub_1",
    to,
    source: "test",
    ...(eventTime && { eventTime }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("guardStatusWrite event-time ordering", () => {
  test("withholds a legal-but-stale transition and audits it", async () => {
    // GRACE_PERIOD applied at T2; a retried ACTIVE from T1 arrives late.
    // ACTIVE is a legal transition from GRACE_PERIOD — only the event
    // timestamp reveals it as stale.
    lockMock.mockResolvedValue({
      id: "pur_1",
      status: PurchaseStatus.GRACE_PERIOD,
      lastStoreEventAt: T2,
    });

    const result = await guardStatusWrite(baseArgs(PurchaseStatus.ACTIVE, T1));

    expect(result.apply).toBe(false);
    expect(result.purchaseId).toBe("pur_1");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "subscription.transition_rejected",
        after: expect.objectContaining({ reason: "stale_event" }),
      }),
      expect.anything(),
    );
  });

  test("applies a newer event and equal-timestamp events", async () => {
    lockMock.mockResolvedValue({
      id: "pur_1",
      status: PurchaseStatus.GRACE_PERIOD,
      lastStoreEventAt: T1,
    });

    const newer = await guardStatusWrite(baseArgs(PurchaseStatus.ACTIVE, T2));
    expect(newer.apply).toBe(true);

    const equal = await guardStatusWrite(baseArgs(PurchaseStatus.ACTIVE, T1));
    expect(equal.apply).toBe(true);
  });

  test("no ordering info (NULL lastStoreEventAt or no eventTime) behaves as before", async () => {
    lockMock.mockResolvedValue({
      id: "pur_1",
      status: PurchaseStatus.GRACE_PERIOD,
      lastStoreEventAt: null,
    });
    const legacyRow = await guardStatusWrite(
      baseArgs(PurchaseStatus.ACTIVE, T1),
    );
    expect(legacyRow.apply).toBe(true);

    lockMock.mockResolvedValue({
      id: "pur_1",
      status: PurchaseStatus.GRACE_PERIOD,
      lastStoreEventAt: T2,
    });
    const noEventTime = await guardStatusWrite(baseArgs(PurchaseStatus.ACTIVE));
    expect(noEventTime.apply).toBe(true);
  });

  test("stale check outranks the allowFrom exception", async () => {
    // Even the REFUND_REVERSED-style sanctioned exit must not replay out
    // of order.
    lockMock.mockResolvedValue({
      id: "pur_1",
      status: PurchaseStatus.REFUNDED,
      lastStoreEventAt: T2,
    });

    const result = await guardStatusWrite({
      ...baseArgs(PurchaseStatus.ACTIVE, T1),
      allowFrom: [PurchaseStatus.REFUNDED],
    });

    expect(result.apply).toBe(false);
  });

  // The two branches below are EARLY RETURNS: each builds its own result
  // object rather than falling through to the one at the end of the
  // function. `apply` was asserted for both, but the rest of the shape --
  // `from`, `to`, and above all `previous` -- was not, and `previous` is
  // what emitProductChanged and emitSubscriptionRecovered key on. An early
  // return that dropped or mis-set it would silently stop announcing plan
  // changes and recoveries with nothing failing.
  test("the stale-event withhold returns the full before-image, not just apply:false", async () => {
    lockMock.mockResolvedValue({
      id: "pur_1",
      status: PurchaseStatus.BILLING_ISSUE,
      productId: "prod_old",
      autoRenewStatus: true,
      lastStoreEventAt: T2,
    });

    const result = await guardStatusWrite(baseArgs(PurchaseStatus.ACTIVE, T1));

    expect(result).toEqual({
      apply: false,
      purchaseId: "pur_1",
      from: PurchaseStatus.BILLING_ISSUE,
      to: PurchaseStatus.ACTIVE,
      previous: {
        status: PurchaseStatus.BILLING_ISSUE,
        productId: "prod_old",
        autoRenewStatus: true,
      },
    });
  });

  test("the allowFrom exception returns apply:true WITH the terminal before-image", async () => {
    // Apple REFUND_REVERSED: the one sanctioned exit from an absorbing
    // status. It takes its own early return, so nothing else in this
    // suite covers the shape it produces.
    lockMock.mockResolvedValue({
      id: "pur_1",
      status: PurchaseStatus.REFUNDED,
      productId: "prod_old",
      autoRenewStatus: false,
      lastStoreEventAt: T1,
    });

    const result = await guardStatusWrite({
      ...baseArgs(PurchaseStatus.ACTIVE, T2),
      allowFrom: [PurchaseStatus.REFUNDED],
    });

    expect(result).toEqual({
      apply: true,
      purchaseId: "pur_1",
      from: PurchaseStatus.REFUNDED,
      to: PurchaseStatus.ACTIVE,
      previous: {
        status: PurchaseStatus.REFUNDED,
        productId: "prod_old",
        autoRenewStatus: false,
      },
    });
    // The sanctioned exit is explicitly NOT audited as a rejection --
    // that is the difference between it and the branch below.
    expect(auditMock).not.toHaveBeenCalled();
  });

  test("state-machine rejection still works with a fresh eventTime", async () => {
    lockMock.mockResolvedValue({
      id: "pur_1",
      status: PurchaseStatus.REFUNDED,
      lastStoreEventAt: T1,
    });

    const result = await guardStatusWrite(baseArgs(PurchaseStatus.ACTIVE, T2));

    expect(result.apply).toBe(false);
  });
});
