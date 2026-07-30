import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ASSET_MAX_BYTES } from "@rovenue/shared";

// =============================================================
// POST /dashboard/projects/:projectId/assets/:kind (paywall asset CDN,
// Task 6). Auth + capability + assetRepo + audit + the asset-store and
// quota services are all mocked at module level, mirroring
// fonts.test.ts's idiom: this exercises the real route's HTTP-layer
// decisions (gate order, error codes, response shape, the exact
// object passed to `putObject`), not a mock's opinion of them.
// `detectAssetKind` and `isValidAssetName` are NOT mocked — they are
// the REAL @rovenue/shared implementations, because the point of
// several tests below (format-vs-kind mismatch, SVG rejection, name
// validation) is that the real magic-byte/allowlist logic drives the
// decision, not a stub.
//
// `store.putObject` is mocked to actually DRAIN whatever it is given
// (Buffer or Readable) rather than the brief's bare
// `vi.fn().mockResolvedValue(undefined)`. A real S3 `Upload` always
// reads a stream to completion; a mock that never reads one would
// leave the video path's hashing `Transform` permanently stalled
// (nothing ever pulls data through it) and produce a byteSize/hash
// that reflects only whatever fit in the stream's internal buffer
// before backpressure — silently correct-looking, actually wrong. The
// draining mock is what lets the "video streams, not buffers" and
// "video hash/size are correct" assertions below mean anything.
//
// `drizzle.db.transaction` resolves its callback with a distinguishable
// SENTINEL object (not `{}`) specifically so the "releases the
// reservation inside the same transaction" test can prove
// `releaseReservation` received THAT object rather than the bare
// `drizzle.db` handle — a call with the wrong first argument is
// exactly what "release ran after the transaction, not inside it"
// would look like.
// =============================================================

const TX_SENTINEL = { __tx: "asset-upload-tx" };

const assertProjectCapability = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/capabilities", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProjectCapability: (...args: unknown[]) =>
    assertProjectCapability(...args),
}));

// Task 7: a bare membership gate, deliberately distinct from
// `assertProjectCapability` above — the list/usage GET routes only
// require the caller to belong to the project named in the URL, not
// the `assets:write` capability DELETE requires (mirrors fonts.test.ts's
// convention for the same split).
const assertProjectAccess = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/project-access", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProjectAccess: (...args: unknown[]) => assertProjectAccess(...args),
}));

vi.mock("../../../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "u1" });
    return next();
  },
}));

// Rate limiting touches Redis for real; mocked as a pass-through so
// these tests never need a live Redis (matches paywall-preview.test.ts
// and funnels.test.ts's convention for route-level limiters).
vi.mock("../../../src/middleware/rate-limit", () => ({
  endpointRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));

const auditMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  audit: (...args: unknown[]) => auditMock(...args),
}));

// Review finding (Task 7): a storage failure AFTER the row is already
// tombstoned must be logged, not surfaced as a 500 — mocked here so the
// "still succeeds" test below can assert on the log call directly
// rather than merely on the response not being a 500 (which the error
// handler catching an UNRELATED thrown error would also satisfy).
//
// `logger.child(...)` must keep working too: `audit.ts`'s real module
// (loaded via `importOriginal` in the audit mock below) calls
// `logger.child("audit")` at module scope, so a bare `{ error: fn }`
// stub breaks import entirely — `child()` returns an equally-shaped
// stub, recursively.
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/logger", () => {
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

const buildStorageKey = vi.hoisted(() => vi.fn());
const publicUrl = vi.hoisted(() => vi.fn());
const putObject = vi.hoisted(() => vi.fn());
const deleteObject = vi.hoisted(() => vi.fn());
const isStorageConfigured = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/asset-store", () => ({
  buildStorageKey: (...args: unknown[]) => buildStorageKey(...args),
  publicUrl: (...args: unknown[]) => publicUrl(...args),
  parseAssetUrl: () => null,
  putObject: (...args: unknown[]) => putObject(...args),
  deleteObject: (...args: unknown[]) => deleteObject(...args),
  isStorageConfigured: () => isStorageConfigured(),
}));

const normalizeImage = vi.hoisted(() => vi.fn());
vi.mock("../../../src/services/assets/normalize", () => {
  class MockAssetProcessingError extends Error {}
  return {
    normalizeImage: (...args: unknown[]) => normalizeImage(...args),
    AssetProcessingError: MockAssetProcessingError,
  };
});

