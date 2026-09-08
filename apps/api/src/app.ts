import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { ERROR_CODE } from "@rovenue/shared";
import { drizzle } from "@rovenue/db";
import { env } from "./lib/env";
import { fail } from "./lib/response";
import { browserCors } from "./middleware/browser-cors";
import { errorHandler } from "./middleware/error";
import { globalIpRateLimit } from "./middleware/rate-limit";
import { metricsMiddleware } from "./middleware/metrics";
import { requestIdMiddleware } from "./middleware/request-id";
import { requestLoggerMiddleware } from "./middleware/request-logger";
import {
  authRoute,
  billingRoute,
  dashboardRoute,
  healthRoute,
  mcpRoute,
  v1Route,
  webhooksRoute,
} from "./routes";
import { mcpAssetUploadRoute } from "./routes/mcp/uploads";
import { mcpFontUploadRoute } from "./routes/mcp/font-uploads";
import { configStreamRoute } from "./routes/v1/config-stream";
import { paywallPreviewRoute } from "./routes/v1/paywall-preview";
import { publicInvitationsRoute } from "./routes/public/invitations";
import { publicUnsubscribeRoute } from "./routes/public/unsubscribe";
import { publicFunnelsRoute } from "./routes/public/funnels";
import { publicFunnelUniversalRoute } from "./routes/public/funnel-universal";
import { publicFunnelMagicRoute } from "./routes/public/funnel-magic";
import { funnelPaymentRoute } from "./routes/public/funnel-payment";
import { stripeOAuthRoute } from "./routes/stripe-oauth";
import { registerAllIntentHandlers } from "./services/copilot/intent-handlers";

registerAllIntentHandlers();

// =============================================================
// Global request-body ceiling
// =============================================================
//
// Defense-in-depth against oversized/hostile bodies (whole-phase review
// follow-up). 1 MiB comfortably clears every legitimate payload — the
// largest are Apple JWS receipt chains (tens of KB) and builder configs
// (bounded to 500 nodes well below this) — while capping memory per
// request. 413 on breach.
const GLOBAL_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * The upload routes bind their OWN, deliberately larger, `bodyLimit`:
 * assets is 10 MiB image / 50 MiB video / 2 MiB Lottie (three
 * registrations precisely because `maxSize` is fixed per registration —
 * routes/dashboard/assets.ts), fonts is 2 MiB plus a multipart framing
 * allowance. A `*` middleware on the ROOT app runs before a sub-route's
 * own, so a global cap applied to those paths does not additionally
 * protect them — it SHADOWS them, and every upload over 1 MiB dies here
 * with hono's default plain-text "Payload Too Large" instead of ever
 * reaching the route that has a real cap and a real error envelope.
 *
 * That failure also misreports itself in the browser: `bodyLimit`
 * rejects off the Content-Length header before reading a byte, so the
 * response (and the closed socket) arrive while the client is still
 * sending the body — XHR then fires `error`, not `load`, and the
 * dashboard can only say "network error" because it never gets a status
 * at all. So the shadowing was invisible from the client and from the
 * route's own tests, which mount `assetsRoute` on a bare Hono app.
 *
 * Matched paths are exactly the upload endpoints (dashboard assets +
 * fonts, data-import, and the MCP ticketed asset and font uploads),
 * and only for the POST that uploads. The method is part of the match rather than left
 * implicit in "the siblings carry no body": a body-carrying verb added
 * at one of these paths later would otherwise inherit an exemption
 * nobody wrote for it, silently and with no compile-time signal.
 *
 * The data-import upload (routes/dashboard/imports.ts,
 * `IMPORT_MAX_UPLOAD_BYTES` — 2 GiB) joined this exemption list for
 * exactly the same reason as the two above — added here deliberately
 * rather than discovered the hard way again, per
 * tests/global-body-limit.test.ts's own regression history.
 */
