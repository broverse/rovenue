import { Hono } from "hono";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { appleWebhookRoute } from "./apple";
import { googleWebhookRoute } from "./google";
import { stripeWebhookRoute } from "./stripe";

export const webhooksRoute = new Hono();

// Per-store webhook throttle: 200 req/min scoped by store + the
// first hop IP (proxy / store gateway). Keeps burst traffic off the
// BullMQ queue without punishing a legitimate store fan-out. Each
// store mounts its own limiter so a misbehaving Stripe relay can't
// eat Apple's budget.
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

webhooksRoute.use("/apple/*", storeLimit("apple"));
webhooksRoute.use("/google/*", storeLimit("google"));
webhooksRoute.use("/stripe/*", storeLimit("stripe"));

webhooksRoute.route("/apple", appleWebhookRoute);
webhooksRoute.route("/google", googleWebhookRoute);
webhooksRoute.route("/stripe", stripeWebhookRoute);
