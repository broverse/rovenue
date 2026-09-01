import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE,
  IMPORT_STATUS_POLL_RATE_LIMIT_PER_MINUTE,
} from "@rovenue/shared";

// =============================================================
// Job lifecycle routes for the data-import tool (Task 10)
//
// PATCH .../imports/:id/mapping, POST .../dry-run, POST .../commit,
// POST .../resume, POST .../cancel, GET .../imports/:id,
// GET .../imports/:id/report, GET .../imports.
//
// Same mocking idiom as imports-upload.test.ts: auth, membership,
// capability, audit and the storage/queue/planner primitives are mocked
// at module level so these tests exercise the ROUTE's own HTTP-layer
// decisions (status codes, envelope shape, which primitive got called
// with what) rather than a mock's opinion of them.
// =============================================================

vi.mock("../../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "u1" });
    return next();
  },
}));

// Task 10 fix round 1 (FIX 1): a REAL (if simplified) counting fake, not
// an unconditional pass-through — the whole point of the new tests below
// is to prove the upload/mutation limiter and the read limiter draw from
// SEPARATE budgets (keyed by `opts.name`), which an always-pass-through
// mock could never distinguish. No window/decay logic (tests are
// synchronous and fast) — just "the Nth call for this name, past its
// max, 429s" — enough to prove wiring AND enforcement without a real
// Redis.
const rateLimitCallCounts = vi.hoisted(() => new Map<string, number>());
vi.mock("../../src/middleware/rate-limit", () => ({
  endpointRateLimit:
    (opts: { name: string; max: number }) =>
    async (
      c: { json: (body: unknown, status?: number) => unknown },
      next: () => Promise<void>,
    ) => {
      const count = (rateLimitCallCounts.get(opts.name) ?? 0) + 1;
      rateLimitCallCounts.set(opts.name, count);
      if (count > opts.max) {
        return c.json(
          { error: { code: "RATE_LIMITED", message: "Too many requests" } },
          429,
        );
      }
      return next();
    },
}));

const auditMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  audit: (...args: unknown[]) => auditMock(...args),
}));

const loggerError = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/logger", () => {
  function makeLoggerStub(): Record<string, unknown> {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: (...args: unknown[]) => loggerWarn(...args),
      error: (...args: unknown[]) => loggerError(...args),
      child: () => makeLoggerStub(),
    };
  }
  return { logger: makeLoggerStub() };
});

const getObjectMock = vi.hoisted(() => vi.fn());
const objectExistsMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/import-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/import-store")>();
  return {
    ...actual,
    // Real `buildStorageKey`/`buildReportPartStorageKey`/
    // `isObjectNotFoundError` — pure key-shape functions the tests below
    // rely on matching production exactly. Only the two I/O primitives
    // are controllable mocks.
    getObject: (...args: unknown[]) => getObjectMock(...args),
    objectExists: (...args: unknown[]) => objectExistsMock(...args),
  };
});

const enqueueImportJobMock = vi.hoisted(() => vi.fn());
const enqueueImportDryRunMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/workers/import-runner", () => ({
  enqueueImportJob: (...args: unknown[]) => enqueueImportJobMock(...args),
  enqueueImportDryRun: (...args: unknown[]) => enqueueImportDryRunMock(...args),
}));

const findMembership = vi.hoisted(() => vi.fn());
const getImportJob = vi.hoisted(() => vi.fn());
const updateImportJobMapping = vi.hoisted(() => vi.fn());
const updateImportJobOptions = vi.hoisted(() => vi.fn());
const setImportJobStatus = vi.hoisted(() => vi.fn());
const listImportJobs = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn());

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      projectRepo: {
        ...actual.drizzle.projectRepo,
        findMembership,
      },
      importJobRepo: {
        ...actual.drizzle.importJobRepo,
        getImportJob,
        updateImportJobMapping,
        updateImportJobOptions,
        setImportJobStatus,
        listImportJobs,
      },
      db: { ...actual.drizzle.db, transaction },
    },
  };
});

