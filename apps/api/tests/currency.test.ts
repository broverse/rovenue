import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted Redis mock
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

vi.mock("../src/lib/redis", () => ({ redis: redisMock }));

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
  });

  test("uses the latest cached rate when no date-specific rate exists", async () => {
    redisStore.set("fx:latest:EUR:USD", "1.08");

    const result = await convertToUsd(50, "EUR", new Date("2026-04-15"));

    expect(result).toBeCloseTo(54);
  });

  test("USD → USD returns the original amount without a lookup", async () => {
    const result = await convertToUsd(99.99, "USD");
    expect(result).toBe(99.99);
    expect(redisMock.get).not.toHaveBeenCalled();
  });
});

// =============================================================
// convertToUsd — static fallback
// =============================================================

describe("convertToUsd — static fallback", () => {
  test("falls back to the static rate table when cache misses", async () => {
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
  test("falls back to static rates when Redis throws", async () => {
    redisMock.get.mockRejectedValue(new Error("redis down"));

    const result = await convertToUsd(100, "EUR");

    expect(result).toBeCloseTo(100 * STATIC_USD_RATES.EUR!);
  });
});

// =============================================================
// fetchAndCacheRates
// =============================================================

describe("fetchAndCacheRates", () => {
  test("fetches rates from the API and stores them in Redis", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        base: "USD",
        rates: { EUR: 0.93, GBP: 0.79, TRY: 33.5, JPY: 148.2 },
      }),
    })) as unknown as typeof fetch;

    await fetchAndCacheRates("2026-04-15", mockFetch);

    expect(redisMock.pipeline).toHaveBeenCalled();
    // Date-specific cache: fx:2026-04-15:EUR:USD
    expect(redisStore.get("fx:2026-04-15:EUR:USD")).toBeDefined();
    // Latest fallback: fx:latest:EUR:USD
    expect(redisStore.get("fx:latest:EUR:USD")).toBeDefined();

    // Rate stored is the inverse (1/rate) because API base=USD gives
    // foreign-per-USD, and we want USD-per-foreign.
    const eurRate = parseFloat(redisStore.get("fx:2026-04-15:EUR:USD")!);
    expect(eurRate).toBeCloseTo(1 / 0.93, 6);
  });

  test("does not throw when the API returns an error", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(fetchAndCacheRates("2026-04-15", mockFetch)).resolves.not.toThrow();
  });

  test("does not throw when the API response is malformed", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: false }),
    })) as unknown as typeof fetch;

    await expect(fetchAndCacheRates("2026-04-15", mockFetch)).resolves.not.toThrow();
  });
});
