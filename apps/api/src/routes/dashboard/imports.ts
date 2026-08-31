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
  IMPORT_STATUS_POLL_RATE_LIMIT_PER_MINUTE,
  CANONICAL_FIELDS,
  detectPreset,
  parseCsvStream,
  validateMapping,
  type CanonicalField,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { validate } from "../../lib/validate";
import { roleHasCapability } from "../../lib/capabilities";
import { audit, extractRequestContext } from "../../lib/audit";
import { fail, ok } from "../../lib/response";
import { logger } from "../../lib/logger";
import * as importStore from "../../lib/import-store";
import { enqueueImportJob, enqueueImportDryRun } from "../../workers/import-runner";

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
// membership row gets 404 ("Project not found"), not 403 — an actor with
// no relationship to the project should not be able to distinguish "this
// project doesn't exist" from "you're not on it" via the status code. A
// caller who IS a member but lacks the capability gets the ordinary 403.
// This is NOT the GDPR handlers' convention re-applied: the GDPR *routes*
// return 403 for a non-member, and reserve 404 for a cross-tenant
// sub-resource id instead. The 404-for-no-membership posture here is a
// deliberate, NEW convention for this route (arguably a better one), not
// a match to an existing one — this route is currently the only dashboard
// route that does it this way.

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

// =============================================================
// Task 10: job lifecycle routes
// =============================================================
//
// Everything below extends the upload route above — same file, same
// membership-then-capability gate (404 for no membership, 403 for a
// member lacking `subscribers:import`; see the module comment above),
// same `{ data }` / `{ error: { code, message } }` envelope. A
// cross-tenant job id (a real cuid2 that belongs to a DIFFERENT
// project) 404s exactly like a nonexistent one — `getImportJob` is
// project-scoped, so a foreign id simply never matches and the two
// cases are indistinguishable, on purpose (same posture as the upload
// route's no-membership case).
//
// Two binding carry-forwards from task-9/task-8's controller context
// (task-10-context.md) drive most of the design below:
//
//   1. `VERIFICATION_INCOMPLETE` was previously a dead end — nothing
//      re-enqueued it. `/resume` is the trigger: it calls the exact
//      same `enqueueImportJob` a `/commit` does, which is safe because
//      `runImportJob` already treats any non-COMPLETED job as "keep
//      going from the checkpoint" (workers/import-runner.ts), and
//      `verifyImportedAnchors` resumes Phase B from `purchases.verifiedAt`
//      with no separate state to thread through. Fix round 2 (FIX A)
//      widened `/resume` to also accept `VERIFYING` — see
//      `RESUMABLE_STATUSES`'s own comment.
//   2. `auditImportRunCompleted` (write.ts, called from
//      workers/import-runner.ts) used to fire before Phase B even
//      started, so the audit trail could say COMPLETED for a run that
//      went on to end VERIFICATION_INCOMPLETE. FIXED AT THE SOURCE in
//      Task 10 fix round 1 (FIX 3): the call now happens after Phase B
//      resolves, with the run's true final status. Fix round 1's own
//      ruling then surfaced a WORSE gap (fix round 2, FIX A): Phase A
//      wrote COMPLETED before handing off to Phase B, so a hard crash
//      (not a catchable error — OOM/deploy-restart/`kill -9`) during
//      Phase B's whole run left the row permanently reading COMPLETED,
//      never re-entered by a retry, never audited at all. Phase A now
//      writes a dedicated `VERIFYING` status instead (migration 0108),
//      resolved to COMPLETED/VERIFICATION_INCOMPLETE by Phase B exactly
//      as before. This file's own mitigation stays regardless — every
//      read here still comes straight from the `import_jobs` row's own
//      `status` column, never from the audit log (`requireImportJob` and
//      every handler below: none of them ever consult `audit_logs`) —
//      belt-and-suspenders, not a replacement for the source-level fix.
//
// A third carry-forward (task-9 RE-REVIEW, binding) concerns the
// counters this file surfaces. Phase B's `verifyAnchorNotFound` /
// `verifyAnchorPending` counters are OVERWRITTEN each call with that
// call's fresh, complete count (verify.ts) — ordinarily that covers the
// WHOLE file. The exception: `IMPORT_VERIFY_MAX_ANCHORS_PER_RUN` forces
// `VERIFICATION_INCOMPLETE` the instant the anchor cap is hit, even when
// the inspected subset itself resolved with zero pending anchors. See
// `verificationCountersScope` below for the (exact, not heuristic)
// inference this route makes since `anchorCapReached` itself is never
// persisted to the row.
//
// Dry run is QUEUED (Task 10 fix round 1, FIX 2), the same way
// commit/resume enqueue onto the existing BullMQ import queue
// (workers/import-runner.ts) — reusing that same queue, dispatched by
// BullMQ job NAME (`IMPORT_DRY_RUN_JOB_NAME` vs `IMPORT_RUN_JOB_NAME` —
// queues/imports.ts) rather than a second queue, since dry-run and
// commit are two phases of one job-lifecycle system. This route was
// ORIGINALLY written to await `planImport` synchronously in-request
// (no queue existed for it yet); that was wrong on the largest files —
// the upload cap is 2 GiB, a dry run reads the whole file, and it is
// mandatory before commit by design, so the main path could run past a
// proxy/load-balancer idle timeout. `ImportJobStatus` already carried
// `DRY_RUN_RUNNING` as a distinct persisted status, which only means
// something for asynchronous work. `GET /:id` (its own, generous
// rate-limit budget — see `statusPollRateLimit` below) is what the
// dashboard polls to observe DRY_RUN_COMPLETE / FAILED.

