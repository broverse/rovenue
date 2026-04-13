import { Hono } from "hono";
import { rateLimit } from "../../middleware/rate-limit";
import { appleWebhookRoute } from "./apple";
import { googleWebhookRoute } from "./google";
import { stripeWebhookRoute } from "./stripe";

export const webhooksRoute = new Hono();

// Cap webhook traffic per source IP to protect the BullMQ queue from
// flood attacks. Store operators will hit this headroom only under DoS.
webhooksRoute.use(
  "*",
  rateLimit({
    windowMs: 60_000,
    max: 300,
    keyPrefix: "rl:webhooks",
  }),
);

webhooksRoute.route("/apple", appleWebhookRoute);
webhooksRoute.route("/google", googleWebhookRoute);
webhooksRoute.route("/stripe", stripeWebhookRoute);
