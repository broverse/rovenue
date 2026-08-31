import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { IMPORT_MAX_UPLOAD_BYTES, IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE } from "@rovenue/shared";

// =============================================================
// POST /dashboard/projects/:projectId/imports (data-import tool, Task 5)
//
// Auth + membership/capability + the import-store + audit are mocked at
// module level, mirroring assets.test.ts's idiom: this exercises the
// real route's HTTP-layer decisions (membership-vs-capability status
// codes, the bodyLimit gate, the response shape) rather than a mock's
// opinion of them. `detectPreset`/`parseCsvStream` are NOT mocked — the
// point of the "valid upload" test is that the REAL Task 1/2 parsing and
// detection logic drives the proposed mapping, not a stub.
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

// Captures the options `endpointRateLimit` is called with (Ruling 3 —
// the plan's own pre-flight scan flagged `IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE`
// as declared-but-possibly-unread; this is what proves it is actually
// wired to the route, not merely defined) while still behaving as a
// pass-through so these tests never need a live Redis.
const endpointRateLimitCalls = vi.hoisted(() => vi.fn());
vi.mock("../../src/middleware/rate-limit", () => ({
  endpointRateLimit: (opts: unknown) => {
    endpointRateLimitCalls(opts);
    return async (_c: unknown, next: () => Promise<void>) => next();
  },
}));

const auditMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  audit: (...args: unknown[]) => auditMock(...args),
}));

const loggerError = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/logger", () => {
  function makeLoggerStub(): Record<string, unknown> {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: (...args: unknown[]) => loggerError(...args),
      child: () => makeLoggerStub(),
    };
  }
  return { logger: makeLoggerStub() };
});

const isStorageConfigured = vi.hoisted(() => vi.fn());
const buildStorageKey = vi.hoisted(() => vi.fn());
const putObject = vi.hoisted(() => vi.fn());
const deleteObject = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/import-store", () => ({
  isStorageConfigured: () => isStorageConfigured(),
  buildStorageKey: (...args: unknown[]) => buildStorageKey(...args),
  putObject: (...args: unknown[]) => putObject(...args),
  deleteObject: (...args: unknown[]) => deleteObject(...args),
}));

const findMembership = vi.hoisted(() => vi.fn());
const createImportJob = vi.hoisted(() => vi.fn());
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
        createImportJob,
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

function uploadUrl(opts?: {
  projectId?: string;
  fileName?: string;
  sourceLabel?: string;
}): string {
  const projectId = opts?.projectId ?? "p1";
  const fileName = opts?.fileName ?? "revenuecat_transactions.csv";
  const params = new URLSearchParams({ fileName });
  if (opts?.sourceLabel) params.set("sourceLabel", opts.sourceLabel);
  return `/dashboard/projects/${projectId}/imports?${params.toString()}`;
}

function upload(
  bytes: Uint8Array,
  opts?: { projectId?: string; fileName?: string; sourceLabel?: string },
  headerOverrides?: Record<string, string>,
) {
  return app().request(uploadUrl(opts), {
    method: "POST",
    headers: {
      "content-length": String(bytes.byteLength),
      ...headerOverrides,
    },
    body: bytes as BlobPart,
  });
}

function csvBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Drains a Buffer (no-op) or a Node Readable/Transform to completion —
 *  what a real S3 `Upload` does. Without this, the route's hashing
 *  transform would stall waiting for a consumer. */
async function drain(body: unknown): Promise<void> {
  if (Buffer.isBuffer(body)) return;
  for await (const _chunk of body as AsyncIterable<unknown>) {
    // draining only
  }
}

const RC_TRANSACTIONS_CSV =
  "rc_original_app_user_id,store,store_transaction_id\nuser_1,app_store,txn_1\n";

let jobIdCounter = 0;

beforeEach(() => {
  jobIdCounter = 0;
  // Deliberately NOT reset here: `endpointRateLimit(...)` is invoked once,
  // at route-module load time (building the `.use("*", ...)` chain), not
  // per request — resetting this mock per-test would erase the one call
  // the wiring test below depends on.
  auditMock.mockReset().mockResolvedValue(undefined);
  loggerError.mockReset();

  isStorageConfigured.mockReset().mockReturnValue(true);
  buildStorageKey
    .mockReset()
    .mockImplementation(
      (projectId: string, jobId: string, fileName: string) =>
        `imports/${projectId}/${jobId}/${fileName}`,
    );
  putObject.mockReset().mockImplementation(async (_key: string, body: unknown) => {
    await drain(body);
  });
  deleteObject.mockReset().mockResolvedValue(undefined);

  findMembership.mockReset().mockResolvedValue({ id: "m1", role: "OWNER" });
  createImportJob.mockReset().mockImplementation(async (_tx: unknown, values: Record<string, unknown>) => ({
    ...values,
    id: values.id ?? `job_${++jobIdCounter}`,
    status: "PENDING_MAPPING",
    checkpointLine: 0,
    counters: {},
    options: {},
    reportStorageKey: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date("2026-08-31T00:00:00Z"),
    updatedAt: new Date("2026-08-31T00:00:00Z"),
  }));
  // The route runs the insert + audit write inside `drizzle.db.transaction`;
  // the mock just invokes the callback with a distinguishable tx handle.
  transaction.mockReset().mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ __tx: "import-upload-tx" }),
  );
});

