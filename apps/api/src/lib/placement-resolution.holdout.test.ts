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
const findOfferingById = vi.hoisted(() => vi.fn(async () => null));
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
      offeringRepo: {
        ...actual.drizzle.offeringRepo,
        findOfferingById,
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

/** Both variant paywalls, active and published — the ordinary case. */
function variantPaywallRows() {
  return [
    {
      id: "pw_control",
      projectId: PROJECT_ID,
      identifier: "pw-control",
      name: "Control",
      isActive: true,
      publishedVersionId: "ver_control",
    },
    {
      id: "pw_treatment",
      projectId: PROJECT_ID,
      identifier: "pw-treatment",
      name: "Treatment",
      isActive: true,
      publishedVersionId: "ver_treatment",
    },
  ];
}

function variantVersionRows() {
  return [
    {
      id: "ver_control",
      offeringId: "off_1",
      remoteConfig: { defaultLocale: "en", locales: { en: { title: "Control" } } },
      builderConfig: null,
      configFormatVersion: 2,
    },
    {
      id: "ver_treatment",
      offeringId: "off_1",
      remoteConfig: { defaultLocale: "en", locales: { en: { title: "Treatment" } } },
      builderConfig: null,
      configFormatVersion: 2,
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  findByIdInProject.mockResolvedValue(runningPaywallExperiment());
  findAudienceByIds.mockResolvedValue([]);
  findProjectHoldoutPercentage.mockResolvedValue(0);
  findPaywallsByIds.mockResolvedValue(variantPaywallRows());
  findVersionsByIds.mockResolvedValue(variantVersionRows());
  findOfferingById.mockResolvedValue(null);
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

  it("a held-out subscriber (holdoutPercentage=100) is served the CONTROL paywall, with no experiment", async () => {
    findProjectHoldoutPercentage.mockResolvedValue(100);

    const result = await resolvePlacement(
      PROJECT_ID,
      placementRow(),
      {},
      undefined,
      "sub_holdout",
    );

    // Control is the FIRST DECLARED variant, the same convention the
    // results service resolves control by.
    expect(result.paywall?.id).toBe("pw_control");
    // No `experiment`: the subscriber must not be drawn into an arm.
    expect(result.experiment).toBeNull();
  });

  it("a held-out subscriber is NOT shown an empty envelope", async () => {
    // `placementRowsSchema` allows at most one all-users row and requires
    // it to be last, so falling through to "the next row" in the normal
    // configuration means falling out of the placement entirely — 10% of
    // users shown no paywall, and a baseline cohort measured on users who
    // saw no offer.
    findProjectHoldoutPercentage.mockResolvedValue(100);

    const result = await resolvePlacement(
      PROJECT_ID,
      placementRow(),
      {},
      undefined,
      "sub_holdout",
    );

    expect(result.paywall).not.toBeNull();
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
    expect(result.paywall?.id).toBe("pw_control");
  });

  it("falls through with no paywall when the control variant cannot be hydrated", async () => {
    // Nothing to withhold them from: the experiment could not have run for
    // anyone. Better an empty envelope than a control paywall conjured
    // from an experiment that is itself broken.
    findProjectHoldoutPercentage.mockResolvedValue(100);
    findPaywallsByIds.mockResolvedValue([]);
    findVersionsByIds.mockResolvedValue([]);

    const result = await resolvePlacement(
      PROJECT_ID,
      placementRow(),
      {},
      undefined,
      "sub_holdout",
    );

    expect(result.paywall).toBeNull();
    expect(result.experiment).toBeNull();
    expect(publishHoldoutExposureMock).not.toHaveBeenCalled();
  });
});

// =============================================================
// PAYWALL variants are all-or-nothing
// =============================================================
//
// Identical rule to `materializeElementVariants`. The variant draw is
// client-side and `selectVariant` falls through to the LAST variant for
// any bucket past the cumulative weight total, so shipping A alone after
// dropping B sends 100% of traffic to A while every exposure is logged as
// a normal split.

describe("resolvePlacement — PAYWALL variant materialisation", () => {
  it("serves both variants when both hydrate", async () => {
    const result = await resolvePlacement(PROJECT_ID, placementRow(), {}, undefined, "sub_1");

    expect(result.experiment?.variants.map((v) => v.variantId)).toEqual([
      "control",
      "treatment",
    ]);
  });

  it("drops the WHOLE experiment when one variant's paywall is archived, and serves control", async () => {
    // The experiment is unusable; the surviving paywall is not. Falling
    // through instead would usually mean serving NOTHING — the row below
    // proves that case.
    findPaywallsByIds.mockResolvedValue([
      variantPaywallRows()[0]!,
      { ...variantPaywallRows()[1]!, isActive: false },
    ]);

    const result = await resolvePlacement(PROJECT_ID, placementRow(), {}, undefined, "sub_1");

    expect(result.experiment).toBeNull();
    expect(result.paywall?.id).toBe("pw_control");
  });

  it("serves control rather than an EMPTY envelope — the experiment row is the only row", async () => {
    // `placementRow()` has exactly one all-users row, which is the normal
    // configuration and the one `placementRowsSchema` forces to be last.
    // `continue` here means falling out of the placement entirely: the
    // device shows no paywall while the dashboard shows a RUNNING
    // experiment, and nobody learns.
    findPaywallsByIds.mockResolvedValue([
      variantPaywallRows()[0]!,
      { ...variantPaywallRows()[1]!, isActive: false },
    ]);

    const result = await resolvePlacement(PROJECT_ID, placementRow(), {}, undefined, "sub_1");

    expect(result.paywall).not.toBeNull();
  });

  it("drops the WHOLE experiment when one variant has no published version", async () => {
    findPaywallsByIds.mockResolvedValue([
      variantPaywallRows()[0]!,
      { ...variantPaywallRows()[1]!, publishedVersionId: null },
    ]);
    findVersionsByIds.mockResolvedValue([variantVersionRows()[0]!]);

    const result = await resolvePlacement(PROJECT_ID, placementRow(), {}, undefined, "sub_1");

    expect(result.experiment).toBeNull();
    expect(result.paywall?.id).toBe("pw_control");
  });

  it("drops the WHOLE experiment when one variant carries no paywallId at all", async () => {
    // A variant with no `paywallId` never becomes a ref, so the count is
    // taken against the DECLARED variants — otherwise a one-ref set would
    // look "complete" and ship as a 1-variant experiment.
    findByIdInProject.mockResolvedValue({
      ...runningPaywallExperiment(),
      variants: [
        { id: "control", weight: 0.5, value: { paywallId: "pw_control" } },
        { id: "treatment", weight: 0.5, value: { inlineConfig: {} } },
      ],
    });

    const result = await resolvePlacement(PROJECT_ID, placementRow(), {}, undefined, "sub_1");

    expect(result.experiment).toBeNull();
    expect(result.paywall?.id).toBe("pw_control");
  });

  it("serves the SURVIVING variant when control itself is the broken one", async () => {
    // `fallback` is the first DECLARED variant that survived — control
    // when control survived, and the best paywall available when it did
    // not. Never nothing.
    findPaywallsByIds.mockResolvedValue([
      { ...variantPaywallRows()[0]!, isActive: false },
      variantPaywallRows()[1]!,
    ]);

    const result = await resolvePlacement(PROJECT_ID, placementRow(), {}, undefined, "sub_1");

    expect(result.experiment).toBeNull();
    expect(result.paywall?.id).toBe("pw_treatment");
  });

  it("falls through to the next row only when NO variant hydrates", async () => {
    findPaywallsByIds.mockResolvedValue([]);
    findVersionsByIds.mockResolvedValue([]);

    const result = await resolvePlacement(PROJECT_ID, placementRow(), {}, undefined, "sub_1");

    expect(result.experiment).toBeNull();
    expect(result.paywall).toBeNull();
  });

  it("does not record a holdout exposure for a partially-broken experiment", async () => {
    // The experiment is not running for anyone, held out or not, so there
    // is nothing to be withheld from and nothing to measure.
    findProjectHoldoutPercentage.mockResolvedValue(100);
    findPaywallsByIds.mockResolvedValue([
      variantPaywallRows()[0]!,
      { ...variantPaywallRows()[1]!, isActive: false },
    ]);

    const result = await resolvePlacement(
      PROJECT_ID,
      placementRow(),
      {},
      undefined,
      "sub_holdout",
    );

    expect(result.paywall?.id).toBe("pw_control");
    expect(publishHoldoutExposureMock).not.toHaveBeenCalled();
  });
});
