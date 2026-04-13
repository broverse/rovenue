import { Hono } from "hono";
import { appleWebhookRoute } from "./apple";
import { googleWebhookRoute } from "./google";

export const webhooksRoute = new Hono();

webhooksRoute.route("/apple", appleWebhookRoute);
webhooksRoute.route("/google", googleWebhookRoute);
