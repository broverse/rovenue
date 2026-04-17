import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma, { type Prisma } from "@rovenue/db";
import { recordEvent } from "../../services/experiment-engine";
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

const log = logger.child("route:v1:experiments");

const eventSchema = z.object({
  key: z.string().min(1).optional(),
  type: z.string().min(1),
  timestamp: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const trackBodySchema = z.object({
  events: z.array(eventSchema).min(1, { message: "events must be non-empty" }),
});

const SUBSCRIBER_HEADER = "x-rovenue-user-id";

export const experimentsRoute = new Hono();

experimentsRoute.post("/track", async (c) => {
  const project = c.get("project");
  const appUserId =
    c.req.query("subscriberId") ?? c.req.header(SUBSCRIBER_HEADER) ?? null;
  if (!appUserId) {
    throw new HTTPException(400, {
      message:
        "subscriberId is required (via query param or X-Rovenue-User-Id header)",
    });
  }

  const raw = await c.req.json().catch(() => ({}));
  const parsed = trackBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.issues.map((i) => i.message).join("; "),
    });
  }

  const subscriber = await prisma.subscriber.upsert({
    where: {
      projectId_appUserId: { projectId: project.id, appUserId },
    },
    create: {
      projectId: project.id,
      appUserId,
      attributes: {} as Prisma.InputJsonValue,
    },
    update: { lastSeenAt: new Date() },
  });

  for (const event of parsed.data.events) {
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
    count: parsed.data.events.length,
  });

  return c.json(ok({ recorded: parsed.data.events.length }));
});
