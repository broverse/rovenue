import { Hono } from "hono";
import { errorHandler } from "./middleware/error";
import { requestIdMiddleware } from "./middleware/request-id";
import { requestLoggerMiddleware } from "./middleware/request-logger";
import { authRoute, healthRoute, v1Route, webhooksRoute } from "./routes";

export function createApp() {
  const app = new Hono();

  // Order matters: request-id must run before request-logger so the
  // logger can read `c.get("requestId")` and wrap the downstream chain
  // in the AsyncLocalStorage scope.
  app.use("*", requestIdMiddleware);
  app.use("*", requestLoggerMiddleware);

  app.onError(errorHandler);

  app.route("/health", healthRoute);
  app.route("/api/auth", authRoute);
  app.route("/webhooks", webhooksRoute);
  app.route("/v1", v1Route);

  return app;
}

export const app = createApp();
