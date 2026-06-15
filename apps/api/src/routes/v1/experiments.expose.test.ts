// =============================================================
// POST /v1/experiments/:id/expose — tenant-ownership unit tests
// =============================================================
//
// Regression coverage for P1-7 (Bug A): the exposure endpoint took
// a path `experimentId` + body `subscriberId` and wrote them to the
// outbox stamped with the CALLER's projectId, with no check that the
// experiment/subscriber belonged to that project. A shipped public
// API key could therefore poison ANOTHER project's analytics.
//
// The fix mirrors /track:
//   1. Load the experiment scoped to the project; cross-project id
//      surfaces as 404 and NO outbox row is written.
//   2. Resolve the client id to a project-owned subscriber via
//      upsertSubscriber and publish with that resolved id.
//
// @rovenue/db and the event-bus are mocked at the module boundary so
// the test needs no Postgres.

import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";

const publishExposureMock = vi.fn();
const findByIdInProjectMock = vi.fn();
const upsertSubscriberMock = vi.fn();
const transactionMock = vi.fn(async (cb: (tx: unknown) => unknown) =>
  cb({ __tx: true }),
);

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: { __db: true },
    experimentRepo: {
      findByIdInProject: (...args: unknown[]) => findByIdInProjectMock(...args),
    },
    subscriberRepo: {
      upsertSubscriber: (...args: unknown[]) => upsertSubscriberMock(...args),
    },
  },
  getDb: () => ({ transaction: transactionMock }),
}));

vi.mock("../../services/event-bus", () => ({
  eventBus: {
    publishExposure: (...args: unknown[]) => publishExposureMock(...args),
  },
}));

// recordEvent + computeExperimentResults are imported by the route
// module but unused on the expose path — stub to keep imports cheap.
vi.mock("../../services/experiment-engine", () => ({
  recordEvent: vi.fn(),
}));
vi.mock("../../services/experiment-results", () => ({
  computeExperimentResults: vi.fn(),
}));

async function buildApp() {
  const { experimentsRoute } = await import("./experiments");
  return new Hono()
    .use("*", async (c, next) => {
      c.set("project", { id: "proj_owner", name: "owner" } as never);
      await next();
    })
    .route("/v1/experiments", experimentsRoute);
}

const VALID_BODY = {
  variantId: "variant_a",
  subscriberId: "foreign_sub_xyz",
};

describe("POST /v1/experiments/:id/expose — tenant ownership", () => {
  beforeEach(() => {
    publishExposureMock.mockReset();
    publishExposureMock.mockResolvedValue(undefined);
    findByIdInProjectMock.mockReset();
    upsertSubscriberMock.mockReset();
    transactionMock.mockClear();
    upsertSubscriberMock.mockImplementation(async (_db: unknown, input: any) => ({
      id: `resolved_${input.rovenueId}`,
      projectId: input.projectId,
      rovenueId: input.rovenueId,
    }));
  });

  it("returns 404 and writes NO outbox row for a cross-project experiment id", async () => {
    // Experiment belongs to another project → scoped lookup returns null.
    findByIdInProjectMock.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.request("/v1/experiments/exp_other_proj/expose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(404);
    expect(findByIdInProjectMock).toHaveBeenCalledWith(
      { __db: true },
      "exp_other_proj",
      "proj_owner",
    );
    // No exposure published, no subscriber resolved.
    expect(publishExposureMock).not.toHaveBeenCalled();
    expect(upsertSubscriberMock).not.toHaveBeenCalled();
  });

  it("publishes the exposure with a project-owned subscriber id for a same-project experiment", async () => {
    findByIdInProjectMock.mockResolvedValue({
      id: "exp_owned",
      projectId: "proj_owner",
    });

    const app = await buildApp();
    const res = await app.request("/v1/experiments/exp_owned/expose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(200);

    // Subscriber resolved within the authenticated project.
    expect(upsertSubscriberMock).toHaveBeenCalledTimes(1);
    expect(upsertSubscriberMock.mock.calls[0]?.[1]).toMatchObject({
      projectId: "proj_owner",
      rovenueId: "foreign_sub_xyz",
      createAttributes: {},
    });

    // Exposure published with the RESOLVED id, not the raw foreign id.
    expect(publishExposureMock).toHaveBeenCalledTimes(1);
    const published = publishExposureMock.mock.calls[0]?.[1];
    expect(published).toMatchObject({
      experimentId: "exp_owned",
      variantId: "variant_a",
      projectId: "proj_owner",
      subscriberId: "resolved_foreign_sub_xyz",
    });
    expect(published.subscriberId).not.toBe("foreign_sub_xyz");
  });
});
