import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { createId } from "@paralleldrive/cuid2";
import { drizzle } from "@rovenue/db";
import {
  ERROR_CODE,
  ASSET_MAX_BYTES,
  ASSET_CONTENT_TYPES,
  ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE,
  detectAssetKind,
  isValidAssetName,
  type AssetKind,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { assertProjectCapability } from "../../lib/capabilities";
import { audit, extractRequestContext } from "../../lib/audit";
import { fail, ok } from "../../lib/response";
import * as store from "../../lib/asset-store";
import { normalizeImage, AssetProcessingError } from "../../services/assets/normalize";
import {
  reserveStorage,
  releaseReservation,
  getStorageUsage,
} from "../../services/assets/quota";

// =============================================================
// Dashboard: paywall assets — upload
// =============================================================
//
// The upload transport is a RAW BODY, not multipart, and that is the
// load-bearing decision here. `parseBody()`/`formData()` fully buffer
// the request body; at a 50 MB video cap, five concurrent uploads
// would be 250 MB resident in a process that API_REPLICAS multiplies.
// Fonts (routes/dashboard/fonts.ts) could afford multipart because it
// carried four metadata fields and a 2 MB cap. Here the metadata is a
// single query param, so multipart buys nothing and costs the
// buffering.
//
// `bodyLimit` is bound THREE TIMES because its `maxSize` is fixed at
// route-registration time and cannot vary per request. One
// registration would have to use the loosest cap, letting an image
// upload accept a 50 MB body. So the kind is a path segment and each
// registration binds its own kind's real cap — see the loop at the
// bottom of this file.
//
// Video streaming: images (10 MB) and Lottie (2 MB) are small enough
// that buffering the whole body with `arrayBuffer()` is fine — sharp
// needs the whole image in memory anyway. Video (50 MB) is not: at
// concurrency, buffering defeats the entire reason `bodyLimit` is
// bound per-kind. For `kind === "video"` the body is piped through a
// hashing/counting `Transform` straight into `store.putObject`, so the
// bytes are never fully resident — this is only possible when the
// request carries a `Content-Length` header, because `hono/body-limit`
// itself falls back to fully buffering the body when one is absent
// (it cannot enforce the cap by reading the header alone, so it reads
// and re-wraps every chunk before we ever see it — see
// node_modules/hono/dist/middleware/body-limit). In that fallback case
// the memory cost has already been paid by body-limit regardless of
// what this route does, so we take the simple buffered path too rather
// than duplicate the buffering.
//
// Streaming means the content hash — and therefore the dedup check —
// cannot be known until the object has already been written (the
// upload IS the hashing pass). So for video the dedup check runs
// AFTER the put, not before: a byte-identical re-upload still lands in
// the bucket once, gets recognised as a duplicate, and is deleted
// again (best-effort; the orphan sweeper is the backstop) rather than
// ever getting a second row or a second quota charge. Image/Lottie
// keep the pre-put dedup check because their bytes are already
// resident by the time the hash is needed.
//
// Gate order is cheapest-first, with one deliberate change from fonts:
// the quota pre-check runs BEFORE format detection, because the next
// step after detection runs sharp (image) or a stream upload (video),
// and spending that cost on a project that cannot store the result is
// pointless. Quota is then checked a SECOND time — via `reserveStorage`
// — against the true post-normalisation size for images (normalisation
// SHRINKS the input, so a pre-check alone would reject uploads that
// would in fact have fit) or the declared `Content-Length` for a
// streamed video (the true byte count is not known until the stream
// ends, so the reservation uses the client-declared size as an upper
// bound; the committed row always stores the true count).
//
// The object is written BEFORE the row, and deliberately NOT in one
// transaction: an S3 put cannot be rolled back, so a transaction that
// failed after the put would leave an object that quota — which counts
// rows — cannot see. The orphan sweeper (Task 9) reclaims the reverse
// failure (row missing, object present). `releaseReservation` runs
// INSIDE the same transaction as the row insert: a reservation that
// outlives its upload holds its bytes against the cap TWICE (as the
// reservation AND as the committed row) until the sweeper clears it
// hours later.

const KIND_TOO_LARGE_MESSAGE: Record<AssetKind, string> = {
  image: `File exceeds the ${ASSET_MAX_BYTES.image}-byte image limit`,
  video: `File exceeds the ${ASSET_MAX_BYTES.video}-byte video limit`,
  lottie: `File exceeds the ${ASSET_MAX_BYTES.lottie}-byte Lottie limit`,
};

/** Enough to hold every magic-byte check `detectAssetKind` performs
 *  (the longest is the 12-byte MP4 `ftyp` check). Small and fixed on
 *  purpose — this is the only prefix ever buffered for a streamed
 *  video upload. */
const DETECT_PREFIX_BYTES = 64;

function toDto(asset: { storageKey: string } & Record<string, unknown>) {
  const { storageKey: _storageKey, ...rest } = asset;
  return { ...rest, url: store.publicUrl(asset.storageKey) };
}

/** Computes a running sha256 + byte count over data as it passes
 *  through, without buffering it — the hash and count are only valid
 *  once the stream this feeds has been fully drained by its consumer
 *  (in production, the S3 `Upload`'s own multipart reads). */
class HashCountingTransform extends Transform {
  private readonly hasher = createHash("sha256");
  bytes = 0;

  override _transform(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.hasher.update(chunk);
    this.bytes += chunk.byteLength;
    this.push(chunk);
    callback();
  }

  digestHex(): string {
    return this.hasher.digest("hex");
  }
}

/** Reads chunks off `readable` until at least `size` bytes have been
 *  seen (or the stream ends), then hands back that prefix AND a new
 *  Readable that replays it before continuing the original stream —
 *  so the caller can peek at the start of a request body for format
 *  detection without consuming it. Only `size` bytes (a small, fixed
 *  constant) are ever buffered by this step. */
async function peekPrefix(
  readable: Readable,
  size: number,
): Promise<{ prefix: Buffer; stream: Readable }> {
  const chunks: Buffer[] = [];
  let total = 0;
  // `destroyOnReturn: false` is load-bearing: breaking a plain
  // `for await...of` over a Node `Readable` calls the iterator's
  // `return()`, which by default DESTROYS the stream — so a bare
  // `break` here would abort `readable` and every byte after the
  // prefix would be lost (the second loop below would throw
  // AbortError instead of yielding the rest of the video). This
  // iterator leaves the stream alive across the break so `replay()`
  // can keep reading it afterward.
  const iterator = readable.iterator({ destroyOnReturn: false });
  for await (const chunk of iterator) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    chunks.push(buf);
    total += buf.byteLength;
    if (total >= size) break;
  }
  const buffered = Buffer.concat(chunks, total);
  const prefix = buffered.subarray(0, Math.min(size, buffered.length));
  const stream = Readable.from(
    (async function* replay() {
      if (buffered.length > 0) yield buffered;
      for await (const chunk of readable) yield chunk;
    })(),
  );
  return { prefix, stream };
}

