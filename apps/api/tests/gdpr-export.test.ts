import { describe, expect, test, beforeEach, vi } from "vitest";

const { drizzleMock, auditMock } = vi.hoisted(() => {
  const auditMock = { audit: vi.fn(async () => undefined) };
  const drizzleMock = {
    default: {},
    drizzle: {
      db: {
        select: vi.fn(),
      },
      schema: {
        subscribers: { id: "id", projectId: "projectId" },
        purchases: { subscriberId: "subscriberId" },
        subscriberAccess: { subscriberId: "subscriberId" },
        creditLedger: { subscriberId: "subscriberId" },
      },
    },
  };
  return { drizzleMock, auditMock };
});

vi.mock("@rovenue/db", () => drizzleMock);
vi.mock("drizzle-orm", () => ({ eq: (_a: unknown, _b: unknown) => ({}) }));
vi.mock("../src/lib/audit", () => auditMock);

import { exportSubscriber } from "../src/services/gdpr/export-subscriber";

function selectChain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => Promise.resolve(rows),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.drizzle.db.select
    .mockImplementationOnce(() =>
      selectChain([
        {
          id: "sub_1",
          projectId: "proj_1",
          appUserId: "app_user_42",
          attributes: { email: "foo@bar.com" },
          deletedAt: null,
        },
      ]),
    )
    .mockImplementationOnce(() =>
      selectChain([{ id: "pur_1", subscriberId: "sub_1", store: "STRIPE" }]),
    )
    .mockImplementationOnce(() =>
      selectChain([
        { id: "acc_1", subscriberId: "sub_1", entitlementKey: "pro" },
      ]),
    )
    .mockImplementationOnce(() =>
      selectChain([{ id: "cl_1", subscriberId: "sub_1", delta: 100 }]),
    );
});

describe("exportSubscriber", () => {
  test("returns subscriber + purchases + access + ledger + timestamp", async () => {
    const dump = await exportSubscriber({
      subscriberId: "sub_1",
      projectId: "proj_1",
      actorUserId: "user_actor",
    });
    expect(dump.subscriber).toMatchObject({
      id: "sub_1",
      appUserId: "app_user_42",
    });
    expect(dump.purchases).toHaveLength(1);
    expect(dump.access).toHaveLength(1);
    expect(dump.creditLedger).toHaveLength(1);
    expect(dump.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("writes a subscriber.exported audit entry", async () => {
    await exportSubscriber({
      subscriberId: "sub_1",
      projectId: "proj_1",
      actorUserId: "user_actor",
    });
    expect(auditMock.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "subscriber.exported",
        resource: "subscriber",
        resourceId: "sub_1",
      }),
    );
  });

  test("throws when subscriber row is missing", async () => {
    drizzleMock.drizzle.db.select.mockReset();
    drizzleMock.drizzle.db.select.mockImplementation(() => ({
      from: () => ({ where: () => Promise.resolve([]) }),
    }));
    await expect(
      exportSubscriber({
        subscriberId: "sub_missing",
        projectId: "proj_1",
        actorUserId: "user_actor",
      }),
    ).rejects.toThrow(/not found/i);
  });

  test("throws when subscriber belongs to a different project", async () => {
    // Override the first select to return a subscriber whose projectId
    // does NOT match the requested project. The service must treat
    // this as 404 (not 403) so it can't be used as an existence oracle
    // across tenants.
    drizzleMock.drizzle.db.select.mockReset();
    drizzleMock.drizzle.db.select.mockImplementationOnce(() => ({
      from: () => ({
        where: () =>
          Promise.resolve([
            {
              id: "sub_other",
              projectId: "proj_different",
              appUserId: "app_user",
              attributes: {},
              deletedAt: null,
            },
          ]),
      }),
    }));
    await expect(
      exportSubscriber({
        subscriberId: "sub_other",
        projectId: "proj_1",
        actorUserId: "user_actor",
      }),
    ).rejects.toThrow(/not found/i);
  });
});