const reserveStorage = vi.hoisted(() => vi.fn());
const releaseReservation = vi.hoisted(() => vi.fn());
const getStorageUsage = vi.hoisted(() => vi.fn());
vi.mock("../../../src/services/assets/quota", () => ({
  reserveStorage: (...args: unknown[]) => reserveStorage(...args),
  releaseReservation: (...args: unknown[]) => releaseReservation(...args),
  getStorageUsage: (...args: unknown[]) => getStorageUsage(...args),
  UNLIMITED_RESERVATION: "unlimited",
}));

const createAsset = vi.hoisted(() => vi.fn());
const findLiveAssetByHash = vi.hoisted(() => vi.fn());
const listAssets = vi.hoisted(() => vi.fn());
const findAssetById = vi.hoisted(() => vi.fn());
const softDeleteAsset = vi.hoisted(() => vi.fn());
const listPublishedUsage = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn());

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      assetRepo: {
        ...actual.drizzle.assetRepo,
        createAsset,
        findLiveAssetByHash,
        listAssets,
        findAssetById,
        softDeleteAsset,
        listPublishedUsage,
      },
      db: { ...actual.drizzle.db, transaction },
    },
  };
});

import { assetsRoute } from "../../../src/routes/dashboard/assets";
import { errorHandler } from "../../../src/middleware/error";

function app() {
  return new Hono()
    .onError(errorHandler)
    .route("/dashboard/projects/:projectId/assets", assetsRoute);
}

function uploadUrl(
  kind: string,
  opts?: { projectId?: string; name?: string },
): string {
  const projectId = opts?.projectId ?? "p1";
  const name = opts?.name ?? "hero";
  return `/dashboard/projects/${projectId}/assets/${kind}?name=${encodeURIComponent(name)}`;
}

/** Full control over headers/body — the primitive the more convenient
 *  helpers below build on. Exists because several tests need a
 *  Content-Length that's ABSENT or WRONG on purpose (see the
 *  Content-Length trust tests), which `upload()` cannot express. */
function uploadWithHeaders(
  kind: string,
  body: BodyInit,
  headers: Record<string, string>,
  opts?: { projectId?: string; name?: string },
) {
  return app().request(uploadUrl(kind, opts), {
    method: "POST",
    headers,
    body,
  });
}

function upload(
  kind: string,
  bytes: Uint8Array,
  opts?: { projectId?: string; name?: string },
) {
  // A real HTTP client (or @hono/node-server reading a real incoming
  // request) always carries a Content-Length header for a non-chunked
  // body; Node's own `Request` constructor (what Hono's `app.request()`
  // test helper builds under the hood) does NOT set one automatically
  // for an in-memory body, so it's set explicitly here to match what
  // production actually sees — this is what lets the video route take
  // its real streaming path rather than the chunked-transfer fallback.
  return uploadWithHeaders(
    kind,
    bytes as BlobPart,
    { "content-length": String(bytes.byteLength) },
    opts,
  );
}

/** Delivers `chunks` as SEPARATE reads on the wire, unlike `upload()`
 *  (a plain `Uint8Array` body, which this runtime always delivers as
 *  ONE chunk — confirmed by hand against undici). Needed to exercise
 *  `peekPrefix`'s break-then-continue-reading-the-same-stream path,
 *  which a single-chunk body cannot reach: the peek loop's `break`
 *  only matters when there is more to read afterward. `duplex: "half"`
 *  is required by the Fetch API whenever the body is a stream. */
function uploadStream(
  kind: string,
  chunks: Buffer[],
  headers: Record<string, string>,
  opts?: { projectId?: string; name?: string },
) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return app().request(uploadUrl(kind, opts), {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

/** A minimal, but real, PNG-shaped prefix (8-byte PNG magic). */
function pngBytes(padTo = 16): Uint8Array {
  const bytes = new Uint8Array(Math.max(padTo, 8));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

/** A minimal, but real, MP4-shaped prefix ("ftyp" at byte offset 4). */
function mp4Bytes(padTo = 16): Uint8Array {
  const bytes = new Uint8Array(Math.max(padTo, 12));
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  return bytes;
}

function lottieBytes(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ v: "5.6.5", layers: [] }),
  );
}

function svgBytes(): Uint8Array {
  return new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
  );
}

/** Drains a Buffer (no-op) or a Readable (consumes it to completion) —
 *  what a real S3 `Upload` does. See the module comment at the top of
 *  this file for why this matters. */
async function drain(body: Buffer | Readable): Promise<void> {
  if (Buffer.isBuffer(body)) return;
  for await (const _chunk of body) {
    // draining only
  }
}