describe("POST /dashboard/projects/:projectId/imports", () => {
  it("wires IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE to the route's own limiter (Ruling 3)", () => {
    // `endpointRateLimit(...)` is called once, at route-module load time
    // (building the `.use("*", ...)` chain) — no request needed to
    // observe it; see the `beforeEach` comment for why this mock is
    // never reset.
    expect(endpointRateLimitCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "import-upload",
        max: IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE,
      }),
    );
    const opts = endpointRateLimitCalls.mock.calls[0]?.[0] as {
      identify: (c: { req: { param: (k: string) => string } }) => string;
    };
    expect(
      opts.identify({ req: { param: () => "p_scoped" } }),
    ).toBe("p_scoped");
  });

  it("returns 403 for a member below ADMIN", async () => {
    findMembership.mockResolvedValue({ id: "m1", role: "DEVELOPER" });

    const res = await upload(csvBytes(RC_TRANSACTIONS_CSV));

    expect(res.status).toBe(403);
    expect(createImportJob).not.toHaveBeenCalled();
  });

  it("returns 404, not 403, for a project the caller has no membership in", async () => {
    findMembership.mockResolvedValue(null);

    const res = await upload(csvBytes(RC_TRANSACTIONS_CSV), { projectId: "p_foreign" });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).not.toBe("FORBIDDEN");
    expect(createImportJob).not.toHaveBeenCalled();
  });

  it("rejects a body over IMPORT_MAX_UPLOAD_BYTES via the route's own bodyLimit, not the global one", async () => {
    // `hono/body-limit` decides off the Content-Length header ALONE when
    // it is present and trusted (confirmed by reading
    // node_modules/hono/dist/middleware/body-limit: `contentLength >
    // maxSize ? onError(c) : next()`, no body read at all) — so a tiny
    // real body with a declared length one byte over the cap exercises
    // the same rejection path a real 500 MiB+1 upload would, without
    // this test allocating 500 MB. The declared length is what a real
    // client's Content-Length header would carry for an over-limit file.
    const res = await upload(
      csvBytes("a"),
      undefined,
      { "content-length": String(IMPORT_MAX_UPLOAD_BYTES + 1) },
    );

    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("IMPORT_FILE_TOO_LARGE");
    // Proves the rejection happened at the bodyLimit gate, before the
    // handler (and therefore the membership check) ever ran — mirrors
    // assets.test.ts's "assertProjectCapability seeing zero calls" proof.
    expect(findMembership).not.toHaveBeenCalled();
  });

  it("creates a job with the detected preset's mapping and PENDING_MAPPING status", async () => {
    const res = await upload(csvBytes(RC_TRANSACTIONS_CSV));

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { job: Record<string, unknown> };
    };
    expect(body.data.job.status).toBe("PENDING_MAPPING");
    expect(body.data.job.presetId).toBe("revenuecat_transactions");
    expect(body.data.job.mapping).toEqual({
      rc_original_app_user_id: "subscriberExternalId",
      store: "store",
      store_transaction_id: "storeTransactionId",
    });
    // The internal storage key is never echoed back to the client.
    expect(body.data.job.storageKey).toBeUndefined();

    expect(createImportJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: "p1",
        createdByUserId: "u1",
        fileName: "revenuecat_transactions.csv",
        sourceLabel: "revenuecat_transactions.csv",
        presetId: "revenuecat_transactions",
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        userId: "u1",
        action: "import.started",
        resource: "import_job",
      }),
      { __tx: "import-upload-tx" },
    );
  });

  it("still creates a job (empty mapping, no preset) for a file that matches no known preset", async () => {
    const res = await upload(csvBytes("some_column,other_column\nfoo,bar\n"));

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { job: Record<string, unknown> };
    };
    expect(body.data.job.presetId).toBeNull();
    expect(body.data.job.mapping).toEqual({});
  });

  it("returns 503 when import storage is not configured", async () => {
    isStorageConfigured.mockReturnValue(false);

    const res = await upload(csvBytes(RC_TRANSACTIONS_CSV));

    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("IMPORT_STORAGE_UNAVAILABLE");
    expect(createImportJob).not.toHaveBeenCalled();
  });
});
