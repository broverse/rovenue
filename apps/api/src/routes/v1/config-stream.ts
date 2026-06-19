import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { Redis } from "ioredis";
import { env } from "../../lib/env";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import {
  CONFIG_INVALIDATE_CHANNEL,
} from "../../lib/config-invalidation";
import { evaluateSubscriberConfig } from "../../services/subscriber-config";
import { resolveEnv, resolveSubscriberId } from "./config";
import { logger } from "../../lib/logger";

// =============================================================
// SSE /v1/config/stream
// =============================================================
//
// Streams the SAME evaluated `{ flags, experiments }` config as GET
// /v1/config to a specific subscriber, then pushes a fresh re-evaluation
// whenever the project's flag/experiment/audience config changes (via the
// `rovenue:experiments:invalidate` Redis channel, which the flag/experiment
// cache-invalidation paths now publish to).
//
// Audit CS1: previously this streamed the raw experiment *bundle* (no flags,
// no per-subscriber evaluation) and listened on a channel that nothing
// published to — it was non-functional end-to-end and inconsistent with
// /v1/config. It now requires a subscriberId (query param or
// X-Rovenue-User-Id header), exactly like /v1/config.

const log = logger.child("config-stream");

export const configStreamRoute = new Hono().get(
  "/v1/config/stream",
  apiKeyAuth("any"),
  (c) => {
    const project = c.get("project");
    const projectId = project.id;

    // Resolve identity + env BEFORE opening the stream so a bad request
    // returns a clean 4xx instead of a half-open SSE connection.
    const appUserId = resolveSubscriberId(c);
    if (!appUserId) {
      throw new HTTPException(400, {
        message:
          "subscriberId is required (via query param or X-Rovenue-User-Id header)",
      });
    }
    const featureFlagEnv = resolveEnv(c);

    return streamSSE(c, async (stream) => {
      const evaluate = () =>
        evaluateSubscriberConfig({
          projectId,
          appUserId,
          env: featureFlagEnv,
          requestAttributes: {},
        });

      // Initial evaluated config so the SDK has working state immediately.
      const initial = await evaluate();
      await stream.writeSSE({
        event: "initial",
        data: JSON.stringify({ ...initial, projectId }),
      });

      // Dedicated subscriber connection — ioredis requires a separate client
      // for pub/sub because the connection transitions to subscribe-only mode.
      const subscriber = new Redis(env.REDIS_URL, { lazyConnect: false });
      await subscriber.subscribe(CONFIG_INVALIDATE_CHANNEL);

      const onMessage = async (_channel: string, payload: string) => {
        try {
          const parsed = JSON.parse(payload) as { projectId: string };
          if (parsed.projectId !== projectId) return;
          const next = await evaluate();
          await stream.writeSSE({
            event: "invalidate",
            data: JSON.stringify({ ...next, projectId }),
          });
        } catch (err) {
          log.warn("invalidation delivery failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      };
      subscriber.on("message", onMessage);

      // Keepalive comment every 25s (below most CDN idle timeouts).
      const keepalive = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" });
      }, 25_000);

      stream.onAbort(() => {
        clearInterval(keepalive);
        void subscriber
          .unsubscribe(CONFIG_INVALIDATE_CHANNEL)
          .catch(() => undefined);
        void subscriber.quit().catch(() => undefined);
      });

      // Block until the client disconnects.
      await new Promise(() => undefined);
    });
  },
);
