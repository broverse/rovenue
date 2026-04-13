import { Hono } from "hono";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { rateLimit } from "../../middleware/rate-limit";
import { receiptsRoute } from "./receipts";
import { subscribersRoute } from "./subscribers";
import { productGroupsRoute } from "./product-groups";

export const v1Route = new Hono();

// Rate limit every /v1 call by authenticated API key — falling back to
// x-forwarded-for when the auth middleware hasn't run yet.
v1Route.use(
  "*",
  rateLimit({
    windowMs: 60_000,
    max: 600,
    keyPrefix: "rl:v1",
    identify: (c) => c.get("project")?.apiKeyId ?? "",
  }),
);

// Every /v1 endpoint is gated by API key auth. The endpoints themselves
// decide whether they require PUBLIC or SECRET via `requireSecretKey`.
v1Route.use("*", apiKeyAuth("any"));

v1Route.route("/receipts", receiptsRoute);
v1Route.route("/subscribers", subscribersRoute);
v1Route.route("/product-groups", productGroupsRoute);
