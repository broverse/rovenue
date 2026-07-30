// =============================================================
// Paywall asset CDN — end-to-end integration against real MinIO
// (Task 8)
// =============================================================
//
// Tasks 1-7 unit-test the whole upload/list/delete surface with the
// storage layer mocked (tests/routes/dashboard/assets.test.ts). This
// file adds no production code — its only job is to run the SAME HTTP
// route against a REAL S3-compatible object store (MinIO, via
// testcontainers) and a REAL Postgres, and prove the six claims a mock
// cannot: bytes round-trip through an actual bucket, an object is
// actually deleted, the partial unique index actually frees a hash
// after soft-delete, quota is actually charged once under real
// concurrency, and — the one this file was written to measure, not
// assert — a 50 MB video upload does not fully buffer in process
// memory.
//
// What's real: `@rovenue/db` (real Postgres, no mocking), `lib/asset-
// store.ts` (real MinIO via startMinio(), tests/helpers.ts),
// `services/assets/quota.ts` (real advisory-lock reservation path),
// `services/assets/normalize.ts` (real sharp), `lib/audit.ts` (real
// hash-chain insert).
//
// What's mocked, and why: `requireDashboardAuth` /
// `assertProjectCapability` / `assertProjectAccess` bypass Better
// Auth session + `project_members` FK ceremony — RBAC correctness is
// this route's OWN concern and is already pinned by assets.test.ts and
// capabilities.test.ts, not this task's. `endpointRateLimit` is a
// pass-through so the storage-cap concurrency test below (Step 6, up
// to 8 simultaneous requests to one project) isn't also fighting
// ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE (20/min) — a second, unrelated
// gate this task isn't measuring.
//
// NOT parallel-safe with tests/services/assets/quota.integration.test.ts:
// both mutate the shared `billing_tier_limits` table (this file writes
// "studio"/"monthly"; that file writes "free" and "enterprise"). Run
// this file alone (`pnpm --filter @rovenue/api test -- assets.integration`),
// matching the task-8 brief's own run command.

process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { StartedTestContainer } from "testcontainers";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import {
  getDb,
  drizzle,
  projects,
  billingSubscriptions,
  billingTierLimits,
} from "@rovenue/db";
import { ASSET_MAX_BYTES } from "@rovenue/shared";
import { startMinio } from "../../helpers";
import { listAllKeys, putObject } from "../../../src/lib/asset-store";
import { getStorageUsage } from "../../../src/services/assets/quota";

// ---- Auth/RBAC bypass (not this task's concern — see module comment) ----

const TEST_USER_ID = "u_assets_it";

vi.mock("../../../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: TEST_USER_ID });
    return next();
  },
}));

vi.mock("../../../src/lib/capabilities", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProjectCapability: async () => ({ id: "m1", role: "OWNER" }),
}));

vi.mock("../../../src/lib/project-access", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProjectAccess: async () => ({ id: "m1", role: "OWNER" }),
}));

