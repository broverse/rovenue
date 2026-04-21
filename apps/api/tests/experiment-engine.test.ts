import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks
// =============================================================

const { prismaMock, drizzleMock, redisMock, redisStore, setRedisMode } = vi.hoisted(() => {
  const store = new Map<string, string>();
  let mode: "ok" | "get-fail" = "ok";

  const redisMock = {
    get: vi.fn(async (key: string) => {
      if (mode === "get-fail") throw new Error("redis down");
      return store.get(key) ?? null;
    }),
    set: vi.fn(
      async (key: string, value: string, _ex?: string, _ttl?: number) => {
        store.set(key, value);
        return "OK";
      },
    ),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
  };

  const prismaMock = {
    experiment: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
    },
    audience: {
      findMany: vi.fn(async () => []),
    },
    experimentAssignment: {
      findMany: vi.fn(async () => []),
      createMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async (args: any) => args.data),
    },
    productGroup: {
      findFirst: vi.fn(async () => null),
    },
  };

  const drizzleMock = {
    db: {} as unknown,
    experimentRepo: {
      findRunningExperimentsByProject: vi.fn(
        async (_db: unknown, projectId: string) =>
          prismaMock.experiment.findMany({
            where: { projectId, status: "RUNNING" },
          }),
      ),
      findExperimentsByProject: vi.fn(async () => []),
      findExperimentById: vi.fn(async () => null),
      findFirstExperimentByAudience: vi.fn(async () => null),
      countExperiments: vi.fn(async () => 0),
    },
    featureFlagRepo: {
      findFeatureFlagsByProject: vi.fn(async () => []),
      findAudiencesByProject: vi.fn(
        async (_db: unknown, projectId: string) =>
          prismaMock.audience.findMany({ where: { projectId } }),
      ),
    },
    accessRepo: {
      findActiveAccess: vi.fn(async () => []),
    },
    creditLedgerRepo: {
      findLatestBalance: vi.fn(async () => null),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };

  return {
    prismaMock,
    drizzleMock,
    redisMock,
    redisStore: store,
    setRedisMode: (m: typeof mode) => {
      mode = m;
    },
  };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
  drizzle: drizzleMock,
  ExperimentStatus: {
    DRAFT: "DRAFT",
    RUNNING: "RUNNING",
    PAUSED: "PAUSED",
    COMPLETED: "COMPLETED",
  },
  Prisma: {
    Decimal: class {
      constructor(public value: number | string) {}
      toString() {
        return String(this.value);
      }
      toNumber() {
        return typeof this.value === "number"
          ? this.value
          : parseFloat(this.value);
      }
    },
  },
}));

vi.mock("../src/lib/redis", () => ({ redis: redisMock }));

// =============================================================
// System under test (after mocks)
// =============================================================

import {
  evaluateExperiments,
  getExperimentResults,
  invalidateExperimentCache,
  recordEvent,
  resolveProductGroup,
} from "../src/services/experiment-engine";

// =============================================================
// Builders
// =============================================================

interface ExperimentOverrides {
  id?: string;
  key?: string;
  type?: "FLAG" | "PRODUCT_GROUP" | "PAYWALL" | "ELEMENT";
  audienceId?: string;
  mutualExclusionGroup?: string | null;
  variants?: Array<{ id: string; name: string; value: unknown; weight: number }>;
  metrics?: string[] | null;
}