type ImportJobStatus =
  | "PENDING_MAPPING"
  | "DRY_RUN_RUNNING"
  | "DRY_RUN_COMPLETE"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "VERIFICATION_INCOMPLETE"
  | "VERIFYING";

/** A mapping may be revised any time the job is NOT actively processing
 *  data under the CURRENT mapping — before a dry run, after one
 *  completes (to fix what it flagged), or after a failed/cancelled
 *  attempt. Excludes DRY_RUN_RUNNING/RUNNING/VERIFICATION_INCOMPLETE
 *  (a run is using this mapping right now) and COMPLETED (the commit
 *  already happened; editing the mapping after the fact would not
 *  retroactively change what was written). */
const MAPPING_EDITABLE_STATUSES: ReadonlySet<ImportJobStatus> = new Set([
  "PENDING_MAPPING",
  "DRY_RUN_COMPLETE",
  "FAILED",
  "CANCELLED",
]);

/** Same set as mapping-editable, for the same reason: a dry run reads
 *  the CURRENT mapping, so it may only start from a state where nothing
 *  else is using it. */
const DRY_RUN_STARTABLE_STATUSES: ReadonlySet<ImportJobStatus> = MAPPING_EDITABLE_STATUSES;

/** Cancellable iff the job is doing (or about to do) something —
 *  everything that is NOT already a terminal outcome. Matches
 *  workers/import-runner.ts's own cancellation check, which polls this
 *  same `status` column at batch/anchor boundaries. `VERIFYING` (Task 10
 *  fix round 2, FIX A) is Phase B actively running — cancellable for the
 *  same reason `RUNNING`/`VERIFICATION_INCOMPLETE` already are. */
const CANCELLABLE_STATUSES: ReadonlySet<ImportJobStatus> = new Set([
  "PENDING_MAPPING",
  "DRY_RUN_RUNNING",
  "DRY_RUN_COMPLETE",
  "RUNNING",
  "VERIFICATION_INCOMPLETE",
  "VERIFYING",
]);

