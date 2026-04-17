import { Hono } from "hono";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { apiKeyRateLimit } from "../../middleware/rate-limit";
import { configRoute } from "./config";
import { experimentsRoute } from "./experiments";
import { receiptsRoute } from "./receipts";
import { subscribersRoute } from "./subscribers";
import { productGroupsRoute } from "./product-groups";

export const v1Route = new Hono();

// Every /v1 endpoint is gated by API key auth. The endpoints themselves
// decide whether they require PUBLIC or SECRET via `requireSecretKey`.
v1Route.use("*", apiKeyAuth("any"));

// Per-project envelope: 500 req/min per authenticated API key. Sits
// after apiKeyAuth so the bucket key is the apiKeyId, not the IP.
v1Route.use("*", apiKeyRateLimit());

v1Route.route("/config", configRoute);
v1Route.route("/experiments", experimentsRoute);
v1Route.route("/receipts", receiptsRoute);
v1Route.route("/subscribers", subscribersRoute);
v1Route.route("/product-groups", productGroupsRoute);
