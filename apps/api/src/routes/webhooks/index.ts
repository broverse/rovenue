import { Hono } from "hono";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { appleWebhookRoute } from "./apple";
import { googleWebhookRoute } from "./google";
import { stripeWebhookRoute } from "./stripe";

// =============================================================
// /webhooks route tree
// =============================================================
//
// Per-store throttle: 200 req/min scoped by store + the first-hop
// IP (proxy / store gateway). Keeps burst traffic off the BullMQ
// queue without punishing legitimate store fan-outs. Each store
// mounts its own limiter so a misbehaving Stripe relay can't eat
// Apple's budget.
//
// Chained on a single expression so the inferred Hono<…> type
// carries `/webhooks/{apple,google,stripe}/:projectId` up to
// AppType — webhooks have no RPC consumers today but keeping the
// shape consistent means future introspection tools don't care.

function storeLimit(storeName: string) {
  return endpointRateLimit({
    name: `webhook:${storeName}`,
    max: 200,
    identify: (c) => {
      const forwarded = c.req
        .header("x-forwarded-for")
        ?.split(",")[0]
        ?.trim();
      return `${storeName}:${forwarded ?? "unknown"}`;
    },
  });
}

export const webhooksRoute = new Hono()
  .use("/apple/*", storeLimit("apple"))
  .use("/google/*", storeLimit("google"))
  .use("/stripe/*", storeLimit("stripe"))
  .route("/apple", appleWebhookRoute)
  .route("/google", googleWebhookRoute)
  .route("/stripe", stripeWebhookRoute);
