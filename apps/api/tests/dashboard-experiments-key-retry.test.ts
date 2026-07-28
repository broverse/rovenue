import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Experiment key collision → retry
// =============================================================
//
// CONTRACT CHANGE (deliberate, not lost coverage): this file originally
// (e3cebdc7, the .cause-unwrap fix) pinned an insert-then-catch-
// unique-violation retry loop for BOTH `POST /dashboard/experiments`
// and `POST /dashboard/experiments/:id/duplicate`. P7 Task 1 (d3db076d)
// replaced that with a generate → SELECT-precheck → single-INSERT
// strategy (`generateFreeExperimentKey` in experiment-create.ts): an
// insert-catch retry cannot work inside the §6.19 transaction (a unique
// violation aborts the enclosing tx, leaving nothing to retry into), the
// unique index remains only an integrity backstop — not a retry trigger
// — and a post-precheck insert race requires two concurrent requests
// generating the same cuid2 simultaneously (beyond astronomical). Task
// 1's implementer missed this file because it lives in apps/api/tests/
// (the separate top-level integration-style test dir), not src/, so it
// went stale pinning the retired behaviour. P7 deferred item 2 (see
// generateFreeExperimentKey call sites in experiments.ts) consolidated
// `duplicate` onto the same helper; this cleanup rewrites both describe
// blocks below to pin the CURRENT precheck contract.
//
// Every fixture here still throws the NESTED shape (drizzle 0.45.2
// rethrows every pg-core failure as a DrizzleQueryError and hangs the
// driver error off `.cause`) for the "propagates a genuine insert
// failure" cases, since that unwrap behaviour is unchanged.

const createExperiment = vi.hoisted(() => vi.fn());
const generateExperimentKey = vi.hoisted(() => vi.fn());
const findExperimentById = vi.hoisted(() => vi.fn());
const findExperimentByKey = vi.hoisted(() => vi.fn());
const findAudienceInProject = vi.hoisted(() => vi.fn());
const assertProjectCapability = vi.hoisted(() => vi.fn());
const invalidateExperimentCache = vi.hoisted(() => vi.fn());

vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "user_1" });
    await next();
  },
}));

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      experimentRepo: {
        ...actual.drizzle.experimentRepo,
        createExperiment,
        generateExperimentKey,
        findExperimentById,
        findExperimentByKey,
      },
      audienceRepo: { ...actual.drizzle.audienceRepo, findAudienceInProject },
    },
  };
});

vi.mock("../src/lib/capabilities", () => ({ assertProjectCapability }));
vi.mock("../src/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  extractRequestContext: () => ({ ipAddress: null, userAgent: null }),
}));
vi.mock("../src/services/experiment-engine", () => ({ invalidateExperimentCache }));

const { experimentsRoute } = await import("../src/routes/dashboard/experiments");
const { EXPERIMENT_KEY_MAX_ATTEMPTS } = await import("../src/services/experiment-create");
const { Hono } = await import("hono");

/** The unique index the retry loop is allowed to retry on. */
const KEY_UNIQUE = "experiments_projectId_key_key";

/**
 * A unique violation in the shape the route actually receives: the
 * driver error is not the thrown object, it is the thrown object's
 * `.cause`.
 */
function wrappedUniqueViolation(constraint: string): Error {
  const driver = Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    { code: "23505", constraint },
  );
  return Object.assign(new Error('Failed query: insert into "experiments" ...'), {
    cause: driver,
  });
}

const VARIANTS = [
  { id: "control", name: "Control", value: false, weight: 0.5 },
  { id: "variant_a", name: "A", value: true, weight: 0.5 },
];

function app() {
  return new Hono().route("/dashboard/experiments", experimentsRoute);
}

function createRequest() {
  return app().request("http://localhost/dashboard/experiments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "proj_a",
      name: "Test",
      type: "FLAG",
      audienceId: "aud_all",
      variants: VARIANTS,
    }),
  });
}

function duplicateRequest() {
  return app().request("http://localhost/dashboard/experiments/exp_1/duplicate", {
    method: "POST",
  });
}

