import { beforeEach, describe, expect, test, vi } from "vitest";
const auditMock = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  extractRequestContext: vi.fn(() => ({ ipAddress: null, userAgent: null })),
  redactCredentials: vi.fn((obj: Record<string, unknown> | null | undefined) => {
    if (!obj) return null;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = "[REDACTED]";
    return out;
  }),
  verifyAuditChain: vi.fn(async () => ({
    projectId: "",
    rowCount: 0,
    firstVerifiedAt: null,
    lastVerifiedAt: null,
    errors: [],
  })),
}));
vi.mock("../src/lib/audit", () => auditMock);

// =============================================================
// Hoisted mocks
// =============================================================

// Mock surface — the service now talks to Drizzle repos, so the
// test captures writes on those spies. An in-memory `subscriberData`
// map drives both findSubscriberByAppUserId lookups and the shape
// returned from softDeleteSubscriberAsMerged / anonymizeSubscriberRow
// so assertions on before/after state stay authoritative.
const { drizzleMock, subscriberStore } = vi.hoisted(() => {
  const subscriberData: Record<string, Record<string, unknown>> = {};

  function findByAppUserId(projectId: string, appUserId: string) {
    return (
      Object.values(subscriberData).find(
        (s) => s.projectId === projectId && s.appUserId === appUserId,
      ) ?? null
    );
  }

  const drizzleDb = {
    transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn(drizzleDb),
    ),
  };

  const reassignPurchases = vi.fn(async () => undefined);
  const reassignSubscriberAccess = vi.fn(async () => undefined);
  const reassignExperimentAssignments = vi.fn(async () => undefined);
  const softDeleteSubscriberAsMerged = vi.fn(
    async (
      _tx: unknown,
      subscriberId: string,
      mergedIntoId: string,
      deletedAt: Date,
    ) => {
      const row = subscriberData[subscriberId];
      if (row) {
        row.deletedAt = deletedAt;
        row.mergedInto = mergedIntoId;
      }
    },
  );
  const anonymizeSubscriberRow = vi.fn(
    async (
      _tx: unknown,
      subscriberId: string,
      anonymousId: string,
      deletedAt: Date,
    ) => {
      const row = subscriberData[subscriberId];
      if (row) {
        row.appUserId = anonymousId;
        row.attributes = {};
        row.deletedAt = deletedAt;
      }
    },
  );
  const findSubscriberByAppUserId = vi.fn(
    async (
      _tx: unknown,
      args: { projectId: string; appUserId: string },
    ) => findByAppUserId(args.projectId, args.appUserId),
  );
  const findLatestBalance = vi.fn(
    async (_tx: unknown, _subscriberId: string) => null as null | { balance: number },
  );
  const insertCreditLedger = vi.fn(async () => undefined);
  const advisoryXactLock = vi.fn(async () => undefined);
  const advisoryXactLock2 = vi.fn(async () => undefined);

  return {
    drizzleMock: {
      db: drizzleDb,
      subscriberRepo: {
        findSubscriberByAppUserId,
        reassignPurchases,
        reassignSubscriberAccess,
        reassignExperimentAssignments,
        softDeleteSubscriberAsMerged,
        anonymizeSubscriberRow,
      },
      creditLedgerRepo: {
        findLatestBalance,
        insertCreditLedger,
      },
      lockRepo: {
        advisoryXactLock,
        advisoryXactLock2,
      },
    },
    subscriberStore: subscriberData,
  };
});

vi.mock("@rovenue/db", () => ({
  default: {},
  drizzle: drizzleMock,
  CreditLedgerType: {
    PURCHASE: "PURCHASE",
    SPEND: "SPEND",
    REFUND: "REFUND",
    BONUS: "BONUS",
    EXPIRE: "EXPIRE",
    TRANSFER_IN: "TRANSFER_IN",
    TRANSFER_OUT: "TRANSFER_OUT",
  },
}));

// =============================================================
// System under test
// =============================================================

import {
  anonymizeSubscriber,
  transferSubscriber,
} from "../src/services/subscriber-transfer";