/** Statuses `/resume` accepts (Task 10 carry-forward 1, widened by fix
 *  round 2 FIX A). `VERIFICATION_INCOMPLETE` is Phase B's own reported
 *  "ran out of retry budget" outcome; `VERIFYING` is Phase B either still
 *  actively running RIGHT NOW (re-enqueueing is a harmless no-op — the
 *  new job blocks on `withProjectImportLock`'s Postgres advisory lock
 *  until the in-flight run releases it, then `processImportJob`'s own
 *  `status === "COMPLETED"` guard makes it a no-op; final-fix-wave FIX 1
 *  removed the BullMQ jobId pinning this comment used to rely on,
 *  because that pinning was ALSO what made `/resume` unreachable in the
 *  first place — see `queues/imports.ts`'s `buildImportJobOptions`) or
 *  crash-interrupted with no retry guaranteed to ever come (a hard
 *  `kill -9`/OOM/deploy-restart never runs BullMQ's own retry — that only
 *  fires for a THROWN error). Without accepting `VERIFYING` here, a
 *  crash-interrupted run would have no operator-triggerable recovery at
 *  all. */
const RESUMABLE_STATUSES: ReadonlySet<ImportJobStatus> = new Set([
  "VERIFICATION_INCOMPLETE",
  "VERIFYING",
]);

const CANONICAL_FIELD_KEYS: ReadonlySet<string> = new Set(
  CANONICAL_FIELDS.map((field) => field.key),
);

