import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks
// =============================================================

const { prismaMock, drizzleMock, syncAccessMock } = vi.hoisted(() => {
  const purchase = {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  };
  const project = {
    findUnique: vi.fn(),
  };
  const outgoingWebhook = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };
  const revenueEvent = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };
  const prismaMock = { purchase, project, outgoingWebhook, revenueEvent };

  // Drizzle repo stubs delegate to the existing prisma finders so
  // Phase 7 cutover doesn't force a rewrite of the test setup.
  const drizzleMock = {
    db: {} as unknown,
    purchaseExtRepo: {
      findPurchasesNearExpiry: vi.fn(
        async (
          _db: unknown,
          args: { now: Date; lookback: Date; statuses: string[] },
        ) => {
          const rows = await prismaMock.purchase.findMany({
            where: {
              status: { in: args.statuses },
              expiresDate: { lt: args.now, gt: args.lookback },
            },
          });
          return Array.isArray(rows) ? rows : [];
        },
      ),
    },
    purchaseRepo: {
      // updatePurchaseStatusIf is a compare-and-swap: updates the
      // row only when the current status matches `expected`. The
      // test's prismaMock.purchase.updateMany already returns a
      // `{count}` shape so we forward to it.
      updatePurchaseStatusIf: vi.fn(
        async (
          _db: unknown,
          id: string,
          expected: string,
          next: string,
        ) => {
          const res = await prismaMock.purchase.updateMany({
            where: { id, status: expected },
            data: { status: next },
          });
          return res?.count ?? 0;
        },
      ),
    },
    projectRepo: {
      findProjectWebhookUrl: vi.fn(async (_db: unknown, id: string) => {
        const row = await prismaMock.project.findUnique({
          where: { id },
          select: { webhookUrl: true },
        });
        return row?.webhookUrl ?? null;
      }),
    },
    outgoingWebhookRepo: {
      findRecentOutgoingByPurchaseAndType: vi.fn(
        async (
          _db: unknown,
          projectId: string,
          subscriberId: string,
          eventType: string,
          purchaseId: string | null,
        ) =>
          prismaMock.outgoingWebhook.findFirst({
            where: {
              projectId,
              eventType,
              purchaseId,
              subscriberId,
            },
          }),
      ),
      enqueueOutgoingWebhook: vi.fn(
        async (_db: unknown, input: Record<string, unknown>) =>
          prismaMock.outgoingWebhook.create({
            data: { ...input, status: "PENDING" },
          }),
      ),
    },
    revenueEventRepo: {
      findRecentRevenueEvent: vi.fn(
        async (
          _db: unknown,
          subscriberId: string,
          purchaseId: string,
          type: string,
        ) =>
          prismaMock.revenueEvent.findFirst({
            where: { subscriberId, purchaseId, type },
          }),
      ),
      createRevenueEvent: vi.fn(
        async (_db: unknown, input: Record<string, unknown>) =>
          prismaMock.revenueEvent.create({ data: input }),
      ),
    },
  };

  return {
    prismaMock,
    drizzleMock,
    syncAccessMock: vi.fn(async () => undefined),
  };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
  drizzle: drizzleMock,
  PurchaseStatus: {
    TRIAL: "TRIAL",
    ACTIVE: "ACTIVE",
    GRACE_PERIOD: "GRACE_PERIOD",
    EXPIRED: "EXPIRED",
    REFUNDED: "REFUNDED",
    REVOKED: "REVOKED",
    PAUSED: "PAUSED",
  },
  RevenueEventType: {
    INITIAL: "INITIAL",
    RENEWAL: "RENEWAL",
    TRIAL_CONVERSION: "TRIAL_CONVERSION",
    CANCELLATION: "CANCELLATION",
    REFUND: "REFUND",
    REACTIVATION: "REACTIVATION",
    CREDIT_PURCHASE: "CREDIT_PURCHASE",
  },
  Store: {
    APP_STORE: "APP_STORE",
    PLAY_STORE: "PLAY_STORE",
    STRIPE: "STRIPE",
  },
  OutgoingWebhookStatus: {
    PENDING: "PENDING",
    SENT: "SENT",
    FAILED: "FAILED",
  },
  Prisma: {
    Decimal: class {
      constructor(public value: number | string) {}
      toString() {
        return String(this.value);
      }
    },
  },
}));

vi.mock("../src/services/access-engine", () => ({
  syncAccess: syncAccessMock,
}));

// =============================================================
// System under test (imported after mocks)
// =============================================================

import { runExpiryCheck } from "../src/workers/expiry-checker";

// =============================================================
// Helpers
// =============================================================

const NOW = new Date("2026-05-01T12:00:00Z");

