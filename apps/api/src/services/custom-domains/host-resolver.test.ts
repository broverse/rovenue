import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Custom-domain host resolver — Redis failure falls back to PG (unit)
// =============================================================
//
// resolveHost documents itself as "Redis hot path with Postgres
// fallback", but an unguarded `redis.get` meant a Redis *error* (as
// opposed to a miss) threw before the Postgres lookup ran, 500-ing every
// custom-domain page load during a Redis blip. Contract pinned here: a
// Redis error behaves exactly like a miss — the DB still answers — and
// cache writes never throw.
// =============================================================

const { redisMock, findByHostnameMock, dbSelectResult } = vi.hoisted(() => ({
  redisMock: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  findByHostnameMock: vi.fn(),
  dbSelectResult: { rows: [] as unknown[] },
}));

vi.mock("../../lib/redis", () => ({ redis: redisMock }));

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: () => ({
          then: (fn: (rows: unknown[]) => unknown) => fn(dbSelectResult.rows),
        }),
      }),
    }),
  });
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: { select },
      customDomainRepo: {
        ...actual.drizzle.customDomainRepo,
        findByHostname: findByHostnameMock,
      },
    },
  };
});

import { resolveHost, invalidateHost } from "./host-resolver";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveHost Redis failure modes", () => {
  test("Redis get error behaves as a miss — Postgres still resolves the host", async () => {
    redisMock.get.mockRejectedValue(new Error("connection refused"));
    redisMock.set.mockRejectedValue(new Error("connection refused"));
    findByHostnameMock.mockResolvedValue({
      funnelId: "fnl_1",
      verifiedAt: new Date(),
      certStatus: "issued",
    });
    dbSelectResult.rows = [{ slug: "quiz", status: "published" }];

    await expect(resolveHost("quiz.acme.com")).resolves.toEqual({
      funnelId: "fnl_1",
      slug: "quiz",
    });
  });

  test("invalidateHost swallows Redis errors", async () => {
    redisMock.del.mockRejectedValue(new Error("connection refused"));
    await expect(invalidateHost("quiz.acme.com")).resolves.toBeUndefined();
  });
});