const mappingBodySchema = z.object({
  mapping: z.record(
    z.string().refine((value) => CANONICAL_FIELD_KEYS.has(value), {
      message: "Unknown canonical field",
    }),
  ),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

/** See the module comment (carry-forward 3, task-9 re-review). `null`
 *  when Phase B has never run for this job (no `verifyAnchor*` key in
 *  `counters` yet) — there is nothing to label. Also `null` while
 *  `status === "VERIFYING"` (Task 10 fix round 2, FIX A): Phase B is
 *  ACTIVELY running (or crash-interrupted and awaiting a retry/`/resume`)
 *  in that state, so whatever `counters` currently hold — possibly
 *  nothing yet, possibly a stale snapshot from an earlier incomplete
 *  attempt — do not describe a concluded scan; labelling them
 *  "wholeFile" or "inspectedSubset" would claim a conclusion that hasn't
 *  happened. `"inspectedSubset"` covers exactly the one combination that
 *  can ONLY be explained by `anchorCapReached` (verify.ts never persists
 *  that flag itself): `VERIFICATION_INCOMPLETE` is reached iff
 *  `anchorsPending > 0 || anchorCapReached` (verify.ts), so
 *  `VERIFICATION_INCOMPLETE` with a persisted `verifyAnchorPending` of
 *  zero cannot be anything else. Every other combination — including
 *  plain `VERIFICATION_INCOMPLETE` with pending > 0 — reflects a call
 *  that scanned (or is resuming to scan) the whole file, so it is
 *  labelled `"wholeFile"`. */
function verificationCountersScope(
  status: string,
  counters: Record<string, number>,
): "wholeFile" | "inspectedSubset" | null {
  if (status === "VERIFYING") return null;
  const touchedPhaseB =
    "verifyAnchorVerified" in counters ||
    "verifyAnchorNotFound" in counters ||
    "verifyAnchorPending" in counters;
  if (!touchedPhaseB) return null;
  const pending = counters.verifyAnchorPending ?? 0;
  return status === "VERIFICATION_INCOMPLETE" && pending === 0
    ? "inspectedSubset"
    : "wholeFile";
}

function toDto(job: { storageKey: string } & Record<string, unknown>) {
  const { storageKey: _storageKey, ...rest } = job;
  const counters = (rest.counters ?? {}) as Record<string, number>;
  const status = String(rest.status);
  return {
    ...rest,
    verificationCountersScope: verificationCountersScope(status, counters),
  };
}

/** Membership-then-capability gate shared by every route in this file
 *  (upload route above included its own inline copy before this task;
 *  left as-is per the "do not rewrite the upload handler" constraint).
 *  404 for no membership at all, 403 for a member lacking
 *  `subscribers:import` — see the module comment at the top of this
 *  file for why that ordering is deliberate. */
async function requireImportAccess(projectId: string, userId: string): Promise<void> {
  const membership = await drizzle.projectRepo.findMembership(
    drizzle.db,
    projectId,
    userId,
  );
  if (!membership) {
    throw new HTTPException(404, { message: "Project not found" });
  }
  if (!roleHasCapability(membership.role, "subscribers:import")) {
    throw new HTTPException(403, {
      message: `Role ${membership.role} lacks capability subscribers:import`,
    });
  }
}

/** Project-scoped job lookup + 404 — a cross-tenant id (belongs to a
 *  different project) and a nonexistent one are indistinguishable, by
 *  construction (`getImportJob`'s WHERE clause), matching the upload
 *  route's no-membership posture. */
async function requireImportJob(projectId: string, id: string) {
  const job = await drizzle.importJobRepo.getImportJob(drizzle.db, projectId, id);
  if (!job) {
    throw new HTTPException(404, { message: "Import job not found" });
  }
  return job;
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

// Task 10 fix round 1 (FIX 1): TWO separate rate limiters, not one
// blanket `.use("*", ...)`.
//
// Before this fix, a single `.use("*", endpointRateLimit({name:
// "import-upload", max: 5, ...}))` sat here and applied to the WHOLE
// sub-app — harmless when the upload route (Task 5) was the only route
// in it, but Task 10 added `GET /:id` specifically for the dashboard to
// POLL while a run is in flight, and that same 5-per-rolling-minute
// budget would exhaust in the first 10-15 seconds of any poll loop,
// shared with every mapping-edit/dry-run/commit/cancel/resume click on
// top. The upload route's own limiter OBJECT is unchanged bit-for-bit
// (same `name`, `max`, `identify`) and its EFFECTIVE budget is unchanged
// (still 5/min, still keyed by projectId) — only WHERE it is mounted
// moved, from blanket to the specific mutation routes it was actually
// sized for. `uploadMutationRateLimit` is constructed exactly once,
// first (matching the existing "called once at module load, and this is
// calls[0]" assumption in imports-upload.test.ts's Ruling-3 test), and
// the SAME middleware instance is reused across every mutation route
// below — `endpointRateLimit`'s bucket key is derived from `name` +
// `identify(c)` in Redis (middleware/rate-limit.ts), not from JS closure
// identity, so reusing one instance across routes and constructing a
// second, differently-named one for reads share nothing by accident.
const uploadMutationRateLimit = endpointRateLimit({
  name: "import-upload",
  max: IMPORT_UPLOAD_RATE_LIMIT_PER_MINUTE,
  identify: (c) => c.req.param("projectId") ?? "unknown",
});

/** New in this fix round: gates ONLY `GET /`, `GET /:id` and
 *  `GET /:id/report` — sized for polling (`IMPORT_STATUS_POLL_RATE_LIMIT_PER_MINUTE`),
 *  never shared with the upload/mutation budget above. */
const statusPollRateLimit = endpointRateLimit({
  name: "import-status-poll",
  max: IMPORT_STATUS_POLL_RATE_LIMIT_PER_MINUTE,
  identify: (c) => c.req.param("projectId") ?? "unknown",
});

export const importsRoute = new Hono().use("*", requireDashboardAuth);

importsRoute.post(
  "/",
  uploadMutationRateLimit,
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

// ---------------------------------------------------------------------------
// GET /  — list, newest first
// ---------------------------------------------------------------------------

importsRoute.get("/", statusPollRateLimit, validate("query", listQuerySchema), async (c) => {
  const projectId = c.req.param("projectId");
  if (!projectId) {
    throw new HTTPException(400, { message: "Missing projectId" });
  }
  const user = c.get("user");
  await requireImportAccess(projectId, user.id);

  const { limit } = c.req.valid("query");
  const jobs = await drizzle.importJobRepo.listImportJobs(
    drizzle.db,
    projectId,
    limit !== undefined ? { limit } : {},
  );
  return c.json(ok({ jobs: jobs.map((job) => toDto(job)) }));
});

// ---------------------------------------------------------------------------
// PATCH /:id/mapping
// ---------------------------------------------------------------------------

importsRoute.patch(
  "/:id/mapping",
  uploadMutationRateLimit,
  validate("json", mappingBodySchema),
  async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing projectId or id" });
    }
    const user = c.get("user");
    await requireImportAccess(projectId, user.id);

    const job = await requireImportJob(projectId, id);
    if (!MAPPING_EDITABLE_STATUSES.has(job.status as ImportJobStatus)) {
      throw new HTTPException(409, {
        message: `Cannot edit the mapping while the job is ${job.status}`,
      });
    }

    // Zod already confirmed every VALUE is a known canonical field
    // (`mappingBodySchema`); `validateMapping` is the business-rule gate
    // on top of that — every REQUIRED field present, no two source
    // columns aimed at the same one.
    const { mapping } = c.req.valid("json") as {
      mapping: Record<string, CanonicalField>;
    };
    const validation = validateMapping(mapping);
    if (!validation.ok) {
      throw new HTTPException(400, {
        message: `Mapping is missing required fields: ${validation.missingRequired.join(", ")}`,
      });
    }

    const updated = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.importJobRepo.updateImportJobMapping(
        tx,
        projectId,
        id,
        mapping,
      );
      await audit(
        {
          projectId,
          userId: user.id,
          action: "import.mapping_updated",
          resource: "import_job",
          resourceId: id,
          before: { mapping: job.mapping },
          after: { mapping: row.mapping },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    return c.json(ok({ job: toDto(updated) }));
  },
);

// ---------------------------------------------------------------------------
// POST /:id/dry-run
// ---------------------------------------------------------------------------

importsRoute.post("/:id/dry-run", uploadMutationRateLimit, async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  if (!projectId || !id) {
    throw new HTTPException(400, { message: "Missing projectId or id" });
  }
  const user = c.get("user");
  await requireImportAccess(projectId, user.id);

  const job = await requireImportJob(projectId, id);
  // Also the route's own defence against "a second dry-run request for a
  // job already in DRY_RUN_RUNNING must not start a second scan" (Task 10
  // fix round 1, FIX 2) — DRY_RUN_RUNNING is deliberately excluded from
  // this set, so a second request 409s here and never reaches the
  // enqueue call below. Final-fix-wave FIX 1 removed
  // `enqueueImportDryRun`'s BullMQ jobId pinning (it was silently
  // bricking re-runs, not just guarding this race), so this status-gate
  // check is the ONLY defence now — a genuine race between two
  // concurrent requests reading the status before either write lands is
  // a pre-existing, narrower gap, unrelated to this fix.
  if (!DRY_RUN_STARTABLE_STATUSES.has(job.status as ImportJobStatus)) {
    throw new HTTPException(409, {
      message: `Cannot start a dry run while the job is ${job.status}`,
    });
  }
  const mapping = job.mapping as Record<string, CanonicalField>;
  const validation = validateMapping(mapping);
  if (!validation.ok) {
    throw new HTTPException(400, {
      message: `Mapping is missing required fields: ${validation.missingRequired.join(", ")}`,
    });
  }

  // Task 10 fix round 1 (FIX 2): queued, not awaited in-request. The
  // upload cap is 2 GiB and a dry run reads the ENTIRE file — on the
  // largest files (exactly the customers this feature targets) an
  // in-request await could run past a typical proxy/load-balancer idle
  // timeout, and a dry run is mandatory before commit by design, so this
  // sits on the MAIN path, not an edge case. `DRY_RUN_RUNNING` existing
  // as its own persisted `ImportJobStatus` only makes sense for
  // asynchronous work — that was always the intent.
  //
  // The transition to DRY_RUN_RUNNING happens HERE, synchronously,
  // before enqueueing — not left to `planImport`'s own first write
  // (services/import/plan.ts still does that too, redundantly and
  // harmlessly, when the worker picks the job up) — so the response this
  // call returns already reflects it, rather than racing the worker's
  // pickup. `GET /:id` (now on its own, generous rate-limit budget — see
  // the module comment on `statusPollRateLimit`) is what the dashboard
  // polls from here to observe DRY_RUN_COMPLETE / FAILED.
  const started = await drizzle.importJobRepo.setImportJobStatus(
    drizzle.db,
    projectId,
    id,
    { status: "DRY_RUN_RUNNING", startedAt: new Date() },
  );
  await enqueueImportDryRun(id);
  await audit({
    projectId,
    userId: user.id,
    action: "import.dry_run_started",
    resource: "import_job",
    resourceId: id,
    after: { presetId: job.presetId },
    ...extractRequestContext(c),
  });

  return c.json(ok({ job: toDto(started) }), 202);
});

// ---------------------------------------------------------------------------
// POST /:id/commit
// ---------------------------------------------------------------------------

importsRoute.post("/:id/commit", uploadMutationRateLimit, async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  if (!projectId || !id) {
    throw new HTTPException(400, { message: "Missing projectId or id" });
  }
  const user = c.get("user");
  await requireImportAccess(projectId, user.id);

  const job = await requireImportJob(projectId, id);
  if (job.status !== "DRY_RUN_COMPLETE") {
    throw new HTTPException(409, {
      message: `Cannot commit: job is ${job.status}, expected DRY_RUN_COMPLETE`,
    });
  }

  await enqueueImportJob(id);
  await audit({
    projectId,
    userId: user.id,
    action: "import.commit_started",
    resource: "import_job",
    resourceId: id,
    after: null,
    ...extractRequestContext(c),
  });

  return c.json(ok({ job: toDto(job) }), 202);
});

// ---------------------------------------------------------------------------
// POST /:id/resume — task-10-context.md carry-forward 1
// ---------------------------------------------------------------------------
//
// Nothing previously re-enqueued a VERIFICATION_INCOMPLETE job — Phase B
// reports that outcome when the store-verification quota runs out, and
// it is resumable in principle (every anchor it already resolved is
// skipped via `purchases.verifiedAt` — verify.ts), but until this route
// existed there was no trigger. Re-enqueues through the EXACT same path
// `/commit` uses: `runImportJob` treats any non-COMPLETED job as "keep
// going from the checkpoint" (workers/import-runner.ts's own module
// comment), so Phase A fast-forwards past every already-checkpointed
// line and Phase B resumes verification where it left off.
//
// Task 10 fix round 2 (FIX A): also accepts `VERIFYING` — see
// `RESUMABLE_STATUSES`'s own comment for why a crash-interrupted
// `VERIFYING` row needs an operator-triggerable path just as much as a
// `VERIFICATION_INCOMPLETE` one does.

importsRoute.post("/:id/resume", uploadMutationRateLimit, async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  if (!projectId || !id) {
    throw new HTTPException(400, { message: "Missing projectId or id" });
  }
  const user = c.get("user");
  await requireImportAccess(projectId, user.id);

  const job = await requireImportJob(projectId, id);
  if (!RESUMABLE_STATUSES.has(job.status as ImportJobStatus)) {
    throw new HTTPException(409, {
      message: `Cannot resume: job is ${job.status}, expected VERIFICATION_INCOMPLETE or VERIFYING`,
    });
  }

  await enqueueImportJob(id);
  await audit({
    projectId,
    userId: user.id,
    action: "import.resumed",
    resource: "import_job",
    resourceId: id,
    after: null,
    ...extractRequestContext(c),
  });

  return c.json(ok({ job: toDto(job) }), 202);
});

// ---------------------------------------------------------------------------
// POST /:id/cancel
// ---------------------------------------------------------------------------

importsRoute.post("/:id/cancel", uploadMutationRateLimit, async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  if (!projectId || !id) {
    throw new HTTPException(400, { message: "Missing projectId or id" });
  }
  const user = c.get("user");
  await requireImportAccess(projectId, user.id);

  const job = await requireImportJob(projectId, id);
  if (!CANCELLABLE_STATUSES.has(job.status as ImportJobStatus)) {
    throw new HTTPException(409, {
      message: `Cannot cancel a job that is already ${job.status}`,
    });
  }

  // The operator action IS the write that flips the row to CANCELLED —
  // workers/import-runner.ts / verify.ts only ever OBSERVE that an
  // already-CANCELLED status appeared underneath them (at a batch/anchor
  // boundary) and stop; neither path sets `finishedAt` on that branch
  // (see import-runner.ts's cancelled branch), so this is also the one
  // place a cancelled job's `finishedAt` gets set — required for the
  // retention sweep's eligibility query (`listImportJobsEligibleForFileRetention`
  // filters on `finishedAt IS NOT NULL`).
  const cancelled = await drizzle.importJobRepo.setImportJobStatus(
    drizzle.db,
    projectId,
    id,
    { status: "CANCELLED", finishedAt: new Date() },
  );
  await audit({
    projectId,
    userId: user.id,
    action: "import.cancelled",
    resource: "import_job",
    resourceId: id,
    before: { status: job.status },
    after: { status: "CANCELLED" },
    ...extractRequestContext(c),
  });

  return c.json(ok({ job: toDto(cancelled) }));
});

