import { Hono } from "hono";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { apiKeyRateLimit } from "../../middleware/rate-limit";
import { configRoute } from "./config";
import { experimentsRoute } from "./experiments";
import { funnelClaimRoute } from "./funnel-claim";
import { meRoute } from "./me";
import { receiptsRoute } from "./receipts";
import { subscribersRoute } from "./subscribers";
import { offeringsRoute } from "./offerings";

// =============================================================
// /v1 route tree
// =============================================================
//
// Chained on a single expression so the inferred Hono<…> type
// carries every sub-path through to AppType at apps/api/src/app.ts.
// apiKeyAuth → apiKeyRateLimit order matters: the rate limit
// bucket is keyed on `apiKeyId`, which apiKeyAuth places on the
// request context first.
//
// Sub-routes that still use the statement-per-handler pattern
// (receiptsRoute, subscribersRoute, offeringsRoute) will have
// their paths in the AppType surface but no body/response
// inference yet — those conversions are tracked as Phase 1
// follow-ups.

export const v1Route = new Hono()
  // Every /v1 endpoint is gated by API key auth. Individual
  // endpoints decide whether they require PUBLIC or SECRET via
  // `requireSecretKey`.
  .use("*", apiKeyAuth("any"))
  // Per-project envelope: 500 req/min per authenticated API key.
  // Sits after apiKeyAuth so the bucket key is the apiKeyId, not
  // the IP.
  .use("*", apiKeyRateLimit())
  .route("/config", configRoute)
  .route("/experiments", experimentsRoute)
  .route("/me", meRoute)
  .route("/receipts", receiptsRoute)
  .route("/subscribers", subscribersRoute)
  .route("/offerings", offeringsRoute)
  // funnelClaimRoute owns `/subscribers/claim-funnel-token` and
  // `/sdk/claim-*`; mounted at root so its handler paths apply
  // verbatim under /v1.
  .route("/", funnelClaimRoute);
