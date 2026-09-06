import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { REVENUECAT_GOOGLE_TOKEN_PRESET_ID } from "@rovenue/shared";

// =============================================================
// The Google purchase-token second pass, at the HTTP boundary
// =============================================================
//
// One question runs through this file: does `import_jobs.kind` actually
// reach the two gates that decide whether a three-column token file can
// be imported at all?
//
// Before this task the answer was no, in a way that was invisible from
// the outside: the `revenuecat_google_token` preset was DETECTED on
// upload (so the operator saw a recognised file and a proposed mapping),
// and then both `PATCH /:id/mapping` and `POST /:id/dry-run` rejected
// that same proposed mapping with 400 "missing required fields:
// store, purchaseDate" — fields the file cannot contain. Every test
// below that asserts a 200/202 on an enrichment job is asserting on that
// exact 400.
//
// The negative half matters just as much: the SAME mapping on a HISTORY
// job must still 400. A fix that simply dropped `store`/`purchaseDate`
// from the required set globally would make every test here pass and
// would let a half-mapped history export through to the writer.
//
// Same mocking idiom as imports.test.ts / imports-upload.test.ts: auth,
// membership, capability, audit, storage and the queue are mocked at
// module level so these tests exercise the ROUTE's own decisions.
// `detectPreset` and `validateMapping` are NOT mocked — they are the
// logic under test.

vi.mock("../../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "u1" });
    return next();
  },
}));

vi.mock("../../src/middleware/rate-limit", () => ({
  endpointRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const auditMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  audit: (...args: unknown[]) => auditMock(...args),
}));

vi.mock("../../src/lib/logger", () => {
  function makeLoggerStub(): Record<string, unknown> {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => makeLoggerStub(),
    };
  }
  return { logger: makeLoggerStub() };
});

const putObject = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/import-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/import-store")>();
  return {
    ...actual,
    isStorageConfigured: () => true,
    putObject: (...args: unknown[]) => putObject(...args),
    deleteObject: async () => undefined,
    getObject: async () => {
      throw new Error("getObject: not used by these tests");
    },
    objectExists: async () => false,
  };
});

const enqueueImportJobMock = vi.hoisted(() => vi.fn());
const enqueueImportDryRunMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/workers/import-runner", () => ({
  enqueueImportJob: (...args: unknown[]) => enqueueImportJobMock(...args),
  enqueueImportDryRun: (...args: unknown[]) => enqueueImportDryRunMock(...args),
}));

const findMembership = vi.hoisted(() => vi.fn());
const createImportJob = vi.hoisted(() => vi.fn());
const getImportJob = vi.hoisted(() => vi.fn());
const updateImportJobMapping = vi.hoisted(() => vi.fn());
const updateImportJobOptions = vi.hoisted(() => vi.fn());
const setImportJobStatus = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn());

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      projectRepo: { ...actual.drizzle.projectRepo, findMembership },
      importJobRepo: {
        ...actual.drizzle.importJobRepo,
        createImportJob,
        getImportJob,
        updateImportJobMapping,
        updateImportJobOptions,
        setImportJobStatus,
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

/** The exact three columns of the file RevenueCat support hand-delivers
 *  on request — the header `detectPreset` matches the
 *  `revenuecat_google_token` preset on. */
const GOOGLE_TOKEN_CSV =
  "user_id,google_purchase_token,google_product_id\nuser_1,tok_abc,com.example.pro.monthly\n";

/** The standard Transactions export's header. */
const RC_TRANSACTIONS_CSV =
  "rc_original_app_user_id,store,store_transaction_id\nuser_1,play_store,txn_1\n";

/** What the preset proposes for a token file, and therefore what BOTH
 *  gates below have to accept on an enrichment job — and reject on a
 *  history one. */
const ENRICHMENT_MAPPING = {
  user_id: "subscriberExternalId",
  google_purchase_token: "googlePurchaseToken",
  google_product_id: "productIdentifier",
};

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    projectId: "p1",
    createdByUserId: "u1",
    sourceLabel: "tokens.csv",
    presetId: REVENUECAT_GOOGLE_TOKEN_PRESET_ID,
    kind: "GOOGLE_TOKEN_ENRICHMENT",
    storageKey: "imports/p1/job_1/tokens.csv",
    fileName: "tokens.csv",
    fileBytes: 100,
    fileSha256: "abc",
    mapping: ENRICHMENT_MAPPING,
    options: {},
    status: "PENDING_MAPPING",
    checkpointLine: 0,
    counters: {},
    dryRunSummary: null,
    reportStorageKey: null,
    reportPartCount: 0,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    filesDeletedAt: null,
    createdAt: new Date("2026-09-06T00:00:00Z"),
    updatedAt: new Date("2026-09-06T00:00:00Z"),
    ...overrides,
  };
}

