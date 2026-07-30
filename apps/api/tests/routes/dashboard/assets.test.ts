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
  return app().request(uploadUrl(kind, opts), {
    method: "POST",
    headers: { "content-length": String(bytes.byteLength) },
    body: bytes as BlobPart,
  });
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
  auditMock.mockReset().mockResolvedValue(undefined);

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
});
