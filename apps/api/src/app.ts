import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./lib/env";
import { errorHandler } from "./middleware/error";
import { globalIpRateLimit } from "./middleware/rate-limit";
import { requestIdMiddleware } from "./middleware/request-id";
import { requestLoggerMiddleware } from "./middleware/request-logger";
import {
  authRoute,
  dashboardRoute,
  healthRoute,
  v1Route,
  webhooksRoute,
} from "./routes";

export function createApp() {
  const app = new Hono();

  // ── 1. Request ID ─────────────────────────────────────────
  // Must run before request-logger so the logger can read
  // `c.get("requestId")` and wrap the downstream chain in the
  // AsyncLocalStorage scope.
  app.use("*", requestIdMiddleware);

  // ── 2. Request logger ─────────────────────────────────────
  app.use("*", requestLoggerMiddleware);

  // ── 3. CORS ───────────────────────────────────────────────
  // Allow the dashboard SPA origin + localhost dev server.
  // SDK calls don't need CORS (native mobile), and webhooks
  // come from store servers — but applying it globally is
  // harmless and keeps the config in one place.
  // Allow the local Vite dev server only outside production so a
  // production deploy never echoes `Access-Control-Allow-Origin:
  // http://localhost:5173` — that would let a malicious page served
  // from localhost call the production API with user cookies.
  const origins = [env.DASHBOARD_URL];
  if (env.NODE_ENV !== "production") {
    origins.push("http://localhost:5173");
  }
  app.use(
    "*",
    cors({
      origin: origins,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Request-Id",
        "X-Rovenue-User-Id",
        "Idempotency-Key",
        "Stripe-Signature",
      ],
      exposeHeaders: [
        "X-Request-Id",
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "X-RateLimit-Reset",
        "X-Rovenue-Experiment",
        "Retry-After",
        "Idempotent-Replay",
      ],
      credentials: true,
      maxAge: 86400,
    }),
  );

  // ── 10. Error handler ─────────────────────────────────────
  app.onError(errorHandler);

  // ── Health (no auth, no rate limit) ───────────────────────
  app.route("/health", healthRoute);

  // ── 4. Global IP rate limit ───────────────────────────────
  // DDoS absorber — sits above all authed paths.
  app.use("*", globalIpRateLimit());

  // ── Route groups ──────────────────────────────────────────
  // Each group mounts its own auth + scoped rate limiters
  // (steps 5–7 in the pipeline diagram).
  app.route("/api/auth", authRoute);
  app.route("/webhooks", webhooksRoute);
  app.route("/v1", v1Route);
  app.route("/dashboard", dashboardRoute);

  return app;
}

export const app = createApp();
