import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// POST /v1/experiments/:id/expose — route-level test
// =============================================================
//
// Mounts the inner `experimentsRoute` directly so we bypass the
// /v1 parent's apiKeyAuth + rate-limit chain (both require Redis
// and a real API key row). The expose handler receives a
// pre-populated `project` context via a light middleware shim.

const publishExposureMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../src/services/event-bus", () => ({
  eventBus: { publishExposure: publishExposureMock },
}));

vi.mock("@rovenue/db", () => ({
  getDb: () => ({
    // `drizzle-orm` db.transaction(cb) passes a tx handle; we
    // just invoke the callback with a stub.
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

// experiment-engine is imported by the /track handler. We stub
// it so the module graph doesn't drag in Redis.
vi.mock("../src/services/experiment-engine", () => ({
  recordEvent: vi.fn(async () => undefined),
}));

import { Hono } from "hono";
import { experimentsRoute } from "../src/routes/v1/experiments";

function buildApp() {
  return new Hono()
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
}

describe("POST /v1/experiments/:id/expose", () => {
  beforeEach(() => {
    publishExposureMock.mockReset();
    publishExposureMock.mockResolvedValue(undefined);
  });

  it("calls eventBus.publishExposure inside a transaction and returns 200", async () => {
    const app = buildApp();
    const res = await app.request("/v1/experiments/exp_1/expose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        variantId: "control",
        subscriberId: "sub_1",
        platform: "ios",
        country: "US",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { accepted: boolean } };
    expect(body.data.accepted).toBe(true);
    expect(publishExposureMock).toHaveBeenCalledTimes(1);
    const [, input] = publishExposureMock.mock.calls[0]!;
    expect(input).toMatchObject({
      experimentId: "exp_1",
      variantId: "control",
      projectId: "proj_test",
      subscriberId: "sub_1",
      platform: "ios",
      country: "US",
    });
  });

  it("rejects missing variantId with 400", async () => {
    const app = buildApp();
    const res = await app.request("/v1/experiments/exp_1/expose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscriberId: "sub_1" }),
    });
    expect(res.status).toBe(400);
    expect(publishExposureMock).not.toHaveBeenCalled();
  });
});
