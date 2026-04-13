import { Hono } from "hono";
import { appleWebhookRoute } from "./apple";

export const webhooksRoute = new Hono();

webhooksRoute.route("/apple", appleWebhookRoute);
