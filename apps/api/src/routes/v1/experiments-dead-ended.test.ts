// =============================================================
// POST /v1/experiments/track and /:id/expose on a dead-ended
// subscriber — unit tests
// =============================================================
//
// Closes two missing-coverage gaps from the Task 1 review:
//
//   - /track's guard (~line 105 of experiments.ts) shipped in commit
//     7fd70426 with no test at all.
//   - /expose's guard is the CRITICAL fix from the fix-round review: the
//     destructure took `deadEnded` but never read it, so an erased
//     subscriber still got a real assignment row + exposure event —
//     un-erasing them through a second path. Both need a test that
//     would have caught the original miss AND would catch a future
//     revert of either guard.
//
// `resolveSubscriberByRovenueId` → null + `findSubscriberByRovenueId` →
// the row is resolveSubscriberForWrite's "dead-ended" shape (soft-deleted,
// no live mergedInto survivor) — see resolve-or-create-subscriber.ts.

import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";

const publishExposureMock = vi.fn();
const findByIdInProjectMock = vi.fn();
const resolveSubscriberByRovenueIdMock = vi.fn();
const findSubscriberByRovenueIdMock = vi.fn();
const upsertSubscriberMock = vi.fn();
const insertAssignmentsSkipDuplicatesMock = vi.fn();
const recordEventMock = vi.fn();
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
      resolveSubscriberByRovenueId: (...args: unknown[]) =>
        resolveSubscriberByRovenueIdMock(...args),
      findSubscriberByRovenueId: (...args: unknown[]) =>
        findSubscriberByRovenueIdMock(...args),
      upsertSubscriber: (...args: unknown[]) => upsertSubscriberMock(...args),
    },
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

vi.mock("../../services/experiment-engine", () => ({
  recordEvent: (...args: unknown[]) => recordEventMock(...args),
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

function mockErased(rovenueId: string, dbId: string) {
  resolveSubscriberByRovenueIdMock.mockResolvedValue(null);
  findSubscriberByRovenueIdMock.mockResolvedValue({
    id: dbId,
    projectId: "proj_owner",
    rovenueId,
    deletedAt: new Date(),
  });
}

function mockLive(rovenueId: string, dbId: string) {
  resolveSubscriberByRovenueIdMock.mockResolvedValue({
    id: dbId,
    projectId: "proj_owner",
    rovenueId,
    deletedAt: null,
  });
}

beforeEach(() => {
  publishExposureMock.mockReset();
  publishExposureMock.mockResolvedValue(undefined);
  findByIdInProjectMock.mockReset();
  resolveSubscriberByRovenueIdMock.mockReset();
  findSubscriberByRovenueIdMock.mockReset();
  upsertSubscriberMock.mockReset();
  insertAssignmentsSkipDuplicatesMock.mockReset();
  insertAssignmentsSkipDuplicatesMock.mockResolvedValue(undefined);
  recordEventMock.mockReset();
  recordEventMock.mockResolvedValue(undefined);
  transactionMock.mockClear();
});

describe("POST /v1/experiments/track — dead-ended subscriber", () => {
  it("records NO conversion event for an erased subscriber, but still reports success", async () => {
    mockErased("erased_track_1", "sub_erased_track_1");

    const app = await buildApp();
    const res = await app.request("/v1/experiments/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rovenue-User-Id": "erased_track_1",
      },
      body: JSON.stringify({ events: [{ type: "purchase_completed" }] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { recorded: number } };
    // Success shape byte-for-byte: same `recorded` count a live subscriber
    // would get — no 4xx, no divergent body a caller could use to infer
    // erasure.
    expect(body.data.recorded).toBe(1);
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("records the conversion event for a live subscriber", async () => {
    // The mirror. Without it the test above passes against a route that
    // has stopped recording conversions for everyone.
    mockLive("live_track_1", "sub_live_track_1");

    const app = await buildApp();
    const res = await app.request("/v1/experiments/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rovenue-User-Id": "live_track_1",
      },
      body: JSON.stringify({ events: [{ type: "purchase_completed" }] }),
    });

    expect(res.status).toBe(200);
    expect(recordEventMock).toHaveBeenCalledTimes(1);
    expect(recordEventMock).toHaveBeenCalledWith(
      "sub_live_track_1",
      "purchase_completed",
      expect.any(Object),
    );
  });
});

describe("POST /v1/experiments/:id/expose — dead-ended subscriber", () => {
  const RUNNING_EXPERIMENT = {
    id: "exp_owned",
    projectId: "proj_owner",
    status: "RUNNING",
    variants: [{ id: "variant_a", name: "A", value: 1, weight: 1 }],
  };

  it("writes NO assignment row and publishes NO exposure for an erased subscriber, but still reports accepted", async () => {
    findByIdInProjectMock.mockResolvedValue(RUNNING_EXPERIMENT);
    mockErased("erased_expose_1", "sub_erased_expose_1");

    const app = await buildApp();
    const res = await app.request("/v1/experiments/exp_owned/expose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variantId: "variant_a",
        subscriberId: "erased_expose_1",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { accepted: boolean } };
    // Same success shape a live subscriber gets — see the assertion below.
    expect(body.data.accepted).toBe(true);

    // This is the CRITICAL regression: reverting the `deadEnded` check
    // in experiments.ts's /expose handler must make BOTH of these fail.
    expect(insertAssignmentsSkipDuplicatesMock).not.toHaveBeenCalled();
    expect(publishExposureMock).not.toHaveBeenCalled();
  });

  it("writes an assignment row and publishes an exposure for a live subscriber", async () => {
    // The mirror. Without it the test above passes against a route that
    // refuses to record exposures for anyone.
    findByIdInProjectMock.mockResolvedValue(RUNNING_EXPERIMENT);
    mockLive("live_expose_1", "sub_live_expose_1");

    const app = await buildApp();
    const res = await app.request("/v1/experiments/exp_owned/expose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        variantId: "variant_a",
        subscriberId: "live_expose_1",
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { accepted: boolean } };
    expect(body.data.accepted).toBe(true);

    expect(insertAssignmentsSkipDuplicatesMock).toHaveBeenCalledTimes(1);
    expect(insertAssignmentsSkipDuplicatesMock.mock.calls[0]?.[1]).toEqual([
      {
        experimentId: "exp_owned",
        subscriberId: "sub_live_expose_1",
        variantId: "variant_a",
        hashVersion: 1,
      },
    ]);
    expect(publishExposureMock).toHaveBeenCalledTimes(1);
    expect(publishExposureMock.mock.calls[0]?.[1]).toMatchObject({
      experimentId: "exp_owned",
      variantId: "variant_a",
      subscriberId: "sub_live_expose_1",
    });
  });
});