let assetIdCounter = 0;
let reservationIdCounter = 0;

beforeEach(() => {
  assetIdCounter = 0;
  reservationIdCounter = 0;

  assertProjectCapability
    .mockReset()
    .mockResolvedValue({ id: "m1", role: "OWNER" });
  assertProjectAccess
    .mockReset()
    .mockResolvedValue({ id: "m1", role: "OWNER" });
  auditMock.mockReset().mockResolvedValue(undefined);
  loggerError.mockReset();

  buildStorageKey
    .mockReset()
    .mockImplementation((projectId: string, assetId: string, kind: string) => {
      const ext = kind === "image" ? "webp" : kind === "video" ? "mp4" : "json";
      return `${projectId}/${assetId}.${ext}`;
    });
  publicUrl.mockReset().mockImplementation((key: string) => `https://cdn.test/${key}`);
  isStorageConfigured.mockReset().mockReturnValue(true);
  putObject.mockReset().mockImplementation(async (_key: string, body: Buffer | Readable) => {
    await drain(body);
  });
  deleteObject.mockReset().mockResolvedValue(undefined);

  // Default: normalisation is the identity function on whatever bytes
  // it was given (real dimensions/policy don't matter to these route
  // tests — sharp itself has its own coverage in normalize.test.ts).
  normalizeImage.mockReset().mockImplementation(async (buf: Buffer) => ({
    bytes: buf,
    width: 10,
    height: 10,
    sourceWidth: 10,
    sourceHeight: 10,
    policyVersion: 1,
  }));

  reserveStorage
    .mockReset()
    .mockImplementation(async () => `res_${++reservationIdCounter}`);
  releaseReservation.mockReset().mockResolvedValue(undefined);
  getStorageUsage.mockReset().mockResolvedValue({ usedBytes: 0, limitBytes: null });

  createAsset.mockReset().mockImplementation(
    async (
      _tx: unknown,
      input: {
        projectId: string;
        kind: string;
        name: string;
        storageKey: string;
        contentHash: string;
        contentType: string;
        byteSize: number;
        width: number | null;
        height: number | null;
        sourceFormat: string | null;
        sourceWidth: number | null;
        sourceHeight: number | null;
        policyVersion: number;
      },
    ) => ({
      id: `asset_${++assetIdCounter}`,
      ...input,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    }),
  );
  findLiveAssetByHash.mockReset().mockResolvedValue(null);
  listAssets.mockReset().mockResolvedValue([]);
  findAssetById.mockReset().mockResolvedValue(null);
  softDeleteAsset.mockReset().mockResolvedValue(undefined);
  listPublishedUsage.mockReset().mockResolvedValue([]);
  transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(TX_SENTINEL),
    );
});

