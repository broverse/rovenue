import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle, getDb } from "@rovenue/db";
import { recordEvent } from "../../services/experiment-engine";
import { eventBus } from "../../services/event-bus";
import { computeExperimentResults } from "../../services/experiment-results";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

// =============================================================
// POST /v1/experiments/track
// =============================================================
//
// Batch event ingestion for the experiment funnel. The SDK
// buffers events locally (debounce ~5s) and POSTs them as a
// single request. Each event is forwarded to recordEvent, which
// appends it to every one of the subscriber's active assignments
// and, when the experiment's metrics list contains the event
// type, records the first occurrence as a conversion.
//
// `key` on each event is informational — funnel analysis reads
// it from the event, but recordEvent dispatches against every
// active assignment regardless of key.
//
// zValidator guarantees the JSON body matches trackBodySchema
// before the handler runs, which gives us a 400 response with
// field-level messages for free and types the body through
// `c.req.valid("json")` for RPC consumers.

const log = logger.child("route:v1:experiments");

export const eventSchema = z.object({
  key: z.string().min(1).optional(),
  type: z.string().min(1),
  timestamp: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const trackBodySchema = z.object({
  events: z.array(eventSchema).min(1, { message: "events must be non-empty" }),
});

export type TrackBody = z.infer<typeof trackBodySchema>;

const SUBSCRIBER_HEADER = "x-rovenue-user-id";

// =============================================================
// POST /v1/experiments/:id/expose
// =============================================================
//
// Records an experiment assignment exposure via the outbox
// event-bus — a short Postgres transaction writes one row to
// `outbox_events` which the dispatcher later ships to Redpanda,
// then CH's Kafka Engine materialises it. Authorization +
// rate-limiting piggyback on the /v1 parent middleware
// (apiKeyAuth + apiKeyRateLimit).
//
// Delta vs. the superseded plan's exposure path: no direct
// Postgres `exposure_events` insert and no Redis buffering —
// the outbox is the single write destination, and CH is the
// single read surface.

export const exposeBodySchema = z.object({
  variantId: z.string().min(1),
  subscriberId: z.string().min(1),
  platform: z.enum(["ios", "android", "web"]).optional(),
  country: z.string().length(2).optional(),
  exposedAt: z.string().datetime().optional(),
});

export type ExposeBody = z.infer<typeof exposeBodySchema>;

export const experimentsRoute = new Hono()
  .post(
    "/track",
    zValidator("json", trackBodySchema),
    async (c) => {
      const project = c.get("project");
      const appUserId =
        c.req.query("subscriberId") ?? c.req.header(SUBSCRIBER_HEADER) ?? null;
      if (!appUserId) {
        throw new HTTPException(400, {
          message:
            "subscriberId is required (via query param or X-Rovenue-User-Id header)",
        });
      }

      const body = c.req.valid("json");

      const subscriber = await drizzle.subscriberRepo.upsertSubscriber(
        drizzle.db,
        {
          projectId: project.id,
          appUserId,
          createAttributes: {},
        },
      );

      for (const event of body.events) {
        const metadata: Record<string, unknown> = {
          ...(event.metadata ?? {}),
        };
        if (event.key) metadata.experimentKey = event.key;
        if (event.timestamp) metadata.clientTimestamp = event.timestamp;

        try {
          await recordEvent(subscriber.id, event.type, metadata);
        } catch (err) {
          log.warn("recordEvent failed", {
            subscriberId: subscriber.id,
            eventType: event.type,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      log.info("experiment events tracked", {
        projectId: project.id,
        subscriberId: subscriber.id,
        count: body.events.length,
      });

      return c.json(ok({ recorded: body.events.length }));
    },
  )
  .post(
    "/:id/expose",
    zValidator("json", exposeBodySchema),
    async (c) => {
      const experimentId = c.req.param("id");
      const input = c.req.valid("json");
      const project = c.get("project");

      try {
        await getDb().transaction(async (tx) => {
          await eventBus.publishExposure(tx, {
            experimentId,
            variantId: input.variantId,
            projectId: project.id,
            subscriberId: input.subscriberId,
            platform: input.platform,
            country: input.country,
            exposedAt: input.exposedAt ? new Date(input.exposedAt) : undefined,
          });
        });
      } catch (err) {
        log.warn("expose failed", {
          projectId: project.id,
          experimentId,
          err: err instanceof Error ? err.message : String(err),
        });
        throw new HTTPException(500, { message: "failed to record exposure" });
      }

      return c.json(ok({ accepted: true }));
    },
  )
  .get("/:id/results", async (c) => {
    // =============================================================
    // GET /v1/experiments/:id/results
    // =============================================================
    //
    // Source: superseded plan Task 8.2, copied per Phase F.5.
    // Returns CH-backed experiment statistics (SRM + per-variant
    // exposures today; CUPED / revenue deltas when the MV chain
    // lands in Plan 2). Scoped to the authenticated project so a
    // cross-project id leak surfaces as "experiment not found".
    const experimentId = c.req.param("id");
    const project = c.get("project");
    const results = await computeExperimentResults(experimentId, project.id);
    return c.json(ok(results));
  });