import { importsRoute } from "../../src/routes/dashboard/imports";
import { errorHandler } from "../../src/middleware/error";

function app() {
  return new Hono()
    .onError(errorHandler)
    .route("/dashboard/projects/:projectId/imports", importsRoute);
}

// mapping is Record<sourceColumnName, canonicalFieldKey> (buildCanonicalRow's
// direction) — keys are arbitrary CSV column names, values must be one of
// CANONICAL_FIELDS's keys.
const VALID_MAPPING = {
  rc_original_app_user_id: "subscriberExternalId",
  store: "store",
  product_identifier: "productIdentifier",
  purchase_date: "purchaseDate",
};

const INCOMPLETE_MAPPING = {
  rc_original_app_user_id: "subscriberExternalId",
  store: "store",
  // productIdentifier and purchaseDate missing.
};

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    projectId: "p1",
    createdByUserId: "u1",
    sourceLabel: "file.csv",
    presetId: "revenuecat_transactions",
    storageKey: "imports/p1/job_1/file.csv",
    fileName: "file.csv",
    fileBytes: 100,
    fileSha256: "abc",
    mapping: VALID_MAPPING,
    options: {},
    status: "PENDING_MAPPING",
    checkpointLine: 0,
    counters: {},
    reportStorageKey: null,
    reportPartCount: 0,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    filesDeletedAt: null,
    createdAt: new Date("2026-08-31T00:00:00Z"),
    updatedAt: new Date("2026-08-31T00:00:00Z"),
    ...overrides,
  };
}

function req(
  path: string,
  init?: { method?: string; body?: unknown; projectId?: string },
) {
  const projectId = init?.projectId ?? "p1";
  return app().request(
    `/dashboard/projects/${projectId}/imports${path}`,
    {
      method: init?.method ?? "GET",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    },
  );
}

beforeEach(() => {
  rateLimitCallCounts.clear();
  auditMock.mockReset().mockResolvedValue(undefined);
  loggerError.mockReset();
  loggerWarn.mockReset();
  getObjectMock.mockReset();
  objectExistsMock.mockReset();
  enqueueImportJobMock.mockReset().mockResolvedValue(undefined);
  enqueueImportDryRunMock.mockReset().mockResolvedValue(undefined);

  findMembership.mockReset().mockResolvedValue({ id: "m1", role: "OWNER" });
  getImportJob.mockReset();
  updateImportJobMapping.mockReset();
  updateImportJobOptions.mockReset();
  setImportJobStatus.mockReset();
  listImportJobs.mockReset().mockResolvedValue([]);
  transaction.mockReset().mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ __tx: "import-lifecycle-tx" }),
  );
});

// =============================================================
// Capability gate — every route shares requireImportAccess
// =============================================================

describe("capability gate (shared by every job-lifecycle route)", () => {
  const cases: Array<{ name: string; method: string; path: string; body?: unknown }> = [
    { name: "list", method: "GET", path: "" },
    { name: "get one", method: "GET", path: "/job_1" },
    { name: "columns", method: "GET", path: "/job_1/columns" },
    { name: "report", method: "GET", path: "/job_1/report" },
    { name: "mapping", method: "PATCH", path: "/job_1/mapping", body: { mapping: VALID_MAPPING } },
    { name: "dry-run", method: "POST", path: "/job_1/dry-run" },
    { name: "commit", method: "POST", path: "/job_1/commit" },
    { name: "resume", method: "POST", path: "/job_1/resume" },
    { name: "cancel", method: "POST", path: "/job_1/cancel" },
  ];

  it.each(cases)("$name: 404s for a project the caller has no membership in", async (c) => {
    findMembership.mockResolvedValue(null);

    const res = await req(c.path, { method: c.method, body: c.body });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).not.toBe("FORBIDDEN");
    expect(getImportJob).not.toHaveBeenCalled();
  });

  it.each(cases)("$name: 403s for a member below ADMIN", async (c) => {
    findMembership.mockResolvedValue({ id: "m1", role: "DEVELOPER" });

    const res = await req(c.path, { method: c.method, body: c.body });

    expect(res.status).toBe(403);
  });
});