// ---------------------------------------------------------------------------
// GET /:id — status + counters, for dashboard polling
// ---------------------------------------------------------------------------

importsRoute.get("/:id", statusPollRateLimit, async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  if (!projectId || !id) {
    throw new HTTPException(400, { message: "Missing projectId or id" });
  }
  const user = c.get("user");
  await requireImportAccess(projectId, user.id);

  const job = await requireImportJob(projectId, id);
  return c.json(ok({ job: toDto(job) }));
});

// ---------------------------------------------------------------------------
// GET /:id/columns — peeks the STORED file's header on demand (fix round 1)
// ---------------------------------------------------------------------------
//
// Task-11 controller context, fix round 1 (FIX 1): the operator whose
// export is NOT a recognised preset — exactly who hand-mapping exists
// for — had no way to see their own file's column names, on a file that
// can be gigabytes and that they may not be able to open locally. A
// misspelled column name passes `validateMapping` (it only checks
// canonical-field coverage, never that a source column actually exists)
// and would otherwise only surface as a dry run where every row lands in
// `invalidRow`, with nothing naming the bad column.
//
// Deliberately NOT persisted on the job row: that would need a schema
// migration, and Docker is down while this is being written, so a
// migration could not be verified. Instead this re-peeks the STORED
// object on every call, reusing the EXACT SAME `peekHeaderPrefix` /
// `detectHeaderFromPrefix` pair the upload route already uses for preset
// detection (module comment above), rather than a second parser. Only
// the bounded `HEADER_PEEK_BYTES` prefix is ever read — never the whole
// file — and the object stream is destroyed immediately after, so a
// repeated poll of this route never re-downloads a multi-gigabyte file
// past its header line.
//
// Same capability gate and project-scoped 404 as every other route in
// this file, and the READ rate-limit budget (`statusPollRateLimit`) —
// this is a peek, not a mutation. A retention-expired (or otherwise
// missing) object gets the SAME clean 404 the report-download route
// uses below, rather than a 500: the dashboard degrades to free-text
// entry in that case (see task-11 fix round 1's dashboard-side report).

