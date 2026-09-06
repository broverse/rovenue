import { Hono } from "hono";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { apiKeyRateLimit } from "../../middleware/rate-limit";
import { billingPortalRoute } from "./billing-portal";
import { checkoutRoute } from "./checkout";
import { requireMatchingPathKey } from "../../middleware/browser-cors";
import { configRoute } from "./config";
import { dsarRoute } from "./dsar";
import { eventsRoute } from "./events";
import { experimentsRoute } from "./experiments";
import { fontsRoute } from "./fonts";
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
  // Browser surface only (a no-op when there is no :publicKey in the path):
  // the key in the URL must be the key that authenticated. Otherwise a site
  // could pair its OWN allow-listed path key with another project's Bearer
  // key and use it from an origin that project never permitted.
  .use("*", requireMatchingPathKey)
  // Per-project envelope: 500 req/min per authenticated API key.
  // Sits after apiKeyAuth so the bucket key is the apiKeyId, not
  // the IP.
  .use("*", apiKeyRateLimit())
  .route("/billing-portal", billingPortalRoute)
  .route("/checkout", checkoutRoute)
  .route("/config", configRoute)
  .route("/dsar", dsarRoute)
  .route("/identify", identifyRoute)
  .route("/events", eventsRoute)
  .route("/experiments", experimentsRoute)
  .route("/fonts", fontsRoute)
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
