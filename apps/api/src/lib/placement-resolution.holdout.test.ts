import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// resolvePlacement — project-level holdout (Task 8)
// =============================================================
//
// Mocking idiom mirrors placement-resolution.draft.test.ts: mock the
// `@rovenue/db` barrel's repo calls (including `drizzle.db.transaction`,
// which the holdout exposure write needs) so no real DB is touched, and
// mock the event-bus module the way experiments.expose.test.ts does.
//
// A PAYWALL-type experiment target row is used throughout (not ELEMENT)
// — the holdout gate sits BEFORE the type-specific materialisation
// branch, so it is exercised identically either way, and PAYWALL needs
// far less fixture scaffolding (materializeElementVariants is untouched
// by this task).

const findByIdInProject = vi.hoisted(() => vi.fn());
const findAudienceByIds = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const findProjectHoldoutPercentage = vi.hoisted(() => vi.fn(async () => 0));
const findPaywallsByIds = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const findVersionsByIds = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const transactionMock = vi.hoisted(() =>
  vi.fn(async (cb: (tx: unknown) => unknown) => cb({ __tx: true })),
);
const publishHoldoutExposureMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { transaction: transactionMock },
      experimentRepo: {
        ...actual.drizzle.experimentRepo,
        findByIdInProject,
      },
      audienceRepo: {
        ...actual.drizzle.audienceRepo,
        findByIds: findAudienceByIds,
      },
      projectRepo: {
        ...actual.drizzle.projectRepo,
        findProjectHoldoutPercentage,
      },
      paywallRepo: {
        ...actual.drizzle.paywallRepo,
        findPaywallsByIds,
      },
      paywallVersionRepo: {
        ...actual.drizzle.paywallVersionRepo,
        findByIds: findVersionsByIds,
      },
    },
  };
});

vi.mock("../services/event-bus", () => ({
  eventBus: {
    publishExposure: vi.fn(async () => {}),
    publishHoldoutExposure: publishHoldoutExposureMock,
  },
}));

import { resolvePlacement } from "./placement-resolution";

const PROJECT_ID = "proj_1";
const PLACEMENT_ID = "plc_1";
const EXPERIMENT_ID = "exp_1";

function placementRow() {
  return {
    id: PLACEMENT_ID,
    projectId: PROJECT_ID,
    identifier: "onboarding",
    name: "Onboarding",
    revision: 1,
    // audienceId: null → matches everyone, including anonymous callers.
    rows: [{ audienceId: null, target: { type: "experiment", experimentId: EXPERIMENT_ID } }],
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  } as unknown as Parameters<typeof resolvePlacement>[1];
}

function runningPaywallExperiment() {
  return {
    id: EXPERIMENT_ID,
    projectId: PROJECT_ID,
    status: "RUNNING",
    type: "PAYWALL",
    variants: [
      { id: "control", weight: 0.5, value: { paywallId: "pw_control" } },
      { id: "treatment", weight: 0.5, value: { paywallId: "pw_treatment" } },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findByIdInProject.mockResolvedValue(runningPaywallExperiment());
  findAudienceByIds.mockResolvedValue([]);
  findProjectHoldoutPercentage.mockResolvedValue(0);
  findPaywallsByIds.mockResolvedValue([]);
  findVersionsByIds.mockResolvedValue([]);
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ __tx: true }));
});

describe("resolvePlacement — holdout", () => {
  it("anonymous resolution (no subscriberId) is unaffected even with holdoutPercentage=100", async () => {
    findProjectHoldoutPercentage.mockResolvedValue(100);

    await resolvePlacement(PROJECT_ID, placementRow(), {}, undefined, undefined);

    // No subscriber to hash against → the holdout gate never even reads
    // the project's percentage, and the row-walk proceeds exactly as it
    // did before this task (falls through to variant materialisation).
    expect(findProjectHoldoutPercentage).not.toHaveBeenCalled();
    expect(publishHoldoutExposureMock).not.toHaveBeenCalled();
    expect(findPaywallsByIds).toHaveBeenCalled();
  });

  it("a held-out subscriber (holdoutPercentage=100) gets no experiment in the envelope — falls through to the empty envelope shape", async () => {
    findProjectHoldoutPercentage.mockResolvedValue(100);

    const result = await resolvePlacement(
      PROJECT_ID,
      placementRow(),
      {},
      undefined,
      "sub_holdout",
    );

    // No new field: the ALREADY-SUPPORTED "no experiment" shape.
    expect(result.experiment).toBeNull();
    expect(result.paywall).toBeNull();
    // Never reached the type-specific variant menu — holdout omitted the
    // row entirely rather than serving a partial/control-only menu.
    expect(findPaywallsByIds).not.toHaveBeenCalled();
  });

  it("a held-out subscriber still gets an exposure recorded, against the real experimentId, with the placementId attached", async () => {
    findProjectHoldoutPercentage.mockResolvedValue(100);

    await resolvePlacement(PROJECT_ID, placementRow(), {}, undefined, "sub_holdout");

    expect(publishHoldoutExposureMock).toHaveBeenCalledTimes(1);
    expect(publishHoldoutExposureMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        experimentId: EXPERIMENT_ID,
        projectId: PROJECT_ID,
        subscriberId: "sub_holdout",
        placementId: PLACEMENT_ID,
      }),
    );
  });

  it("a non-held-out subscriber (holdoutPercentage=0) proceeds to normal variant materialisation", async () => {
    findProjectHoldoutPercentage.mockResolvedValue(0);

    await resolvePlacement(PROJECT_ID, placementRow(), {}, undefined, "sub_normal");

    expect(publishHoldoutExposureMock).not.toHaveBeenCalled();
    // Reached past the holdout gate into the PAYWALL variant-menu path.
    expect(findPaywallsByIds).toHaveBeenCalled();
  });

  it("a holdout exposure publish failure is swallowed — the row still falls through to the empty envelope, not an error", async () => {
    findProjectHoldoutPercentage.mockResolvedValue(100);
    transactionMock.mockRejectedValueOnce(new Error("outbox down"));

    const result = await resolvePlacement(
      PROJECT_ID,
      placementRow(),
      {},
      undefined,
      "sub_holdout",
    );

    expect(result.experiment).toBeNull();
    expect(result.paywall).toBeNull();
  });
});
