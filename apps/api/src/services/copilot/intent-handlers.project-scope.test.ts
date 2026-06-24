import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Intent handlers — cross-project mutation guards (unit)
// =============================================================
//
// Regression for the P1 IDOR: the audience/feature-flag/experiment
// update repos filter by id alone, and the /execute route only checks
// that the *intent* belongs to the project — never the target entity
// referenced in the (AI-supplied) payload. A user could approve an
// intent whose payload carried another project's entity id and mutate
// it. The handlers now validate the target belongs to ctx.projectId
// inside the tx before mutating; this pins that guard.
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const drizzleMock = {
    db: {
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
        cb({} as unknown),
      ),
    },
    subscriberRepo: { findSubscriberById: vi.fn() },
    accessRepo: { createAccess: vi.fn(async () => ({ id: "acc_1" })) },
    audienceRepo: {
      findAudienceInProject: vi.fn(),
      updateAudience: vi.fn(async () => ({ id: "aud_1" })),
    },
    dashboardFeatureFlagRepo: {
      findFeatureFlagById: vi.fn(),
      updateFeatureFlag: vi.fn(async () => ({ id: "flag_1" })),
    },
    experimentRepo: {
      findByIdInProject: vi.fn(),
      updateExperiment: vi.fn(async () => ({ id: "exp_1" })),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: { ...actual.drizzle, ...drizzleMock },
  };
});

vi.mock("../../lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { registerAllIntentHandlers } from "./intent-handlers";
import {
  executeIntent,
  __resetIntentHandlersForTests,
} from "./intent-executor";

const CTX = { projectId: "prj_self", userId: "u_1", role: "ADMIN" };

function run(toolName: string, payload: unknown) {
  return executeIntent({
    intent: { id: "int_1", toolName, payload },
    ctx: CTX,
  });
}

describe("intent handlers — cross-project mutation guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetIntentHandlersForTests();
    registerAllIntentHandlers();
    drizzleMock.db.transaction.mockImplementation(
      async (cb: (tx: unknown) => unknown) => cb({} as unknown),
    );
  });

  test("featureFlags_toggle rejects a flag from another project and does not mutate", async () => {
    drizzleMock.dashboardFeatureFlagRepo.findFeatureFlagById.mockResolvedValue({
      id: "flag_other",
      projectId: "prj_other",
    });

    await expect(
      run("action_featureFlags_toggle", { flagId: "flag_other", enabled: true }),
    ).rejects.toThrow(/not found in project/);
    expect(
      drizzleMock.dashboardFeatureFlagRepo.updateFeatureFlag,
    ).not.toHaveBeenCalled();
  });

  test("featureFlags_toggle proceeds for a same-project flag", async () => {
    drizzleMock.dashboardFeatureFlagRepo.findFeatureFlagById.mockResolvedValue({
      id: "flag_self",
      projectId: "prj_self",
    });

    await run("action_featureFlags_toggle", {
      flagId: "flag_self",
      enabled: false,
    });
    expect(
      drizzleMock.dashboardFeatureFlagRepo.updateFeatureFlag,
    ).toHaveBeenCalledTimes(1);
  });

  test("featureFlags_updateRules rejects a cross-project flag", async () => {
    drizzleMock.dashboardFeatureFlagRepo.findFeatureFlagById.mockResolvedValue({
      id: "flag_other",
      projectId: "prj_other",
    });

    await expect(
      run("action_featureFlags_updateRules", {
        flagId: "flag_other",
        rules: [],
      }),
    ).rejects.toThrow(/not found in project/);
    expect(
      drizzleMock.dashboardFeatureFlagRepo.updateFeatureFlag,
    ).not.toHaveBeenCalled();
  });

  test("audiences_update rejects a cross-project audience (finder returns null)", async () => {
    drizzleMock.audienceRepo.findAudienceInProject.mockResolvedValue(null);

    await expect(
      run("action_audiences_update", { audienceId: "aud_other", name: "x" }),
    ).rejects.toThrow(/not found in project/);
    expect(drizzleMock.audienceRepo.updateAudience).not.toHaveBeenCalled();
  });

  test("experiments_start rejects a cross-project experiment", async () => {
    drizzleMock.experimentRepo.findByIdInProject.mockResolvedValue(null);

    await expect(
      run("action_experiments_start", { experimentId: "exp_other" }),
    ).rejects.toThrow(/not found in project/);
    expect(drizzleMock.experimentRepo.updateExperiment).not.toHaveBeenCalled();
  });

  test("experiments_stop rejects a cross-project experiment", async () => {
    drizzleMock.experimentRepo.findByIdInProject.mockResolvedValue(null);

    await expect(
      run("action_experiments_stop", {
        experimentId: "exp_other",
        winnerVariantId: "v1",
      }),
    ).rejects.toThrow(/not found in project/);
    expect(drizzleMock.experimentRepo.updateExperiment).not.toHaveBeenCalled();
  });

  test("subscribers_grantAccess rejects a subscriber from another project", async () => {
    drizzleMock.subscriberRepo.findSubscriberById.mockResolvedValue({
      id: "sub_other",
      projectId: "prj_other",
    });

    await expect(
      run("action_subscribers_grantAccess", {
        subscriberId: "sub_other",
        accessId: "premium",
        reason: "test",
      }),
    ).rejects.toThrow(/not found in project/);
    expect(drizzleMock.accessRepo.createAccess).not.toHaveBeenCalled();
  });
});
