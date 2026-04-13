import { Hono } from "hono";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { receiptsRoute } from "./receipts";
import { subscribersRoute } from "./subscribers";
import { productGroupsRoute } from "./product-groups";

export const v1Route = new Hono();

// Every /v1 endpoint is gated by API key auth. The endpoints themselves
// decide whether they require PUBLIC or SECRET via `requireSecretKey`.
v1Route.use("*", apiKeyAuth("any"));

v1Route.route("/receipts", receiptsRoute);
v1Route.route("/subscribers", subscribersRoute);
v1Route.route("/product-groups", productGroupsRoute);
