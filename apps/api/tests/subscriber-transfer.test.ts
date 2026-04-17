import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks
// =============================================================

const { prismaMock } = vi.hoisted(() => {
  const subscriberData: Record<string, Record<string, unknown>> = {};

  function lookupSubscriber(args: any): Record<string, unknown> | null {
    if (args.where?.id) {
      return subscriberData[args.where.id] ?? null;
    }
    if (args.where?.projectId_appUserId) {
      const { projectId, appUserId } = args.where.projectId_appUserId;
      return (
        Object.values(subscriberData).find(
          (s) => s.projectId === projectId && s.appUserId === appUserId,
        ) ?? null
      );
    }
    return null;
  }

  const purchaseUpdateMany = vi.fn(async () => ({ count: 0 }));
  const accessUpdateMany = vi.fn(async () => ({ count: 0 }));
  const experimentAssignmentUpdateMany = vi.fn(async () => ({ count: 0 }));
  const creditLedgerFindFirst = vi.fn(async () => null);
  const creditLedgerCreate = vi.fn(async (args: any) => args.data);
  const subscriberFindUnique = vi.fn(async (args: any) => lookupSubscriber(args));
  const subscriberUpdate = vi.fn(async (args: any) => {
    const existing = lookupSubscriber(args);
    return { ...existing, ...args.data };
  });
  const $executeRaw = vi.fn(async () => 0);
  const $transaction = vi.fn(
    async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
      fn({
        subscriber: {
          findUnique: subscriberFindUnique,
          update: subscriberUpdate,
        },
        purchase: { updateMany: purchaseUpdateMany },
        subscriberAccess: { updateMany: accessUpdateMany },
        experimentAssignment: { updateMany: experimentAssignmentUpdateMany },
        creditLedger: {
          findFirst: creditLedgerFindFirst,
          create: creditLedgerCreate,
        },
        $executeRaw,
      }),
  );

  const auditLog = { create: vi.fn(async () => ({ id: "al_1" })) };

  return {
    prismaMock: {
      subscriber: { findUnique: subscriberFindUnique, update: subscriberUpdate },
      purchase: { updateMany: purchaseUpdateMany },
      subscriberAccess: { updateMany: accessUpdateMany },
      experimentAssignment: { updateMany: experimentAssignmentUpdateMany },
      creditLedger: { findFirst: creditLedgerFindFirst, create: creditLedgerCreate },
      auditLog,
      $transaction,
      $executeRaw,
      // Keep reference to store for test setup
      __subscriberData: subscriberData,
    },
  };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
  CreditLedgerType: {
    PURCHASE: "PURCHASE",
    SPEND: "SPEND",
    REFUND: "REFUND",
    BONUS: "BONUS",
    EXPIRE: "EXPIRE",
    TRANSFER_IN: "TRANSFER_IN",
    TRANSFER_OUT: "TRANSFER_OUT",
  },
  Prisma: {
    sql: (s: TemplateStringsArray, ...v: unknown[]) => ({ strings: s, values: v }),
  },
}));

// =============================================================
// System under test
// =============================================================

import { transferSubscriber } from "../src/services/subscriber-transfer";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset subscriber store
  for (const key of Object.keys(prismaMock.__subscriberData)) {
    delete prismaMock.__subscriberData[key];
  }
});

function setupSubscribers(
  from: {
    id?: string;
    projectId?: string;
    appUserId?: string;
    deletedAt?: Date | null;
  },
  to: {
    id?: string;
    projectId?: string;
    appUserId?: string;
    deletedAt?: Date | null;
  },
) {
  prismaMock.__subscriberData[from.id ?? "sub_from"] = {
    id: from.id ?? "sub_from",
    projectId: from.projectId ?? "proj_a",
    appUserId: from.appUserId ?? "old_user",
    deletedAt: from.deletedAt ?? null,
  };
  prismaMock.__subscriberData[to.id ?? "sub_to"] = {
    id: to.id ?? "sub_to",
    projectId: to.projectId ?? "proj_a",
    appUserId: to.appUserId ?? "new_user",
    deletedAt: to.deletedAt ?? null,
  };
}

// =============================================================
// Tests
// =============================================================

