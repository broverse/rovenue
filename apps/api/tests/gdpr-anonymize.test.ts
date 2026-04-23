import { describe, expect, test, beforeEach, vi } from "vitest";

const { drizzleMock, auditMock } = vi.hoisted(() => {
  const auditMock = {
    audit: vi.fn(async () => undefined),
    extractRequestContext: vi.fn(() => ({
      ipAddress: null,
      userAgent: null,
    })),
  };
  const drizzleMock = {
    db: {
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({}),
      ),
    },
    subscriberRepo: {
      anonymizeSubscriberRow: vi.fn(async () => undefined),
    },
  };
  return { drizzleMock, auditMock };
});

vi.mock("@rovenue/db", () => ({
  default: {},
  drizzle: drizzleMock,
}));
vi.mock("../src/lib/audit", () => auditMock);
vi.mock("../src/lib/env", () => ({
  env: {
    ENCRYPTION_KEY:
      "6ecfcd0f73d5afe055ff651e0e4ce85679cdd12bb4cede7aa4338b693047b8f1",
  },
}));

import { anonymizeSubscriber } from "../src/services/gdpr/anonymize-subscriber";

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.db.transaction.mockImplementation(async (cb) => cb({}));
});

describe("anonymizeSubscriber", () => {
  test("derives a stable anon_ token from subscriberId", async () => {
    const result = await anonymizeSubscriber({
      subscriberId: "sub_abc",
      projectId: "proj_1",
      actorUserId: "user_actor",
      reason: "gdpr_request",
    });
    expect(result.anonymousId).toMatch(/^anon_[0-9a-f]{24}$/);
    const again = await anonymizeSubscriber({
      subscriberId: "sub_abc",
      projectId: "proj_1",
      actorUserId: "user_actor",
      reason: "gdpr_request",
    });
    expect(again.anonymousId).toBe(result.anonymousId);
  });

  test("calls anonymizeSubscriberRow with the derived id + deletedAt", async () => {
    await anonymizeSubscriber({
      subscriberId: "sub_xyz",
      projectId: "proj_1",
      actorUserId: "user_actor",
      reason: "gdpr_request",
    });
    expect(drizzleMock.subscriberRepo.anonymizeSubscriberRow).toHaveBeenCalledWith(
      expect.anything(),
      "sub_xyz",
      expect.stringMatching(/^anon_[0-9a-f]{24}$/),
      expect.any(Date),
    );
  });

  test("writes audit entry with subscriber.anonymized action", async () => {
    await anonymizeSubscriber({
      subscriberId: "sub_1",
      projectId: "proj_1",
      actorUserId: "user_actor",
      reason: "gdpr_request",
      ipAddress: "203.0.113.5",
      userAgent: "test-ua",
    });
    expect(auditMock.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "subscriber.anonymized",
        resource: "subscriber",
        resourceId: "sub_1",
        projectId: "proj_1",
        userId: "user_actor",
        ipAddress: "203.0.113.5",
        userAgent: "test-ua",
        after: expect.objectContaining({
          reason: "gdpr_request",
          anonymousId: expect.stringMatching(/^anon_[0-9a-f]{24}$/),
        }),
      }),
      expect.anything(),
    );
  });

  test("runs row update + audit inside a single transaction", async () => {
    await anonymizeSubscriber({
      subscriberId: "sub_tx",
      projectId: "proj_1",
      actorUserId: "user_actor",
      reason: "gdpr_request",
    });
    expect(drizzleMock.db.transaction).toHaveBeenCalledTimes(1);
  });

  test("returns deletedAt alongside anonymousId", async () => {
    const result = await anonymizeSubscriber({
      subscriberId: "sub_dt",
      projectId: "proj_1",
      actorUserId: "user_actor",
      reason: "gdpr_request",
    });
    expect(result.deletedAt).toBeInstanceOf(Date);
  });
});
