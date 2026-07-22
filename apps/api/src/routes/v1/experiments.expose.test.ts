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
const insertAssignmentsSkipDuplicatesMock = vi.fn();
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
    // Lazy assignment persist (Task 5) — the expose handler calls this
    // right after subscriber resolution, before publishExposure.
    experimentAssignmentRepo: {
      insertAssignmentsSkipDuplicates: (...args: unknown[]) =>
        insertAssignmentsSkipDuplicatesMock(...args),
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
    insertAssignmentsSkipDuplicatesMock.mockReset();
    insertAssignmentsSkipDuplicatesMock.mockResolvedValue(undefined);
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
      status: "RUNNING",
      variants: [
        { id: "control", name: "Control", value: 0, weight: 1 },
        { id: "variant_a", name: "A", value: 1, weight: 1 },
      ],
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

    // Lazy assignment persisted with the RESOLVED subscriber id too.
    expect(insertAssignmentsSkipDuplicatesMock).toHaveBeenCalledTimes(1);
    expect(insertAssignmentsSkipDuplicatesMock.mock.calls[0]?.[1]).toEqual([
      {
        experimentId: "exp_owned",
        subscriberId: "resolved_foreign_sub_xyz",
        variantId: "variant_a",
        hashVersion: 1,
      },
    ]);
  });
});

describe("POST /v1/experiments/:id/expose — variant + status validation", () => {
  beforeEach(() => {
    publishExposureMock.mockReset();
    publishExposureMock.mockResolvedValue(undefined);
    findByIdInProjectMock.mockReset();
    upsertSubscriberMock.mockReset();
    insertAssignmentsSkipDuplicatesMock.mockReset();
    insertAssignmentsSkipDuplicatesMock.mockResolvedValue(undefined);
    transactionMock.mockClear();
    upsertSubscriberMock.mockImplementation(async (_db: unknown, input: any) => ({
      id: `resolved_${input.rovenueId}`,
      projectId: input.projectId,
      rovenueId: input.rovenueId,
    }));
  });

  it("returns 400 and publishes NOTHING when variantId is not one of the experiment's variants", async () => {
    findByIdInProjectMock.mockResolvedValue({
      id: "exp_owned",
      projectId: "proj_owner",
      status: "RUNNING",
      // Note: no "variant_a" here — VALID_BODY's variantId is bogus.
      variants: [
        { id: "control", name: "Control", value: 0, weight: 1 },
        { id: "variant_b", name: "B", value: 2, weight: 1 },
      ],
    });

    const app = await buildApp();
    const res = await app.request("/v1/experiments/exp_owned/expose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(400);
    // Validation happens before subscriber resolution + outbox write.
    expect(publishExposureMock).not.toHaveBeenCalled();
    expect(upsertSubscriberMock).not.toHaveBeenCalled();
  });

  it("returns 409 and publishes NOTHING when the experiment is not RUNNING", async () => {
    findByIdInProjectMock.mockResolvedValue({
      id: "exp_owned",
      projectId: "proj_owner",
      status: "DRAFT",
      variants: [{ id: "variant_a", name: "A", value: 1, weight: 1 }],
    });

    const app = await buildApp();
    const res = await app.request("/v1/experiments/exp_owned/expose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(409);
    expect(publishExposureMock).not.toHaveBeenCalled();
    expect(upsertSubscriberMock).not.toHaveBeenCalled();
  });

  it("publishes when variantId is a valid member of a RUNNING experiment", async () => {
    findByIdInProjectMock.mockResolvedValue({
      id: "exp_owned",
      projectId: "proj_owner",
      status: "RUNNING",
      variants: [
        { id: "control", name: "Control", value: 0, weight: 1 },
        { id: "variant_a", name: "A", value: 1, weight: 1 },
      ],
    });

    const app = await buildApp();
    const res = await app.request("/v1/experiments/exp_owned/expose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(200);
    expect(publishExposureMock).toHaveBeenCalledTimes(1);
    expect(publishExposureMock.mock.calls[0]?.[1]).toMatchObject({
      experimentId: "exp_owned",
      variantId: "variant_a",
    });
  });
});
