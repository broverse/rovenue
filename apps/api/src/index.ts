import { serve } from "@hono/node-server";
import { app } from "./app";
import { env } from "./lib/env";
import { logger } from "./lib/logger";
import { createWebhookWorker } from "./services/webhook-processor";

// Start the in-process webhook worker alongside the HTTP server. For
// horizontal scaling, move this to a separate process using the same
// entrypoint and switch the HTTP side off there.
createWebhookWorker();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("listening", { url: `http://localhost:${info.port}` });
});