// =============================================================
// PATCH /:id/mapping
// =============================================================

describe("PATCH /:id/mapping", () => {
  it("404s for a job belonging to a different project (cross-tenant)", async () => {
    getImportJob.mockResolvedValue(null);

    const res = await req("/job_1/mapping", {
      method: "PATCH",
      body: { mapping: VALID_MAPPING },
    });

    expect(res.status).toBe(404);
    expect(updateImportJobMapping).not.toHaveBeenCalled();
  });

  it("400s with the list of missing required fields", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "PENDING_MAPPING" }));

    const res = await req("/job_1/mapping", {
      method: "PATCH",
      body: { mapping: INCOMPLETE_MAPPING },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("productIdentifier");
    expect(body.error.message).toContain("purchaseDate");
    expect(updateImportJobMapping).not.toHaveBeenCalled();
  });

  it("409s when the job is not in an editable state", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "RUNNING" }));

    const res = await req("/job_1/mapping", {
      method: "PATCH",
      body: { mapping: VALID_MAPPING },
    });

    expect(res.status).toBe(409);
    expect(updateImportJobMapping).not.toHaveBeenCalled();
  });

  it("updates the mapping and audits it when valid", async () => {
    const existing = makeJob({ status: "PENDING_MAPPING", mapping: {} });
    getImportJob.mockResolvedValue(existing);
    updateImportJobMapping.mockResolvedValue(
      makeJob({ status: "PENDING_MAPPING", mapping: VALID_MAPPING }),
    );

    const res = await req("/job_1/mapping", {
      method: "PATCH",
      body: { mapping: VALID_MAPPING },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { job: Record<string, unknown> } };
    expect(body.data.job.mapping).toEqual(VALID_MAPPING);
    expect(body.data.job.storageKey).toBeUndefined();
    expect(updateImportJobMapping).toHaveBeenCalledWith(
      { __tx: "import-lifecycle-tx" },
      "p1",
      "job_1",
      VALID_MAPPING,
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "import.mapping_updated", resourceId: "job_1" }),
      { __tx: "import-lifecycle-tx" },
    );
  });

  // ===========================================================
  // Final-fix-wave FIX 6 — the sandbox/anchorless opt-in is reachable
  // ===========================================================
  //
  // skipSandbox/importAnchorless were only ever READ (write.ts/plan.ts) —
  // no route wrote import_jobs.options. This PATCH's optional `options`
  // field is the fix.

  it("does not touch options when the body omits it", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "PENDING_MAPPING", mapping: {} }));
    updateImportJobMapping.mockResolvedValue(
      makeJob({ status: "PENDING_MAPPING", mapping: VALID_MAPPING }),
    );

    const res = await req("/job_1/mapping", {
      method: "PATCH",
      body: { mapping: VALID_MAPPING },
    });

    expect(res.status).toBe(200);
    expect(updateImportJobOptions).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "import.options_updated" }),
      expect.anything(),
    );
  });

  it("patches options alongside the mapping and audits it separately when present", async () => {
    const existing = makeJob({
      status: "PENDING_MAPPING",
      mapping: {},
      options: { skipSandbox: true, importAnchorless: true },
    });
    getImportJob.mockResolvedValue(existing);
    updateImportJobMapping.mockResolvedValue(
      makeJob({ status: "PENDING_MAPPING", mapping: VALID_MAPPING, options: existing.options }),
    );
    updateImportJobOptions.mockResolvedValue(
      makeJob({
        status: "PENDING_MAPPING",
        mapping: VALID_MAPPING,
        options: { skipSandbox: false, importAnchorless: true },
      }),
    );

    const res = await req("/job_1/mapping", {
      method: "PATCH",
      body: { mapping: VALID_MAPPING, options: { skipSandbox: false } },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { job: { options: Record<string, boolean> } } };
    expect(body.data.job.options).toEqual({ skipSandbox: false, importAnchorless: true });
    expect(updateImportJobOptions).toHaveBeenCalledWith(
      { __tx: "import-lifecycle-tx" },
      "p1",
      "job_1",
      { skipSandbox: false },
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "import.options_updated",
        resourceId: "job_1",
        before: { options: existing.options },
      }),
      { __tx: "import-lifecycle-tx" },
    );
  });

  it("409s before touching options when the job is not in an editable state", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "RUNNING" }));

    const res = await req("/job_1/mapping", {
      method: "PATCH",
      body: { mapping: VALID_MAPPING, options: { skipSandbox: false } },
    });

    expect(res.status).toBe(409);
    expect(updateImportJobOptions).not.toHaveBeenCalled();
  });
});

