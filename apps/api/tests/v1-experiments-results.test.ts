import { beforeAll, describe, expect, it, vi } from "vitest";

// =============================================================
// GET /v1/experiments/:id/results — route test
// =============================================================
//
// Source: superseded plan Task 8.2, adapted for this repo's
// apiKeyAuth factory + `c.get("project").id` context key.

vi.mock("../src/services/experiment-results", () => ({
  computeExperimentResults: vi.fn(async (experimentId: string) => ({
    experimentId,
    status: "RUNNING",
    variants: [
      { variantId: "control", exposures: 1000, uniqueUsers: 950 },
      { variantId: "treatment", exposures: 1010, uniqueUsers: 960 },
    ],
    conversion: null,
    revenue: null,
    srm: { chi2: 0.1, df: 1, pValue: 0.75, isMismatch: false, message: "ok" },
    sampleSize: null,
  })),
}));

// Stub the other service deps that experiments.ts pulls in.
vi.mock("../src/services/experiment-engine", () => ({
  recordEvent: vi.fn(async () => undefined),
}));
vi.mock("../src/services/event-bus", () => ({
  eventBus: { publishExposure: vi.fn(async () => undefined) },
}));
vi.mock("@rovenue/db", () => ({
  getDb: () => ({
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb({}),
  }),
  drizzle: {
    db: {} as unknown,
    subscriberRepo: {
      upsertSubscriber: vi.fn(async () => ({ id: "sub_stub" })),
    },
    outboxRepo: { insert: vi.fn(async () => undefined) },
  },
}));

import { Hono } from "hono";
import { experimentsRoute } from "../src/routes/v1/experiments";

let app: Hono;
beforeAll(() => {
  app = new Hono()
    .use("*", async (c, next) => {
      c.set("project", {
        id: "proj_test",
        name: "Test",
        slug: "test",
        keyKind: "public",
        apiKeyId: "key_1",
      } as never);
      await next();
    })
    .route("/v1/experiments", experimentsRoute);
});

describe("GET /v1/experiments/:id/results", () => {
  it("returns the CH-backed computation wrapped in {data: ...}", async () => {
    const res = await app.request("/v1/experiments/exp_a/results");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { experimentId: string; variants: unknown[] };
    };
    expect(body.data.experimentId).toBe("exp_a");
    expect(body.data.variants).toHaveLength(2);
  });
});
