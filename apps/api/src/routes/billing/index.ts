import { Hono } from "hono";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { billingWebhookRoute } from "./webhook";

// =============================================================
// /billing route tree
// =============================================================
//
// Phase 1: only /billing/stripe/webhook is live. The platform Stripe
// webhook is mounted at /billing/stripe/webhook (not /webhooks/stripe
// — that path is for the *customer's* Stripe account). Keeping the
// paths distinct prevents accidental cross-pollination of secrets.
//
// Rate-limit: 200 req/min per first-hop IP — mirrors the per-store
// budget used on /webhooks/*. Stripe's retry cadence is well under
// this; the limit guards against relay abuse, not genuine fan-outs.

export const billingRoute = new Hono()
  .use(
    "/stripe/webhook",
    endpointRateLimit({
      name: "billing:stripe",
      max: 200,
      identify: (c) =>
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown",
    }),
  )
  .route("/stripe/webhook", billingWebhookRoute);