// =============================================================
// Buffered path — image and lottie
// =============================================================

async function handleBuffered(
  c: Context,
  kind: "image" | "lottie",
  projectId: string,
  name: string,
  userId: string,
) {
  const raw = Buffer.from(await c.req.arrayBuffer());
  // No in-handler size re-check here, unlike fonts.ts's Gate 2: that
  // route's `bodyLimit` had to be loosened by a multipart framing
  // allowance (boundary + part headers), so its own bodyLimit could
  // not be the precise authority on the FILE's size and a second,
  // exact check was needed after parseBody. This transport is a raw
  // body — bodyLimit's `maxSize` IS `ASSET_MAX_BYTES[kind]` exactly,
  // no allowance — so it already is the precise authority; a second
  // check here would be redundant AND would blur the one property a
  // reviewer needs to see clearly: that each kind's cap is enforced
  // ONLY by that kind's own `bodyLimit` registration (see the loop at
  // the bottom of this file, and the "uses the LOTTIE cap on the
  // lottie route" test, which exists specifically to catch a
  // regression to one shared registration).
  const detected = detectAssetKind(raw);
  if (!detected || detected.kind !== kind) {
    return c.json(
      fail(
        ERROR_CODE.ASSET_FORMAT_UNSUPPORTED,
        `Bytes do not look like a ${kind}`,
      ),
      400,
    );
  }

  let bytes: Buffer = raw;
  let width: number | null = null;
  let height: number | null = null;
  let sourceWidth: number | null = null;
  let sourceHeight: number | null = null;
  let policyVersion = 0;

  if (kind === "image") {
    try {
      const normalized = await normalizeImage(raw);
      bytes = normalized.bytes;
      width = normalized.width;
      height = normalized.height;
      sourceWidth = normalized.sourceWidth;
      sourceHeight = normalized.sourceHeight;
      policyVersion = normalized.policyVersion;
    } catch (err) {
      if (err instanceof AssetProcessingError) {
        return c.json(
          fail(ERROR_CODE.ASSET_PROCESSING_FAILED, err.message),
          400,
        );
      }
      throw err;
    }
  }

  const contentHash = createHash("sha256").update(bytes).digest("hex");

  // Idempotent upload: identical bytes return the existing row rather
  // than creating a second one, so quota is not charged twice.
  const existing = await drizzle.assetRepo.findLiveAssetByHash(
    drizzle.db,
    projectId,
    contentHash,
  );
  if (existing) {
    return c.json(ok(toDto(existing)));
  }

  // Second quota check, against the TRUE post-normalisation size —
  // normalisation shrinks images, so the pre-check above alone would
  // reject uploads that would in fact have fit.
  const reservationId = await reserveStorage(drizzle.db, projectId, bytes.byteLength);
  if (reservationId === null) {
    return c.json(fail(ERROR_CODE.ASSET_QUOTA_EXCEEDED, "Storage quota exhausted"), 402);
  }

  const assetId = createId();
  const storageKey = store.buildStorageKey(projectId, assetId, kind);

  // Object FIRST, row second — see the module comment.
  await store.putObject(storageKey, bytes, ASSET_CONTENT_TYPES[kind]);

  const asset = await drizzle.db.transaction(async (tx) => {
    const row = await drizzle.assetRepo.createAsset(tx, {
      projectId,
      kind,
      name,
      storageKey,
      contentHash,
      contentType: ASSET_CONTENT_TYPES[kind],
      byteSize: bytes.byteLength,
      width,
      height,
      sourceFormat: detected.sourceFormat,
      sourceWidth,
      sourceHeight,
      policyVersion,
    });
    await audit(
      {
        projectId,
        userId,
        action: "asset.uploaded",
        resource: "paywall_asset",
        resourceId: row.id,
        after: { kind, name, byteSize: row.byteSize, contentHash: row.contentHash },
        ...extractRequestContext(c),
      },
      tx,
    );
    // Same transaction as the insert, deliberately — see module comment.
    await releaseReservation(tx, reservationId);
    return row;
  });

  return c.json(ok(toDto(asset)), 201);
}