// =============================================================
// POST /:id/dry-run
// =============================================================

describe("POST /:id/dry-run", () => {
  it("404s for a cross-tenant job id", async () => {
    getImportJob.mockResolvedValue(null);

    const res = await req("/job_1/dry-run", { method: "POST" });

    expect(res.status).toBe(404);
    expect(enqueueImportDryRunMock).not.toHaveBeenCalled();
  });

  it("409s when the job is already running", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "RUNNING" }));

    const res = await req("/job_1/dry-run", { method: "POST" });

    expect(res.status).toBe(409);
    expect(enqueueImportDryRunMock).not.toHaveBeenCalled();
  });

  it("409s when the job is already DRY_RUN_RUNNING (must not start a second scan)", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "DRY_RUN_RUNNING" }));

    const res = await req("/job_1/dry-run", { method: "POST" });

    expect(res.status).toBe(409);
    expect(enqueueImportDryRunMock).not.toHaveBeenCalled();
  });

  it("400s when the current mapping is missing required fields, without enqueueing", async () => {
    getImportJob.mockResolvedValue(
      makeJob({ status: "PENDING_MAPPING", mapping: INCOMPLETE_MAPPING }),
    );

    const res = await req("/job_1/dry-run", { method: "POST" });

    expect(res.status).toBe(400);
    expect(enqueueImportDryRunMock).not.toHaveBeenCalled();
  });

  it("Task 10 fix round 1 (FIX 2): transitions to DRY_RUN_RUNNING, enqueues, and returns 202 immediately", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "PENDING_MAPPING" }));
    setImportJobStatus.mockResolvedValue(
      makeJob({ status: "DRY_RUN_RUNNING", startedAt: new Date("2026-08-31T01:00:00Z") }),
    );

    const res = await req("/job_1/dry-run", { method: "POST" });

    expect(res.status).toBe(202);
    // The transition happens in THIS request, synchronously — not left
    // for the worker to eventually report — so the response already
    // reflects it.
    expect(setImportJobStatus).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
      "job_1",
      expect.objectContaining({ status: "DRY_RUN_RUNNING", startedAt: expect.any(Date) }),
    );
    expect(enqueueImportDryRunMock).toHaveBeenCalledWith("job_1");
    const body = (await res.json()) as { data: { job: Record<string, unknown> } };
    expect(body.data.job.status).toBe("DRY_RUN_RUNNING");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "import.dry_run_started" }),
    );
  });
});

// =============================================================
// POST /:id/commit
// =============================================================

describe("POST /:id/commit", () => {
  it("409s unless the job is DRY_RUN_COMPLETE", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "PENDING_MAPPING" }));

    const res = await req("/job_1/commit", { method: "POST" });

    expect(res.status).toBe(409);
    expect(enqueueImportJobMock).not.toHaveBeenCalled();
  });

  it("enqueues the run and returns 202 from DRY_RUN_COMPLETE", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "DRY_RUN_COMPLETE" }));

    const res = await req("/job_1/commit", { method: "POST" });

    expect(res.status).toBe(202);
    expect(enqueueImportJobMock).toHaveBeenCalledWith("job_1");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "import.commit_started" }),
    );
  });
});

// =============================================================
// POST /:id/resume — carry-forward 1
// =============================================================

