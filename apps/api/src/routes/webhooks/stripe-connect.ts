import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type Stripe from "stripe";
import { drizzle } from "@rovenue/db";
import { webhookReplayGuard } from "../../middleware/webhook-replay-guard";
import { enqueueWebhookEvent } from "../../services/webhook-processor";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { ok } from "../../lib/response";
import { getConnectPlatformStripe } from "../../lib/stripe-platform";

// =============================================================
// Stripe Connect webhook — one endpoint for every connected account
// =============================================================
//
// Replaces the per-project /webhooks/stripe/:projectId route. The
// project is discovered from `event.account` instead of the URL, so
// customers configure no webhook of their own. Everything downstream
// (claimWebhookEvent idempotency on (STRIPE, event.id), status
// mapping, revenue dedupe keys) is unchanged.

const log = logger.child("route:webhook:stripe-connect");
const TOLERANCE_SECONDS = 300;

export const stripeConnectWebhookRoute = new Hono().post(
  "/connect",
  async (c, next) => {
    // Signature verification is inline rather than a shared middleware
    // because it needs no project lookup — one platform-level secret
    // covers every connected account.
    const signature = c.req.header("stripe-signature");
    if (!signature) {
      throw new HTTPException(401, { message: "Missing Stripe-Signature header" });
    }
    const secret = env.STRIPE_CONNECT_WEBHOOK_SECRET;
    const stripe = getConnectPlatformStripe(true) ?? getConnectPlatformStripe(false);
    if (!secret || !stripe) {
      throw new HTTPException(503, { message: "Stripe Connect is not configured" });
    }

    const rawBody = await c.req.text();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        secret,
        TOLERANCE_SECONDS,
      );
    } catch (err) {
      log.warn("connect webhook signature verification failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      throw new HTTPException(401, { message: "Invalid Stripe signature" });
    }

    c.set("verifiedWebhook", { source: "STRIPE", rawBody, event });
    c.set("webhookEventId", event.id);
    c.set("webhookEventTimestamp", event.created);
    await next();
  },
  webhookReplayGuard({ source: "stripe" }),
  async (c) => {
    const verified = c.get("verifiedWebhook");
    if (!verified || verified.source !== "STRIPE") {
      throw new HTTPException(500, { message: "Verified payload missing" });
    }
    const event = verified.event;

    const accountId = event.account;
    if (!accountId) {
      // Platform-account events belong at /billing/stripe/webhook.
      log.warn("connect webhook received an event with no account", {
        eventId: event.id,
        eventType: event.type,
      });
      throw new HTTPException(400, { message: "Event has no connected account" });
    }

    const connection = await drizzle.stripeConnectionRepo.findActiveByAccountId(
      drizzle.db,
      accountId,
    );
    if (!connection) {
      // Almost always an in-flight event for an account that just
      // disconnected. Ack so Stripe stops retrying.
      log.info("connect webhook for unknown account", {
        accountId,
        eventId: event.id,
      });
      return c.json(ok({ status: "unknown_account" as const }), 202);
    }

    const projectId = connection.projectId;

    // Connection lifecycle events are handled here rather than in the
    // subscription pipeline — they are about the link, not about a
    // customer's purchase.
    if (event.type === "account.application.deauthorized") {
      await drizzle.stripeConnectionRepo.markDisconnected(
        drizzle.db,
        connection.id,
        "stripe_deauthorized",
      );
      log.info("stripe account deauthorized from Stripe's side", { projectId });
      return c.json(ok({ status: "disconnected" as const }), 202);
    }

    if (event.type === "account.updated") {
      const account = event.data.object as Stripe.Account;
      await drizzle.stripeConnectionRepo.updateAccountState(
        drizzle.db,
        connection.id,
        {
          chargesEnabled: Boolean(account.charges_enabled),
          payoutsEnabled: Boolean(account.payouts_enabled),
          capabilities: account.capabilities ?? {},
          country: account.country ?? null,
          defaultCurrency: account.default_currency ?? null,
        },
      );
      return c.json(ok({ status: "account_synced" as const }), 202);
    }

    const job = await enqueueWebhookEvent({
      source: "STRIPE",
      projectId,
      event,
    });

    log.info("connect notification enqueued", {
      projectId,
      accountId,
      eventType: event.type,
      eventId: event.id,
      jobId: job.id,
    });

    return c.json(
      ok({ status: "enqueued" as const, jobId: job.id }),
      202,
    );
  },
);
