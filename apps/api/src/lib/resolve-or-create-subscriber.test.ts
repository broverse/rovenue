import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveByRovenueId, findByRovenueId, upsert } = vi.hoisted(() => ({
  resolveByRovenueId: vi.fn(),
  findByRovenueId: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {},
    subscriberRepo: {
      resolveSubscriberByRovenueId: resolveByRovenueId,
      findSubscriberByRovenueId: findByRovenueId,
      upsertSubscriber: upsert,
    },
  },
}));

import {
  resolveOrCreateSubscriber,
  resolveSubscriberForWrite,
} from "./resolve-or-create-subscriber";

beforeEach(() => {
  resolveByRovenueId.mockReset();
  findByRovenueId.mockReset();
  findByRovenueId.mockResolvedValue(null);
  upsert.mockReset();
});

describe("resolveOrCreateSubscriber", () => {
  it("returns the existing subscriber without creating", async () => {
    resolveByRovenueId.mockResolvedValue({ id: "s1", rovenueId: "r1" });
    const { subscriber: sub } = await resolveOrCreateSubscriber("p1", "r1");
    expect(sub).toEqual({ id: "s1", rovenueId: "r1" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("creates a minimal anonymous subscriber when none exists", async () => {
    resolveByRovenueId.mockResolvedValue(null);
    upsert.mockResolvedValue({ id: "s2", rovenueId: "r2" });
    const { subscriber: sub } = await resolveOrCreateSubscriber("p1", "r2");
    expect(sub).toEqual({ id: "s2", rovenueId: "r2" });
    // This wrapper is reachable only from the SDK's public-key /v1
    // surface, so creating here IS an install: it stamps
    // `sdkInstalledAt`. Asserted as an instant rather than a
    // truthiness check so a future change to `null` fails here.
    expect(upsert).toHaveBeenCalledWith({}, {
      projectId: "p1",
      rovenueId: "r2",
      createAttributes: {},
      sdkInstalledAt: expect.any(Date),
    });
  });

  it("follows the merge chain instead of upserting onto a retired row", async () => {
    // resolveSubscriberByRovenueId walks mergedInto to the live survivor;
    // the contract pinned here is that the survivor wins and NO upsert
    // happens (upsert's ON CONFLICT target is the full unique index and
    // would hand back the soft-deleted row).
    resolveByRovenueId.mockResolvedValue({ id: "s_live", rovenueId: "r_old" });
    const { subscriber: sub } = await resolveOrCreateSubscriber("p1", "r_old");
    expect(sub.id).toBe("s_live");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("passes `deadEnded: true` through from resolveSubscriberForWrite", async () => {
    // The bug this whole sub-project's Task 1 exists to fix: this wrapper
    // used to destructure `{ subscriber }` and drop `deadEnded` on the
    // floor, so every caller behind it (this is the ONLY entry point the
    // SDK's public-key /v1 surface uses) silently lost the flag and wrote
    // onto soft-deleted rows. resolveSubscriberForWrite's own test already
    // covers the underlying computation; this one covers the wrapper not
    // re-dropping it.
    resolveByRovenueId.mockResolvedValue(null);
    findByRovenueId.mockResolvedValue({
      id: "s_dead_wrapper",
      rovenueId: "r_erased_wrapper",
      deletedAt: new Date(),
      mergedInto: null,
    });

    const result = await resolveOrCreateSubscriber("p1", "r_erased_wrapper");

    expect(result.deadEnded).toBe(true);
    expect(result.subscriber.id).toBe("s_dead_wrapper");
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("resolveSubscriberForWrite", () => {
  it("flags a dead-ended row and does NOT create/upsert over it", async () => {
    // A soft-deleted row with no live mergedInto survivor (GDPR erasure)
    // must not be resurrected by an SDK write, and the full unique index
    // forbids creating a fresh row under the same rovenueId.
    resolveByRovenueId.mockResolvedValue(null);
    findByRovenueId.mockResolvedValue({
      id: "s_dead",
      rovenueId: "r_erased",
      deletedAt: new Date(),
      mergedInto: null,
    });

    const result = await resolveSubscriberForWrite("p1", "r_erased");

    expect(result.deadEnded).toBe(true);
    expect(result.subscriber.id).toBe("s_dead");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("passes createAttributes through on the create path", async () => {
    resolveByRovenueId.mockResolvedValue(null);
    upsert.mockResolvedValue({ id: "s3", rovenueId: "r3" });

    const result = await resolveSubscriberForWrite("p1", "r3", { a: 1 });

    expect(result.deadEnded).toBe(false);
    // NULL sdkInstalledAt on this lower-level entry point, deliberately:
    // the CSV importer calls it directly, and an imported subscriber is
    // not an install. Only `resolveOrCreateSubscriber` opts in.
    expect(upsert).toHaveBeenCalledWith({}, {
      projectId: "p1",
      rovenueId: "r3",
      createAttributes: { a: 1 },
      sdkInstalledAt: null,
    });
  });
});