function req(path: string, init?: { method?: string; body?: unknown }) {
  return app().request(`/dashboard/projects/p1/imports${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
}

function upload(csv: string, fileName: string) {
  const bytes = new TextEncoder().encode(csv);
  return app().request(
    `/dashboard/projects/p1/imports?fileName=${encodeURIComponent(fileName)}`,
    {
      method: "POST",
      headers: { "content-length": String(bytes.byteLength) },
      body: bytes as BlobPart,
    },
  );
}

async function drain(body: unknown): Promise<void> {
  if (Buffer.isBuffer(body)) return;
  for await (const _chunk of body as AsyncIterable<unknown>) {
    // draining only — a real S3 Upload consumes the stream
  }
}

beforeEach(() => {
  auditMock.mockReset().mockResolvedValue(undefined);
  putObject.mockReset().mockImplementation(async (_key: string, body: unknown) => {
    await drain(body);
  });
  enqueueImportJobMock.mockReset().mockResolvedValue(undefined);
  enqueueImportDryRunMock.mockReset().mockResolvedValue(undefined);

  findMembership.mockReset().mockResolvedValue({ id: "m1", role: "OWNER" });
  createImportJob
    .mockReset()
    .mockImplementation(async (_tx: unknown, values: Record<string, unknown>) => ({
      ...values,
      status: "PENDING_MAPPING",
      checkpointLine: 0,
      counters: {},
      options: {},
      reportStorageKey: null,
      reportPartCount: 0,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date("2026-09-06T00:00:00Z"),
      updatedAt: new Date("2026-09-06T00:00:00Z"),
    }));
  getImportJob.mockReset();
  updateImportJobMapping
    .mockReset()
    .mockImplementation(async (_tx: unknown, _p: string, _id: string, mapping: unknown) =>
      makeJob({ mapping }),
    );
  updateImportJobOptions.mockReset().mockImplementation(async () => makeJob());
  setImportJobStatus
    .mockReset()
    .mockImplementation(async (_db: unknown, _p: string, _id: string, patch: object) =>
      makeJob(patch as Record<string, unknown>),
    );
  transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => unknown) => cb({ __tx: "enrichment-tx" }));
});

// =============================================================
// Upload — the kind is decided here, from the detected preset
// =============================================================

describe("POST / (upload) sets import_jobs.kind from the detected preset", () => {
  it("creates a GOOGLE_TOKEN_ENRICHMENT job for the three-column token file", async () => {
    const res = await upload(GOOGLE_TOKEN_CSV, "google_tokens.csv");

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { job: Record<string, unknown> } };
    expect(body.data.job.presetId).toBe(REVENUECAT_GOOGLE_TOKEN_PRESET_ID);
    expect(body.data.job.kind).toBe("GOOGLE_TOKEN_ENRICHMENT");
    // The mapping the preset proposes is exactly the one both gates
    // below must accept — proven here from the REAL detectPreset rather
    // than restated as a literal.
    expect(body.data.job.mapping).toEqual(ENRICHMENT_MAPPING);
    expect(createImportJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "GOOGLE_TOKEN_ENRICHMENT" }),
    );
  });

  it("creates a HISTORY job for the Transactions export", async () => {
    const res = await upload(RC_TRANSACTIONS_CSV, "transactions.csv");

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { job: Record<string, unknown> } };
    expect(body.data.job.kind).toBe("HISTORY");
  });

  it("creates a HISTORY job for a file matching no preset at all", async () => {
    // The default direction matters: an unrecognised header treated as
    // an enrichment job would silently patch nothing and report every
    // row as noMatch. Treated as history, it fails loudly at the mapping
    // gate, which is where the operator can act on it.
    const res = await upload("some_column,other_column\nfoo,bar\n", "mystery.csv");

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { job: Record<string, unknown> } };
    expect(body.data.job.presetId).toBeNull();
    expect(body.data.job.kind).toBe("HISTORY");
  });
});

// =============================================================
// PATCH /:id/mapping — the gate that used to 400
// =============================================================

describe("PATCH /:id/mapping honours the job's kind", () => {
  it("accepts the three-column mapping on a GOOGLE_TOKEN_ENRICHMENT job", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "PENDING_MAPPING" }));

    const res = await req("/job_1/mapping", {
      method: "PATCH",
      body: { mapping: ENRICHMENT_MAPPING },
    });

    expect(res.status).toBe(200);
    expect(updateImportJobMapping).toHaveBeenCalledWith(
      { __tx: "enrichment-tx" },
      "p1",
      "job_1",
      ENRICHMENT_MAPPING,
    );
  });

  it("still 400s with store + purchaseDate on a HISTORY job", async () => {
    getImportJob.mockResolvedValue(
      makeJob({ kind: "HISTORY", presetId: "revenuecat_transactions" }),
    );

    const res = await req("/job_1/mapping", {
      method: "PATCH",
      body: { mapping: ENRICHMENT_MAPPING },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("store");
    expect(body.error.message).toContain("purchaseDate");
    expect(updateImportJobMapping).not.toHaveBeenCalled();
  });

  it("400s an enrichment mapping that is missing the token column", async () => {
    getImportJob.mockResolvedValue(makeJob());
    const { google_purchase_token: _dropped, ...withoutToken } = ENRICHMENT_MAPPING;

    const res = await req("/job_1/mapping", {
      method: "PATCH",
      body: { mapping: withoutToken },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("googlePurchaseToken");
    expect(updateImportJobMapping).not.toHaveBeenCalled();
  });

  it("persists enrichUngroupedChains alongside the mapping", async () => {
    // The opt-in has no other write path: `z.object` strips undeclared
    // keys, so a mapping PATCH is the ONLY way an operator can turn it
    // on, and the dry-run report is the only place they learn it exists.
    getImportJob.mockResolvedValue(makeJob());

    const res = await req("/job_1/mapping", {
      method: "PATCH",
      body: { mapping: ENRICHMENT_MAPPING, options: { enrichUngroupedChains: true } },
    });

    expect(res.status).toBe(200);
    expect(updateImportJobOptions).toHaveBeenCalledWith(
      { __tx: "enrichment-tx" },
      "p1",
      "job_1",
      { enrichUngroupedChains: true },
    );
  });
});

// =============================================================
// POST /:id/dry-run — the second gate, which must agree with the first
// =============================================================

describe("POST /:id/dry-run honours the job's kind", () => {
  it("starts a dry run for an enrichment job's three-column mapping", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "PENDING_MAPPING" }));

    const res = await req("/job_1/dry-run", { method: "POST" });

    expect(res.status).toBe(202);
    expect(enqueueImportDryRunMock).toHaveBeenCalledWith("job_1");
  });

  it("still 400s the same mapping on a HISTORY job, and enqueues nothing", async () => {
    getImportJob.mockResolvedValue(makeJob({ kind: "HISTORY" }));

    const res = await req("/job_1/dry-run", { method: "POST" });

    expect(res.status).toBe(400);
    expect(enqueueImportDryRunMock).not.toHaveBeenCalled();
  });
});

// =============================================================
// GET /:id — dry-run counters are read with the job's OWN bucket list
// =============================================================

describe("GET /:id reconstructs dry-run counters per kind", () => {
  it("reports the enrichment buckets, not the history ones", async () => {
    getImportJob.mockResolvedValue(
      makeJob({
        status: "DRY_RUN_COMPLETE",
        counters: {
          dryRun_enriched: 4,
          dryRun_alreadyEnriched: 1,
          dryRun_ungroupedChains: 2,
          enrichedPurchaseRows: 9,
          ungroupedChainsPurchaseRows: 6,
        },
      }),
    );

    const res = await req("/job_1");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { job: { counters: Record<string, number> } };
    };
    const { counters } = body.data.job;
    expect(counters.enriched).toBe(4);
    expect(counters.alreadyEnriched).toBe(1);
    expect(counters.ungroupedChains).toBe(2);
    expect(counters.conflictingToken).toBe(0);
    // Reading with the history list would have produced these keys (all
    // zero) and none of the ones above.
    expect(counters.willCreate).toBeUndefined();
    expect(counters.androidNoToken).toBeUndefined();
  });

  it("still reports the history buckets for a HISTORY job", async () => {
    getImportJob.mockResolvedValue(
      makeJob({
        kind: "HISTORY",
        status: "DRY_RUN_COMPLETE",
        counters: { dryRun_willCreate: 7, dryRun_androidNoToken: 3 },
      }),
    );

    const res = await req("/job_1");

    const body = (await res.json()) as {
      data: { job: { counters: Record<string, number> } };
    };
    expect(body.data.job.counters.willCreate).toBe(7);
    expect(body.data.job.counters.androidNoToken).toBe(3);
    expect(body.data.job.counters.enriched).toBeUndefined();
  });
});