// =============================================================
// Streaming path — video
// =============================================================

async function handleStreamedVideo(
  c: Context,
  projectId: string,
  name: string,
  userId: string,
) {
  const contentLengthHeader = c.req.header("content-length");
  // Mirrors `hono/body-limit`'s OWN trust condition exactly (see
  // node_modules/hono/dist/middleware/body-limit: `hasContentLength &&
  // !hasTransferEncoding`) rather than trusting Content-Length whenever
  // it's merely present. Per RFC 7230 §3.3.3, a request carrying BOTH
  // headers must have Content-Length ignored — Transfer-Encoding wins —
  // and body-limit already does that (it falls through to its
  // read-and-count loop). If this route trusted the header anyway, a
  // request with a stale/attacker-chosen Content-Length alongside
  // `transfer-encoding: chunked` would size the reservation off a
  // number body-limit itself no longer believes.
  const hasTransferEncoding = c.req.header("transfer-encoding") !== undefined;
  const body = c.req.raw.body;
  const declaredBytes =
    contentLengthHeader && !hasTransferEncoding
      ? Number(contentLengthHeader)
      : NaN;

  // No RELIABLE declared size (Content-Length absent, or present
  // alongside Transfer-Encoding and therefore untrusted — see above) or
  // no body: `hono/body-limit` has already fully buffered the request
  // into memory before we got here in that case — its header check is
  // ONE comparison against the header value with no body read at all
  // when Content-Length is present and trusted (confirmed by reading
  // hono/body-limit's source: `contentLength > maxSize ? onError(c) :
  // next()`, nothing else); the read-and-count loop that actually
  // bounds the transport is its FALLBACK, used only when there's no
  // Content-Length to trust. So streaming buys nothing extra here —
  // fall back to the simple buffered path rather than duplicate that
  // buffering, and reserve against the TRUE (already-buffered) byte
  // count instead of a number we don't have.
  if (!body || !Number.isFinite(declaredBytes) || declaredBytes <= 0) {
    return handleBufferedVideo(c, projectId, name, userId);
  }
  return streamVideo(c, body, declaredBytes, projectId, name, userId);
}