describe("POST /:id/resume", () => {
  it("409s unless the job is VERIFICATION_INCOMPLETE or VERIFYING", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "DRY_RUN_COMPLETE" }));

    const res = await req("/job_1/resume", { method: "POST" });

    expect(res.status).toBe(409);
    expect(enqueueImportJobMock).not.toHaveBeenCalled();
  });

  it("re-enqueues the SAME run path as commit from VERIFICATION_INCOMPLETE", async () => {
    getImportJob.mockResolvedValue(
      makeJob({ status: "VERIFICATION_INCOMPLETE", counters: { verifyAnchorPending: 40 } }),
    );

    const res = await req("/job_1/resume", { method: "POST" });

    expect(res.status).toBe(202);
    expect(enqueueImportJobMock).toHaveBeenCalledWith("job_1");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "import.resumed" }),
    );
  });

  it("Task 10 fix round 2 (FIX A): also accepts VERIFYING, recovering a crash-interrupted run", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "VERIFYING" }));

    const res = await req("/job_1/resume", { method: "POST" });

    expect(res.status).toBe(202);
    expect(enqueueImportJobMock).toHaveBeenCalledWith("job_1");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "import.resumed" }),
    );
  });
});

// =============================================================
// POST /:id/cancel
// =============================================================

describe("POST /:id/cancel", () => {
  it("409s for a job that is already terminal", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "COMPLETED" }));

    const res = await req("/job_1/cancel", { method: "POST" });

    expect(res.status).toBe(409);
    expect(setImportJobStatus).not.toHaveBeenCalled();
  });

  it("cancels a running job and sets finishedAt", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "RUNNING" }));
    setImportJobStatus.mockResolvedValue(makeJob({ status: "CANCELLED" }));

    const res = await req("/job_1/cancel", { method: "POST" });

    expect(res.status).toBe(200);
    expect(setImportJobStatus).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
      "job_1",
      expect.objectContaining({ status: "CANCELLED", finishedAt: expect.any(Date) }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "import.cancelled" }),
    );
  });

  it("allows cancelling a VERIFICATION_INCOMPLETE job", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "VERIFICATION_INCOMPLETE" }));
    setImportJobStatus.mockResolvedValue(makeJob({ status: "CANCELLED" }));

    const res = await req("/job_1/cancel", { method: "POST" });

    expect(res.status).toBe(200);
  });

  it("Task 10 fix round 2 (FIX A): allows cancelling a VERIFYING job", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "VERIFYING" }));
    setImportJobStatus.mockResolvedValue(makeJob({ status: "CANCELLED" }));

    const res = await req("/job_1/cancel", { method: "POST" });

    expect(res.status).toBe(200);
  });
});

// =============================================================
// GET /:id — status + counters for polling
// =============================================================