describe("POST /dashboard/projects/:projectId/assets/:kind", () => {
  it("rejects a body over the per-kind cap with ASSET_FILE_TOO_LARGE", async () => {
    // A real body one byte over the image cap: fetch sets Content-Length
    // to match, so hono/body-limit's header-only branch fires and
    // rejects before the handler (and its own arrayBuffer() read) ever
    // runs — assertProjectCapability seeing zero calls is what proves
    // the rejection happened at the body-limit gate.
    const bytes = new Uint8Array(ASSET_MAX_BYTES.image + 1);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await upload("image", bytes);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("ASSET_FILE_TOO_LARGE");
    expect(assertProjectCapability).not.toHaveBeenCalled();
  });

  it("uses the LOTTIE cap on the lottie route, not the video cap", async () => {
    // 5 MB clears the video cap (50 MB) but not the lottie cap (2 MB).
    // This is what proves the three bodyLimit registrations are bound
    // independently rather than all sharing the loosest (video) limit
    // — a single shared registration would let the lottie request
    // through too.
    const fiveMb = 5 * 1024 * 1024;
    expect(fiveMb).toBeLessThan(ASSET_MAX_BYTES.video);
    expect(fiveMb).toBeGreaterThan(ASSET_MAX_BYTES.lottie);

    const videoBody = mp4Bytes(fiveMb);
    const videoRes = await upload("video", videoBody);
    expect(videoRes.status).not.toBe(413);
    expect(videoRes.status).toBe(201);

    const lottieBody = new Uint8Array(fiveMb);
    const lottieRes = await upload("lottie", lottieBody);
    expect(lottieRes.status).toBe(413);
    expect((await lottieRes.json()).error.code).toBe("ASSET_FILE_TOO_LARGE");
  });

  it("rejects bytes that disagree with the kind in the path", async () => {
    // MP4 bytes posted to .../assets/image -> ASSET_FORMAT_UNSUPPORTED,
    // even though the bytes are a perfectly valid asset of a DIFFERENT
    // kind. The path segment names the intent; the bytes must confirm
    // it, not merely "be some accepted format".
    const res = await upload("image", mp4Bytes());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("ASSET_FORMAT_UNSUPPORTED");
    expect(normalizeImage).not.toHaveBeenCalled();
  });

  it("rejects SVG bytes with ASSET_FORMAT_UNSUPPORTED", async () => {
    // SVG is text, not magic bytes, and is deliberately absent from
    // detectAssetKind — accepting it would hand attacker-controlled XML
    // to the image pipeline.
    const res = await upload("image", svgBytes());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("ASSET_FORMAT_UNSUPPORTED");
  });

  it("rejects an invalid name with ASSET_INVALID_NAME", async () => {
    const res = await upload("image", pngBytes(), { name: "../etc/passwd" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("ASSET_INVALID_NAME");
    // Name validation is the very first gate — nothing downstream
    // (capability, quota, format) should ever run for a name this
    // route already knows it will reject.
    expect(assertProjectCapability).not.toHaveBeenCalled();
  });

  it("returns ASSET_QUOTA_EXCEEDED before running sharp when the project is full", async () => {
    getStorageUsage.mockResolvedValue({ usedBytes: 100, limitBytes: 100 });
    const res = await upload("image", pngBytes());
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("ASSET_QUOTA_EXCEEDED");
    // The load-bearing assertion: normalisation (sharp) must never run
    // for a project that cannot store the result — a status-code-only
    // check would pass even if the gate order regressed and sharp ran
    // first.
    expect(normalizeImage).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
  });

  it("returns ASSET_STORAGE_UNAVAILABLE when storage is unconfigured", async () => {
    isStorageConfigured.mockReturnValue(false);
    const res = await upload("image", pngBytes());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("ASSET_STORAGE_UNAVAILABLE");
    // Storage configuration is checked before the quota query — no
    // point asking "is there room" when there is nowhere to put it.
    expect(getStorageUsage).not.toHaveBeenCalled();
  });

  it("returns the existing asset for a byte-identical re-upload", async () => {
    // normalizeImage's default mock (identity) means the content hash
    // is computed over the raw png bytes.
    const bytes = pngBytes();
    const contentHash = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    const existing = {
      id: "asset_existing",
      projectId: "p1",
      kind: "image",
      name: "hero",
      storageKey: "p1/asset_existing.webp",
      contentHash,
      contentType: "image/webp",
      byteSize: bytes.byteLength,
      width: 10,
      height: 10,
      sourceFormat: "png",
      sourceWidth: 10,
      sourceHeight: 10,
      policyVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    findLiveAssetByHash.mockResolvedValue(existing);

    const res = await upload("image", bytes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; url: string } };
    expect(body.data.id).toBe("asset_existing");
    expect(body.data.url).toBe("https://cdn.test/p1/asset_existing.webp");
    expect(findLiveAssetByHash).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
      contentHash,
    );
    // One row, one publicUrl, quota charged once: none of the
    // write/reserve path should run for a duplicate.
    expect(reserveStorage).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
    expect(createAsset).not.toHaveBeenCalled();
  });

  it("requires assets:write", async () => {
    // A CUSTOMER_SUPPORT member gets 403 — same shape assertProjectCapability
    // itself throws for a role lacking the capability.
    assertProjectCapability.mockRejectedValue(
      new HTTPException(403, {
        message: "Role CUSTOMER_SUPPORT lacks capability assets:write",
      }),
    );
    const res = await upload("image", pngBytes());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(putObject).not.toHaveBeenCalled();
  });

  it("writes an audit entry on success", async () => {
    const res = await upload("image", pngBytes());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        userId: "u1",
        action: "asset.uploaded",
        resource: "paywall_asset",
        resourceId: body.data.id,
      }),
      TX_SENTINEL,
    );
  });

  // -----------------------------------------------------------
  // The three load-bearing behaviours from the task brief, each
  // pinned by a test that fails if the behaviour regresses — not
  // merely a status-code check that would still pass.
  // -----------------------------------------------------------

  it("streams the video body straight into putObject rather than buffering it whole", async () => {
    const bytes = mp4Bytes(1024);
    const res = await upload("video", bytes);
    expect(res.status).toBe(201);
    expect(putObject).toHaveBeenCalledTimes(1);

    const passedBody = putObject.mock.calls[0]?.[1];
    // The load-bearing assertion: a Buffer here means the handler
    // reverted to `Buffer.from(await c.req.arrayBuffer())` for video —
    // exactly the buffering the per-kind bodyLimit split exists to
    // avoid at 50 MB. A stream proves the bytes were forwarded chunk
    // by chunk instead.
    expect(Buffer.isBuffer(passedBody)).toBe(false);
    expect(typeof (passedBody as { pipe?: unknown }).pipe).toBe("function");

    // Not just "some stream" — the RIGHT bytes actually flowed through
    // it: the committed row's byteSize matches the real body length.
    expect(createAsset).toHaveBeenCalledWith(
      TX_SENTINEL,
      expect.objectContaining({ kind: "video", byteSize: bytes.byteLength }),
    );
  });

  it("releases the reservation inside the same transaction as the row insert, not after it", async () => {
    const res = await upload("image", pngBytes());
    expect(res.status).toBe(201);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(createAsset).toHaveBeenCalledWith(TX_SENTINEL, expect.anything());
    // The load-bearing assertion: releaseReservation's first argument
    // must be the SAME tx object the transaction callback received —
    // a call with the bare (non-tx) db handle is what "released after
    // the transaction committed" looks like, and would leave the
    // reservation double-counting the upload's bytes until the sweeper
    // clears it hours later.
    expect(releaseReservation).toHaveBeenCalledWith(
      TX_SENTINEL,
      expect.any(String),
    );
    // releaseReservation must be called exactly once, with the tx
    // object above — never a second time with the bare db handle.
    expect(releaseReservation).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------
  // Content-Length trust boundary (review round 1, Important finding
  // 1). `hono/body-limit` (node_modules/hono/dist/middleware/body-
  // limit/index.js) does ONE comparison against the header and calls
  // `next()` WITHOUT reading a byte when Content-Length is present and
  // Transfer-Encoding is absent — it does NOT bound the transport by
  // reading chunks in that case. The chunk-counting fallback only runs
  // when there's no reliable declared length. These tests pin what
  // THIS route does with that declared value in each case, rather than
  // leaving the claim as an unverified comment.
  // -----------------------------------------------------------

  it("falls back to the buffered path and reserves the TRUE byte count when Content-Length is absent", async () => {
    // No header at all (the chunked-transfer shape): body-limit itself
    // falls back to reading and counting chunks, so there is no
    // reliable declared size for this route to stream against. The
    // load-bearing assertion is that `reserveStorage` receives the
    // REAL, already-known byte count — not NaN, 0, or undefined, which
    // is what a naive `Number(undefined)` would have produced.
    const bytes = mp4Bytes(2048);
    const res = await uploadWithHeaders("video", bytes as BlobPart, {}, {});
    expect(res.status).toBe(201);
    expect(reserveStorage).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
      bytes.byteLength,
    );
    // Confirms the buffered fallback was actually taken (a Buffer, not
    // a stream, reached putObject) — not the streaming path fed a
    // fallback estimate.
    expect(Buffer.isBuffer(putObject.mock.calls[0]?.[1])).toBe(true);
  });

  it("does not trust a Content-Length that's accompanied by Transfer-Encoding", async () => {
    // Per RFC 7230 §3.3.3, Content-Length must be ignored when
    // Transfer-Encoding is also present — and body-limit's own source
    // already behaves that way (`hasContentLength && !hasTransferEncoding`).
    // This route must mirror that, not trust the header just because
    // it's present: reserving off a number body-limit itself no longer
    // believes would be worse than not having the header at all.
    const bytes = mp4Bytes(2048);
    const res = await uploadWithHeaders(
      "video",
      bytes as BlobPart,
      { "content-length": "10", "transfer-encoding": "chunked" },
      {},
    );
    expect(res.status).toBe(201);
    expect(reserveStorage).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
      bytes.byteLength,
    );
    expect(Buffer.isBuffer(putObject.mock.calls[0]?.[1])).toBe(true);
  });

  it("reserves against the declared Content-Length, not the actual streamed size, when they disagree", async () => {
    // Behind a real HTTP server this specific mismatch (declared
    // SMALLER than actual) cannot happen — Content-Length bounds how
    // many body bytes the server ever delivers to this handler (RFC
    // 7230 §3.3.3), so actual received is bounded by declared there.
    // It CAN happen in a synthetic Request built directly (no real
    // wire framing to enforce it), which is exactly what's constructed
    // here — this is what turns "the reservation is an upper-bound
    // estimate" from a comment into an assertion.
    const bytes = mp4Bytes(2048);
    const declared = 100;
    const res = await uploadWithHeaders(
      "video",
      bytes as BlobPart,
      { "content-length": String(declared) },
      {},
    );
    expect(res.status).toBe(201);
    // Reserved against the (wrong, too-small) declared size...
    expect(reserveStorage).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
      declared,
    );
    // ...but the committed row always carries the TRUE size, hashed
    // from what actually streamed through — an under-reservation never
    // corrupts the record, it only under-charges the quota for that
    // one upload (documented accepted risk, same class as the Task 5
    // tier-limit-read-before-lock race).
    expect(createAsset).toHaveBeenCalledWith(
      TX_SENTINEL,
      expect.objectContaining({ byteSize: bytes.byteLength }),
    );
  });

  it("reserves against a Content-Length larger than the actual body, then releases the over-reservation and stores the TRUE byte count", async () => {
    // The mirror image of the test above, and the third of the three
    // Content-Length cases the comment above `reserveStorage(...)` in
    // streamVideo enumerates: declared > actual. This one is the
    // ordinary case for a well-behaved client (an accurate-but-rounded
    // estimate, or one that pads slightly) rather than the synthetic
    // edge case above, and it's the one whose "harmless" claim depends
    // entirely on the release actually happening — a lingering
    // reservation here would hold phantom bytes against the project's
    // cap until the sweeper cleared it hours later, with no error to
    // surface it.
    const bytes = mp4Bytes(2048); // the TRUE body
    const declared = bytes.byteLength + 5_000_000; // claims ~5 MB more
    const res = await uploadWithHeaders(
      "video",
      bytes as BlobPart,
      { "content-length": String(declared) },
      {},
    );
    expect(res.status).toBe(201);

    // Reserved against the (over-stated) declared size...
    expect(reserveStorage).toHaveBeenCalledWith(
      expect.anything(),
      "p1",
      declared,
    );
    // ...but the committed row carries the TRUE, smaller streamed size.
    expect(createAsset).toHaveBeenCalledWith(
      TX_SENTINEL,
      expect.objectContaining({ byteSize: bytes.byteLength }),
    );
    // The load-bearing assertion: the over-reservation does not linger.
    // It must be released with the SAME reservation id reserveStorage
    // returned ("res_1" — the mock's counter resets to 0 in beforeEach,
    // so this test's single reservation call is deterministically the
    // first), inside the SAME transaction as the row commit (the tx
    // sentinel, not the bare db handle — see the "releases the
    // reservation inside the same transaction" test above for what a
    // regression here looks like) — exactly once, never left open.
    expect(releaseReservation).toHaveBeenCalledWith(TX_SENTINEL, "res_1");
    expect(releaseReservation).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------
  // Regression test for the `destroyOnReturn: false` fix in
  // `peekPrefix` (review round 1, Important finding 2). A single-chunk
  // body — what `upload()`'s plain `Uint8Array` is always delivered as
  // by this runtime — cannot exercise the bug: the peek loop's `break`
  // only matters when the stream has more to give afterward. Four real
  // wire chunks force exactly that: the peek loop must break mid-
  // stream (after chunk 3, once >= DETECT_PREFIX_BYTES=64 bytes have
  // accumulated) and the replay loop must then keep reading the SAME
  // underlying Readable to pick up chunk 4. Before the fix, breaking
  // destroyed the stream and chunk 4 was silently lost — the response
  // still succeeded, the row's byteSize just came up short, which is
  // exactly the "video looks uploaded but won't finish playing" defect
  // class this exists to catch.
  // -----------------------------------------------------------

  it("streams a multi-chunk video body into putObject byte-for-byte, in order", async () => {
    const chunks = [
      Buffer.from(mp4Bytes(30)), // carries the ftyp magic at offset 4
      Buffer.alloc(30, 2),
      Buffer.alloc(30, 3),
      Buffer.alloc(30, 4),
    ];
    const expected = Buffer.concat(chunks);
    // 120 bytes > the route's internal DETECT_PREFIX_BYTES (64), so the
    // peek loop is guaranteed to break with data still unread.
    expect(expected.byteLength).toBeGreaterThan(64);

    const res = await uploadStream(
      "video",
      chunks,
      { "content-length": String(expected.byteLength) },
      {},
    );
    expect(res.status).toBe(201);
    expect(createAsset).toHaveBeenCalledWith(
      TX_SENTINEL,
      expect.objectContaining({
        kind: "video",
        byteSize: expected.byteLength,
        contentHash: createHash("sha256").update(expected).digest("hex"),
      }),
    );
  });
});