/** Video has no "image" branch in handleBuffered's type, so the
 *  chunked/no-Content-Length fallback gets its own small buffered
 *  implementation rather than widening handleBuffered's kind union for
 *  a codepath video otherwise never takes. */
async function handleBufferedVideo(
  c: Context,
  projectId: string,
  name: string,
  userId: string,
) {
  // No in-handler size re-check — see the comment in handleBuffered.
  // This branch is only reached when body-limit itself already fell
  // back to reading and counting chunks (no Content-Length), which
  // enforces `ASSET_MAX_BYTES.video` on its own before `next()` is
  // ever called.
  const raw = Buffer.from(await c.req.arrayBuffer());
  const detected = detectAssetKind(raw);
  if (!detected || detected.kind !== "video") {
    return c.json(
      fail(ERROR_CODE.ASSET_FORMAT_UNSUPPORTED, "Bytes do not look like a video"),
      400,
    );
  }
  const contentHash = createHash("sha256").update(raw).digest("hex");
  const existing = await drizzle.assetRepo.findLiveAssetByHash(
    drizzle.db,
    projectId,
    contentHash,
  );
  if (existing) {
    return c.json(ok(toDto(existing)));
  }
  const reservationId = await reserveStorage(drizzle.db, projectId, raw.byteLength);
  if (reservationId === null) {
    return c.json(fail(ERROR_CODE.ASSET_QUOTA_EXCEEDED, "Storage quota exhausted"), 402);
  }
  const assetId = createId();
  const storageKey = store.buildStorageKey(projectId, assetId, "video");
  await store.putObject(storageKey, raw, ASSET_CONTENT_TYPES.video);
  const asset = await drizzle.db.transaction(async (tx) => {
    const row = await drizzle.assetRepo.createAsset(tx, {
      projectId,
      kind: "video",
      name,
      storageKey,
      contentHash,
      contentType: ASSET_CONTENT_TYPES.video,
      byteSize: raw.byteLength,
      width: null,
      height: null,
      sourceFormat: null,
      sourceWidth: null,
      sourceHeight: null,
      policyVersion: 0,
    });
    await audit(
      {
        projectId,
        userId,
        action: "asset.uploaded",
        resource: "paywall_asset",
        resourceId: row.id,
        after: { kind: "video", name, byteSize: row.byteSize, contentHash: row.contentHash },
        ...extractRequestContext(c),
      },
      tx,
    );
    await releaseReservation(tx, reservationId);
    return row;
  });
  return c.json(ok(toDto(asset)), 201);
}

