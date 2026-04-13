import { Hono } from "hono";
import { errorHandler } from "./middleware/error";
import { authRoute, healthRoute } from "./routes";

export function createApp() {
  const app = new Hono();

  app.onError(errorHandler);

  app.route("/health", healthRoute);
  app.route("/api/auth", authRoute);

  return app;
}

export const app = createApp();