describe("transferSubscriber", () => {
  test("moves purchases, access, and experiment assignments to the target", async () => {
    setupSubscribers({}, {});
    prismaMock.creditLedger.findFirst.mockResolvedValue({ balance: 0 });

    await transferSubscriber("proj_a", "old_user", "new_user");

    expect(prismaMock.purchase.updateMany).toHaveBeenCalledWith({
      where: { subscriberId: "sub_from" },
      data: { subscriberId: "sub_to" },
    });
    expect(prismaMock.subscriberAccess.updateMany).toHaveBeenCalledWith({
      where: { subscriberId: "sub_from" },
      data: { subscriberId: "sub_to" },
    });
    expect(prismaMock.experimentAssignment.updateMany).toHaveBeenCalledWith({
      where: { subscriberId: "sub_from" },
      data: { subscriberId: "sub_to" },
    });
  });

  test("transfers credit balance via TRANSFER_OUT + TRANSFER_IN entries", async () => {
    setupSubscribers({}, {});
    prismaMock.creditLedger.findFirst.mockImplementation(
      async (args: any) => {
        if (args.where.subscriberId === "sub_from") return { balance: 150 };
        return { balance: 50 };
      },
    );

    await transferSubscriber("proj_a", "old_user", "new_user");

    const creates = prismaMock.creditLedger.create.mock.calls.map(
      (c: any) => c[0].data,
    );
    expect(creates).toHaveLength(2);

    const outEntry = creates.find((d: any) => d.type === "TRANSFER_OUT");
    const inEntry = creates.find((d: any) => d.type === "TRANSFER_IN");

    expect(outEntry).toBeDefined();
    expect(outEntry.subscriberId).toBe("sub_from");
    expect(outEntry.amount).toBe(-150);
    expect(outEntry.balance).toBe(0);

    expect(inEntry).toBeDefined();
    expect(inEntry.subscriberId).toBe("sub_to");
    expect(inEntry.amount).toBe(150);
    expect(inEntry.balance).toBe(200); // 50 + 150
  });

  test("skips credit transfer when fromSubscriber has zero balance", async () => {
    setupSubscribers({}, {});
    prismaMock.creditLedger.findFirst.mockResolvedValue({ balance: 0 });

    await transferSubscriber("proj_a", "old_user", "new_user");

    expect(prismaMock.creditLedger.create).not.toHaveBeenCalled();
  });

  test("soft-deletes the source subscriber with deletedAt + mergedInto", async () => {
    setupSubscribers({}, {});
    prismaMock.creditLedger.findFirst.mockResolvedValue({ balance: 0 });

    await transferSubscriber("proj_a", "old_user", "new_user");

    const updateCall = prismaMock.subscriber.update.mock.calls.find(
      (c: any) => c[0].where.id === "sub_from",
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0].data.deletedAt).toBeInstanceOf(Date);
    expect(updateCall![0].data.mergedInto).toBe("sub_to");
  });

  test("throws when fromSubscriber does not exist", async () => {
    prismaMock.__subscriberData["sub_to"] = {
      id: "sub_to",
      projectId: "proj_a",
      appUserId: "new_user",
      deletedAt: null,
    };

    await expect(
      transferSubscriber("proj_a", "ghost", "new_user"),
    ).rejects.toThrow(/not found/i);
  });

  test("throws when toSubscriber does not exist", async () => {
    prismaMock.__subscriberData["sub_from"] = {
      id: "sub_from",
      projectId: "proj_a",
      appUserId: "old_user",
      deletedAt: null,
    };

    await expect(
      transferSubscriber("proj_a", "old_user", "ghost"),
    ).rejects.toThrow(/not found/i);
  });

  test("throws when fromSubscriber is already soft-deleted", async () => {
    setupSubscribers({ deletedAt: new Date() }, {});

    await expect(
      transferSubscriber("proj_a", "old_user", "new_user"),
    ).rejects.toThrow(/already.*transfer/i);
  });

  test("throws when transferring to self", async () => {
    setupSubscribers({ appUserId: "same" }, { appUserId: "same" });

    await expect(
      transferSubscriber("proj_a", "same", "same"),
    ).rejects.toThrow(/same/i);
  });

  test("returns the transfer summary", async () => {
    setupSubscribers({}, {});
    prismaMock.creditLedger.findFirst.mockResolvedValue({ balance: 100 });

    const result = await transferSubscriber("proj_a", "old_user", "new_user");

    expect(result).toEqual({
      fromSubscriberId: "sub_from",
      toSubscriberId: "sub_to",
      creditsTransferred: 100,
    });
  });
});
