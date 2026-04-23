import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Redis } from "ioredis";
import { env } from "../../lib/env";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { loadBundleFromCache } from "../../services/experiment-engine";
import { logger } from "../../lib/logger";

// =============================================================
// SSE /v1/config/stream
// =============================================================
//
// Source: superseded plan `docs/superpowers/plans/
// 2026-04-23-clickhouse-foundation-and-experiments.md` Task 7.1
// (lines 2137-2273), copied per Phase F.3 of the Kafka+outbox
// pivot. Streams flag/experiment config to SDKs via Redis pub/sub
// — it does not touch the ingest path, so no semantic change.
//
// Drift vs. superseded plan: `apiKeyAuth` in this repo is a
// factory, not a bare middleware — we call `apiKeyAuth("any")`.
// Project context lives under `c.get("project")` rather than
// `c.get("projectId")`.

const log = logger.child("config-stream");
const INVALIDATE_CHANNEL = "rovenue:experiments:invalidate";

export const configStreamRoute = new Hono()
  .use("*", apiKeyAuth("any"))
  .get("/v1/config/stream", (c) =>
    streamSSE(c, async (stream) => {
      const project = c.get("project");
      const projectId = project.id;

      // Send the initial bundle straight away so SDK clients have a
      // working config before the first invalidation arrives.
      const initial = await loadBundleFromCache(projectId);
      await stream.writeSSE({
        event: "initial",
        data: JSON.stringify({ ...initial, projectId }),
      });

      // Dedicated subscriber connection — ioredis requires a separate
      // client for pub/sub because the connection transitions to a
      // subscribe-only mode.
      const subscriber = new Redis(env.REDIS_URL, { lazyConnect: false });
      await subscriber.subscribe(INVALIDATE_CHANNEL);

      const onMessage = async (_channel: string, payload: string) => {
        try {
          const parsed = JSON.parse(payload) as { projectId: string };
          if (parsed.projectId !== projectId) return;
          const bundle = await loadBundleFromCache(projectId);
          await stream.writeSSE({
            event: "invalidate",
            data: JSON.stringify({ ...bundle, projectId }),
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
        void subscriber.unsubscribe(INVALIDATE_CHANNEL).catch(() => undefined);
        void subscriber.quit().catch(() => undefined);
      });

      // Block until the client disconnects. hono's streamSSE returns
      // when the response is closed; we just await an unresolvable
      // promise here.
      await new Promise(() => undefined);
    }),
  );
