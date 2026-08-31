import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { createId } from "@paralleldrive/cuid2";
import { drizzle } from "@rovenue/db";
import {
  ERROR_CODE,
  IMPORT_MAX_UPLOAD_BYTES,
  IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE,
  detectPreset,
  parseCsvStream,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { validate } from "../../lib/validate";
import { roleHasCapability } from "../../lib/capabilities";
import { audit, extractRequestContext } from "../../lib/audit";
import { fail, ok } from "../../lib/response";
import { logger } from "../../lib/logger";
import * as importStore from "../../lib/import-store";

// =============================================================
// Dashboard: data import — upload + create job (Task 5)
// =============================================================
//
// POST /dashboard/projects/:projectId/imports
//
// Transport is a RAW BODY, not multipart — mirrors
// routes/dashboard/assets.ts's module comment: `parseBody()`/`formData()`
// fully buffer the request, and a RevenueCat/Adapty export can be
// hundreds of MB. The body is streamed straight into the (private)
// import bucket while a running sha256/byte-count transform observes it,
// exactly like assets.ts's streamed-video path — the file is never fully
// resident.
//
// The header row is peeked BEFORE the object write completes (a small,
// bounded prefix — enough to see the first CSV line) so the preset can
// be detected and proposed as the initial mapping, but the object is
// still written from that SAME prefix plus the rest of the stream, so
// nothing is read twice and nothing is dropped. If no preset matches
// (or the header can't be found within the peek bound), the job is
// still created — `presetId: null`, `mapping: {}` — for the operator to
// map by hand later; that is a normal outcome, not an error (Task 2's
// `detectPreset` never invents a match it can't back up).
//
// Membership is resolved in TWO steps rather than one
// `assertProjectCapability` call, deliberately: a caller with NO
// membership row gets 404 ("Project not found"), not 403, matching the
// GDPR subscriber handlers' cross-project convention — an actor with no
// relationship to the project should not be able to distinguish "this
// project doesn't exist" from "you're not on it" via the status code. A
// caller who IS a member but lacks the capability gets the ordinary 403.

/** Enough to hold the header line of any real CSV export (hundreds of
 *  columns, generously quoted) without risking buffering a meaningful
 *  fraction of a large file. If no newline appears within this many
 *  bytes, the header is treated as undetectable — the job is still
 *  created with an empty mapping (see module comment); this bound is
 *  never treated as a size error. */
const HEADER_PEEK_BYTES = 64 * 1024;

const LINE_FEED_BYTE = 0x0a;

const uploadQuerySchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  // Free-text label the operator chose for this import run; defaults to
  // the file name. Never treated as schema (see the repository comment).
  sourceLabel: z.string().trim().min(1).max(255).optional(),
});

function toDto(job: { storageKey: string } & Record<string, unknown>) {
  const { storageKey: _storageKey, ...rest } = job;
  return rest;
}

/** Computes a running sha256 + byte count over data as it passes
 *  through, without buffering it — mirrors assets.ts's
 *  `HashCountingTransform`. Duplicated rather than imported because
 *  assets.ts does not export it; extracting a shared helper is not
 *  justified by two call sites. */
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

/**
 * Reads chunks off `readable` until either a chunk containing a newline
 * byte has been seen or `maxBytes` have been buffered, then hands back
 * that prefix AND a new Readable that replays it before continuing the
 * original stream — the same "peek without consuming" shape as
 * assets.ts's `peekPrefix`, except bounded by a newline rather than a
 * fixed byte count, since a CSV header's length isn't known in advance.
 *
 * `sawNewline: false` means either the bound was hit first (header too
 * long to peek safely) or the stream ended before any newline appeared
 * (a file with no header/rows at all) — both are treated identically by
 * the caller: header detection is skipped, not attempted on a
 * possibly-truncated line.
 */
async function peekHeaderPrefix(
  readable: Readable,
  maxBytes: number,
): Promise<{ prefix: Buffer; stream: Readable; sawNewline: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let sawNewline = false;
  // `destroyOnReturn: false` — see assets.ts's `peekPrefix` for why a
  // bare `break` over a Node Readable would otherwise destroy the
  // stream and lose every byte after the prefix.
  const iterator = readable.iterator({ destroyOnReturn: false });
  for await (const chunk of iterator) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    chunks.push(buf);
    total += buf.byteLength;
    if (buf.includes(LINE_FEED_BYTE)) {
      sawNewline = true;
      break;
    }
    if (total >= maxBytes) break;
  }
  const buffered = Buffer.concat(chunks, total);
  const stream = Readable.from(
    (async function* replay() {
      if (buffered.length > 0) yield buffered;
      for await (const chunk of readable) yield chunk;
    })(),
  );
  return { prefix: buffered, stream, sawNewline };
}