const ROUTE_OWNED_BODY_LIMIT_PATH =
  /^\/(?:dashboard\/projects\/[^/]+\/(?:assets\/(?:image|video|lottie)|fonts|imports)|mcp\/uploads\/(?:image|video|lottie)|mcp\/font-uploads\/font)$/;

const globalBodyLimit = bodyLimit({
  maxSize: GLOBAL_BODY_LIMIT_BYTES,
  // Hono's default `onError` throws an HTTPException whose text lives in
  // a `res` that `errorHandler` replaces with its own envelope, so a
  // breach reached the client as HTTP_ERROR with an empty message. Every
  // other rejection in this codebase is a `{ error: { code, message } }`
  // a caller can act on; this one is too.
  onError: (c) =>
    c.json(
      fail(
        ERROR_CODE.PAYLOAD_TOO_LARGE,
        `Request body exceeds the ${GLOBAL_BODY_LIMIT_BYTES}-byte limit`,
      ),
      413,
    ),
});

const scopedGlobalBodyLimit: MiddlewareHandler = (c, next) =>
  c.req.method === "POST" && ROUTE_OWNED_BODY_LIMIT_PATH.test(c.req.path)
    ? next()
    : globalBodyLimit(c, next);

// =============================================================
// Hono app + RPC-ready AppType export
// =============================================================
//
// Every `.use()` / `.route()` call is chained on a single expression
// so Hono's type system can accumulate the full path surface on the
// resulting `Hono<...>` type. That lets consumers do:
//
//   import type { AppType } from "@rovenue/api";
//   const client = hc<AppType>("https://api.rovenue.io");
//   const res = await client.v1.config.$get();
//
// Sub-route files (routes/v1/*.ts, routes/dashboard/*.ts) still use
// the statement-per-handler pattern — Phase 1 of the Hono RPC
// cutover converts them to the same chained form so request/response
// inference extends past the top-level path prefix.

// =============================================================
// Browser-surface origin lookup
// =============================================================
//
// Resolves the origins a public key permits, for the CORS preflight that
// cannot authenticate. An unknown key yields an empty list, which refuses
// every origin — the same outcome as a key that exists but was never enabled
// for browser use, so a probe cannot distinguish the two.
//
// This is an unauthenticated read: a preflight costs one
// `findApiKeyByPublic`. The global IP rate limit is registered BEFORE the
// middleware that calls this, which is load-bearing rather than incidental —
// hono's cors answers OPTIONS without calling next(), so a limiter registered
// after it would never run for a preflight at all. The query is a single row
// by unique index; if it ever becomes a hot path it wants the same caching the
// authenticated key lookup gets.
async function lookupAllowedOrigins(publicKey: string): Promise<string[]> {
  const record = await drizzle.apiKeyRepo.findApiKeyByPublic(
    drizzle.db,
    publicKey,
  );
  if (!record || record.revokedAt !== null) return [];
  return record.allowedOrigins;
}

/**
 * Mount prefix for the browser surface.
 *
 * The public key sits in the path because a CORS preflight carries no
 * `Authorization` header — it is the only project reference a preflight can
 * carry. Declared once: the dashboard CORS skips this prefix and the per-key
 * CORS attaches to it, and those two must not be able to disagree.
 */
const BROWSER_SURFACE_PREFIX = "/v1/web/";

