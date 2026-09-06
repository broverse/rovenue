import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import {
  requireSecretKey,
  type AuthenticatedProject,
} from "../../middleware/api-key-auth";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { isUniqueViolationOf } from "../../lib/pg-errors";
import { resolveSubscriber } from "../../lib/resolve-subscriber";
import { validate } from "../../lib/validate";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";
import * as importStore from "../../lib/import-store";
import {
  DSAR_EXPORT_JOB_NAME,
  DSAR_ERASURE_JOB_NAME,
  enqueueDsarJob,
} from "../../queues/dsar";

// =============================================================
// /v1/dsar — self-service DSAR API (ROADMAP §9.1, Task 3)
// =============================================================
//
// Secret-key S2S only: the CUSTOMER'S OWN backend authenticates its own
// end user (however it does that — never Rovenue's business), decides a
// subject-access request is legitimate, and asks Rovenue on their
// behalf. `requireSecretKey` on every route here is not a formality —
// a PUBLIC key reaching `/erasure` would let anyone with a client
// bundle erase another person's data.
//
// Authorisation, and the §12.3 lesson (this project has shipped this
// exact bug class before):
//
//   - POST /export and POST /erasure resolve the subscriber via
//     `resolveSubscriber(project.id, body.appUserId)`, which is scoped
//     BY THE QUERY ITSELF (packages/db's `resolveSubscriberByRovenueId`
//     filters on `projectId = args.projectId`) — there is structurally
//     no way for this call to return a subscriber belonging to another
//     project, so there is nothing to "check afterward" without writing
//     dead code that can never fire.
//   - GET /:id and GET /:id/download are the routes actually at risk:
//     `findDsarRequestById` (Task 2) is deliberately NOT project-scoped
//     (it takes only the caller-supplied `:id`, matching
//     `import-jobs.ts`'s `getImportJobById` precedent), so EVERY caller
//     of it here re-authorises the returned row's own `projectId`
//     against the authenticated key's project before doing anything
//     else with it — see `requireOwnedDsarRequest` below. Never trust a
//     projectId from the request body or path; the row's own column is
//     the only thing that gets compared.
//
// Rate limiting: `dsarEndpointLimit` is shared across POST /export and
// POST /erasure (one budget, not one each — exactly like receipts.ts
// shares one 30/min budget across /apple and /google) because a DSAR
// export runs a multi-table read and must stay tighter than receipts'
// 30/min. GET /:id and GET /:id/download are plain reads gated only by
// the outer `/v1` per-key envelope (apiKeyRateLimit), matching
// dashboard/imports.ts's split between a strict mutation budget and an
// unmetered-at-the-route-level read path.

const log = logger.child("route:v1:dsar");

export const DSAR_ENDPOINT_MAX_PER_MINUTE = 5;

const dsarEndpointLimit = endpointRateLimit({
  name: "dsar",
  max: DSAR_ENDPOINT_MAX_PER_MINUTE,
});

/** The ONLY unique constraint `dsar_requests` has — see schema.ts's
 *  `openRequestUniq` (the partial unique index over
 *  `(subscriberId, type) WHERE status IN ('PENDING','RUNNING')`).
 *  Named explicitly (rather than a bare 23505 code check) per
 *  `isUniqueViolationOf`'s own doc: a bare code check is only correct
 *  when the statement can violate exactly one constraint, and naming it
 *  keeps that true even if a second unique index is ever added to this
 *  table. */
const DSAR_OPEN_REQUEST_UNIQUE_CONSTRAINT =
  "dsar_requests_open_subscriber_type_uniq";

export const dsarRequestBodySchema = z.object({
  appUserId: z.string().min(1),
  requestedBy: z.string().min(1),
});

export type DsarRequestBody = z.infer<typeof dsarRequestBodySchema>;

type DsarRequestRow = Awaited<
  ReturnType<typeof drizzle.dsarRequestRepo.createDsarRequest>
>;

type DsarType = "EXPORT" | "ERASURE";

function serializeDsarRequest(request: DsarRequestRow) {
  const now = Date.now();
  const downloadReady =
    request.status === "COMPLETED" &&
    request.artifactKey != null &&
    (request.expiresAt == null || request.expiresAt.getTime() > now);
  return {
    id: request.id,
    type: request.type,
    status: request.status,
    requestedBy: request.requestedBy,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    completedAt: request.completedAt,
    expiresAt: request.expiresAt,
    error: request.error,
    downloadReady,
  };
}

/**
 * Create-or-return-the-open-one, on top of the database's own
 * idempotency guarantee.
 *
 * Two layers, deliberately:
 *   1. `findOpenDsarRequest` first — the common case (a caller retrying
 *      after a timeout, or genuinely asking twice) never needs to touch
 *      the unique-index error path at all.
 *   2. A concurrent double-submit can still race between that check and
 *      the insert; when it does, `createDsarRequest` throws a wrapped
 *      Postgres unique-violation (Drizzle rethrows every query failure
 *      as `DrizzleQueryError` with the real `pg` error on `.cause` —
 *      see `isUniqueViolationOf`'s own doc) rather than 500ing, this
 *      re-reads the now-existing open request and returns THAT one,
 *      exactly as if this call had lost the race gracefully.
 *
 * Enqueues a job only when THIS call is the one that actually inserted
 * the row — never on either the fast idempotent path or the race-loser
 * path — so "returns the same request when the same subject asks twice"
 * also means "never enqueues a second job for it".
 */