function experiment(over: ExperimentOverrides = {}): Record<string, unknown> {
  return {
    id: over.id ?? "exp_1",
    projectId: "proj_a",
    name: over.key ?? "Experiment",
    description: null,
    type: over.type ?? "FLAG",
    key: over.key ?? "exp",
    audienceId: over.audienceId ?? "aud_all",
    status: "RUNNING",
    variants:
      over.variants ?? [
        { id: "control", name: "Control", value: false, weight: 0.5 },
        { id: "variant_a", name: "Variant A", value: true, weight: 0.5 },
      ],
    metrics: over.metrics ?? null,
    mutualExclusionGroup: over.mutualExclusionGroup ?? null,
    startedAt: new Date(),
    completedAt: null,
    winnerVariantId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function audience(
  id: string,
  rules: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    projectId: "proj_a",
    name: id,
    description: null,
    rules,
    isDefault: Object.keys(rules).length === 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function assignment(over: {
  id?: string;
  experimentId?: string;
  subscriberId?: string;
  variantId?: string;
  convertedAt?: Date | null;
  events?: Array<Record<string, unknown>>;
  revenue?: number | null;
  purchaseId?: string | null;
  experiment?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: over.id ?? "asg_1",
    experimentId: over.experimentId ?? "exp_1",
    subscriberId: over.subscriberId ?? "sub_1",
    variantId: over.variantId ?? "control",
    assignedAt: new Date(),
    events: over.events ?? [],
    convertedAt: over.convertedAt ?? null,
    purchaseId: over.purchaseId ?? null,
    revenue: over.revenue ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
    experiment: over.experiment,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  redisStore.clear();
  setRedisMode("ok");
  prismaMock.experiment.findMany.mockResolvedValue([]);
  prismaMock.audience.findMany.mockResolvedValue([]);
  prismaMock.experimentAssignment.findMany.mockResolvedValue([]);
  prismaMock.experimentAssignment.createMany.mockResolvedValue({ count: 0 });
});

// =============================================================
// evaluateExperiments
// =============================================================

describe("evaluateExperiments — empty state", () => {
  test("no running experiments → empty result", async () => {
    const result = await evaluateExperiments("proj_a", "sub_1", {});
    expect(result).toEqual({});
    expect(prismaMock.experimentAssignment.createMany).not.toHaveBeenCalled();
  });
});

describe("evaluateExperiments — new assignment", () => {
  test("assigns subscriber to a variant and persists via createMany", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([
      experiment({ key: "pricing-test", type: "PRODUCT_GROUP" }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([audience("aud_all", {})]);

    const result = await evaluateExperiments("proj_a", "sub_1", {});

    const entry = result["pricing-test"];
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("PRODUCT_GROUP");
    expect(["control", "variant_a"]).toContain(entry!.variantId);

    expect(
      prismaMock.experimentAssignment.createMany,
    ).toHaveBeenCalledOnce();
    const [call] = prismaMock.experimentAssignment.createMany.mock.calls;
    const data = (call![0] as { data: Array<Record<string, unknown>> }).data;
    expect(data).toHaveLength(1);
    expect(data[0]!.experimentId).toBe("exp_1");
    expect(data[0]!.subscriberId).toBe("sub_1");
    expect(data[0]!.variantId).toBe(entry!.variantId);
  });

  test("deterministic — same subscriber gets the same variant across calls", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([
      experiment({ key: "stable" }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([audience("aud_all", {})]);

    const a = await evaluateExperiments("proj_a", "sub_stable", {});
    prismaMock.experimentAssignment.findMany.mockResolvedValue([]);
    const b = await evaluateExperiments("proj_a", "sub_stable", {});

    expect(a["stable"]!.variantId).toBe(b["stable"]!.variantId);
  });
});

describe("evaluateExperiments — audience targeting", () => {
  test("subscriber outside the audience is excluded", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([
      experiment({ key: "tr-only", audienceId: "aud_tr" }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([
      audience("aud_tr", { country: "TR" }),
    ]);

    const result = await evaluateExperiments("proj_a", "sub_1", {
      country: "DE",
    });

    expect(result).toEqual({});
    expect(prismaMock.experimentAssignment.createMany).not.toHaveBeenCalled();
  });

  test("subscriber inside the audience gets assigned", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([
      experiment({ key: "tr-only", audienceId: "aud_tr" }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([
      audience("aud_tr", { country: "TR" }),
    ]);

    const result = await evaluateExperiments("proj_a", "sub_1", {
      country: "TR",
    });

    expect(result["tr-only"]).toBeDefined();
  });
});

describe("evaluateExperiments — sticky assignment", () => {
  test("existing assignment is reused without a new write", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([
      experiment({ id: "exp_1", key: "paywall-summer", type: "PAYWALL" }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([audience("aud_all", {})]);
    prismaMock.experimentAssignment.findMany.mockResolvedValue([
      assignment({
        id: "asg_1",
        experimentId: "exp_1",
        subscriberId: "sub_1",
        variantId: "variant_a",
      }),
    ]);

    const result = await evaluateExperiments("proj_a", "sub_1", {});

    expect(result["paywall-summer"]!.variantId).toBe("variant_a");
    expect(
      prismaMock.experimentAssignment.createMany,
    ).not.toHaveBeenCalled();
  });
});

describe("evaluateExperiments — mutual exclusion", () => {
  test("subscriber already in another experiment of the same namespace is skipped", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([
      experiment({
        id: "exp_b",
        key: "paywall_b",
        mutualExclusionGroup: "paywall-tests",
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([audience("aud_all", {})]);
    prismaMock.experimentAssignment.findMany.mockResolvedValue([
      assignment({
        id: "asg_a",
        experimentId: "exp_a",
        subscriberId: "sub_1",
        variantId: "control",
        experiment: {
          id: "exp_a",
          mutualExclusionGroup: "paywall-tests",
          status: "RUNNING",
        },
      }),
    ]);

    const result = await evaluateExperiments("proj_a", "sub_1", {});

    expect(result).toEqual({});
    expect(prismaMock.experimentAssignment.createMany).not.toHaveBeenCalled();
  });

  test("within a single call, the first experiment in a namespace blocks the second", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([
      experiment({
        id: "exp_a",
        key: "test_a",
        mutualExclusionGroup: "paywall-tests",
      }),
      experiment({
        id: "exp_b",
        key: "test_b",
        mutualExclusionGroup: "paywall-tests",
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([audience("aud_all", {})]);

    const result = await evaluateExperiments("proj_a", "sub_1", {});

    // Only one of the two should be assigned — the first in iteration order.
    const keys = Object.keys(result);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe("test_a");
  });
});

// =============================================================
// Caching
// =============================================================

describe("experiment-engine cache", () => {
  test("first call hits DB; second call uses cache", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([experiment()]);
    prismaMock.audience.findMany.mockResolvedValue([audience("aud_all", {})]);

    await evaluateExperiments("proj_a", "sub_1", {});
    await evaluateExperiments("proj_a", "sub_2", {});

    expect(prismaMock.experiment.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.audience.findMany).toHaveBeenCalledTimes(1);
  });

  test("invalidateExperimentCache forces refresh", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([experiment()]);
    prismaMock.audience.findMany.mockResolvedValue([audience("aud_all", {})]);

    await evaluateExperiments("proj_a", "sub_1", {});
    await invalidateExperimentCache("proj_a");
    await evaluateExperiments("proj_a", "sub_1", {});

    expect(prismaMock.experiment.findMany).toHaveBeenCalledTimes(2);
    expect(redisMock.del).toHaveBeenCalledWith("experiments:proj_a");
  });

  test("Redis GET failure falls through to DB", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([
      experiment({ key: "live" }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([audience("aud_all", {})]);

    setRedisMode("get-fail");
    const result = await evaluateExperiments("proj_a", "sub_1", {});

    expect(result["live"]).toBeDefined();
  });
});

// =============================================================
// resolveProductGroup
// =============================================================

describe("resolveProductGroup", () => {
  test("returns requested group when no PRODUCT_GROUP experiment is active", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([]);
    prismaMock.audience.findMany.mockResolvedValue([]);
    prismaMock.productGroup.findFirst.mockResolvedValue({
      id: "pg_weekly",
      identifier: "weekly_first",
    } as never);

    const group = await resolveProductGroup("sub_1", "proj_a", "weekly_first");

    expect(group?.identifier).toBe("weekly_first");
    expect(prismaMock.productGroup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj_a",
          identifier: "weekly_first",
        }),
      }),
    );
  });

  test("falls back to the default group when no requestedGroup is supplied", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([]);
    prismaMock.audience.findMany.mockResolvedValue([]);
    prismaMock.productGroup.findFirst.mockResolvedValue({
      id: "pg_default",
      identifier: "default",
    } as never);

    await resolveProductGroup("sub_1", "proj_a");

    expect(prismaMock.productGroup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj_a",
          isDefault: true,
        }),
      }),
    );
  });

  test("active PRODUCT_GROUP experiment overrides the requested group", async () => {
    prismaMock.experiment.findMany.mockResolvedValue([
      experiment({
        id: "exp_1",
        key: "pricing-test",
        type: "PRODUCT_GROUP",
        variants: [
          {
            id: "control",
            name: "default",
            value: "default",
            weight: 0,
          },
          {
            id: "variant_a",
            name: "weekly",
            value: "weekly_first",
            weight: 1,
          },
        ],
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([audience("aud_all", {})]);
    prismaMock.productGroup.findFirst.mockResolvedValue({
      id: "pg_weekly",
      identifier: "weekly_first",
    } as never);

    const group = await resolveProductGroup("sub_1", "proj_a", "default");

    expect(group?.identifier).toBe("weekly_first");
    expect(prismaMock.productGroup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "proj_a",
          identifier: "weekly_first",
        }),
      }),
    );
  });
});

// =============================================================
// recordEvent
// =============================================================

describe("recordEvent", () => {
  test("appends the event to every active assignment", async () => {
    prismaMock.experimentAssignment.findMany.mockResolvedValue([
      assignment({
        id: "asg_a",
        experimentId: "exp_a",
        events: [],
        experiment: { metrics: ["paywall_viewed", "purchase"] },
      }),
      assignment({
        id: "asg_b",
        experimentId: "exp_b",
        events: [],
        experiment: { metrics: null },
      }),
    ]);

    await recordEvent("sub_1", "paywall_viewed");

    expect(prismaMock.experimentAssignment.update).toHaveBeenCalledTimes(2);
    for (const call of prismaMock.experimentAssignment.update.mock.calls) {
      const args = call[0] as { data: { events: Array<{ type: string }> } };
      expect(args.data.events).toHaveLength(1);
      expect(args.data.events[0]!.type).toBe("paywall_viewed");
    }
  });

  test("purchase event sets convertedAt/purchaseId/revenue on matching metrics", async () => {
    prismaMock.experimentAssignment.findMany.mockResolvedValue([
      assignment({
        id: "asg_a",
        events: [],
        experiment: { metrics: ["purchase"] },
      }),
    ]);

    await recordEvent("sub_1", "purchase", {
      purchaseId: "pur_1",
      revenue: 9.99,
    });

    const call = prismaMock.experimentAssignment.update.mock.calls[0]!;
    const data = (call[0] as { data: Record<string, unknown> }).data;
    expect(data.convertedAt).toBeInstanceOf(Date);
    expect(data.purchaseId).toBe("pur_1");
    expect(data.revenue).toBeDefined();
  });

  test("non-conversion event type does not set convertedAt", async () => {
    prismaMock.experimentAssignment.findMany.mockResolvedValue([
      assignment({
        id: "asg_a",
        events: [],
        experiment: { metrics: ["purchase"] },
      }),
    ]);

    await recordEvent("sub_1", "cta_clicked");

    const call = prismaMock.experimentAssignment.update.mock.calls[0]!;
    const data = (call[0] as { data: Record<string, unknown> }).data;
    expect(data.convertedAt).toBeUndefined();
  });

  test("does not overwrite an already-converted assignment", async () => {
    const already = new Date("2026-01-01T00:00:00Z");
    prismaMock.experimentAssignment.findMany.mockResolvedValue([
      assignment({
        id: "asg_a",
        events: [],
        convertedAt: already,
        experiment: { metrics: ["purchase"] },
      }),
    ]);

    await recordEvent("sub_1", "purchase", { purchaseId: "pur_2", revenue: 5 });

    const call = prismaMock.experimentAssignment.update.mock.calls[0]!;
    const data = (call[0] as { data: Record<string, unknown> }).data;
    expect(data.convertedAt).toBeUndefined();
    expect(data.purchaseId).toBeUndefined();
  });

  test("no active assignments → no writes", async () => {
    prismaMock.experimentAssignment.findMany.mockResolvedValue([]);

    await recordEvent("sub_1", "paywall_viewed");

    expect(prismaMock.experimentAssignment.update).not.toHaveBeenCalled();
  });
});

// =============================================================
// getExperimentResults
// =============================================================

describe("getExperimentResults", () => {
  test("aggregates totalUsers, conversions, revenue per variant + SRM", async () => {
    const expRow = experiment({
      id: "exp_1",
      key: "pricing",
      metrics: ["purchase"],
      variants: [
        { id: "control", name: "Control", value: "default", weight: 0.5 },
        {
          id: "variant_a",
          name: "Variant A",
          value: "weekly",
          weight: 0.5,
        },
      ],
    });
    prismaMock.experiment.findMany.mockResolvedValue([expRow]);
    prismaMock.experiment.findUnique.mockResolvedValue(expRow as never);
    prismaMock.audience.findMany.mockResolvedValue([audience("aud_all", {})]);

    // 100 control / 100 variant — 10% vs 20% conversion with revenue
    const assignments: Record<string, unknown>[] = [];
    for (let i = 0; i < 100; i += 1) {
      assignments.push({
        id: `asg_c_${i}`,
        experimentId: "exp_1",
        subscriberId: `sub_c_${i}`,
        variantId: "control",
        assignedAt: new Date(),
        events:
          i < 10
            ? [
                { type: "paywall_viewed", timestamp: "2026-01-01" },
                { type: "purchase", timestamp: "2026-01-01" },
              ]
            : [{ type: "paywall_viewed", timestamp: "2026-01-01" }],
        convertedAt: i < 10 ? new Date() : null,
        purchaseId: i < 10 ? `pur_${i}` : null,
        revenue: i < 10 ? { toNumber: () => 10 } : null,
      });
    }
    for (let i = 0; i < 100; i += 1) {
      assignments.push({
        id: `asg_v_${i}`,
        experimentId: "exp_1",
        subscriberId: `sub_v_${i}`,
        variantId: "variant_a",
        assignedAt: new Date(),
        events:
          i < 20
            ? [
                { type: "paywall_viewed", timestamp: "2026-01-01" },
                { type: "purchase", timestamp: "2026-01-01" },
              ]
            : [{ type: "paywall_viewed", timestamp: "2026-01-01" }],
        convertedAt: i < 20 ? new Date() : null,
        purchaseId: i < 20 ? `pur_v_${i}` : null,
        revenue: i < 20 ? { toNumber: () => 15 } : null,
      });
    }

    prismaMock.experimentAssignment.findMany.mockResolvedValue(assignments);

    const result = await getExperimentResults("exp_1");

    expect(result.variants).toHaveLength(2);
    const control = result.variants.find((v) => v.variantId === "control")!;
    const variant = result.variants.find((v) => v.variantId === "variant_a")!;

    expect(control.totalUsers).toBe(100);
    expect(control.conversions).toBe(10);
    expect(control.conversionRate).toBeCloseTo(0.1);
    expect(control.totalRevenue).toBe(100);
    expect(control.revenuePerUser).toBe(1);

    expect(variant.totalUsers).toBe(100);
    expect(variant.conversions).toBe(20);
    expect(variant.conversionRate).toBeCloseTo(0.2);
    expect(variant.totalRevenue).toBe(300);
    expect(variant.stats.lift).toBeCloseTo(1, 0);
    expect(variant.stats.isSignificant).toBe(true);

    expect(result.srm.isMismatch).toBe(false);
    expect(result.sampleSize).toBeGreaterThan(0);
  });
});
