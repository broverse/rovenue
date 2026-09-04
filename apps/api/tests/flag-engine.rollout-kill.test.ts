import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks — db + redis (mirrors flag-engine.test.ts)
// =============================================================

const { dbMock, drizzleMock, redisMock } = vi.hoisted(() => {
  const store = new Map<string, string>();

  const redisMock = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    publish: vi.fn(async () => 1),
  };

  const dbMock = {
    featureFlag: { findMany: vi.fn(async () => [] as unknown[]) },
    audience: { findMany: vi.fn(async () => [] as unknown[]) },
  };

  const drizzleMock = {
    db: {} as unknown,
    featureFlagRepo: {
      findFeatureFlagsByProject: vi.fn(async () => dbMock.featureFlag.findMany()),
      findAudiencesByProject: vi.fn(async () => dbMock.audience.findMany()),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>): Promise<T> => primary(),
    ),
  };

  return { dbMock, drizzleMock, redisMock, redisStore: store };
});

vi.mock("@rovenue/db", () => ({
  default: dbMock,
  drizzle: drizzleMock,
  FeatureFlagEnv: {
    PROD: "PROD",
    STAGING: "STAGING",
    DEVELOPMENT: "DEVELOPMENT",
  },
}));

vi.mock("../src/lib/redis", () => ({ redis: redisMock }));

import {
  evaluateAllFlags,
  evaluateFlag,
  invalidateFlagCache,
} from "../src/services/flag-engine";

// =============================================================
// Constants
// =============================================================

const PROJECT_ID = "prj_rollout_kill";
const ENV = "PROD" as const;
const FLAG_KEY = "staged_feature";
const DEFAULT_VALUE = "off";
const RULE_VALUE = "on";

/** Population large enough that a subset relation is meaningful rather
 *  than coincidental at 10,000-bucket precision. */
const POPULATION_SIZE = 500;

/** Ascending rollout fractions. Each admitted set must contain the one
 *  before it. */
const ROLLOUT_STEPS = [0.3, 0.6, 1] as const;

function subscriberIds(): string[] {
  return Array.from(
    { length: POPULATION_SIZE },
    (_unused, i) => `sub_${i.toString().padStart(4, "0")}`,
  );
}

function flagRow(overrides: {
  isEnabled?: boolean;
  rolloutPercentage?: number | null;
}) {
  return {
    id: "flg_1",
    key: FLAG_KEY,
    isEnabled: overrides.isEnabled ?? true,
    defaultValue: DEFAULT_VALUE,
    rules: [
      {
        value: RULE_VALUE,
        rolloutPercentage: overrides.rolloutPercentage ?? null,
      },
    ],
  };
}

function seedFlag(row: ReturnType<typeof flagRow>): void {
  dbMock.featureFlag.findMany.mockResolvedValue([row]);
  dbMock.audience.findMany.mockResolvedValue([]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await invalidateFlagCache(PROJECT_ID);
});

// =============================================================
// 1. Kill switch dominates every rule
// =============================================================

describe("kill switch", () => {
  test("evaluateFlag returns the default when the flag is disabled, even though a rule matches at 100%", async () => {
    seedFlag(flagRow({ isEnabled: false, rolloutPercentage: 1 }));

    const result = await evaluateFlag(
      PROJECT_ID,
      ENV,
      FLAG_KEY,
      "sub_0000",
      {},
    );

    expect(result).toBe(DEFAULT_VALUE);
  });

  test("evaluateFlag returns the rule value once the same flag is enabled", async () => {
    seedFlag(flagRow({ isEnabled: true, rolloutPercentage: 1 }));

    const result = await evaluateFlag(
      PROJECT_ID,
      ENV,
      FLAG_KEY,
      "sub_0000",
      {},
    );

    // Guards against the disabled assertion above passing for the wrong
    // reason (e.g. the rule never matching at all).
    expect(result).toBe(RULE_VALUE);
  });

  test("evaluateAllFlags omits a disabled flag entirely", async () => {
    seedFlag(flagRow({ isEnabled: false, rolloutPercentage: 1 }));

    const all = await evaluateAllFlags(PROJECT_ID, ENV, "sub_0000", {});

    // A separate code path from evaluateFlag: it skips disabled flags
    // rather than returning their default.
    expect(all).not.toHaveProperty(FLAG_KEY);
  });
});

// =============================================================
// 2. Rollout is monotone — raising the percentage only ever adds
// =============================================================

describe("rollout monotonicity", () => {
  async function admittedAt(percentage: number): Promise<Set<string>> {
    seedFlag(flagRow({ isEnabled: true, rolloutPercentage: percentage }));
    await invalidateFlagCache(PROJECT_ID);

    const admitted = new Set<string>();
    for (const id of subscriberIds()) {
      const value = await evaluateFlag(PROJECT_ID, ENV, FLAG_KEY, id, {});
      if (value === RULE_VALUE) admitted.add(id);
    }
    return admitted;
  }

  test("each rollout step is a superset of the one below it", async () => {
    const sets: Set<string>[] = [];
    for (const step of ROLLOUT_STEPS) {
      sets.push(await admittedAt(step));
    }

    for (let i = 1; i < sets.length; i += 1) {
      const smaller = sets[i - 1]!;
      const larger = sets[i]!;
      const evicted = [...smaller].filter((id) => !larger.has(id));

      // The property that makes a staged rollout safe: nobody who has
      // already seen the feature loses it when the percentage goes up.
      expect(evicted).toEqual([]);
      expect(larger.size).toBeGreaterThanOrEqual(smaller.size);
    }
  });

  test("100% admits the whole population and 0% admits nobody", async () => {
    const all = await admittedAt(1);
    expect(all.size).toBe(POPULATION_SIZE);

    const none = await admittedAt(0);
    expect(none.size).toBe(0);
  });
});
