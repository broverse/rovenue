import { serve } from "@hono/node-server";
import { app } from "./app";
import { env } from "./lib/env";
import { logger } from "./lib/logger";
import { createWebhookWorker } from "./services/webhook-processor";
import {
  createExpiryWorker,
  scheduleExpiryCheck,
} from "./workers/expiry-checker";

// Start the in-process webhook worker alongside the HTTP server. For
// horizontal scaling, move this to a separate process using the same
// entrypoint and switch the HTTP side off there.
createWebhookWorker();

// Subscription expiry sweeper — 5-minute repeatable BullMQ job.
createExpiryWorker();
scheduleExpiryCheck().catch((err: unknown) => {
  logger.error("failed to schedule expiry checker", {
    err: err instanceof Error ? err.message : String(err),
  });
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("listening", { url: `http://localhost:${info.port}` });
});
