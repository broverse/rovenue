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
import { configStreamRoute } from "./routes/v1/config-stream";

// =============================================================
// Hono app + RPC-ready AppType export
// =============================================================
//
// Every `.use()` / `.route()` call is chained on a single expression
// so Hono's type system can accumulate the full path surface on the
// resulting `Hono<...>` type. That lets consumers do:
//
//   import type { AppType } from "@rovenue/api";
//   const client = hc<AppType>("https://api.rovenue.com");
//   const res = await client.v1.config.$get();
//
// Sub-route files (routes/v1/*.ts, routes/dashboard/*.ts) still use
// the statement-per-handler pattern — Phase 1 of the Hono RPC
// cutover converts them to the same chained form so request/response
// inference extends past the top-level path prefix.

export function createApp() {
  // Allow the local Vite dev server only outside production so a
  // production deploy never echoes `Access-Control-Allow-Origin:
  // http://localhost:5173` — that would let a malicious page served
  // from localhost call the production API with user cookies.
  const origins = [env.DASHBOARD_URL];
  if (env.NODE_ENV !== "production") {
    origins.push("http://localhost:5173");
  }

  // ── Pipeline ──────────────────────────────────────────────
  // 1. Request ID (scopes the logger's AsyncLocalStorage)
  // 2. Request logger
  // 3. CORS (dashboard origin + dev server)
  // -> /health mounts here with no rate limit (liveness probes)
  // 4. Global IP rate limit (DDoS absorber)
  // -> /api/auth, /webhooks, /v1, /dashboard each own their own
  //    auth + scoped rate limiters.
  //
  // Error handler is attached after the chain — `onError` returns
  // Hono but doesn't contribute route types, so we apply it last to
  // keep the chain's inferred AppType focused on actual endpoints.
  const app = new Hono()
    .use("*", requestIdMiddleware)
    .use("*", requestLoggerMiddleware)
    .use(
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
    )
    .route("/health", healthRoute)
    .use("*", globalIpRateLimit())
    .route("/api/auth", authRoute)
    .route("/webhooks", webhooksRoute)
    .route("/v1", v1Route)
    .route("/", configStreamRoute)
    .route("/dashboard", dashboardRoute);

  app.onError(errorHandler);

  return app;
}

export const app = createApp();

/**
 * RPC type bridge. Dashboard and SDK import this (type-only) to
 * instantiate `hc<AppType>()` with full path + method inference.
 * Never `export const` the client here — it is built per-consumer
 * with their own baseUrl, auth headers, and fetch polyfill.
 */
export type AppType = typeof app;
