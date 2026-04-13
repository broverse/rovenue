import { Hono } from "hono";
import { errorHandler } from "./middleware/error";
import { healthRoute } from "./routes";

export function createApp() {
  const app = new Hono();

  app.onError(errorHandler);

  app.route("/health", healthRoute);

  return app;
}

export const app = createApp();
