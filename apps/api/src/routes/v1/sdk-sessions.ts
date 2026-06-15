import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createId } from "@paralleldrive/cuid2";
import { API_KEY_KIND } from "@rovenue/shared";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "@rovenue/db";
import { getProducer } from "../../lib/kafka";
import { logger } from "../../lib/logger";

// =============================================================
// POST /v1/sdk/sessions — Refund Shield telemetry ingest
// =============================================================
//
// The SDK posts a batch of session lifecycle events (open /
// background / close) so ClickHouse can compute objective
// engagement signals for Apple's CONSUMPTION_REQUEST window.
//
// Pipeline (see CH migration 0009):
//   POST /v1/sdk/sessions
//     -> Redpanda topic `rovenue.sdk-sessions`
//     -> CH rovenue.sdk_session_events_queue (Kafka Engine)
//     -> mv_sdk_sessions_to_raw
//     -> raw_sdk_session_events (ReplacingMergeTree)
//     -> sdk_sessions_daily aggregate (T5)
//
// Direct Kafka produce — no outbox row, no Postgres write.
// This trades exactly-once for low write amplification: a brief
// Kafka outage drops a small window of session telemetry, which
// is acceptable for Refund Shield's lifetime aggregation
// (Apple's CONSUMPTION_REQUEST has a 12h response window — even
// a multi-minute Kafka blip leaves plenty of headroom).
//
// Authentication: PUBLIC API key (rov_pub_*). The route is
// mounted under /v1 which already runs `apiKeyAuth("any")` — we
// enforce public-only via the same `requirePublicApiKey` guard
// pattern used by /v1/events.
//
// Queue envelope (matches CH migration 0009 columns):
//   { eventId, aggregateId, eventType, payload }
// where `payload` is a stringified JSON object that the MV's
// JSONExtract* expressions parse out.

const log = logger.child("route:v1:sdk-sessions");

const requirePublicApiKey: import("hono").MiddlewareHandler = async (
  c,
  next,
) => {
  const project = c.get("project");
  if (project?.keyKind !== API_KEY_KIND.PUBLIC) {
    throw new HTTPException(403, { message: "Public API key required" });
  }
  await next();
};

const sessionEventSchema = z.object({
  type: z.enum(["open", "background", "close"]),
  occurredAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative().optional(),
  appVersion: z.string().min(1).max(32),
  sdkVersion: z.string().min(1).max(32),
});

const bodySchema = z.object({
  // cuid2 IDs are text, not UUID — matches CH `String` typing in
  // raw_sdk_session_events (see migration 0009 comment on ID types).
  subscriberId: z.string().min(1).max(128),
  events: z.array(sessionEventSchema).min(1).max(200),
});

export const sdkSessionsRoute = new Hono().post(
  "/",
  requirePublicApiKey,
  zValidator("json", bodySchema),
  async (c) => {
    const project = c.get("project");
    const { subscriberId: rawSubscriberId, events } = c.req.valid("json");

    // Tenant ownership: resolve the client-supplied id to a project-owned
    // subscriber so the Kafka key + payload always carry an id we own
    // (mirrors /me, /track). A raw foreign id would otherwise corrupt the
    // engagement aggregates feeding Refund Shield.
    const subscriber = await drizzle.subscriberRepo.upsertSubscriber(
      drizzle.db,
      {
        projectId: project.id,
        rovenueId: rawSubscriberId,
        createAttributes: {},
      },
    );
    const subscriberId = subscriber.id;

    const messages = events.map((e) => ({
      // Partition key — same subscriber's events land on the same
      // partition so ReplacingMergeTree dedup is deterministic.
      key: subscriberId,
      value: JSON.stringify({
        eventId: createId(),
        aggregateId: subscriberId,
        eventType: "sdk.session",
        payload: JSON.stringify({
          projectId: project.id,
          subscriberId,
          eventType: e.type,
          occurredAt: e.occurredAt,
          durationMs: e.durationMs ?? 0,
          appVersion: e.appVersion,
          sdkVersion: e.sdkVersion,
        }),
      }),
    }));

    const producer = await getProducer();
    if (!producer) {
      // KAFKA_BROKERS unset — treat as degraded telemetry.
      // The SDK retries; in dev this means the endpoint is a
      // no-op rather than 500. We still return 503 so the SDK's
      // retry path keeps the buffered batch and doesn't drop it.
      log.warn("kafka unavailable: dropping sdk session batch", {
        projectId: project.id,
        batchSize: events.length,
      });
      return c.json(
        {
          error: { code: "TELEMETRY_UNAVAILABLE", message: "retry" },
        },
        503,
      );
    }

    try {
      await producer.send({
        topic: "rovenue.sdk-sessions",
        messages,
      });
    } catch (err) {
      log.error("kafka produce failed for sdk sessions", {
        projectId: project.id,
        batchSize: events.length,
        err: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        {
          error: { code: "TELEMETRY_UNAVAILABLE", message: "retry" },
        },
        503,
      );
    }

    return c.body(null, 202);
  },
);
