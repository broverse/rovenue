import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { createId } from "@paralleldrive/cuid2";
import { drizzle, MemberRole, type Db } from "@rovenue/db";
import { collectMediaUrls, type BuilderConfig } from "@rovenue/shared/paywall";
import {
  ERROR_CODE,
  ASSET_MAX_BYTES,
  ASSET_CONTENT_TYPES,
  ASSET_UPLOAD_RATE_LIMIT_PER_MINUTE,
  detectAssetKind,
  isValidAssetName,
  type AssetKind,
  type ImageSourceFormat,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { validate } from "../../lib/validate";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { assertProjectCapability } from "../../lib/capabilities";
import { assertProjectAccess } from "../../lib/project-access";
import { audit, extractRequestContext } from "../../lib/audit";
import { fail, ok } from "../../lib/response";
import { logger } from "../../lib/logger";
import { isUniqueViolationOf } from "../../lib/pg-errors";
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
// Shared upload finalisation — object write, then the row
// =============================================================
//
// Both steps below run at the end of all THREE upload paths (buffered
// image/lottie, buffered video, streamed video) and both can fail in a
// way that must not leak the quota reservation `reserveStorage` already
// committed (review finding 2). Factored into two functions rather than
// left inline at each call site specifically because a fix applied at
// two of three call sites and missed at the third is exactly the defect
// shape this plan has already hit once — one function fixed once closes
// it for all three by construction.

/** Matches `paywall_assets_project_hash_key` (migration 0099:35-37) —
 *  the partial unique index `createAsset` can violate when two
 *  concurrent uploads of byte-identical content both pass their own
 *  pre-put `findLiveAssetByHash` check (review finding 1; no pre-check
 *  can close that window, only handling the resulting 23505 can). Named
 *  here rather than inlined at the `isUniqueViolationOf` call site so a
 *  future index rename can't drift the two apart silently. */
const PAYWALL_ASSETS_PROJECT_HASH_KEY = "paywall_assets_project_hash_key";

/**
 * Releases a quota reservation from inside a catch block, WITHOUT letting
 * a failure in the release itself replace the error that's already
 * propagating (residual finding 1). Both call sites below are already
 * reacting to a failure — a storage error, a failed row transaction — and
 * `releaseReservation` running unguarded there means a second failure (a
 * dropped pool connection is the realistic case, since the request is
 * already in a bad way) would throw OUT of the catch block and replace
 * the original error, so the caller sees an unhandled exception instead
 * of the intended 503/`ASSET_STORAGE_UNAVAILABLE` and the logs point at
 * the cleanup instead of the cause.
 *
 * If release fails, the reservation is simply left behind — that is an
 * accepted, non-permanent leak: the orphan sweeper (Task 9) clears
 * reservations older than its grace window regardless of why they were
 * never released, which is exactly the backstop it exists for.
 */
async function releaseReservationOrLog(db: Db, reservationId: string): Promise<void> {
  try {
    await releaseReservation(db, reservationId);
  } catch (err) {
    logger.error(
      "asset upload: failed to release quota reservation; leaving for orphan sweeper",
      {
        reservationId,
        err: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

/**
 * Writes the object, releasing the just-taken reservation and returning
 * a 503 response if the write fails — rather than letting a storage
 * outage leak the reservation until the sweeper's ~30h backstop
 * (6h grace, 24h cadence) clears it. Returns `null` on success, meaning
 * "keep going"; returns a `Response` to short-circuit the caller with
 * otherwise.
 */
async function putObjectOrReleaseReservation(
  c: Context,
  storageKey: string,
  body: Readable | Buffer,
  contentType: string,
  reservationId: string,
  metadata?: Record<string, string>,
): Promise<Response | null> {
  try {
    await store.putObject(storageKey, body, contentType, metadata);
    return null;
  } catch (err) {
    await releaseReservationOrLog(drizzle.db, reservationId);
    logger.error("asset upload: storage write failed; reservation released", {
      storageKey,
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      fail(ERROR_CODE.ASSET_STORAGE_UNAVAILABLE, "Asset storage is unreachable"),
      503,
    );
  }
}

/** The fields that vary by kind in `CreateAssetInput` — everything else
 *  (`id`, `projectId`, `storageKey`, `contentHash`) is supplied by
 *  {@link commitAssetRow} itself from its own parameters, so a caller
 *  can't pass a mismatched pair (see `CreateAssetInput.id`'s own doc
 *  comment in the repository for what that mismatch breaks). */
interface UploadRowFields {
  kind: AssetKind;
  name: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  sourceFormat: ImageSourceFormat | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  policyVersion: number;
}

type AssetRow = Awaited<ReturnType<typeof drizzle.assetRepo.createAsset>>;

/**
 * Commits the asset row (+ audit entry + reservation release) inside
 * one transaction, exactly as before — but now catches the two ways
 * that transaction can fail instead of letting either leak the
 * reservation or 500 (review findings 1 and 2):
 *
 * - A concurrent duplicate upload's row commits first, and our own
 *   INSERT loses the race against `paywall_assets_project_hash_key`.
 *   Resolved to the SAME outcome design spec §4.2 promises for the
 *   sequential case: the winner's row, HTTP 200 — plus releasing our
 *   reservation (never became a committed row; the transaction that
 *   would have released it rolled back) and best-effort deleting our
 *   own now-redundant object, mirroring what the streamed-video path
 *   already does for its post-put dedup hit.
 * - Any other failure (a DB error unrelated to the race): the
 *   reservation is released and the error rethrown unchanged — the
 *   object is deliberately left for the orphan sweeper, exactly the
 *   row-missing/object-present case it exists to reclaim (module
 *   comment above).
 */
async function commitAssetRow(
  c: Context,
  params: {
    projectId: string;
    userId: string;
    reservationId: string;
    assetId: string;
    storageKey: string;
    contentHash: string;
    row: UploadRowFields;
  },
): Promise<{ asset: AssetRow; status: 200 | 201 }> {
  try {
    const asset = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.assetRepo.createAsset(tx, {
        id: params.assetId,
        projectId: params.projectId,
        storageKey: params.storageKey,
        contentHash: params.contentHash,
        ...params.row,
      });
      await audit(
        {
          projectId: params.projectId,
          userId: params.userId,
          action: "asset.uploaded",
          resource: "paywall_asset",
          resourceId: row.id,
          after: {
            kind: params.row.kind,
            name: params.row.name,
            byteSize: row.byteSize,
            contentHash: row.contentHash,
          },
          ...extractRequestContext(c),
        },
        tx,
      );
      // Same transaction as the insert, deliberately — see module comment.
      await releaseReservation(tx, params.reservationId);
      return row;
    });
    return { asset, status: 201 };
  } catch (err) {
    if (isUniqueViolationOf(err, PAYWALL_ASSETS_PROJECT_HASH_KEY)) {
      const existing = await drizzle.assetRepo.findLiveAssetByHash(
        drizzle.db,
        params.projectId,
        params.contentHash,
      );
      await releaseReservationOrLog(drizzle.db, params.reservationId);
      await store.deleteObject(params.storageKey).catch(() => {});
      if (existing) {
        return { asset: existing, status: 200 };
      }
      // The row we collided with existed a moment ago — soft-delete
      // only tombstones, it doesn't free the hash — so it cannot be
      // gone here. Falling through to the generic rethrow below is
      // defensive, not a path this should ever actually take.
    } else {
      await releaseReservationOrLog(drizzle.db, params.reservationId);
    }
    throw err;
  }
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

  // Object FIRST, row second — see the module comment. On failure,
  // `putObjectOrReleaseReservation` releases the reservation this
  // upload took before returning a 503 (review finding 2) — contentHash
  // is already known here, so it's carried as object metadata (see
  // asset-store.ts's `putObject` comment for what that can and can't
  // deliver toward design spec §6).
  const putFailure = await putObjectOrReleaseReservation(
    c,
    storageKey,
    bytes,
    ASSET_CONTENT_TYPES[kind],
    reservationId,
    { [store.ASSET_CONTENT_HASH_METADATA_KEY]: contentHash },
  );
  if (putFailure) return putFailure;

  // MUST match the id already baked into `storageKey` above (see
  // CreateAssetInput.id's doc comment) — otherwise this row's real id
  // silently diverges from the id its own public URL resolves to.
  const { asset, status } = await commitAssetRow(c, {
    projectId,
    userId,
    reservationId,
    assetId,
    storageKey,
    contentHash,
    row: {
      kind,
      name,
      contentType: ASSET_CONTENT_TYPES[kind],
      byteSize: bytes.byteLength,
      width,
      height,
      sourceFormat: detected.sourceFormat,
      sourceWidth,
      sourceHeight,
      policyVersion,
    },
  });

  return c.json(ok(toDto(asset)), status);
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

  const putFailure = await putObjectOrReleaseReservation(
    c,
    storageKey,
    raw,
    ASSET_CONTENT_TYPES.video,
    reservationId,
    { [store.ASSET_CONTENT_HASH_METADATA_KEY]: contentHash },
  );
  if (putFailure) return putFailure;

  const { asset, status } = await commitAssetRow(c, {
    projectId,
    userId,
    reservationId,
    assetId,
    storageKey,
    contentHash,
    row: {
      kind: "video",
      name,
      contentType: ASSET_CONTENT_TYPES.video,
      byteSize: raw.byteLength,
      width: null,
      height: null,
      sourceFormat: null,
      sourceWidth: null,
      sourceHeight: null,
      policyVersion: 0,
    },
  });
  return c.json(ok(toDto(asset)), status);
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
  // as it arrives while accumulating the hash and byte count. No
  // content-hash metadata here (unlike the other two paths) — the hash
  // IS the upload for a streamed body, so it isn't known until this
  // call's own Promise resolves; see asset-store.ts's `putObject`
  // comment for that gap.
  const counter = new HashCountingTransform();
  reassembled.pipe(counter);
  const putFailure = await putObjectOrReleaseReservation(
    c,
    storageKey,
    counter,
    ASSET_CONTENT_TYPES.video,
    reservationId,
  );
  if (putFailure) return putFailure;

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

  const { asset, status } = await commitAssetRow(c, {
    projectId,
    userId,
    reservationId,
    assetId,
    storageKey,
    contentHash,
    row: {
      kind: "video",
      name,
      contentType: ASSET_CONTENT_TYPES.video,
      byteSize,
      width: null,
      height: null,
      sourceFormat: null,
      sourceWidth: null,
      sourceHeight: null,
      policyVersion: 0,
    },
  });

  return c.json(ok(toDto(asset)), status);
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

// =============================================================
// Dashboard: paywall assets — list, usage lookup, delete
// =============================================================
//
// Both GETs use `assertProjectAccess` (any project member, no write
// capability required) — same convention as fonts.ts's GET route.
// DELETE is gated on `assets:write` ALONE (matching fonts.ts's DELETE
// and the sibling virtual-currencies.ts convention noted there): the
// codebase does not stack assertProjectAccess + assertProjectCapability
// on one write route.
//
// Deleting is guarded by a REFERENCE CHECK first (Task 9 of the
// 2026-08-23 store-billing correctness plan): the object delete below
// is a HARD delete, so an asset still referenced by a published
// version or a draft builderConfig would 404 on device the moment the
// bytes are gone. `?force=true` (the dashboard's confirm dialog, or a
// deliberate API caller) skips the check entirely and proceeds exactly
// as before.
//
// Delete ordering is the one behaviour in this file that must not be
// got backwards. The row is soft-deleted FIRST, inside a transaction
// with the audit entry, and the bucket object is deleted AFTER,
// outside that transaction (an S3 delete cannot participate in a
// Postgres tx). If the object delete then fails, the row is already
// gone — the sweeper (Task 9) reclaims the orphaned object later, a
// fully recoverable state. The reverse order is not recoverable: a
// row commit failing after the object was already deleted leaves a
// LIVE row pointing at bytes that no longer exist, which is a 404 for
// every published paywall using that asset, with no automated fix.
/** DELETE `?force=` — the explicit opt-out of the in-use guard. An
 *  enum-then-transform rather than `z.coerce.boolean()`, because coerce
 *  treats ANY non-empty string ("false" included) as true. */
// Exported for the MCP delete_asset write tool and its intent handler:
// same deliberate, narrow services→routes exception as the catalog
// creates (dashboard parity — never a weaker re-declaration).
export const deleteAssetQuerySchema = z.object({
  force: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

/**
 * Every paywall of `projectId` still referencing `assetId`: the UNION
 * of the published usage index (`listPublishedUsage` — rows written at
 * publish time, published versions only by design) and a walk of every
 * current draft `builderConfig` (drafts have no usage rows until they
 * are published, so the index alone would let a delete strand a draft
 * one click away from going live). Deduped by paywall id — a paywall
 * whose published version AND draft both reference the asset appears
 * once. The draft configs were schema-validated when PATCH stored
 * them, so `collectMediaUrls`' typed walk is safe on them.
 */
async function findReferencingPaywalls(
  projectId: string,
  assetId: string,
): Promise<{ id: string; name: string }[]> {
  const [published, drafts] = await Promise.all([
    drizzle.assetRepo.listPublishedUsage(drizzle.db, assetId),
    drizzle.paywallRepo.listDraftBuilderConfigs(drizzle.db, projectId),
  ]);
  const referencing = new Map<string, { id: string; name: string }>();
  for (const paywall of published) referencing.set(paywall.id, paywall);
  for (const draft of drafts) {
    if (referencing.has(draft.id)) continue;
    const referenced = collectMediaUrls(draft.builderConfig as BuilderConfig).some(
      (url) => {
        const resolved = store.parseAssetUrl(url);
        return (
          resolved !== null &&
          resolved.projectId === projectId &&
          resolved.assetId === assetId
        );
      },
    );
    if (referenced) referencing.set(draft.id, { id: draft.id, name: draft.name });
  }
  return [...referencing.values()];
}

assetsRoute
  // ----- GET /dashboard/projects/:projectId/assets -----
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const [assets, usage] = await Promise.all([
      drizzle.assetRepo.listAssets(drizzle.db, projectId),
      getStorageUsage(drizzle.db, projectId),
    ]);
    return c.json(ok({ assets: assets.map(toDto), usage }));
  })
  // ----- GET /dashboard/projects/:projectId/assets/:id/usage -----
  //
  // See `listPublishedUsage`'s own comment (assets repository) for the
  // honest boundary this reports: only paywalls whose CURRENT published
  // version references the asset, not every version that ever did.
  .get("/:id/usage", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing projectId or id" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const asset = await drizzle.assetRepo.findAssetById(drizzle.db, projectId, id);
    if (!asset) {
      return c.json(fail(ERROR_CODE.NOT_FOUND, "Asset not found"), 404);
    }
    const publishedPaywalls = await drizzle.assetRepo.listPublishedUsage(
      drizzle.db,
      id,
    );
    return c.json(ok({ publishedPaywalls }));
  })
  // ----- DELETE /dashboard/projects/:projectId/assets/:id -----
  .delete("/:id", validate("query", deleteAssetQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing projectId or id" });
    }
    const user = c.get("user");
    const { force } = c.req.valid("query");
    await assertProjectCapability(projectId, user.id, "assets:write");

    const asset = await drizzle.assetRepo.findAssetById(drizzle.db, projectId, id);
    if (!asset) {
      return c.json(fail(ERROR_CODE.NOT_FOUND, "Asset not found"), 404);
    }

    // Referential guard (Task 9) — see the section comment above.
    // Skipped entirely under force: "proceed exactly as before", not
    // "compute the usage and ignore it".
    if (!force) {
      const referencing = await findReferencingPaywalls(projectId, id);
      if (referencing.length > 0) {
        const refs = referencing
          .map((paywall) => `"${paywall.name}" (${paywall.id})`)
          .join(", ");
        throw new HTTPException(409, {
          message: `Asset is referenced by ${referencing.length} paywall(s): ${refs}. Re-run with force=true to delete it anyway.`,
          cause: ERROR_CODE.ASSET_IN_USE,
        });
      }
    }

    // Row first, object second (design spec §5.8) — see the module
    // comment above. A failed object delete leaves an orphan the
    // sweeper reclaims; the reverse order would leave a live row
    // pointing at nothing.
    await drizzle.db.transaction(async (tx) => {
      await drizzle.assetRepo.softDeleteAsset(tx, projectId, id);
      await audit(
        {
          projectId,
          userId: user.id,
          action: "asset.deleted",
          resource: "paywall_asset",
          resourceId: id,
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    // The row is already tombstoned and the transaction has committed,
    // so the delete has substantially succeeded at this point — every
    // read path already treats this asset as gone. A storage failure
    // here must NOT surface as a 500: that would tell the caller the
    // delete failed when it did not, and the natural response (retry)
    // can only ever 404, since the row is already soft-deleted. Log it
    // and let the orphan sweeper (Task 9) reclaim the object instead.
    try {
      await store.deleteObject(asset.storageKey);
    } catch (err) {
      logger.error("asset row deleted but storage object delete failed; sweeper will reclaim", {
        assetId: id,
        storageKey: asset.storageKey,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return c.json(ok({ deleted: true }));
  });