describe("experiment key collisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let n = 0;
    generateExperimentKey.mockImplementation(() => `key_${(n += 1)}`);
    // No collision by default — generateFreeExperimentKey's precheck
    // finds the first generated key free.
    findExperimentByKey.mockResolvedValue(null);
    findAudienceInProject.mockResolvedValue({ id: "aud_all", projectId: "proj_a" });
    assertProjectCapability.mockResolvedValue(undefined);
    invalidateExperimentCache.mockResolvedValue(undefined);
    findExperimentById.mockResolvedValue({
      id: "exp_1",
      projectId: "proj_a",
      name: "Source",
      description: null,
      type: "FLAG",
      key: "key_source",
      audienceId: "aud_all",
      variants: VARIANTS,
      metrics: null,
      mutualExclusionGroup: null,
    });
  });

  describe("POST /dashboard/experiments", () => {
    it("regenerates the key when the PRECHECK finds the first key taken, then inserts once with the second key", async () => {
      findExperimentByKey
        .mockResolvedValueOnce({ id: "exp_existing" }) // key_1 taken
        .mockResolvedValueOnce(null); // key_2 free
      createExperiment.mockImplementation(
        async (_db: unknown, values: { key: string }) => ({ id: "exp_new", ...values }),
      );

      const res = await createRequest();

      expect(res.status).toBe(200);
      // ONE insert (never a wasted attempt) — the collision was resolved
      // by the SELECT-precheck, not by catching a failed insert.
      expect(findExperimentByKey).toHaveBeenCalledTimes(2);
      expect(createExperiment).toHaveBeenCalledTimes(1);
      expect(createExperiment).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ key: "key_2" }),
      );
      const body = (await res.json()) as { data: { experiment: { key: string } } };
      expect(body.data.experiment.key).toBe("key_2");
    });

    it("keeps prechecking up to the attempt budget, then gives up without ever inserting", async () => {
      findExperimentByKey.mockResolvedValue({ id: "exp_existing" }); // every candidate key collides

      const res = await createRequest();

      expect(res.status).toBe(500);
      expect(findExperimentByKey).toHaveBeenCalledTimes(EXPERIMENT_KEY_MAX_ATTEMPTS);
      // The precheck loop never got to a free key, so INSERT is never reached.
      expect(createExperiment).not.toHaveBeenCalled();
    });

    it("propagates a genuine insert failure without retrying (no catch-loop left)", async () => {
      findExperimentByKey.mockResolvedValue(null); // precheck never collides
      createExperiment.mockRejectedValue(wrappedUniqueViolation(KEY_UNIQUE));

      const res = await createRequest();

      // Even a violation of the KEY unique index itself no longer
      // triggers a retry — the precheck already found the key free, so
      // this can only be the astronomically-unlikely concurrent-insert
      // race, and it surfaces immediately rather than looping.
      expect(res.status).toBe(500);
      expect(createExperiment).toHaveBeenCalledTimes(1);
    });

    it("does not retry a unique violation of a DIFFERENT index", async () => {
      findExperimentByKey.mockResolvedValue(null);
      createExperiment.mockRejectedValue(wrappedUniqueViolation("experiments_pkey"));

      const res = await createRequest();

      expect(res.status).toBe(500);
      expect(createExperiment).toHaveBeenCalledTimes(1);
    });

    it("does not retry a non-unique-violation error", async () => {
      createExperiment.mockRejectedValue(
        Object.assign(new Error("Failed query"), {
          cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
        }),
      );

      const res = await createRequest();

      expect(res.status).toBe(500);
      expect(createExperiment).toHaveBeenCalledTimes(1);
    });
  });

  // Mirrors experiment-create.test.ts's collision cases: duplicate now
  // shares generateFreeExperimentKey with createExperimentValidated, so
  // a collision is resolved by the SELECT-precheck BEFORE any insert is
  // attempted — never by catching an insert failure and retrying.
  describe("POST /dashboard/experiments/:id/duplicate", () => {
    it("regenerates the key when the precheck finds the first key taken, then inserts once with the second key", async () => {
      findExperimentByKey
        .mockResolvedValueOnce({ id: "exp_existing" }) // key_1 taken
        .mockResolvedValueOnce(null); // key_2 free
      createExperiment.mockImplementation(
        async (_db: unknown, values: { key: string }) => ({ id: "exp_new", ...values }),
      );

      const res = await duplicateRequest();

      expect(res.status).toBe(200);
      expect(findExperimentByKey).toHaveBeenCalledTimes(2);
      expect(createExperiment).toHaveBeenCalledTimes(1);
      expect(createExperiment).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ key: "key_2" }),
      );
      const body = (await res.json()) as { data: { experiment: { key: string } } };
      expect(body.data.experiment.key).toBe("key_2");
    });

    it("propagates a genuine insert failure without retrying (no catch-loop left)", async () => {
      findExperimentByKey.mockResolvedValue(null); // precheck never collides
      createExperiment.mockRejectedValue(wrappedUniqueViolation("experiments_pkey"));

      const res = await duplicateRequest();

      expect(res.status).toBe(500);
      expect(createExperiment).toHaveBeenCalledTimes(1);
    });
  });
});