describe("GET /:id", () => {
  it("404s for a cross-tenant id", async () => {
    getImportJob.mockResolvedValue(null);

    const res = await req("/job_1");

    expect(res.status).toBe(404);
  });

  it("labels verification counters null when Phase B never ran", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "DRY_RUN_COMPLETE", counters: {} }));

    const res = await req("/job_1");

    const body = (await res.json()) as { data: { job: Record<string, unknown> } };
    expect(body.data.job.verificationCountersScope).toBeNull();
  });

  it("labels counters wholeFile for an ordinary COMPLETED verification", async () => {
    getImportJob.mockResolvedValue(
      makeJob({
        status: "COMPLETED",
        counters: { verifyAnchorVerified: 5, verifyAnchorNotFound: 0, verifyAnchorPending: 0 },
      }),
    );

    const res = await req("/job_1");

    const body = (await res.json()) as { data: { job: Record<string, unknown> } };
    expect(body.data.job.verificationCountersScope).toBe("wholeFile");
  });

  it("labels counters inspectedSubset when VERIFICATION_INCOMPLETE with zero pending (anchor cap)", async () => {
    getImportJob.mockResolvedValue(
      makeJob({
        status: "VERIFICATION_INCOMPLETE",
        counters: { verifyAnchorVerified: 100_000, verifyAnchorNotFound: 0, verifyAnchorPending: 0 },
      }),
    );

    const res = await req("/job_1");

    const body = (await res.json()) as { data: { job: Record<string, unknown> } };
    expect(body.data.job.verificationCountersScope).toBe("inspectedSubset");
  });

  it("labels counters wholeFile when VERIFICATION_INCOMPLETE with pending > 0 (ordinary throttle)", async () => {
    getImportJob.mockResolvedValue(
      makeJob({
        status: "VERIFICATION_INCOMPLETE",
        counters: { verifyAnchorVerified: 5, verifyAnchorNotFound: 0, verifyAnchorPending: 3 },
      }),
    );

    const res = await req("/job_1");

    const body = (await res.json()) as { data: { job: Record<string, unknown> } };
    expect(body.data.job.verificationCountersScope).toBe("wholeFile");
  });

  it("Task 10 fix round 2 (FIX A): labels counters null while VERIFYING, even with stale counters from an earlier attempt", async () => {
    getImportJob.mockResolvedValue(
      makeJob({
        status: "VERIFYING",
        counters: { verifyAnchorVerified: 5, verifyAnchorNotFound: 0, verifyAnchorPending: 3 },
      }),
    );

    const res = await req("/job_1");

    const body = (await res.json()) as { data: { job: Record<string, unknown> } };
    expect(body.data.job.verificationCountersScope).toBeNull();
  });

  // Final-fix-wave FIX 3: `import_jobs.counters` holds a
  // `dryRun_`-prefixed namespace (the dry-run planner's own, never
  // additive across attempts) separate from the plain `ImportOutcome`
  // keys the commit run increments. The DTO must present the dry-run
  // preview under the SAME plain keys the client already reads, sourced
  // from the prefixed namespace, while the job is still in a pre-commit
  // status — never a mix of both namespaces.
  it("surfaces the dry-run planner's counters under plain outcome keys while DRY_RUN_COMPLETE", async () => {
    getImportJob.mockResolvedValue(
      makeJob({
        status: "DRY_RUN_COMPLETE",
        counters: { dryRun_willCreate: 42, dryRun_androidNoToken: 3 },
      }),
    );

    const res = await req("/job_1");

    const body = (await res.json()) as {
      data: { job: { counters: Record<string, number> } };
    };
    expect(body.data.job.counters.willCreate).toBe(42);
    expect(body.data.job.counters.androidNoToken).toBe(3);
    // The prefixed key itself must not leak through to the client.
    expect(body.data.job.counters.dryRun_willCreate).toBeUndefined();
  });

  it("does not remap counters once a commit has started — a leftover dryRun_ key from an earlier attempt stays hidden, the plain keys pass through as the commit's own", async () => {
    getImportJob.mockResolvedValue(
      makeJob({
        status: "COMPLETED",
        counters: { dryRun_willCreate: 42, willCreate: 100 },
      }),
    );

    const res = await req("/job_1");

    const body = (await res.json()) as {
      data: { job: { counters: Record<string, number> } };
    };
    expect(body.data.job.counters.willCreate).toBe(100);
    expect(body.data.job.counters.dryRun_willCreate).toBe(42);
  });
});

// =============================================================
// GET /:id/columns — fix round 1, FIX 1
//
// Peeks the STORED object on demand and returns its header row, so the
// mapping editor can offer a picker instead of asking the operator to
// type exact column names from a file they may not be able to open.
// =============================================================