importsRoute.get("/:id/columns", statusPollRateLimit, async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  if (!projectId || !id) {
    throw new HTTPException(400, { message: "Missing projectId or id" });
  }
  const user = c.get("user");
  await requireImportAccess(projectId, user.id);

  const job = await requireImportJob(projectId, id);

  const exists = await importStore.objectExists(job.storageKey);
  if (!exists) {
    throw new HTTPException(404, {
      message: "This file has been deleted by the retention sweep",
    });
  }

  const objectStream = await importStore.getObject(job.storageKey);
  let header: string[] | null;
  try {
    const { prefix, sawNewline } = await peekHeaderPrefix(objectStream, HEADER_PEEK_BYTES);
    // Same "too-long-or-absent header is a normal outcome, not an error"
    // posture as the upload route's own peek (module comment at the top
    // of this file) — an empty `columns` array, not a 4xx, tells the
    // dashboard detection found nothing usable so it should fall back to
    // free text.
    header = sawNewline ? await detectHeaderFromPrefix(prefix) : null;
  } finally {
    objectStream.destroy();
  }

  return c.json(ok({ columns: header ?? [] }));
});

// ---------------------------------------------------------------------------
// GET /:id/report — streams the report (Task 8 durable-parts contract)
// ---------------------------------------------------------------------------
//
// The report is no longer one object. Task 8 made it durable across a
// crash-and-resume by writing one immutable part per `runImportJob`
// ATTEMPT that did real work (`import_jobs.reportPartCount`,
// `buildReportPartStorageKey`). This route enumerates `1..reportPartCount`
// IN ORDER and concatenates — each part is independently valid NDJSON
// with no cross-part framing, so concatenation is the whole job, never a
// re-frame. `reportStorageKey` (the DRY-RUN planner's own, separate,
// single object — plan.ts) is NOT part of that enumeration; it is only
// ever served on its own, and only when no commit attempt has written a
// part yet (`reportPartCount === 0`) — once one has, the Phase-A parts
// are the authoritative record of what the commit actually did, so they
// take precedence over the (by then stale) dry-run preview.