// =============================================================
// GET/DELETE (Task 7): list, usage lookup, delete
// =============================================================

/** Minimal, but complete, `paywallAssets` row shape — same fields the
 *  "returns the existing asset for a byte-identical re-upload" test
 *  above builds by hand, factored out for reuse here. */
function assetFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "asset_1",
    projectId: "p1",
    kind: "image",
    name: "hero",
    storageKey: "p1/asset_1.webp",
    contentHash: "a".repeat(64),
    contentType: "image/webp",
    byteSize: 1234,
    width: 10,
    height: 10,
    sourceFormat: "png",
    sourceWidth: 10,
    sourceHeight: 10,
    policyVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function listAssetsRes(projectId = "p1") {
  return app().request(`/dashboard/projects/${projectId}/assets`);
}

function assetUsageRes(id: string, projectId = "p1") {
  return app().request(`/dashboard/projects/${projectId}/assets/${id}/usage`);
}

function deleteAssetRes(id: string, projectId = "p1") {
  return app().request(`/dashboard/projects/${projectId}/assets/${id}`, {
    method: "DELETE",
  });
}

describe("GET /dashboard/projects/:projectId/assets", () => {
  it("lists live assets with their public URLs and the project's usage", async () => {
    listAssets.mockResolvedValue([assetFixture()]);
    getStorageUsage.mockResolvedValue({ usedBytes: 1234, limitBytes: 5000 });

    const res = await listAssetsRes();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        assets: Array<{ id: string; url: string } & Record<string, unknown>>;
        usage: { usedBytes: number; limitBytes: number | null };
      };
    };
    expect(body.data.assets).toHaveLength(1);
    expect(body.data.assets[0].id).toBe("asset_1");
    // The DTO substitutes `url` for the raw `storageKey` (never leaked
    // to a dashboard client) — same mapping `toDto` performs for the
    // upload routes.
    expect(body.data.assets[0].url).toBe("https://cdn.test/p1/asset_1.webp");
    expect(body.data.assets[0]).not.toHaveProperty("storageKey");
    expect(body.data.usage).toEqual({ usedBytes: 1234, limitBytes: 5000 });
    expect(listAssets).toHaveBeenCalledWith(expect.anything(), "p1");
    expect(assertProjectAccess).toHaveBeenCalledWith(
      "p1",
      "u1",
      expect.anything(),
    );
  });

  it("omits soft-deleted assets", async () => {
    // The repo call itself already filters `deletedAt is null` (pinned
    // in assets.integration.test.ts); this test pins that the route
    // passes the repo's result straight through rather than
    // re-including anything.
    listAssets.mockResolvedValue([]);
    const res = await listAssetsRes();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { assets: unknown[] } };
    expect(body.data.assets).toEqual([]);
  });

  it("does not leak another project's assets", async () => {
    // listAssets is scoped by the projectId argument the route passes
    // it — this pins that the URL's projectId, not some other value,
    // is what reaches the repo call.
    listAssets.mockImplementation(async (_db: unknown, projectId: string) =>
      projectId === "p1" ? [assetFixture()] : [],
    );
    const res = await listAssetsRes("p2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { assets: unknown[] } };
    expect(body.data.assets).toEqual([]);
    expect(listAssets).toHaveBeenCalledWith(expect.anything(), "p2");
  });
});

