import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted Redis + drizzle + env mocks
// =============================================================

const { redisMock, redisStore } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const makePipeline = () => {
    const ops: Array<() => void> = [];
    const api = {
      set: vi.fn((key: string, value: string, _ex?: string, _ttl?: number) => {
        ops.push(() => store.set(key, value));
        return api;
      }),
      exec: vi.fn(async () => {
        for (const op of ops) op();
        return [];
      }),
    };
    return api;
  };
  const redisMock = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(
      async (key: string, value: string, _ex?: string, _ttl?: number) => {
        store.set(key, value);
        return "OK";
      },
    ),
    pipeline: vi.fn(() => makePipeline()),
  };
  return { redisMock, redisStore: store };
});

const { dbMock, fxRateRepoMock } = vi.hoisted(() => {
  const fxRateRepoMock = {
    upsertDailyRates: vi.fn(async () => undefined),
    getRate: vi.fn(async (_db: unknown, _date: string, _quote: string) => null as string | null),
    getRatesForRange: vi.fn(async () => []),
  };
  const dbMock = {} as unknown;
  return { dbMock, fxRateRepoMock };
});

const { envMock } = vi.hoisted(() => ({
  envMock: {
    OPEN_EXCHANGE_RATES_APP_ID: "test-app-id",
    REDIS_URL: "redis://localhost:6379",
    NODE_ENV: "test" as const,
  },
}));

vi.mock("../src/lib/redis", () => ({ redis: redisMock }));
vi.mock("../src/lib/env", () => ({ env: envMock }));
vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: dbMock,
    fxRateRepo: fxRateRepoMock,
  },
}));

// =============================================================
// System under test
// =============================================================

import {
  convertToUsd,
  fetchAndCacheRates,
  STATIC_USD_RATES,
} from "../src/services/fx";

// =============================================================
// Helpers
// =============================================================

beforeEach(() => {
  vi.clearAllMocks();
  redisStore.clear();
  fxRateRepoMock.getRate.mockResolvedValue(null);
  fxRateRepoMock.upsertDailyRates.mockResolvedValue(undefined);
  envMock.OPEN_EXCHANGE_RATES_APP_ID = "test-app-id";
});

// =============================================================
// convertToUsd — cache hit
// =============================================================

describe("convertToUsd — cached rate", () => {
  test("uses the date-specific cached rate when available", async () => {
    redisStore.set("fx:2026-04-15:TRY:USD", "0.03");

    const result = await convertToUsd(100, "TRY", new Date("2026-04-15"));

    expect(result).toBeCloseTo(3);
    expect(redisMock.get).toHaveBeenCalledWith("fx:2026-04-15:TRY:USD");
    expect(fxRateRepoMock.getRate).not.toHaveBeenCalled();
  });

  test("uses the latest cached rate when no date-specific rate exists", async () => {
    redisStore.set("fx:latest:EUR:USD", "1.08");

    const result = await convertToUsd(50, "EUR", new Date("2026-04-15"));

    expect(result).toBeCloseTo(54);
    expect(fxRateRepoMock.getRate).not.toHaveBeenCalled();
  });

  test("USD → USD returns the original amount without a lookup", async () => {
    const result = await convertToUsd(99.99, "USD");
    expect(result).toBe(99.99);
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(fxRateRepoMock.getRate).not.toHaveBeenCalled();
  });
});

// =============================================================
// convertToUsd — Postgres fallback
// =============================================================

describe("convertToUsd — Postgres fallback", () => {
  test("uses fx_rates row when both Redis lookups miss", async () => {
    // PG `rate` is foreign-per-USD (e.g. 1 USD = 33.5 TRY).
    // convertToUsd divides: 100 TRY ÷ 33.5 ≈ 2.985 USD
    fxRateRepoMock.getRate.mockResolvedValue("33.5");

    const result = await convertToUsd(100, "TRY", new Date("2026-04-15"));

    expect(fxRateRepoMock.getRate).toHaveBeenCalledWith(
      dbMock,
      "2026-04-15",
      "TRY",
    );
    expect(result).toBeCloseTo(100 / 33.5, 4);
  });

  test("falls through to static when Postgres returns null", async () => {
    fxRateRepoMock.getRate.mockResolvedValue(null);

    const result = await convertToUsd(100, "TRY");

    expect(fxRateRepoMock.getRate).toHaveBeenCalled();
    expect(result).toBeCloseTo(100 * STATIC_USD_RATES.TRY!);
  });

  test("falls through to static when Postgres throws", async () => {
    fxRateRepoMock.getRate.mockRejectedValue(new Error("pg down"));

    const result = await convertToUsd(100, "EUR");

    expect(result).toBeCloseTo(100 * STATIC_USD_RATES.EUR!);
  });
});