async function createOrReturnOpenDsarRequest(
  project: AuthenticatedProject,
  type: DsarType,
  body: DsarRequestBody,
): Promise<DsarRequestRow> {
  const subscriber = await resolveSubscriber(project.id, body.appUserId);

  const existing = await drizzle.dsarRequestRepo.findOpenDsarRequest(
    drizzle.db,
    { projectId: project.id, subscriberId: subscriber.id, type },
  );
  if (existing) return existing;

  let created: DsarRequestRow;
  try {
    created = await drizzle.dsarRequestRepo.createDsarRequest(drizzle.db, {
      projectId: project.id,
      subscriberId: subscriber.id,
      type,
      requestedBy: body.requestedBy,
    });
  } catch (err) {
    if (isUniqueViolationOf(err, DSAR_OPEN_REQUEST_UNIQUE_CONSTRAINT)) {
      const raceWinner = await drizzle.dsarRequestRepo.findOpenDsarRequest(
        drizzle.db,
        { projectId: project.id, subscriberId: subscriber.id, type },
      );
      if (raceWinner) {
        log.info("dsar request: lost the create race, returning the winner", {
          projectId: project.id,
          subscriberId: subscriber.id,
          type,
          requestId: raceWinner.id,
        });
        return raceWinner;
      }
    }
    throw err;
  }

  await enqueueDsarJob(
    type === "EXPORT" ? DSAR_EXPORT_JOB_NAME : DSAR_ERASURE_JOB_NAME,
    {
      dsarRequestId: created.id,
      projectId: project.id,
      subscriberId: subscriber.id,
      type,
    },
  );

  return created;
}

/**
 * The §12.3 checkpoint: `findDsarRequestById` is NOT project-scoped
 * (Task 2, matching `import-jobs.ts`'s precedent), so every caller here
 * re-authorises the row's own `projectId` against the authenticated
 * key's project before returning or acting on it.
 *
 * 404 for BOTH "no such row" and "row belongs to another project" —
 * deliberately the same status and message for both. A 403 here would
 * confirm to a probing caller that SOME other project's request exists
 * under that id, which is itself the information leak; this way an id
 * that exists in another project is indistinguishable from one that
 * does not exist at all.
 */
async function requireOwnedDsarRequest(
  project: AuthenticatedProject,
  id: string,
): Promise<DsarRequestRow> {
  const request = await drizzle.dsarRequestRepo.findDsarRequestById(
    drizzle.db,
    id,
  );
  if (!request || request.projectId !== project.id) {
    throw new HTTPException(404, { message: "DSAR request not found" });
  }
  return request;
}

export const dsarRoute = new Hono()
  // -------------------------------------------------------------
  // POST /export
  // -------------------------------------------------------------
  .post(
    "/export",
    requireSecretKey,
    dsarEndpointLimit,
    validate("json", dsarRequestBodySchema),
    async (c) => {
      const project = c.get("project");
      const body = c.req.valid("json");
      const request = await createOrReturnOpenDsarRequest(
        project,
        "EXPORT",
        body,
      );
      return c.json(ok({ request: serializeDsarRequest(request) }));
    },
  )
  // -------------------------------------------------------------
  // POST /erasure
  // -------------------------------------------------------------
  .post(
    "/erasure",
    requireSecretKey,
    dsarEndpointLimit,
    validate("json", dsarRequestBodySchema),
    async (c) => {
      const project = c.get("project");
      const body = c.req.valid("json");
      const request = await createOrReturnOpenDsarRequest(
        project,
        "ERASURE",
        body,
      );
      return c.json(ok({ request: serializeDsarRequest(request) }));
    },
  )
  // -------------------------------------------------------------
  // GET /:id
  // -------------------------------------------------------------
  .get("/:id", requireSecretKey, async (c) => {
    const project = c.get("project");
    const id = c.req.param("id");
    const request = await requireOwnedDsarRequest(project, id);
    return c.json(ok({ request: serializeDsarRequest(request) }));
  })
  // -------------------------------------------------------------
  // GET /:id/download (Ruling B: stream, never a URL)
  // -------------------------------------------------------------
  //
  // Refuses a request that is not COMPLETED, has no artifact, or whose
  // expiresAt has passed — all checked BEFORE `c.body()` commits to a
  // streamed response, matching dashboard/imports.ts's report-download
  // precedent: once a streamed 200 starts, the status code can no
  // longer change, so every refusal has to happen up front.
  .get("/:id/download", requireSecretKey, async (c) => {
    const project = c.get("project");
    const id = c.req.param("id");
    const request = await requireOwnedDsarRequest(project, id);

    if (request.status !== "COMPLETED" || !request.artifactKey) {
      throw new HTTPException(404, {
        message: "No download is available for this request",
      });
    }
    if (request.expiresAt && request.expiresAt.getTime() < Date.now()) {
      throw new HTTPException(404, {
        message: "This download link has expired",
      });
    }

    const artifactKey = request.artifactKey;
    const exists = await importStore.objectExists(artifactKey);
    if (!exists) {
      throw new HTTPException(404, {
        message: "This artifact is no longer available",
      });
    }

    c.header("Content-Type", "application/octet-stream");
    c.header(
      "Content-Disposition",
      `attachment; filename="dsar-${request.id}.export"`,
    );

    return c.body(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          const objectStream = await importStore.getObject(artifactKey);
          try {
            for await (const chunk of objectStream) {
              controller.enqueue(
                Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
              );
            }
          } finally {
            controller.close();
          }
        },
      }),
    );
  });