/**
 * Parses just the header row out of a peeked prefix using the real
 * streaming CSV parser (Task 1), rather than a hand-rolled comma split —
 * a quoted header column containing a comma would break a naive split.
 * Feeds the prefix as a single chunk and stops at the first `header`
 * event; `parseCsvStream` never reaches its end-of-stream `flush()` in
 * that case; because the loop `break`s before draining, generator is
 * left safely stopped mid-header-event rather than run through the row
 * validation path, which could otherwise throw on a spuriously-completed
 * partial row.
 */
async function detectHeaderFromPrefix(prefix: Buffer): Promise<string[] | null> {
  async function* single(): AsyncGenerator<Uint8Array> {
    yield new Uint8Array(prefix);
  }
  for await (const event of parseCsvStream(single())) {
    if ("header" in event) return event.header;
    break;
  }
  return null;
}

export const importsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .use(
    "*",
    endpointRateLimit({
      name: "import-upload",
      max: IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE,
      identify: (c) => c.req.param("projectId") ?? "unknown",
    }),
  );

importsRoute.post(
  "/",
  bodyLimit({
    maxSize: IMPORT_MAX_UPLOAD_BYTES,
    onError: (c) =>
      c.json(
        fail(
          ERROR_CODE.IMPORT_FILE_TOO_LARGE,
          `File exceeds the ${IMPORT_MAX_UPLOAD_BYTES}-byte limit`,
        ),
        413,
      ),
  }),
  validate("query", uploadQuerySchema),
  async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    const { fileName, sourceLabel } = c.req.valid("query");

    // See the module comment: 404 for no membership at all (existence
    // does not leak), 403 for a member lacking the capability.
    const membership = await drizzle.projectRepo.findMembership(
      drizzle.db,
      projectId,
      user.id,
    );
    if (!membership) {
      throw new HTTPException(404, { message: "Project not found" });
    }
    if (!roleHasCapability(membership.role, "subscribers:import")) {
      throw new HTTPException(403, {
        message: `Role ${membership.role} lacks capability subscribers:import`,
      });
    }

    if (!importStore.isStorageConfigured()) {
      return c.json(
        fail(ERROR_CODE.IMPORT_STORAGE_UNAVAILABLE, "Import storage is not configured"),
        503,
      );
    }

    const body = c.req.raw.body;
    if (!body) {
      throw new HTTPException(400, { message: "Missing request body" });
    }

    const nodeReadable = Readable.fromWeb(
      body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
    );
    const { prefix, stream: reassembled, sawNewline } = await peekHeaderPrefix(
      nodeReadable,
      HEADER_PEEK_BYTES,
    );

    // A header line longer than the peek bound, or none at all, is a
    // normal (if unusual) file — detection is simply skipped rather than
    // risking a match against a truncated line.
    const header = sawNewline ? await detectHeaderFromPrefix(prefix) : null;
    const detection = header ? detectPreset(header) : null;

    const jobId = createId();
    const storageKey = importStore.buildStorageKey(projectId, jobId, fileName);

    const counter = new HashCountingTransform();
    reassembled.pipe(counter);
    try {
      await importStore.putObject(storageKey, counter, "text/csv");
    } catch (err) {
      logger.error("import upload: storage write failed", {
        storageKey,
        err: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        fail(ERROR_CODE.IMPORT_STORAGE_UNAVAILABLE, "Import storage is unreachable"),
        503,
      );
    }

    try {
      const job = await drizzle.db.transaction(async (tx) => {
        const row = await drizzle.importJobRepo.createImportJob(tx, {
          id: jobId,
          projectId,
          createdByUserId: user.id,
          sourceLabel: sourceLabel ?? fileName,
          presetId: detection?.presetId ?? null,
          storageKey,
          fileName,
          fileBytes: counter.bytes,
          fileSha256: counter.digestHex(),
          mapping: detection?.mapping ?? {},
        });
        await audit(
          {
            projectId,
            userId: user.id,
            action: "import.started",
            resource: "import_job",
            resourceId: row.id,
            after: {
              sourceLabel: row.sourceLabel,
              presetId: row.presetId,
              fileName: row.fileName,
              fileBytes: row.fileBytes,
            },
            ...extractRequestContext(c),
          },
          tx,
        );
        return row;
      });

      return c.json(ok({ job: toDto(job) }), 201);
    } catch (err) {
      // The row/audit write failed after the object was already
      // committed — best-effort cleanup so a failed upload doesn't leave
      // an untracked PII object behind; a delete failure here is logged,
      // not surfaced, so the ORIGINAL error is what the caller sees.
      await importStore.deleteObject(storageKey).catch((cleanupErr) => {
        logger.error("import upload: failed to clean up orphaned object after a failed job insert", {
          storageKey,
          err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      });
      throw err;
    }
  },
);