interface CandidateOverrides {
  id?: string;
  projectId?: string;
  subscriberId?: string;
  productId?: string;
  status?: "ACTIVE" | "GRACE_PERIOD" | "TRIAL";
  store?: "APP_STORE" | "PLAY_STORE" | "STRIPE";
  expiresDate?: Date;
  gracePeriodExpires?: Date | null;
  priceAmount?: number | null;
  priceCurrency?: string | null;
}

function buildCandidate(over: CandidateOverrides = {}): Record<string, unknown> {
  return {
    id: over.id ?? "pur_1",
    projectId: over.projectId ?? "proj_a",
    subscriberId: over.subscriberId ?? "sub_1",
    productId: over.productId ?? "prod_1",
    status: over.status ?? "ACTIVE",
    store: over.store ?? "APP_STORE",
    expiresDate:
      over.expiresDate ?? new Date(NOW.getTime() - 10 * 60 * 1000),
    gracePeriodExpires: over.gracePeriodExpires ?? null,
    priceAmount: over.priceAmount ?? 9.99,
    priceCurrency: over.priceCurrency ?? "USD",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.purchase.findMany.mockResolvedValue([]);
  prismaMock.purchase.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.project.findUnique.mockResolvedValue({
    webhookUrl: "https://example.com/hook",
  });
  prismaMock.outgoingWebhook.findFirst.mockResolvedValue(null);
  prismaMock.outgoingWebhook.create.mockResolvedValue({ id: "ow_1" });
  prismaMock.revenueEvent.findFirst.mockResolvedValue(null);
  prismaMock.revenueEvent.create.mockResolvedValue({ id: "rev_1" });
  syncAccessMock.mockResolvedValue(undefined);
});

// =============================================================
// Tests
// =============================================================

describe("runExpiryCheck — query window", () => {
  test("queries purchases expired in the last 24h across TRIAL/ACTIVE/GRACE_PERIOD", async () => {
    await runExpiryCheck(NOW);

    expect(prismaMock.purchase.findMany).toHaveBeenCalledOnce();
    const args = prismaMock.purchase.findMany.mock.calls[0]![0] as {
      where: {
        status: { in: string[] };
        expiresDate: { lt: Date; gt: Date };
      };
    };
    expect(new Set(args.where.status.in)).toEqual(
      new Set(["ACTIVE", "GRACE_PERIOD", "TRIAL"]),
    );
    expect(args.where.expiresDate.lt.getTime()).toBe(NOW.getTime());
    expect(args.where.expiresDate.gt.getTime()).toBe(
      NOW.getTime() - 24 * 60 * 60 * 1000,
    );
  });

  test("returns zero-count result when no candidates found", async () => {
    prismaMock.purchase.findMany.mockResolvedValue([]);

    const result = await runExpiryCheck(NOW);

    expect(result).toEqual({
      checked: 0,
      expired: 0,
      movedToGracePeriod: 0,
      errors: 0,
    });
  });
});

describe("runExpiryCheck — ACTIVE expiration", () => {
  test("transitions ACTIVE → EXPIRED, syncs access, emits outgoing webhook + revenue event", async () => {
    prismaMock.purchase.findMany.mockResolvedValue([buildCandidate()]);

    const result = await runExpiryCheck(NOW);

    expect(prismaMock.purchase.updateMany).toHaveBeenCalledWith({
      where: { id: "pur_1", status: "ACTIVE" },
      data: { status: "EXPIRED" },
    });
    expect(syncAccessMock).toHaveBeenCalledWith("sub_1");
    expect(prismaMock.outgoingWebhook.create).toHaveBeenCalledOnce();
    const webhookCall =
      prismaMock.outgoingWebhook.create.mock.calls[0]![0] as {
        data: { eventType: string; projectId: string; purchaseId: string };
      };
    expect(webhookCall.data.eventType).toBe("EXPIRATION");
    expect(webhookCall.data.purchaseId).toBe("pur_1");

    expect(prismaMock.revenueEvent.create).toHaveBeenCalledOnce();
    const revenueCall = prismaMock.revenueEvent.create.mock.calls[0]![0] as {
      data: { type: string; purchaseId: string; store: string };
    };
    expect(revenueCall.data.type).toBe("CANCELLATION");
    expect(revenueCall.data.purchaseId).toBe("pur_1");

    expect(result.checked).toBe(1);
    expect(result.expired).toBe(1);
    expect(result.movedToGracePeriod).toBe(0);
    expect(result.errors).toBe(0);
  });

  test("GRACE_PERIOD → EXPIRED when gracePeriodExpires has passed", async () => {
    prismaMock.purchase.findMany.mockResolvedValue([
      buildCandidate({
        id: "pur_2",
        status: "GRACE_PERIOD",
        gracePeriodExpires: new Date(NOW.getTime() - 60 * 1000),
      }),
    ]);

    const result = await runExpiryCheck(NOW);

    expect(prismaMock.purchase.updateMany).toHaveBeenCalledWith({
      where: { id: "pur_2", status: "GRACE_PERIOD" },
      data: { status: "EXPIRED" },
    });
    expect(result.expired).toBe(1);
  });
});