importsRoute.get("/:id/report", statusPollRateLimit, async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  if (!projectId || !id) {
    throw new HTTPException(400, { message: "Missing projectId or id" });
  }
  const user = c.get("user");
  await requireImportAccess(projectId, user.id);

  const job = await requireImportJob(projectId, id);

  const keys: string[] =
    job.reportPartCount > 0
      ? Array.from({ length: job.reportPartCount }, (_, i) =>
          importStore.buildReportPartStorageKey(projectId, id, i + 1),
        )
      : job.reportStorageKey
        ? [job.reportStorageKey]
        : [];

  if (keys.length === 0) {
    throw new HTTPException(404, {
      message: "No report is available for this job yet",
    });
  }

  // Once `c.body()` below commits to a streamed response, the status
  // code can no longer change — so the retention-expired case (every
  // part of a terminal, past-window job gets deleted TOGETHER by the
  // sweep — workers/import-retention.ts) is checked up front, as a
  // clean 404, rather than surfacing as a truncated 200 download.
  const firstKeyExists = await importStore.objectExists(keys[0]!);
  if (!firstKeyExists) {
    throw new HTTPException(404, {
      message: "This report has been deleted by the retention sweep",
    });
  }

  c.header("Content-Type", "application/x-ndjson");
  c.header(
    "Content-Disposition",
    `attachment; filename="import-${id}-report.ndjson"`,
  );

  return c.body(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (const key of keys) {
            let partStream: Readable;
            try {
              partStream = await importStore.getObject(key);
            } catch (err) {
              // A 404 here means retention-expired, not a bug (see the
              // module comment) — end the stream with whatever already
              // went out instead of throwing into an already-committed
              // 200 response. The pre-flight check above makes this
              // unreachable for the common (all-or-nothing) sweep; it is
              // logged because it should be, in case a part is ever
              // missing on its own.
              if (importStore.isObjectNotFoundError(err)) {
                logger.warn(
                  "import report: part missing mid-download (retention race)",
                  { jobId: id, key },
                );
                break;
              }
              throw err;
            }
            for await (const chunk of partStream) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
              controller.enqueue(buf);
            }
          }
        } finally {
          controller.close();
        }
      },
    }),
  );
});
