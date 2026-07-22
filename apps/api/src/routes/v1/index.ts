import { Hono } from "hono";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { apiKeyRateLimit } from "../../middleware/rate-limit";
import { configRoute } from "./config";
import { eventsRoute } from "./events";
import { experimentsRoute } from "./experiments";
import { funnelClaimRoute } from "./funnel-claim";
import { meRoute } from "./me";
import { receiptsRoute } from "./receipts";
import { sdkSessionsRoute } from "./sdk-sessions";
import { subscribersRoute } from "./subscribers";
import { identifyRoute } from "./identify";
import { offeringsRoute } from "./offerings";
import { placementsRoute } from "./placements";
import { purchasesRoute } from "./purchases";
import { virtualCurrenciesV1Route } from "./virtual-currencies";

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
  .route("/identify", identifyRoute)
  .route("/events", eventsRoute)
  .route("/experiments", experimentsRoute)
  .route("/me", meRoute)
  .route("/receipts", receiptsRoute)
  .route("/sdk/sessions", sdkSessionsRoute)
  .route("/subscribers", subscribersRoute)
  .route("/offerings", offeringsRoute)
  .route("/placements", placementsRoute)
  .route("/purchases", purchasesRoute)
  .route("/virtual-currencies", virtualCurrenciesV1Route)
  // funnelClaimRoute owns `/subscribers/claim-funnel-token` and
  // `/sdk/claim-*`; mounted at root so its handler paths apply
  // verbatim under /v1.
  .route("/", funnelClaimRoute);