async function streamVideo(
  c: Context,
  body: ReadableStream<Uint8Array>,
  declaredBytes: number,
  projectId: string,
  name: string,
  userId: string,
) {
  // Reserve against the CLIENT-DECLARED size before a single byte is
  // written — the true count isn't known until the stream ends, so
  // this is an upper-bound gate, not the final charge. The committed
  // row below always stores the true byte count from the counting
  // transform.
  //
  // Declared > actual: over-reserves harmlessly; released in the same
  // tx as the row once the true (smaller) count is known.
  // Declared < actual: behind a real HTTP server this cannot happen —
  // Content-Length delimits how many body bytes the server will ever
  // deliver to this handler (RFC 7230 §3.3.3), so actual bytes received
  // is bounded by the declared value there. It CAN happen in a
  // synthetic Request built directly (no real framing to enforce it,
  // which is exactly what the "reserves against the declared size, not
  // the actual streamed size" test below constructs) — in that case
  // this route still stores the TRUE hashed/counted size on the row, it
  // just under-reserved against the cap for that one upload, the same
  // class of accepted race the tier-limit read documents in Task 5.
  const reservationId = await reserveStorage(drizzle.db, projectId, declaredBytes);
  if (reservationId === null) {
    return c.json(fail(ERROR_CODE.ASSET_QUOTA_EXCEEDED, "Storage quota exhausted"), 402);
  }

  const nodeReadable = Readable.fromWeb(
    body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
  );
  const { prefix, stream: reassembled } = await peekPrefix(
    nodeReadable,
    DETECT_PREFIX_BYTES,
  );

  const detected = detectAssetKind(prefix);
  if (!detected || detected.kind !== "video") {
    await releaseReservation(drizzle.db, reservationId);
    reassembled.destroy();
    return c.json(
      fail(ERROR_CODE.ASSET_FORMAT_UNSUPPORTED, "Bytes do not look like a video"),
      400,
    );
  }

  const assetId = createId();
  const storageKey = store.buildStorageKey(projectId, assetId, "video");

  // Object FIRST, row second — see the module comment. The bytes are
  // never fully resident: `counter` forwards each chunk to `putObject`
  // as it arrives while accumulating the hash and byte count.
  const counter = new HashCountingTransform();
  reassembled.pipe(counter);
  await store.putObject(storageKey, counter, ASSET_CONTENT_TYPES.video);

  const contentHash = counter.digestHex();
  const byteSize = counter.bytes;

  // The dedup check can only run AFTER the put for a streamed upload —
  // the content hash IS the upload. A byte-identical re-upload still
  // lands in the bucket once; it's deleted again here (best-effort —
  // the orphan sweeper is the backstop) rather than getting a second
  // row or a second quota charge.
  const existing = await drizzle.assetRepo.findLiveAssetByHash(
    drizzle.db,
    projectId,
    contentHash,
  );
  if (existing) {
    await releaseReservation(drizzle.db, reservationId);
    await store.deleteObject(storageKey).catch(() => {});
    return c.json(ok(toDto(existing)));
  }

  const asset = await drizzle.db.transaction(async (tx) => {
    const row = await drizzle.assetRepo.createAsset(tx, {
      projectId,
      kind: "video",
      name,
      storageKey,
      contentHash,
      contentType: ASSET_CONTENT_TYPES.video,
      byteSize,
      width: null,
      height: null,
      sourceFormat: null,
      sourceWidth: null,
      sourceHeight: null,
      policyVersion: 0,
    });
    await audit(
      {
        projectId,
        userId,
        action: "asset.uploaded",
        resource: "paywall_asset",
        resourceId: row.id,
        after: { kind: "video", name, byteSize: row.byteSize, contentHash: row.contentHash },
        ...extractRequestContext(c),
      },
      tx,
    );
    // Same transaction as the insert, deliberately — see module comment.
    await releaseReservation(tx, reservationId);
    return row;
  });

  return c.json(ok(toDto(asset)), 201);
}

// =============================================================
// Shared gate + dispatch
// =============================================================

function uploadHandler(kind: AssetKind) {
  return async (c: Context) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    const name = c.req.query("name") ?? "";

    if (!isValidAssetName(name)) {
      return c.json(fail(ERROR_CODE.ASSET_INVALID_NAME, "Invalid asset name"), 400);
    }
    await assertProjectCapability(projectId, user.id, "assets:write");

    if (!store.isStorageConfigured()) {
      return c.json(
        fail(ERROR_CODE.ASSET_STORAGE_UNAVAILABLE, "Asset storage is not configured"),
        503,
      );
    }

    // Gate: is the project already at its cap? Cheap (no sharp, no
    // stream read), and it avoids paying for normalisation/upload on a
    // result that cannot be stored.
    const usage = await getStorageUsage(drizzle.db, projectId);
    if (usage.limitBytes !== null && usage.usedBytes >= usage.limitBytes) {
      return c.json(fail(ERROR_CODE.ASSET_QUOTA_EXCEEDED, "Storage quota exhausted"), 402);
    }

    if (kind === "video") {
      return handleStreamedVideo(c, projectId, name, user.id);
    }
    return handleBuffered(c, kind, projectId, name, user.id);
  };
}

export const assetsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .use(
    "*",
    endpointRateLimit({
      name: "asset-upload",
      max: ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE,
      identify: (c) => c.req.param("projectId") ?? "unknown",
    }),
  );

// Three registrations, one handler factory — see the module comment.
// `bodyLimit`'s `maxSize` is fixed at route-registration time, which is
// exactly why this is three `.post()` calls (one per kind's own cap)
// rather than one shared registration at the loosest (video) limit.
for (const kind of ["image", "video", "lottie"] as const) {
  assetsRoute.post(
    `/${kind}`,
    bodyLimit({
      maxSize: ASSET_MAX_BYTES[kind],
      onError: (c) =>
        c.json(
          fail(ERROR_CODE.ASSET_FILE_TOO_LARGE, KIND_TOO_LARGE_MESSAGE[kind]),
          413,
        ),
    }),
    uploadHandler(kind),
  );
}
