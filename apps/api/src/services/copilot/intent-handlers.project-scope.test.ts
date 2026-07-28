import { beforeEach, describe, expect, test, vi } from "vitest";
import type { BuilderConfig, PaywallTreeOp } from "@rovenue/shared/paywall";
import { GeneratedConfigError } from "../paywall-ai/validate-config";

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
    paywallRepo: {
      findPaywallById: vi.fn(),
      updatePaywall: vi.fn(async () => ({ id: "pw_1" })),
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

// =============================================================
// action.paywall.editTree — dry-run, no-write handler (Task 3)
// =============================================================
//
// `paywallRepo.findPaywallById` is already scoped to (projectId, id) at
// the repo layer (unlike e.g. `subscriberRepo.findSubscriberById`), so
// the handler's IDOR guard is "call it with ctx.projectId and treat a
// miss as not-found" — same outcome as the other handlers' manual
// project-id check, enforced one layer down instead.

const BASE_PAYWALL_CONFIG: BuilderConfig = {
  formatVersion: 2,
  defaultLocale: "en",
  localizations: { en: { title_key: "Go Pro", cta_key: "Continue" } },
  root: {
    type: "stack",
    id: "root",
    axis: "v",
    children: [
      { type: "text", id: "title", key: "title_key", role: "title" },
      {
        type: "packageList",
        id: "packages",
        packageIds: ["pkg_monthly"],
        cellLayout: "row",
      },
      { type: "purchaseButton", id: "purchase", labelKey: "cta_key" },
    ],
  },
};

function selfProjectPaywall(builderConfig: BuilderConfig | null = BASE_PAYWALL_CONFIG) {
  return {
    id: "pw_1",
    projectId: "prj_self",
    builderConfig,
    remoteConfig: { defaultLocale: "en" },
  };
}

describe("action_paywall_editTree — IDOR, op kinds, duplicate-id refusal, no writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetIntentHandlersForTests();
    registerAllIntentHandlers();
  });

  test("rejects a paywall from another project (scoped finder misses) and never touches applyTreeOp's result", async () => {
    drizzleMock.paywallRepo.findPaywallById.mockResolvedValue(null);

    await expect(
      run("action_paywall_editTree", {
        paywallId: "pw_other",
        op: { kind: "remove", nodeId: "purchase" } satisfies PaywallTreeOp,
      }),
    ).rejects.toThrow(/not found in project/);
    expect(drizzleMock.paywallRepo.updatePaywall).not.toHaveBeenCalled();
  });

  test.each<[string, PaywallTreeOp]>([
    [
      "insert",
      { kind: "insert", parentId: "root", index: 0, subtree: { type: "spacer", id: "new_spacer", size: 4 } },
    ],
    [
      "replace",
      { kind: "replace", nodeId: "purchase", subtree: { type: "purchaseButton", id: "purchase", labelKey: "cta_key" } },
    ],
    ["remove", { kind: "remove", nodeId: "packages" }],
    ["updateProps", { kind: "updateProps", nodeId: "title", patch: { role: "subtitle" } }],
    ["setLocalizations", { kind: "setLocalizations", locale: "en", entries: { title_key: "Go Premium" } }],
  ])("accepts a valid %s op for the owning project, returns { op, paywallId }, never writes", async (_kind, op) => {
    drizzleMock.paywallRepo.findPaywallById.mockResolvedValue(selfProjectPaywall());

    const result = await run("action_paywall_editTree", { paywallId: "pw_1", op });

    expect(result).toEqual({ op, paywallId: "pw_1" });
    expect(drizzleMock.paywallRepo.updatePaywall).not.toHaveBeenCalled();
  });

  test("falls back to an empty draft (remoteConfig.defaultLocale) when builderConfig is null", async () => {
    drizzleMock.paywallRepo.findPaywallById.mockResolvedValue(selfProjectPaywall(null));
    const op: PaywallTreeOp = {
      kind: "insert",
      parentId: "root",
      index: 0,
      subtree: { type: "spacer", id: "sp_1", size: 4 },
    };

    const result = await run("action_paywall_editTree", { paywallId: "pw_1", op });

    expect(result).toEqual({ op, paywallId: "pw_1" });
    expect(drizzleMock.paywallRepo.updatePaywall).not.toHaveBeenCalled();
  });

  test("rejects an insert that would introduce a duplicate node id via GeneratedConfigError, never writes", async () => {
    drizzleMock.paywallRepo.findPaywallById.mockResolvedValue(selfProjectPaywall());
    const op: PaywallTreeOp = {
      kind: "insert",
      parentId: "root",
      index: 0,
      // "title" already exists in BASE_PAYWALL_CONFIG — save-tier DUPLICATE_NODE_ID.
      subtree: { type: "text", id: "title", key: "title_key", role: "title" },
    };

    await expect(
      run("action_paywall_editTree", { paywallId: "pw_1", op }),
    ).rejects.toThrow(GeneratedConfigError);
    expect(drizzleMock.paywallRepo.updatePaywall).not.toHaveBeenCalled();
  });

  test("propagates a TreeOpError for a structurally invalid op (target not found), never writes", async () => {
    drizzleMock.paywallRepo.findPaywallById.mockResolvedValue(selfProjectPaywall());
    const op: PaywallTreeOp = { kind: "remove", nodeId: "does_not_exist" };

    await expect(run("action_paywall_editTree", { paywallId: "pw_1", op })).rejects.toThrow();
    expect(drizzleMock.paywallRepo.updatePaywall).not.toHaveBeenCalled();
  });
});
