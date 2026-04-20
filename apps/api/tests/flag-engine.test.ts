import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks — prisma + redis
// =============================================================

const { prismaMock, drizzleMock, redisMock, redisStore, setRedisMode } = vi.hoisted(() => {
  const store = new Map<string, string>();
  let mode: "ok" | "get-fail" | "set-fail" | "all-fail" = "ok";

  const redisMock = {
    get: vi.fn(async (key: string) => {
      if (mode === "get-fail" || mode === "all-fail") {
        throw new Error("redis get down");
      }
      return store.get(key) ?? null;
    }),
    set: vi.fn(
      async (key: string, value: string, _ex?: string, _ttl?: number) => {
        if (mode === "set-fail" || mode === "all-fail") {
          throw new Error("redis set down");
        }
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
    featureFlag: {
      findMany: vi.fn(async () => []),
    },
    audience: {
      findMany: vi.fn(async () => []),
    },
  };

  // Shadow reader is a no-op that always yields the primary
  // caller — Drizzle parity is covered in its own unit test
  // file, not here.
  const drizzleMock = {
    db: {} as unknown,
    featureFlagRepo: {
      findFeatureFlagsByProject: vi.fn(async () => []),
      findAudiencesByProject: vi.fn(async () => []),
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
}));

vi.mock("../src/lib/redis", () => ({ redis: redisMock }));

// =============================================================
// System under test (imported after mocks)
// =============================================================

import {
  evaluateAllFlags,
  evaluateFlag,
  invalidateFlagCache,
} from "../src/services/flag-engine";

// =============================================================
// Test data builders
// =============================================================

interface RuleInput {
  audienceId: string;
  value: unknown;
  rolloutPercentage?: number | null;
}

function flag(
  overrides: {
    id?: string;
    key?: string;
    isEnabled?: boolean;
    defaultValue?: unknown;
    rules?: RuleInput[];
    type?: string;
    projectId?: string;
    description?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? "flag_1",
    projectId: overrides.projectId ?? "proj_a",
    key: overrides.key ?? "test-flag",
    type: overrides.type ?? "BOOLEAN",
    isEnabled: overrides.isEnabled ?? true,
    defaultValue: overrides.defaultValue ?? false,
    rules: overrides.rules ?? [],
    description: overrides.description ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function audience(
  id: string,
  rules: Record<string, unknown>,
  overrides: { name?: string; isDefault?: boolean } = {},
): Record<string, unknown> {
  return {
    id,
    projectId: "proj_a",
    name: overrides.name ?? id,
    description: null,
    rules,
    isDefault: overrides.isDefault ?? false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  redisStore.clear();
  setRedisMode("ok");
  prismaMock.featureFlag.findMany.mockResolvedValue([]);
  prismaMock.audience.findMany.mockResolvedValue([]);
});

// =============================================================
// evaluateFlag — kill switch, matches, defaults
// =============================================================

describe("evaluateFlag — kill switch", () => {
  test("disabled flag returns defaultValue regardless of rules", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({
        key: "kill-me",
        isEnabled: false,
        defaultValue: false,
        rules: [{ audienceId: "aud_all", value: true }],
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([audience("aud_all", {})]);

    const result = await evaluateFlag("proj_a", "kill-me", "sub_1", {
      country: "TR",
    });

    expect(result).toBe(false);
  });
});

describe("evaluateFlag — unknown flag", () => {
  test("returns null when the flag key does not exist", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([]);
    prismaMock.audience.findMany.mockResolvedValue([]);

    const result = await evaluateFlag("proj_a", "missing", "sub_1", {});

    expect(result).toBeNull();
  });
});

describe("evaluateFlag — rule matching", () => {
  test("first rule matches → returns its value", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({
        key: "new_paywall",
        rules: [{ audienceId: "aud_tr", value: true }],
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([
      audience("aud_tr", { country: "TR" }),
    ]);

    const result = await evaluateFlag("proj_a", "new_paywall", "sub_1", {
      country: "TR",
    });

    expect(result).toBe(true);
  });

  test("first rule's audience misses → second rule wins", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({
        key: "new_paywall",
        rules: [
          { audienceId: "aud_tr", value: "tr_version" },
          { audienceId: "aud_all", value: "default_version" },
        ],
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([
      audience("aud_tr", { country: "TR" }),
      audience("aud_all", {}, { isDefault: true }),
    ]);

    const result = await evaluateFlag("proj_a", "new_paywall", "sub_1", {
      country: "DE",
    });

    expect(result).toBe("default_version");
  });

  test("no rule matches → returns defaultValue", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({
        key: "new_paywall",
        defaultValue: "fallback",
        rules: [{ audienceId: "aud_tr", value: "tr_only" }],
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([
      audience("aud_tr", { country: "TR" }),
    ]);

    const result = await evaluateFlag("proj_a", "new_paywall", "sub_1", {
      country: "US",
    });

    expect(result).toBe("fallback");
  });

  test("skips rule whose audience no longer exists", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({
        key: "new_paywall",
        defaultValue: "fallback",
        rules: [
          { audienceId: "aud_deleted", value: "orphan" },
          { audienceId: "aud_all", value: "all_users" },
        ],
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([
      audience("aud_all", {}, { isDefault: true }),
    ]);

    const result = await evaluateFlag("proj_a", "new_paywall", "sub_1", {});

    expect(result).toBe("all_users");
  });
});

// =============================================================
// evaluateFlag — rollout gate
// =============================================================

describe("evaluateFlag — rollout", () => {
  test("rolloutPercentage=1 always returns the rule value", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({
        key: "new_paywall",
        rules: [
          { audienceId: "aud_all", value: true, rolloutPercentage: 1 },
        ],
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([
      audience("aud_all", {}, { isDefault: true }),
    ]);

    for (let i = 0; i < 20; i += 1) {
      const result = await evaluateFlag(
        "proj_a",
        "new_paywall",
        `sub_${i}`,
        {},
      );
      expect(result).toBe(true);
    }
  });

  test("rolloutPercentage=0 falls through to next rule / defaultValue", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({
        key: "new_paywall",
        defaultValue: "off",
        rules: [
          { audienceId: "aud_all", value: "on", rolloutPercentage: 0 },
        ],
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([
      audience("aud_all", {}, { isDefault: true }),
    ]);

    const result = await evaluateFlag("proj_a", "new_paywall", "sub_1", {});

    expect(result).toBe("off");
  });

  test("10% rollout hits ~10% of subscribers (±2%)", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({
        key: "canary",
        defaultValue: false,
        rules: [
          { audienceId: "aud_all", value: true, rolloutPercentage: 0.1 },
        ],
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([
      audience("aud_all", {}, { isDefault: true }),
    ]);

    // Reset the call counters so cache hits still count for the
    // drift measurement below.
    prismaMock.featureFlag.findMany.mockClear();

    let hits = 0;
    const N = 5_000;
    for (let i = 0; i < N; i += 1) {
      const v = await evaluateFlag("proj_a", "canary", `sub_${i}`, {});
      if (v === true) hits += 1;
    }
    const drift = Math.abs(hits / N - 0.1);
    expect(drift).toBeLessThan(0.02);
  });

  test("subscriber in matching audience but outside rollout falls through to lower-priority rule", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({
        key: "tiered",
        defaultValue: "default",
        rules: [
          { audienceId: "aud_tr", value: "tr_canary", rolloutPercentage: 0 },
          { audienceId: "aud_all", value: "everyone" },
        ],
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([
      audience("aud_tr", { country: "TR" }),
      audience("aud_all", {}, { isDefault: true }),
    ]);

    const result = await evaluateFlag("proj_a", "tiered", "sub_1", {
      country: "TR",
    });

    expect(result).toBe("everyone");
  });
});

// =============================================================
// Caching
// =============================================================

describe("flag-engine cache", () => {
  test("first call hits DB; second call uses Redis cache", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({ key: "cached", defaultValue: true }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([]);

    await evaluateFlag("proj_a", "cached", "sub_1", {});
    await evaluateFlag("proj_a", "cached", "sub_2", {});

    expect(prismaMock.featureFlag.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.audience.findMany).toHaveBeenCalledTimes(1);
    expect(redisMock.set).toHaveBeenCalledTimes(1);
  });

  test("cache key is scoped by project", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([flag({ key: "f" })]);
    prismaMock.audience.findMany.mockResolvedValue([]);

    await evaluateFlag("proj_a", "f", "sub_1", {});
    await evaluateFlag("proj_b", "f", "sub_1", {});

    expect(prismaMock.featureFlag.findMany).toHaveBeenCalledTimes(2);
  });

  test("Redis TTL is 60 seconds", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([flag()]);
    prismaMock.audience.findMany.mockResolvedValue([]);

    await evaluateFlag("proj_a", "test-flag", "sub_1", {});

    const [, , mode, ttl] = redisMock.set.mock.calls[0]!;
    expect(mode).toBe("EX");
    expect(ttl).toBe(60);
  });

  test("invalidateFlagCache forces next call to re-fetch from DB", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([flag()]);
    prismaMock.audience.findMany.mockResolvedValue([]);

    await evaluateFlag("proj_a", "test-flag", "sub_1", {});
    await invalidateFlagCache("proj_a");
    await evaluateFlag("proj_a", "test-flag", "sub_1", {});

    expect(prismaMock.featureFlag.findMany).toHaveBeenCalledTimes(2);
    expect(redisMock.del).toHaveBeenCalledWith("flags:proj_a");
  });

  test("Redis GET failure falls through to DB (fail open)", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({ key: "live", defaultValue: "ok" }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([]);

    setRedisMode("get-fail");
    const result = await evaluateFlag("proj_a", "live", "sub_1", {});

    expect(result).toBe("ok");
  });

  test("Redis SET failure does not swallow the result", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({ key: "live", defaultValue: "ok" }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([]);

    setRedisMode("set-fail");
    const result = await evaluateFlag("proj_a", "live", "sub_1", {});

    expect(result).toBe("ok");
  });
});

// =============================================================
// evaluateAllFlags
// =============================================================

describe("evaluateAllFlags", () => {
  test("returns a map of every enabled flag's evaluated value", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([
      flag({ key: "a", defaultValue: "a_default" }),
      flag({ key: "b", isEnabled: false, defaultValue: "b_default" }),
      flag({
        key: "c",
        defaultValue: 0,
        rules: [{ audienceId: "aud_all", value: 42 }],
      }),
    ]);
    prismaMock.audience.findMany.mockResolvedValue([
      audience("aud_all", {}, { isDefault: true }),
    ]);

    const result = await evaluateAllFlags("proj_a", "sub_1", {});

    expect(result).toEqual({
      a: "a_default",
      c: 42,
    });
    expect(result).not.toHaveProperty("b");
  });

  test("returns empty object for project with no flags", async () => {
    prismaMock.featureFlag.findMany.mockResolvedValue([]);
    prismaMock.audience.findMany.mockResolvedValue([]);

    const result = await evaluateAllFlags("proj_a", "sub_1", {});

    expect(result).toEqual({});
  });
});
