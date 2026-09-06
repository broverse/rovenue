import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { Redis } from "ioredis";
import { env } from "../../lib/env";
import { attachRedisErrorLogger } from "../../lib/redis";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import {
  CONFIG_INVALIDATE_CHANNEL,
  parseConfigInvalidation,
  type ConfigInvalidationMessage,
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

/**
 * Trailing-edge window for re-evaluating after an invalidation. A burst of
 * attribute writes for one subscriber collapses into a single push. This
 * bounds push RATE, never correctness: the trailing evaluation always reads
 * current state, so the last push in a burst is always right.
 */
export const CONFIG_STREAM_COALESCE_MS = 250;

/**
 * Whether an invalidation message concerns this stream.
 *
 * `resolvedSubscriberId` is null until the initial evaluation completes.
 * In that window a targeted message wakes the stream anyway — a wasted
 * evaluation is cheap, a dropped update is not.
 */
export function shouldWakeStream(
  message: ConfigInvalidationMessage,
  projectId: string,
  resolvedSubscriberId: string | null,
): boolean {
  if (message.projectId !== projectId) return false;
  if (!message.subscriberIds) return true;
  if (resolvedSubscriberId === null) return true;
  return message.subscriberIds.includes(resolvedSubscriberId);
}

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
      // Tracked from each evaluation and matched against invalidation
      // messages — the RESOLVED row id, never the appUserId the stream was
      // opened with. A /transfer merge changes which row an id resolves to,
      // so matching on the external id would strand a device after a merge.
      let resolvedSubscriberId: string | null = null;

      const evaluate = async () => {
        const config = await evaluateSubscriberConfig({
          projectId,
          appUserId,
          env: featureFlagEnv,
          requestAttributes: {},
        });
        resolvedSubscriberId = config.subscriberId;
        return config;
      };

      // Initial evaluated config so the SDK has working state immediately.
      // Wire shape is exactly `{ flags, experiments, projectId }` — mirrors
      // GET /v1/config. subscriberId is an internal row id and must never
      // reach the public SDK wire.
      const initial = await evaluate();
      await stream.writeSSE({
        event: "initial",
        data: JSON.stringify({
          flags: initial.flags,
          experiments: initial.experiments,
          projectId,
        }),
      });

      // Dedicated subscriber connection — ioredis requires a separate client
      // for pub/sub because the connection transitions to subscribe-only mode.
      const subscriber = attachRedisErrorLogger(
        new Redis(env.REDIS_URL, { lazyConnect: false }),
        "config-stream-subscriber",
      );
      await subscriber.subscribe(CONFIG_INVALIDATE_CHANNEL);

      let coalesceTimer: NodeJS.Timeout | null = null;

      const pushFreshConfig = async () => {
        coalesceTimer = null;
        try {
          const next = await evaluate();
          await stream.writeSSE({
            event: "invalidate",
            data: JSON.stringify({
              flags: next.flags,
              experiments: next.experiments,
              projectId,
            }),
          });
        } catch (err) {
          log.warn("invalidation delivery failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      };

      const onMessage = (_channel: string, payload: string) => {
        const message = parseConfigInvalidation(payload);
        if (!message) return;
        if (!shouldWakeStream(message, projectId, resolvedSubscriberId)) {
          return;
        }

        // Trailing edge: an invalidation arriving while one is already
        // pending collapses into it rather than queueing a second push.
        if (coalesceTimer !== null) return;
        coalesceTimer = setTimeout(() => {
          void pushFreshConfig();
        }, CONFIG_STREAM_COALESCE_MS);
      };
      subscriber.on("message", onMessage);

      // Keepalive comment every 25s (below most CDN idle timeouts).
      const keepalive = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "" });
      }, 25_000);

      stream.onAbort(() => {
        clearInterval(keepalive);
        if (coalesceTimer !== null) clearTimeout(coalesceTimer);
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
