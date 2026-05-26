import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { Redis } from "ioredis";
import { MemberRole } from "@rovenue/db";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { liveEventsChannelFor } from "../../workers/outbox-dispatcher";

// =============================================================
// Dashboard: Live events SSE (Phase 4.3)
// =============================================================
//
// GET /dashboard/projects/:projectId/events/stream
//
// Server-Sent Events feed for the live-events page. The outbox
// dispatcher publishes each committed row to a per-project Redis
// pub/sub channel; this endpoint subscribes to that channel for
// the duration of the request and writes one SSE message per
// event.
//
// ioredis requires a dedicated subscriber connection because the
// client transitions to subscribe-only mode after the first
// SUBSCRIBE — so we open a fresh `Redis` here and shut it down
// when the request aborts.
//
// Keepalive: a `ping` SSE event every 25s so intermediaries
// (nginx / browser EventSource) don't reap the connection during
// quiet periods.

const log = logger.child("dashboard-events-stream");
const KEEPALIVE_MS = 25_000;

export const eventsStreamRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/stream", (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    // Membership check up front so unauthorised callers don't open
    // a long-lived stream they'll just disconnect from.
    const user = c.get("user");

    return streamSSE(c, async (stream) => {
      try {
        await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
      } catch (err) {
        log.warn("denied", { projectId, userId: user.id });
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            code: "FORBIDDEN",
            message: err instanceof Error ? err.message : "Access denied",
          }),
        });
        return;
      }

      // Send a `ready` marker so the client knows the stream is
      // live (useful for the UI's "Streaming" / "Paused" pill).
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ projectId, ts: new Date().toISOString() }),
      });

      const channel = liveEventsChannelFor(projectId);
      const subscriber = new Redis(env.REDIS_URL, {
        lazyConnect: false,
        maxRetriesPerRequest: 3,
      });
      await subscriber.subscribe(channel);

      const onMessage = async (_chan: string, payload: string): Promise<void> => {
        try {
          // The dispatcher already encodes the wire shape — pass
          // through verbatim. We re-parse-and-stringify only to
          // validate it's well-formed JSON; an exception drops
          // the event silently rather than crashing the stream.
          JSON.parse(payload);
          await stream.writeSSE({ event: "live", data: payload });
        } catch (err) {
          log.warn("malformed-live-event", {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      };
      subscriber.on("message", onMessage);

      const keepalive = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" });
      }, KEEPALIVE_MS);

      stream.onAbort(() => {
        clearInterval(keepalive);
        void subscriber.unsubscribe(channel).catch(() => undefined);
        void subscriber.quit().catch(() => undefined);
      });

      // Block until the client disconnects; hono's streamSSE
      // returns when the response is closed.
      await new Promise(() => undefined);
    });
  });