describe("runExpiryCheck — grace period transitions", () => {
  test("ACTIVE with future gracePeriodExpires → GRACE_PERIOD (no webhook/revenue event)", async () => {
    prismaMock.purchase.findMany.mockResolvedValue([
      buildCandidate({
        status: "ACTIVE",
        gracePeriodExpires: new Date(NOW.getTime() + 60 * 60 * 1000),
      }),
    ]);

    const result = await runExpiryCheck(NOW);

    expect(prismaMock.purchase.updateMany).toHaveBeenCalledWith({
      where: { id: "pur_1", status: "ACTIVE" },
      data: { status: "GRACE_PERIOD" },
    });
    expect(syncAccessMock).toHaveBeenCalledWith("sub_1");
    expect(prismaMock.outgoingWebhook.create).not.toHaveBeenCalled();
    expect(prismaMock.revenueEvent.create).not.toHaveBeenCalled();
    expect(result.movedToGracePeriod).toBe(1);
    expect(result.expired).toBe(0);
  });
});

describe("runExpiryCheck — idempotency", () => {
  test("skips side effects when updateMany count is 0 (another worker won)", async () => {
    prismaMock.purchase.findMany.mockResolvedValue([buildCandidate()]);
    prismaMock.purchase.updateMany.mockResolvedValue({ count: 0 });

    const result = await runExpiryCheck(NOW);

    expect(syncAccessMock).not.toHaveBeenCalled();
    expect(prismaMock.outgoingWebhook.create).not.toHaveBeenCalled();
    expect(prismaMock.revenueEvent.create).not.toHaveBeenCalled();
    expect(result.expired).toBe(0);
  });

  test("does not re-emit outgoing webhook if one already exists", async () => {
    prismaMock.purchase.findMany.mockResolvedValue([buildCandidate()]);
    prismaMock.outgoingWebhook.findFirst.mockResolvedValue({ id: "ow_existing" });

    await runExpiryCheck(NOW);

    expect(prismaMock.outgoingWebhook.create).not.toHaveBeenCalled();
  });

  test("does not re-create revenue event if a CANCELLATION already exists for this purchase", async () => {
    prismaMock.purchase.findMany.mockResolvedValue([buildCandidate()]);
    prismaMock.revenueEvent.findFirst.mockResolvedValue({ id: "rev_existing" });

    await runExpiryCheck(NOW);

    expect(prismaMock.revenueEvent.create).not.toHaveBeenCalled();
  });

  test("skips outgoing webhook creation when project has no webhook URL", async () => {
    prismaMock.purchase.findMany.mockResolvedValue([buildCandidate()]);
    prismaMock.project.findUnique.mockResolvedValue({ webhookUrl: null });

    await runExpiryCheck(NOW);

    expect(prismaMock.outgoingWebhook.create).not.toHaveBeenCalled();
    // But revenue event still recorded
    expect(prismaMock.revenueEvent.create).toHaveBeenCalled();
  });
});

describe("runExpiryCheck — error isolation", () => {
  test("one failing purchase does not stop the batch", async () => {
    prismaMock.purchase.findMany.mockResolvedValue([
      buildCandidate({ id: "pur_a", subscriberId: "sub_a" }),
      buildCandidate({ id: "pur_b", subscriberId: "sub_b" }),
      buildCandidate({ id: "pur_c", subscriberId: "sub_c" }),
    ]);

    let call = 0;
    prismaMock.purchase.updateMany.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error("simulated DB failure");
      return { count: 1 };
    });

    const result = await runExpiryCheck(NOW);

    expect(result.checked).toBe(3);
    expect(result.expired).toBe(2);
    expect(result.errors).toBe(1);
    expect(syncAccessMock).toHaveBeenCalledTimes(2);
  });

  test("syncAccess failure is swallowed and does not block webhook/revenue events", async () => {
    prismaMock.purchase.findMany.mockResolvedValue([buildCandidate()]);
    syncAccessMock.mockRejectedValue(new Error("advisory lock failed"));

    const result = await runExpiryCheck(NOW);

    expect(prismaMock.outgoingWebhook.create).toHaveBeenCalledOnce();
    expect(prismaMock.revenueEvent.create).toHaveBeenCalledOnce();
    expect(result.expired).toBe(1);
    expect(result.errors).toBe(0);
  });
});