export function createApp() {
  // Allow the local Vite dev server only outside production so a
  // production deploy never echoes `Access-Control-Allow-Origin:
  // http://localhost:5173` — that would let a malicious page served
  // from localhost call the production API with user cookies.
  const origins = [env.DASHBOARD_URL];
  if (env.NODE_ENV !== "production") {
    // Vite picks the next free port (5174, 5175, …) when 5173 is in use,
    // so allow the small fallback range instead of hard-coding 5173.
    origins.push(
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
    );
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
  // The dashboard's CORS. Applied to everything EXCEPT the browser surface,
  // for two reasons, the second of which is a security one:
  //
  //   - hono's cors answers an OPTIONS request itself without calling
  //     `next()`, so a global handler would reply to every /v1/web preflight
  //     with the dashboard's origin list and the per-key middleware would
  //     never run at all;
  //   - it sets `Access-Control-Allow-Credentials: true` unconditionally, and
  //     hono sets that header regardless of whether the origin matched. On the
  //     browser surface that lands on top of a reflected customer origin —
  //     precisely the reflected-origin-plus-credentials pairing browserCors
  //     sets `credentials: false` to avoid.
  const dashboardCors = cors({
    origin: origins,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
  });

  const app = new Hono()
    .use("*", requestIdMiddleware)
    .use("*", requestLoggerMiddleware)
    .use("*", scopedGlobalBodyLimit)
    .use("*", (c, next) =>
      c.req.path.startsWith(BROWSER_SURFACE_PREFIX)
        ? next()
        : dashboardCors(c, next),
    )
    .route("/health", healthRoute)
    .use("*", globalIpRateLimit())
    // Registered AFTER the rate limiter, deliberately. A preflight costs one
    // unauthenticated `findApiKeyByPublic`, and hono's cors answers OPTIONS
    // without calling next() — so anything registered later never runs for a
    // preflight at all. Behind the limiter, a flood of preflights carrying
    // random keys is throttled like any other traffic.
    .use(`${BROWSER_SURFACE_PREFIX}:publicKey/*`, browserCors(lookupAllowedOrigins))
    .use("*", metricsMiddleware)
    .route("/api/auth", authRoute)
    .route("/billing", billingRoute)
    .route("/webhooks", webhooksRoute)
    // paywallPreviewRoute MUST be registered before `.route("/v1", v1Route)`
    // below. Hono composes middleware across sub-apps in REGISTRATION
    // order, not by mount-path specificity: v1Route's `.use("*",
    // apiKeyAuth("any"))` becomes a `/v1/*` wildcard in the parent
    // router, and it would shadow this route's exact
    // `/v1/preview/paywalls/:token` path (throwing 401 before the
    // handler ever runs) if v1Route were registered first — verified
    // empirically against the installed hono version. Registering the
    // exact-path route first means it's matched (and terminates,
    // without calling `next()`) before the wildcard auth is ever
    // reached. This does not affect any other /v1/* path: only this
    // route's own exact path is registered ahead of the wildcard.
    .route("/", paywallPreviewRoute)
    // The browser surface. Same v1 router, reached under a prefix that
    // carries the public key, because a CORS preflight is an OPTIONS request
    // with NO Authorization header — the project cannot be resolved from the
    // Bearer key at the moment the origin must be decided.
    //
    // Registered BEFORE `/v1` for the same reason paywallPreviewRoute is:
    // v1Route's `.use("*", apiKeyAuth("any"))` becomes a `/v1/*` wildcard in
    // this parent router, and Hono composes by registration order rather
    // than mount-path specificity. Registered after, that wildcard would run
    // auth on `/v1/web/...` and 401 the preflight before CORS ever answered.
    .route("/v1/web/:publicKey", v1Route)
    .route("/v1", v1Route)
    .route("/", configStreamRoute)
    .route("/invitations", publicInvitationsRoute)
    .route("/unsubscribe", publicUnsubscribeRoute)
    .route("/public", publicFunnelsRoute)
    .route("/public", funnelPaymentRoute)
    .route("/public/magic", publicFunnelMagicRoute)
    .route("/universal", publicFunnelUniversalRoute)
    .route("/stripe/oauth", stripeOAuthRoute)
    .route("/dashboard", dashboardRoute)
    // The MCP ticketed uploads. Registered BEFORE `.route("/mcp",
    // mcpRoute): Hono composes sub-apps in registration order, and
    // mcpRoute's `.all("*")` protocol handler would otherwise swallow
    // these POSTs before these routes ever ran.
    .route("/mcp/uploads", mcpAssetUploadRoute)
    .route("/mcp/font-uploads", mcpFontUploadRoute)
    .route("/mcp", mcpRoute);

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
