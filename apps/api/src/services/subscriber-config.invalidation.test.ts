import { beforeEach, describe, expect, test, vi } from "vitest";

const { drizzleMock, resolveMock, publishSubscriberMock } = vi.hoisted(() => ({
  drizzleMock: {
    db: {} as unknown,
    subscriberRepo: { updateSubscriberAttributesById: vi.fn(async () => {}) },
  },
  resolveMock: vi.fn(async () => ({
    subscriber: { id: "sub_row_1", attributes: {} },
    deadEnded: false,
  })),
  publishSubscriberMock: vi.fn(async () => {}),
}));

vi.mock("@rovenue/db", () => ({ drizzle: drizzleMock }));
vi.mock("../lib/resolve-or-create-subscriber", () => ({
  resolveSubscriberForWrite: resolveMock,
}));
vi.mock("../lib/config-invalidation", () => ({
  publishSubscriberInvalidation: publishSubscriberMock,
}));
vi.mock("./flag-engine", () => ({ evaluateAllFlags: vi.fn(async () => ({})) }));
vi.mock("./experiment-engine", () => ({ evaluateExperiments: vi.fn(async () => ({})) }));

import { evaluateSubscriberConfig } from "./subscriber-config";

const BASE = {
  projectId: "prj_1",
  appUserId: "user_external_1",
  env: "PROD" as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveMock.mockResolvedValue({
    subscriber: { id: "sub_row_1", attributes: {} },
    deadEnded: false,
  });
});

describe("evaluateSubscriberConfig", () => {
  test("returns the resolved row id, not the appUserId", async () => {
    const result = await evaluateSubscriberConfig({
      ...BASE,
      requestAttributes: {},
    });

    // The stream matches invalidations on this. Returning the external id
    // would break matching after a /transfer merge.
    expect(result.subscriberId).toBe("sub_row_1");
  });

  test("publishes an invalidation when attributes actually change", async () => {
    await evaluateSubscriberConfig({
      ...BASE,
      requestAttributes: { plan: "pro" },
    });

    expect(publishSubscriberMock).toHaveBeenCalledWith("prj_1", ["sub_row_1"]);
  });

  test("publishes NOTHING when there are no new attributes", async () => {
    await evaluateSubscriberConfig({ ...BASE, requestAttributes: {} });

    // THE LOOP GUARD. The SSE stream re-evaluates with empty attributes on
    // every push. If this published, each push would cause another push,
    // forever. If this test ever fails, do not "fix" it by filtering in
    // the stream — the guard belongs here.
    expect(publishSubscriberMock).not.toHaveBeenCalled();
  });

  test("publishes nothing for a dead-ended subscriber", async () => {
    resolveMock.mockResolvedValue({
      subscriber: { id: "sub_row_1", attributes: {} },
      deadEnded: true,
    });

    await evaluateSubscriberConfig({
      ...BASE,
      requestAttributes: { plan: "pro" },
    });

    // Nothing was written, so there is nothing to tell anyone about.
    expect(publishSubscriberMock).not.toHaveBeenCalled();
    expect(drizzleMock.subscriberRepo.updateSubscriberAttributesById).not.toHaveBeenCalled();
  });
});