describe("GET /dashboard/projects/:projectId/assets/:id/usage", () => {
  it("returns the published paywalls referencing the asset", async () => {
    findAssetById.mockResolvedValue(assetFixture());
    listPublishedUsage.mockResolvedValue([
      { id: "pw_1", name: "Onboarding paywall" },
    ]);

    const res = await assetUsageRes("asset_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { publishedPaywalls: Array<{ id: string; name: string }> };
    };
    expect(body.data.publishedPaywalls).toEqual([
      { id: "pw_1", name: "Onboarding paywall" },
    ]);
    expect(listPublishedUsage).toHaveBeenCalledWith(
      expect.anything(),
      "asset_1",
    );
  });

  it("returns an empty list for an asset only a draft references", async () => {
    // The index covers published versions only (design spec §7): a
    // `paywall_asset_usages` row can exist for a paywall's draft (or an
    // older, no-longer-published version) and still correctly produce
    // an empty list here, because `listPublishedUsage` joins on the
    // paywall's CURRENT `publishedVersionId`. This pins that the ROUTE
    // surfaces exactly what the repo returns — the boundary itself is
    // pinned against real Postgres in assets.integration.test.ts, where
    // it's exercised with an actually-inserted row that fails this
    // join on purpose. An empty array here must read as "correctly
    // reports nothing live", not as a bug.
    findAssetById.mockResolvedValue(assetFixture());
    listPublishedUsage.mockResolvedValue([]);

    const res = await assetUsageRes("asset_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { publishedPaywalls: unknown[] };
    };
    expect(body.data.publishedPaywalls).toEqual([]);
  });

  it("returns 404 for an asset that does not exist (or belongs to another project)", async () => {
    findAssetById.mockResolvedValue(null);
    const res = await assetUsageRes("nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(listPublishedUsage).not.toHaveBeenCalled();
  });
});

describe("DELETE /dashboard/projects/:projectId/assets/:id", () => {
  // -----------------------------------------------------------
  // The one behaviour in this file that must not be got backwards
  // (design spec §5.8): the row is soft-deleted FIRST, inside the same
  // transaction as the audit entry, and the bucket object is deleted
  // SECOND, after that transaction commits. A status-code-only
  // assertion ("both eventually ran") would still pass if the order
  // were reversed, so this test records the actual call order via a
  // shared array and asserts on it directly.
  // -----------------------------------------------------------
  it("soft-deletes the row and then deletes the object, in that order", async () => {
    findAssetById.mockResolvedValue(assetFixture({ storageKey: "p1/asset_1.webp" }));
    const order: string[] = [];
    softDeleteAsset.mockImplementation(async () => {
      order.push("softDeleteAsset");
    });
    deleteObject.mockImplementation(async () => {
      order.push("deleteObject");
    });

    const res = await deleteAssetRes("asset_1");
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ data: { deleted: true } });

    expect(order).toEqual(["softDeleteAsset", "deleteObject"]);
    expect(softDeleteAsset).toHaveBeenCalledWith(TX_SENTINEL, "p1", "asset_1");
    expect(deleteObject).toHaveBeenCalledWith("p1/asset_1.webp");
  });

  // Review finding (Task 7, Important): the row is already tombstoned
  // and the transaction has committed by the time `deleteObject` runs —
  // the delete has substantially succeeded. If `deleteObject` rejects,
  // that must NOT surface as a 500 (which would tell the caller the
  // delete failed and invite a retry that can only ever 404, since the
  // row is already gone); it must be logged and the response must
  // still be the normal success envelope. A test that only checked
  // "no 500" would also pass if the route swallowed some UNRELATED
  // error, so this asserts the specific log call too.
  it("still returns success and logs when the storage delete fails after the row is tombstoned", async () => {
    findAssetById.mockResolvedValue(assetFixture({ storageKey: "p1/asset_1.webp" }));
    const storageErr = new Error("S3 unreachable");
    deleteObject.mockRejectedValue(storageErr);

    const res = await deleteAssetRes("asset_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deleted: true } });

    // The row is still tombstoned regardless of the storage outcome —
    // softDeleteAsset already ran and committed before deleteObject was
    // ever called.
    expect(softDeleteAsset).toHaveBeenCalledWith(TX_SENTINEL, "p1", "asset_1");
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("sweeper will reclaim"),
      expect.objectContaining({
        assetId: "asset_1",
        storageKey: "p1/asset_1.webp",
        err: "S3 unreachable",
      }),
    );
  });

  it("returns 404 for another project's asset", async () => {
    // findAssetById is scoped by (projectId, id) in the repo (pinned in
    // assets.integration.test.ts); mocked here to reflect that scoping
    // so this test pins the route's REACTION to "not found" — a 404,
    // not a 403 (which would confirm to a caller who cannot have it
    // that the asset exists somewhere).
    findAssetById.mockResolvedValue(null);
    const res = await deleteAssetRes("asset_1", "p2");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(softDeleteAsset).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("requires assets:write", async () => {
    assertProjectCapability.mockRejectedValue(
      new HTTPException(403, {
        message: "Role CUSTOMER_SUPPORT lacks capability assets:write",
      }),
    );
    const res = await deleteAssetRes("asset_1");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(findAssetById).not.toHaveBeenCalled();
    expect(softDeleteAsset).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("writes an audit entry", async () => {
    findAssetById.mockResolvedValue(assetFixture());
    const res = await deleteAssetRes("asset_1");
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        userId: "u1",
        action: "asset.deleted",
        resource: "paywall_asset",
        resourceId: "asset_1",
      }),
      TX_SENTINEL,
    );
  });
});
