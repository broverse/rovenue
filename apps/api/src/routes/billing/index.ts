import { Hono } from "hono";
import { billingWebhookRoute } from "./webhook";

// =============================================================
// /billing route tree
// =============================================================
//
// Phase 1: only /billing/stripe/webhook is live. The platform Stripe
// webhook is mounted at /billing/stripe/webhook (not /webhooks/stripe
// — that path is for the *customer's* Stripe account). Keeping the
// paths distinct prevents accidental cross-pollination of secrets.

export const billingRoute = new Hono().route(
  "/stripe/webhook",
  billingWebhookRoute,
);
