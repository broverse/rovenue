import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Mock scaffolding mirrors subscriber-config.invalidation.test.ts:
// vi.hoisted mocks + vi.mock per dependency module, no real DB.
// =============================================================

const { drizzleMock, auditMock, syncAccessMock, publishSubscriberMock } =
  vi.hoisted(() => {
    const SUBSCRIBERS: Record<string, { id: string; deletedAt: null }> = {
      user_a: { id: "sub_from", deletedAt: null },
      user_b: { id: "sub_to", deletedAt: null },
    };
    return {
      drizzleMock: {
        db: {
          transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
        },
        schema: {},
        lockRepo: {
          advisoryXactLock2: vi.fn(async () => {}),
        },
        subscriberRepo: {
          findSubscriberByAppUserId: vi.fn(
            async (
              _tx: unknown,
              { appUserId }: { projectId: string; appUserId: string },
            ) => SUBSCRIBERS[appUserId] ?? null,
          ),
          findSubscriberById: vi.fn(async (_tx: unknown, id: string) => ({
            id,
            projectId: "prj_1",
          })),
          reassignPurchases: vi.fn(async () => {}),
          reassignRevenueEvents: vi.fn(async () => {}),
          reassignSubscriberAccess: vi.fn(async () => {}),
          reassignExperimentAssignments: vi.fn(async () => {}),
          softDeleteSubscriberAsMerged: vi.fn(async () => {}),
        },
        creditLedgerRepo: {
          findAllBalances: vi.fn(async () => []),
          findLatestBalance: vi.fn(async () => null),
          insertCreditLedger: vi.fn(async () => {}),
        },
      },
      auditMock: vi.fn(async () => {}),
      syncAccessMock: vi.fn(async () => {}),
      publishSubscriberMock: vi.fn(async () => {}),
    };
  });

vi.mock("@rovenue/db", () => ({
  drizzle: drizzleMock,
  CreditLedgerType: { TRANSFER_OUT: "TRANSFER_OUT", TRANSFER_IN: "TRANSFER_IN" },
}));
vi.mock("../lib/audit", () => ({ audit: auditMock }));
vi.mock("./access-engine", () => ({ syncAccess: syncAccessMock }));
vi.mock("../lib/config-invalidation", () => ({
  publishSubscriberInvalidation: publishSubscriberMock,
}));

import { transferSubscriber } from "./subscriber-transfer";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("transferSubscriber invalidation", () => {
  test("publishes an invalidation for BOTH the retired and surviving rows", async () => {
    await transferSubscriber("prj_1", "user_a", "user_b");

    // A device still holding the retired id must be woken so its next
    // evaluation re-resolves onto the survivor. Publishing only the
    // survivor leaves that device stranded until it reconnects.
    expect(publishSubscriberMock).toHaveBeenCalledWith(
      "prj_1",
      expect.arrayContaining(["sub_from", "sub_to"]),
    );
  });
});