describe("GET /:id/columns", () => {
  it("404s for a cross-tenant id", async () => {
    getImportJob.mockResolvedValue(null);

    const res = await req("/job_1/columns");

    expect(res.status).toBe(404);
    expect(objectExistsMock).not.toHaveBeenCalled();
  });

  it("returns the header row of the stored file, in file order", async () => {
    getImportJob.mockResolvedValue(makeJob({ storageKey: "imports/p1/job_1/file.csv" }));
    objectExistsMock.mockResolvedValue(true);
    getObjectMock.mockResolvedValue(
      Readable.from([Buffer.from("rc_original_app_user_id,store,product_identifier\nu1,APP_STORE,pro_monthly\n")]),
    );

    const res = await req("/job_1/columns");

    expect(res.status).toBe(200);
    expect(objectExistsMock).toHaveBeenCalledWith("imports/p1/job_1/file.csv");
    const body = (await res.json()) as { data: { columns: string[] } };
    expect(body.data.columns).toEqual([
      "rc_original_app_user_id",
      "store",
      "product_identifier",
    ]);
  });

  it("404s (retention-expired) when the object is gone, matching the report route's posture", async () => {
    getImportJob.mockResolvedValue(makeJob());
    objectExistsMock.mockResolvedValue(false);

    const res = await req("/job_1/columns");

    expect(res.status).toBe(404);
    expect(getObjectMock).not.toHaveBeenCalled();
  });

  it("returns an empty column list (not an error) when no header can be found", async () => {
    getImportJob.mockResolvedValue(makeJob());
    objectExistsMock.mockResolvedValue(true);
    // No newline anywhere in the peeked prefix — an unusual but normal
    // file, per the upload route's own header-peek posture.
    getObjectMock.mockResolvedValue(Readable.from([Buffer.from("no newline here at all")]));

    const res = await req("/job_1/columns");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { columns: string[] } };
    expect(body.data.columns).toEqual([]);
  });

  it("destroys the object stream after peeking, never reading past the header", async () => {
    getImportJob.mockResolvedValue(makeJob());
    objectExistsMock.mockResolvedValue(true);
    const stream = Readable.from([Buffer.from("a,b\n1,2\n")]);
    const destroySpy = vi.spyOn(stream, "destroy");
    getObjectMock.mockResolvedValue(stream);

    const res = await req("/job_1/columns");

    expect(res.status).toBe(200);
    expect(destroySpy).toHaveBeenCalled();
  });

  it("is gated on the READ rate-limit budget, not the mutation one", async () => {
    getImportJob.mockResolvedValue(makeJob());
    objectExistsMock.mockResolvedValue(true);
    getObjectMock.mockImplementation(async () =>
      Readable.from([Buffer.from("a,b\n1,2\n")]),
    );

    for (let i = 0; i < IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE + 5; i++) {
      const res = await req("/job_1/columns");
      expect(res.status).toBe(200);
    }
  });
});

// =============================================================
// GET / — list
// =============================================================

describe("GET / (list)", () => {
  it("returns jobs from listImportJobs, newest first", async () => {
    listImportJobs.mockResolvedValue([
      makeJob({ id: "job_2" }),
      makeJob({ id: "job_1" }),
    ]);

    const res = await req("");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { jobs: Array<Record<string, unknown>> } };
    expect(body.data.jobs.map((j) => j.id)).toEqual(["job_2", "job_1"]);
    expect(body.data.jobs[0]?.storageKey).toBeUndefined();
  });
});

// =============================================================
// GET /:id/report — durable report-parts contract (Task 8)
// =============================================================