vi.mock("../../../src/middleware/rate-limit", () => ({
  endpointRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

import { assetsRoute } from "../../../src/routes/dashboard/assets";
import { errorHandler } from "../../../src/middleware/error";

function app() {
  return new Hono()
    .onError(errorHandler)
    .route("/dashboard/projects/:projectId/assets", assetsRoute);
}

function uploadUrl(
  kind: string,
  opts: { projectId: string; name?: string },
): string {
  const name = opts.name ?? "asset";
  return `/dashboard/projects/${opts.projectId}/assets/${kind}?name=${encodeURIComponent(name)}`;
}

function upload(
  kind: string,
  body: BlobPart,
  opts: { projectId: string; name?: string },
  extraHeaders: Record<string, string> = {},
) {
  return app().request(uploadUrl(kind, opts), {
    method: "POST",
    headers: extraHeaders,
    body,
  });
}

function deleteAsset(projectId: string, id: string) {
  return app().request(`/dashboard/projects/${projectId}/assets/${id}`, {
    method: "DELETE",
  });
}

/** A real, unique-per-call PNG, built in-process via sharp (no binary
 *  fixture checked into the repo) — same technique as
 *  services/assets/normalize.test.ts. Distinct RGB per call keeps
 *  content hashes from colliding across unrelated test cases even
 *  when they happen to share a project. */
async function realPng(rgb: [number, number, number]): Promise<Buffer> {
  return sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
}

/** A real, valid Lottie JSON body of a deterministic, uniform byte
 *  length across every `nonce` in 0..9999 — needed so the concurrency
 *  test's cap arithmetic (`CAP_ITEMS * itemSize`) is exact rather than
 *  approximate. `nonce` also keeps every fixture's content hash
 *  distinct, so none of the concurrent uploads short-circuits into the
 *  dedup path. */
function lottieFixture(nonce: number): Uint8Array {
  const json = JSON.stringify({
    v: "5.6.5",
    layers: [],
    nonce: String(nonce).padStart(4, "0"),
  });
  return new TextEncoder().encode(json);
}

type Tier = "free" | "indie" | "studio" | "enterprise";

const RUN_ID = Date.now();
let projectCounter = 0;
const createdProjectIds: string[] = [];

/** Real project + real billing_subscriptions row on the given tier —
 *  same shape services/assets/quota.integration.test.ts's seedProject
 *  uses, so a real (not mocked) reserveStorage/getStorageUsage sees a
 *  real tier to join against. */
async function seedProject(tier: Tier = "enterprise"): Promise<string> {
  const db = getDb();
  const id = `prj_assets_it_${RUN_ID}_${projectCounter++}`;
  await db.insert(projects).values({ id, name: `Assets IT ${id}` });
  await db
    .insert(billingSubscriptions)
    .values({ projectId: id, state: "active", tier, cycle: "monthly" });
  createdProjectIds.push(id);
  return id;
}

/** Upserts (tier, "monthly") in the reference billing_tier_limits
 *  table. Only used for the "studio" tier below — "enterprise" is
 *  already seeded NULL (genuinely unlimited) in this dev database, so
 *  every other test in this file needs no override at all. */
async function setTierLimit(tier: Tier, limitBytes: number | null): Promise<void> {
  await getDb()
    .insert(billingTierLimits)
    .values({
      tier,
      cycle: "monthly",
      priceUsdCents: 0,
      mtrMin: "0",
      retentionDays: 30,
      auditLogDays: 7,
      assetStorageBytesLimit: limitBytes,
    })
    .onConflictDoUpdate({
      target: [billingTierLimits.tier, billingTierLimits.cycle],
      set: { assetStorageBytesLimit: limitBytes },
    });
}

const RSS_SAMPLE_INTERVAL_MS = 20;

/** Runs `fn`, sampling `process.memoryUsage().rss` every
 *  `RSS_SAMPLE_INTERVAL_MS` throughout, and returns the peak growth
 *  over the RSS observed immediately before `fn` started (including
 *  one final sample taken right after `fn` resolves, in case the true
 *  peak landed between the last interval tick and completion). RSS is
 *  inherently GC-noisy — see the "streams a 50 MB video" test below
 *  for what that noise looked like in practice and how the assertion
 *  is built to survive it. */
async function measureRssGrowth(fn: () => Promise<void>): Promise<number> {
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, RSS_SAMPLE_INTERVAL_MS);
  try {
    await fn();
  } finally {
    clearInterval(sampler);
  }
  const after = process.memoryUsage().rss;
  if (after > peak) peak = after;
  return peak - baseline;
}

let minio: StartedTestContainer;

beforeAll(async () => {
  minio = await startMinio();
}, 120_000);

afterAll(async () => {
  const db = getDb();
  for (const id of createdProjectIds) {
    // Cascades to billing_subscriptions / paywall_assets /
    // paywall_asset_reservations (FK ON DELETE CASCADE).
    await db.delete(projects).where(eq(projects.id, id));
  }
  await minio?.stop();
});

describe("asset upload against real storage", () => {
  it("stores an image and serves the bytes back from its public URL", async () => {
    const projectId = await seedProject();
    const png = await realPng([11, 22, 33]);

    const res = await upload("image", png as BlobPart, {
      projectId,
      name: "hero",
    }, { "content-length": String(png.byteLength) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; url: string } };
    expect(body.data.url).toContain(`${projectId}/`);
    expect(body.data.url).toContain(".webp");

    // The row exists, is real, and points at the real content type.
    const row = await drizzle.assetRepo.findAssetById(getDb(), projectId, body.data.id);
    expect(row).not.toBeNull();
    expect(row?.contentType).toBe("image/webp");

    // The public URL actually serves real WebP bytes back — through a
    // real MinIO GET, not a mock's opinion of one.
    const fetched = await fetch(body.data.url);
    expect(fetched.status).toBe(200);
    const bytes = Buffer.from(await fetched.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
  });

  // -----------------------------------------------------------
  // The claim that most needs measuring, not asserting: the video
  // route pipes the request body straight into the S3 multipart
  // Upload rather than buffering the whole 50 MB. Every other test in
  // this suite (and every unit test in assets.test.ts) proves that
  // only indirectly — via `Buffer.isBuffer(passedBody) === false`.
  // This one actually samples process RSS across the upload. The
  // methodology below is the result of two failed attempts, kept
  // in this comment because the failures are as informative as the
  // final number:
  //
  // Attempt 1 (no warm-up, single sample): a cold 50 MB upload showed
  // 78-84 MB of RSS growth — MORE than the file itself, which reads
  // like damning evidence of full buffering. It isn't: direct, repeated
  // measurement of the identical `putObject` call, bypassing this
  // route/Hono entirely, showed the SAME call costs ~74-84 MB the FIRST
  // time a process performs a multipart upload of this size, then far
  // less on every call after that — and the cost reproduced identically
  // whether the body was streamed or a single pre-built Buffer. That
  // means it's the allocator reserving a new page-class arena for this
  // size of allocation for the first time (an OS/V8-level artifact,
  // paid once per PROCESS), not this route's behaviour. So a warm-up
  // pass now runs first: a real request through the real route, to a
  // throwaway project, discarded and unmeasured.
  //
  // Attempt 2 (warm-up, single measured sample): still too noisy to
  // trust even after warm-up. 28 repeated local runs of warm-up-then-
  // measure-once produced growth readings from 0.0 MB to 45.1 MB on
  // the IDENTICAL code path, and every fixed bound tight enough to mean
  // anything (30-40 MB) still failed on the unlucky tail a few times in
  // that run — a real GC/allocator noise floor, not a real difference
  // in behaviour between the passing and failing runs. That noise is
  // exactly what this task's brief warns about by name.
  //
  // Final methodology: after the same warm-up, MEASURED_PASSES (3)
  // independent real uploads run back to back, each against its own
  // throwaway project with distinct content (so none short-circuits
  // into the video route's post-put dedup path — see below). Every raw
  // sample is logged; the assertion is made against the MEDIAN, which a
  // single unlucky GC pause cannot dominate the way it can a lone
  // sample. This is reported as a limitation, not hidden: it costs
  // three uploads' worth of noise instead of one, and it still cannot
  // rule out that a rarer, larger spike exists beyond what 3 samples
  // caught — only that the median of 3 independent real uploads stayed
  // small across every local run taken while writing this test (see the
  // task-8 report for the full set of numbers observed).
  //
  // Sampling within each pass: RSS is polled every 20 ms; the peak
  // observed sample (including one taken immediately after the request
  // resolves) minus the RSS taken immediately before the request started
  // is that pass's growth. RSS can only go up or hold steady within a
  // process (freed pages are not reliably returned to the OS), so each
  // sample is a ceiling on what that one request added, not a leak-free
  // measurement.
  //
  // The streaming body itself is generated lazily, one ~1 MB chunk at a
  // time inside the ReadableStream's `pull()`, rather than built as one
  // Buffer up front — a single 50 MB Buffer resident in the TEST's own
  // memory before the upload starts would make it impossible to tell
  // the test's own baseline apart from anything the ROUTE buffers.
  // -----------------------------------------------------------
  function makeVideoStream(totalBytes: number, salt: number): ReadableStream<Uint8Array> {
    const CHUNK_BYTES = 1024 * 1024;
    let sent = 0;
    let wroteHeader = false;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(CHUNK_BYTES, totalBytes - sent);
        const chunk = new Uint8Array(size);
        if (!wroteHeader) {
          chunk.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp" at offset 4
          chunk[12] = salt; // keeps warm-up/measured content hashes distinct
          wroteHeader = true;
        }
        sent += size;
        controller.enqueue(chunk);
      },
    });
  }

  async function uploadVideoStream(projectId: string, name: string, totalBytes: number, salt: number) {
    return app().request(uploadUrl("video", { projectId, name }), {
      method: "POST",
      headers: { "content-length": String(totalBytes) },
      body: makeVideoStream(totalBytes, salt),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  }

  it("streams a 50 MB video without buffering it whole", async () => {
    const totalBytes = ASSET_MAX_BYTES.video; // exactly at the cap
    const MEASURED_PASSES = 3;

    // Warm-up: throwaway project, unmeasured, discarded.
    const warmupProjectId = await seedProject();
    const warmupRes = await uploadVideoStream(warmupProjectId, "warmup", totalBytes, 0x00);
    expect(warmupRes.status).toBe(201); // real upload, or the warm-up isn't representative

    // MEASURED_PASSES independent measured uploads — see the
    // methodology note above for why this is 3-and-median rather than
    // 1-and-a-fixed-bound.
    const growths: number[] = [];
    let lastProjectId = "";
    for (let i = 0; i < MEASURED_PASSES; i++) {
      const projectId = await seedProject();
      let res: Response | undefined;
      const growth = await measureRssGrowth(async () => {
        res = await uploadVideoStream(projectId, `big-video-${i}`, totalBytes, 0x10 + i);
      });
      expect(res?.status).toBe(201);
      const respBody = (await res!.json()) as { data: { id: string; byteSize: number } };
      expect(respBody.data.byteSize).toBe(totalBytes);
      growths.push(growth);
      lastProjectId = projectId;
    }

    // Real object, real size, via a real MinIO HEAD-equivalent read —
    // pinned on the last of the measured passes.
    const usage = await getStorageUsage(getDb(), lastProjectId);
    expect(usage.usedBytes).toBe(totalBytes);

    const sorted = [...growths].sort((a, b) => a - b);
    const medianGrowth = sorted[Math.floor(sorted.length / 2)]!;

    // Comfortably below the 50 MB file size, and calibrated against the
    // per-sample distribution above (mean ~25 MB; a per-sample spike
    // above this bound happens, but taking 3 independent samples and
    // using the median makes it very unlikely for 2 of 3 to spike
    // together). Still far short of what full buffering would cost — a
    // single 50 MB Buffer, measured the identical way, costs at least
    // the file size itself (confirmed by direct measurement of that
    // shape; see the methodology note above), so a regression back to
    // `Buffer.from(await c.req.arrayBuffer())` still fails this
    // comfortably.
    const PEAK_GROWTH_BOUND_BYTES = 35 * 1024 * 1024;
    const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
    console.log(
      `[peak-rss] fileSize=${mb(totalBytes)}MB samples=[${growths.map(mb).join(", ")}]MB ` +
        `median=${mb(medianGrowth)}MB bound=${mb(PEAK_GROWTH_BOUND_BYTES)}MB`,
    );
    expect(medianGrowth).toBeLessThan(PEAK_GROWTH_BOUND_BYTES);
  }, 60_000);

  it("charges quota once for a byte-identical re-upload", async () => {
    const projectId = await seedProject();
    const png = await realPng([55, 66, 77]);

    const usageBefore = await getStorageUsage(getDb(), projectId);

    const first = await upload("image", png as BlobPart, {
      projectId,
      name: "dup",
    }, { "content-length": String(png.byteLength) });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { id: string } };

    const usageAfterFirst = await getStorageUsage(getDb(), projectId);
    expect(usageAfterFirst.usedBytes).toBeGreaterThan(usageBefore.usedBytes);

    const second = await upload("image", png as BlobPart, {
      projectId,
      name: "dup-again",
    }, { "content-length": String(png.byteLength) });
    // 200, not 201 — the existing row is returned, nothing new created.
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data: { id: string } };
    expect(secondBody.data.id).toBe(firstBody.data.id);

    const usageAfterSecond = await getStorageUsage(getDb(), projectId);
    expect(usageAfterSecond.usedBytes).toBe(usageAfterFirst.usedBytes);

    const rows = await drizzle.assetRepo.listAssets(getDb(), projectId);
    expect(rows).toHaveLength(1);

    // One object in the real bucket, not two.
    const keys = (await listAllKeys()).filter((k) => k.startsWith(`${projectId}/`));
    expect(keys).toHaveLength(1);
  });

  it("removes the object when the asset is deleted", async () => {
    const projectId = await seedProject();
    const png = await realPng([90, 80, 70]);

    const uploadRes = await upload("image", png as BlobPart, {
      projectId,
      name: "todelete",
    }, { "content-length": String(png.byteLength) });
    expect(uploadRes.status).toBe(201);
    const { data } = (await uploadRes.json()) as { data: { id: string; url: string } };

    const beforeDelete = await fetch(data.url);
    expect(beforeDelete.status).toBe(200);

    const delRes = await deleteAsset(projectId, data.id);
    expect(delRes.status).toBe(200);

    const afterDelete = await fetch(data.url);
    expect(afterDelete.status).toBe(404);

    const keys = (await listAllKeys()).filter((k) => k.startsWith(`${projectId}/`));
    expect(keys).toHaveLength(0);
  });

  it("frees the content hash for re-upload after deletion", async () => {
    const projectId = await seedProject();
    const png = await realPng([1, 2, 3]);

    const first = await upload("image", png as BlobPart, {
      projectId,
      name: "reuse",
    }, { "content-length": String(png.byteLength) });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { id: string } };

    const delRes = await deleteAsset(projectId, firstBody.data.id);
    expect(delRes.status).toBe(200);

    // The unique index is partial on deletedAt IS NULL — the SAME
    // bytes, in the SAME project, must succeed as a genuinely NEW
    // upload (201 with a new id), not resolve to the tombstoned row.
    const second = await upload("image", png as BlobPart, {
      projectId,
      name: "reuse-again",
    }, { "content-length": String(png.byteLength) });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { data: { id: string } };
    expect(secondBody.data.id).not.toBe(firstBody.data.id);

    const rows = await drizzle.assetRepo.listAssets(getDb(), projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(secondBody.data.id);
  });

  // -----------------------------------------------------------
  // Real Postgres, real concurrency, real objects — the one case a
  // mocked transaction cannot substantiate (see
  // services/assets/quota.integration.test.ts's equivalent case for
  // the service-level version of this same claim). This one drives it
  // through the actual HTTP route, so it also exercises the route's
  // own pre-check → reserveStorage → commit → releaseReservation path
  // under real interleaving, not just the service function directly.
  // -----------------------------------------------------------
  it("does not exceed the tier cap under concurrent uploads", async () => {
    const projectId = await seedProject("studio");

    const CONCURRENCY = 8;
    const CAP_ITEMS = 3;
    const fixtures = Array.from({ length: CONCURRENCY }, (_, i) => lottieFixture(i));
    const itemSize = fixtures[0]!.byteLength;
    for (const f of fixtures) expect(f.byteLength).toBe(itemSize);

    await setTierLimit("studio", itemSize * CAP_ITEMS);

    const responses = await Promise.all(
      fixtures.map((bytes, i) =>
        upload(
          "lottie",
          bytes as BlobPart,
          { projectId, name: `concurrent-${i}` },
          { "content-length": String(bytes.byteLength) },
        ),
      ),
    );
    const results = await Promise.all(
      responses.map(async (r) => ({ status: r.status, body: (await r.json()) as { error?: { code: string } } })),
    );

    const successes = results.filter((r) => r.status === 201);
    const failures = results.filter((r) => r.status !== 201);
    expect(successes).toHaveLength(CAP_ITEMS);
    for (const f of failures) {
      expect(f.status).toBe(402);
      expect(f.body.error?.code).toBe("ASSET_QUOTA_EXCEEDED");
    }

    // Real committed total, read back from Postgres — never exceeds,
    // and exactly hits, the cap (lottie bytes are stored unmodified,
    // no normalisation, so the math is exact rather than approximate).
    const usage = await getStorageUsage(getDb(), projectId);
    expect(usage.usedBytes).toBeLessThanOrEqual(CAP_ITEMS * itemSize);
    expect(usage.usedBytes).toBe(CAP_ITEMS * itemSize);

    const rows = await drizzle.assetRepo.listAssets(getDb(), projectId);
    expect(rows).toHaveLength(CAP_ITEMS);

    // And a real object per successful row — no orphaned or missing
    // bucket objects from the losing requests.
    const keys = (await listAllKeys()).filter((k) => k.startsWith(`${projectId}/`));
    expect(keys).toHaveLength(CAP_ITEMS);
  });
});