// =============================================================
// convertToUsd — static fallback
// =============================================================

describe("convertToUsd — static fallback", () => {
  test("falls back to the static rate table when cache + pg miss", async () => {
    const result = await convertToUsd(100, "TRY");
    expect(result).toBeCloseTo(100 * STATIC_USD_RATES.TRY!);
  });

  test("unknown currency passes through 1:1", async () => {
    const result = await convertToUsd(42, "XYZ");
    expect(result).toBe(42);
  });
});

// =============================================================
// convertToUsd — Redis failure
// =============================================================

describe("convertToUsd — Redis failure", () => {
  test("falls back through pg to static when Redis throws", async () => {
    redisMock.get.mockRejectedValue(new Error("redis down"));
    fxRateRepoMock.getRate.mockResolvedValue(null);

    const result = await convertToUsd(100, "EUR");

    expect(result).toBeCloseTo(100 * STATIC_USD_RATES.EUR!);
  });
});

// =============================================================
// fetchAndCacheRates
// =============================================================

describe("fetchAndCacheRates", () => {
  test("fetches from OpenExchangeRates, writes Postgres then Redis", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      // app_id is passed as a query param, not a header
      expect(url).toContain("openexchangerates.org/api/latest.json");
      expect(url).toContain("app_id=test-app-id");
      return {
        ok: true,
        json: async () => ({
          base: "USD",
          rates: { EUR: 0.93, GBP: 0.79, TRY: 33.5, JPY: 148.2 },
          timestamp: 1234567890,
        }),
      };
    }) as unknown as typeof fetch;

    await fetchAndCacheRates("2026-04-15", mockFetch);

    // Postgres canonical: rate stored as foreign-per-USD verbatim
    expect(fxRateRepoMock.upsertDailyRates).toHaveBeenCalledTimes(1);
    const [, pgRows] = fxRateRepoMock.upsertDailyRates.mock.calls[0]!;
    expect(pgRows).toHaveLength(4);
    expect(pgRows).toContainEqual({
      date: "2026-04-15",
      base: "USD",
      quote: "EUR",
      rate: "0.93",
    });

    // Redis cache: USD-per-foreign (1/rate)
    expect(redisMock.pipeline).toHaveBeenCalled();
    expect(redisStore.get("fx:2026-04-15:EUR:USD")).toBeDefined();
    expect(redisStore.get("fx:latest:EUR:USD")).toBeDefined();
    const eurRate = parseFloat(redisStore.get("fx:2026-04-15:EUR:USD")!);
    expect(eurRate).toBeCloseTo(1 / 0.93, 6);
  });

  test("skips the fetch entirely when OPEN_EXCHANGE_RATES_APP_ID is blank", async () => {
    envMock.OPEN_EXCHANGE_RATES_APP_ID = "";
    const mockFetch = vi.fn() as unknown as typeof fetch;

    await fetchAndCacheRates("2026-04-15", mockFetch);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(fxRateRepoMock.upsertDailyRates).not.toHaveBeenCalled();
  });

  test("does not throw when the API returns an error", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(
      fetchAndCacheRates("2026-04-15", mockFetch),
    ).resolves.not.toThrow();
    expect(fxRateRepoMock.upsertDailyRates).not.toHaveBeenCalled();
  });

  test("does not throw when the API payload has error=true", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ error: true, status: 401, message: "invalid_app_id" }),
    })) as unknown as typeof fetch;

    await expect(
      fetchAndCacheRates("2026-04-15", mockFetch),
    ).resolves.not.toThrow();
    expect(fxRateRepoMock.upsertDailyRates).not.toHaveBeenCalled();
  });

  test("still mirrors to Redis when Postgres upsert fails", async () => {
    fxRateRepoMock.upsertDailyRates.mockRejectedValue(new Error("pg down"));
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        base: "USD",
        rates: { EUR: 0.93 },
      }),
    })) as unknown as typeof fetch;

    await fetchAndCacheRates("2026-04-15", mockFetch);

    expect(redisStore.get("fx:2026-04-15:EUR:USD")).toBeDefined();
  });
});