describe("GET /:id/report", () => {
  it("404s when no report exists yet", async () => {
    getImportJob.mockResolvedValue(
      makeJob({ reportPartCount: 0, reportStorageKey: null }),
    );

    const res = await req("/job_1/report");

    expect(res.status).toBe(404);
    expect(objectExistsMock).not.toHaveBeenCalled();
  });

  it("serves the dry-run planner's single report object when no commit part exists yet", async () => {
    getImportJob.mockResolvedValue(
      makeJob({ reportPartCount: 0, reportStorageKey: "imports/p1/job_1/report.ndjson" }),
    );
    objectExistsMock.mockResolvedValue(true);
    getObjectMock.mockResolvedValue(Readable.from([Buffer.from('{"line":1}\n')]));

    const res = await req("/job_1/report");

    expect(res.status).toBe(200);
    expect(objectExistsMock).toHaveBeenCalledWith("imports/p1/job_1/report.ndjson");
    expect(await res.text()).toBe('{"line":1}\n');
  });

  it("404s (retention-expired) when the first part is gone", async () => {
    getImportJob.mockResolvedValue(makeJob({ reportPartCount: 2 }));
    objectExistsMock.mockResolvedValue(false);

    const res = await req("/job_1/report");

    expect(res.status).toBe(404);
    expect(getObjectMock).not.toHaveBeenCalled();
  });

  it("streams every part in numeric order and concatenates them", async () => {
    getImportJob.mockResolvedValue(makeJob({ reportPartCount: 2 }));
    objectExistsMock.mockResolvedValue(true);
    getObjectMock.mockImplementation(async (key: string) => {
      if (key.endsWith("report.part-0001.ndjson")) {
        return Readable.from([Buffer.from('{"line":1}\n')]);
      }
      if (key.endsWith("report.part-0002.ndjson")) {
        return Readable.from([Buffer.from('{"line":2}\n')]);
      }
      throw new Error(`unexpected key: ${key}`);
    });

    const res = await req("/job_1/report");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await res.text()).toBe('{"line":1}\n{"line":2}\n');
    expect(getObjectMock).toHaveBeenNthCalledWith(1, expect.stringContaining("part-0001"));
    expect(getObjectMock).toHaveBeenNthCalledWith(2, expect.stringContaining("part-0002"));
  });

  it("ends the stream gracefully (not a 500) when a later part disappears mid-download", async () => {
    getImportJob.mockResolvedValue(makeJob({ reportPartCount: 2 }));
    objectExistsMock.mockResolvedValue(true);
    getObjectMock.mockImplementation(async (key: string) => {
      if (key.endsWith("part-0001.ndjson")) {
        return Readable.from([Buffer.from('{"line":1}\n')]);
      }
      const err = new Error("not found");
      err.name = "NoSuchKey";
      throw err;
    });

    const res = await req("/job_1/report");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"line":1}\n');
    expect(loggerWarn).toHaveBeenCalled();
  });
});

// =============================================================
// Rate limiting — Task 10 fix round 1, FIX 1
//
// The read routes (GET /:id, GET /) must NOT share the upload/mutation
// route's tight budget (IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE = 5) — that
// was the whole bug: a dashboard polling GET /:id would exhaust it in
// the first 10-15 seconds. `rateLimitCallCounts` (the fake limiter
// above) proves this with real enforcement, keyed by the SAME `name`
// `endpointRateLimit` is actually called with in the route
// (`import-upload` vs `import-status-poll`) — not just that two
// DIFFERENT-looking calls happened.
// =============================================================

describe("rate limiting (Task 10 fix round 1, FIX 1)", () => {
  it("does not throttle GET /:id even well past the mutation budget's call count", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "DRY_RUN_COMPLETE" }));

    const callCount = IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE + 20;
    expect(callCount).toBeLessThan(IMPORT_STATUS_POLL_RATE_LIMIT_PER_MINUTE);

    for (let i = 0; i < callCount; i++) {
      const res = await req("/job_1");
      expect(res.status).toBe(200);
    }
  });

  it("does not throttle GET / (list) on the mutation budget either", async () => {
    listImportJobs.mockResolvedValue([]);

    for (let i = 0; i < IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE + 5; i++) {
      const res = await req("");
      expect(res.status).toBe(200);
    }
  });

  it("still throttles a mutation route (commit) at the upload budget", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "DRY_RUN_COMPLETE" }));

    const statuses: number[] = [];
    for (let i = 0; i < IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE + 1; i++) {
      const res = await req("/job_1/commit", { method: "POST" });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE)).toEqual(
      Array(IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE).fill(202),
    );
    expect(statuses.at(-1)).toBe(429);
  });

  it("mutation and read budgets are independent: exhausting one leaves the other untouched", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "DRY_RUN_COMPLETE" }));

    // Exhaust the mutation budget via commit.
    for (let i = 0; i < IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE; i++) {
      const res = await req("/job_1/commit", { method: "POST" });
      expect(res.status).toBe(202);
    }
    expect((await req("/job_1/commit", { method: "POST" })).status).toBe(429);

    // GET /:id (the read budget) is completely unaffected.
    expect((await req("/job_1")).status).toBe(200);
  });
});