beforeEach(() => {
  vi.clearAllMocks();
  // Reset subscriber store
  for (const key of Object.keys(subscriberStore)) {
    delete subscriberStore[key];
  }
  // Default: no credits.
  drizzleMock.creditLedgerRepo.findLatestBalance.mockReset();
  drizzleMock.creditLedgerRepo.findLatestBalance.mockResolvedValue(null);
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
  subscriberStore[from.id ?? "sub_from"] = {
    id: from.id ?? "sub_from",
    projectId: from.projectId ?? "proj_a",
    appUserId: from.appUserId ?? "old_user",
    deletedAt: from.deletedAt ?? null,
  };
  subscriberStore[to.id ?? "sub_to"] = {
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

    await transferSubscriber("proj_a", "old_user", "new_user");

    expect(drizzleMock.subscriberRepo.reassignPurchases).toHaveBeenCalledWith(
      expect.anything(),
      "sub_from",
      "sub_to",
    );
    expect(
      drizzleMock.subscriberRepo.reassignSubscriberAccess,
    ).toHaveBeenCalledWith(expect.anything(), "sub_from", "sub_to");
    expect(
      drizzleMock.subscriberRepo.reassignExperimentAssignments,
    ).toHaveBeenCalledWith(expect.anything(), "sub_from", "sub_to");
  });

  test("transfers credit balance via TRANSFER_OUT + TRANSFER_IN entries", async () => {
    setupSubscribers({}, {});
    drizzleMock.creditLedgerRepo.findLatestBalance.mockImplementation(
      async (_tx: unknown, subscriberId: string) =>
        subscriberId === "sub_from" ? { balance: 150 } : { balance: 50 },
    );

    await transferSubscriber("proj_a", "old_user", "new_user");

    const creates = drizzleMock.creditLedgerRepo.insertCreditLedger.mock.calls.map(
      (c: [unknown, Record<string, unknown>]) => c[1],
    );
    expect(creates).toHaveLength(2);

    const outEntry = creates.find((d) => d.type === "TRANSFER_OUT");
    const inEntry = creates.find((d) => d.type === "TRANSFER_IN");

    expect(outEntry).toBeDefined();
    expect(outEntry!.subscriberId).toBe("sub_from");
    expect(outEntry!.amount).toBe(-150);
    expect(outEntry!.balance).toBe(0);

    expect(inEntry).toBeDefined();
    expect(inEntry!.subscriberId).toBe("sub_to");
    expect(inEntry!.amount).toBe(150);
    expect(inEntry!.balance).toBe(200); // 50 + 150
  });

  test("skips credit transfer when fromSubscriber has zero balance", async () => {
    setupSubscribers({}, {});
    drizzleMock.creditLedgerRepo.findLatestBalance.mockResolvedValue({
      balance: 0,
    });

    await transferSubscriber("proj_a", "old_user", "new_user");

    expect(
      drizzleMock.creditLedgerRepo.insertCreditLedger,
    ).not.toHaveBeenCalled();
  });

  test("soft-deletes the source subscriber with deletedAt + mergedInto", async () => {
    setupSubscribers({}, {});

    await transferSubscriber("proj_a", "old_user", "new_user");

    const call =
      drizzleMock.subscriberRepo.softDeleteSubscriberAsMerged.mock.calls[0]!;
    expect(call[1]).toBe("sub_from");
    expect(call[2]).toBe("sub_to");
    expect(call[3]).toBeInstanceOf(Date);
  });

  test("throws when fromSubscriber does not exist", async () => {
    subscriberStore["sub_to"] = {
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
    subscriberStore["sub_from"] = {
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
    drizzleMock.creditLedgerRepo.findLatestBalance.mockResolvedValue({
      balance: 100,
    });

    const result = await transferSubscriber("proj_a", "old_user", "new_user");

    expect(result).toEqual({
      fromSubscriberId: "sub_from",
      toSubscriberId: "sub_to",
      creditsTransferred: 100,
    });
  });
});

// =============================================================
// anonymizeSubscriber
// =============================================================

describe("anonymizeSubscriber", () => {
  test("replaces appUserId with an anon: token and clears attributes", async () => {
    subscriberStore["sub_1"] = {
      id: "sub_1",
      projectId: "proj_a",
      appUserId: "alice@example.com",
      attributes: { email: "alice@example.com", country: "TR" },
      deletedAt: null,
    };

    const result = await anonymizeSubscriber(
      "proj_a",
      "alice@example.com",
      "user_admin",
    );

    expect(result.alreadyAnonymized).toBe(false);
    expect(result.subscriberId).toBe("sub_1");
    expect(result.anonymousId).toMatch(/^anon:[a-f0-9]{32}$/);

    const call =
      drizzleMock.subscriberRepo.anonymizeSubscriberRow.mock.calls[0]!;
    expect(call[1]).toBe("sub_1");
    expect(call[2]).toBe(result.anonymousId);
    expect(call[3]).toBeInstanceOf(Date);
  });

  test("rejects already-anonymized input to prevent double-hashing", async () => {
    await expect(
      anonymizeSubscriber("proj_a", "anon:abc123", "user_admin"),
    ).rejects.toThrow(/already-anonymized/);
  });

  test("throws when the subscriber does not exist", async () => {
    await expect(
      anonymizeSubscriber("proj_a", "missing@example.com", "user_admin"),
    ).rejects.toThrow(/not found/);
  });
});
