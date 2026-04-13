import { Hono } from "hono";
import { logger as honoRequestLogger } from "hono/logger";
import { errorHandler } from "./middleware/error";
import { authRoute, healthRoute, v1Route, webhooksRoute } from "./routes";
import { logger } from "./lib/logger";

const requestLog = logger.child("request");

export function createApp() {
  const app = new Hono();

  app.use(
    "*",
    honoRequestLogger((message, ...rest) => {
      requestLog.info(message, rest.length > 0 ? { details: rest } : undefined);
    }),
  );

  app.onError(errorHandler);

  app.route("/health", healthRoute);
  app.route("/api/auth", authRoute);
  app.route("/webhooks", webhooksRoute);
  app.route("/v1", v1Route);

  return app;
}

export const app = createApp();
