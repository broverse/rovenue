import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Experiment key collision → retry
// =============================================================
//
// The experiment key is backend-assigned, and both create and duplicate
// wrap the insert in a bounded retry loop so a cuid2 clash regenerates
// instead of failing the request. The loop's guard used to read
// `err.code === "23505"` off the caught error — but drizzle 0.45.2
// rethrows every pg-core failure as a DrizzleQueryError and hangs the
// driver error off `.cause`, so the guard never matched, `continue` was
// dead code, and a real collision 500'd on the first attempt.
//
// Every fixture here therefore throws the NESTED shape. A test that
// threw a flat `{ code: "23505" }` would pass against the broken loop
// and prove nothing.

const createExperiment = vi.hoisted(() => vi.fn());
const generateExperimentKey = vi.hoisted(() => vi.fn());
const findExperimentById = vi.hoisted(() => vi.fn());
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

/**
 * Reject the first `failures` calls with a key collision, then succeed —
 * echoing back whichever key that winning attempt generated.
 */
function collideThenSucceed(failures: number, constraint = KEY_UNIQUE) {
  let call = 0;
  createExperiment.mockImplementation(async (_db: unknown, values: { key: string }) => {
    call += 1;
    if (call <= failures) throw wrappedUniqueViolation(constraint);
    return { id: "exp_new", ...values };
  });
}

describe("experiment key collisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let n = 0;
    generateExperimentKey.mockImplementation(() => `key_${(n += 1)}`);
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
    it("regenerates the key and retries when the insert collides", async () => {
      collideThenSucceed(1);

      const res = await createRequest();

      expect(res.status).toBe(200);
      // Two inserts, and the second used a FRESH key — a loop that
      // retried with the same key would spin against the same index.
      expect(createExperiment).toHaveBeenCalledTimes(2);
      const keys = createExperiment.mock.calls.map((c) => (c[1] as { key: string }).key);
      expect(keys).toEqual(["key_1", "key_2"]);
      expect(new Set(keys).size).toBe(2);
      const body = (await res.json()) as { data: { experiment: { key: string } } };
      expect(body.data.experiment.key).toBe("key_2");
    });

    it("keeps retrying up to the attempt budget", async () => {
      collideThenSucceed(4);

      const res = await createRequest();

      expect(res.status).toBe(200);
      expect(createExperiment).toHaveBeenCalledTimes(5);
    });

    it("gives up once the budget is exhausted instead of looping forever", async () => {
      createExperiment.mockRejectedValue(wrappedUniqueViolation(KEY_UNIQUE));

      const res = await createRequest();

      expect(res.status).toBe(500);
      expect(createExperiment).toHaveBeenCalledTimes(5);
    });

    it("does not retry a unique violation of a DIFFERENT index", async () => {
      // Regenerating the key cannot clear a violation the key had no
      // part in, so retrying it would only burn the budget and report
      // the wrong error.
      collideThenSucceed(1, "experiments_pkey");

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

  describe("POST /dashboard/experiments/:id/duplicate", () => {
    it("regenerates the key and retries when the copy's insert collides", async () => {
      collideThenSucceed(1);

      const res = await duplicateRequest();

      expect(res.status).toBe(200);
      expect(createExperiment).toHaveBeenCalledTimes(2);
      const keys = createExperiment.mock.calls.map((c) => (c[1] as { key: string }).key);
      expect(new Set(keys).size).toBe(2);
    });

    it("does not retry a unique violation of a DIFFERENT index", async () => {
      collideThenSucceed(1, "experiments_pkey");

      const res = await duplicateRequest();

      expect(res.status).toBe(500);
      expect(createExperiment).toHaveBeenCalledTimes(1);
    });
  });
});
