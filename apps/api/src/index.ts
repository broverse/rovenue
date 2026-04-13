import { serve } from "@hono/node-server";
import { app } from "./app";
import { env } from "./lib/env";
import { logger } from "./lib/logger";

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("listening", { url: `http://localhost:${info.port}` });
});
