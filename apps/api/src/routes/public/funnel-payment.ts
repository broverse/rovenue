import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { ok } from "../../lib/response";
import { chargesEnabled, requireConnectedStripe } from "../../lib/stripe-platform";
import { resolvePricesForPackages } from "../../services/stripe/price-resolver";
import { packagesSchema, parseStoreIds } from "../../lib/offering-hydration";
import type { PresentedContext } from "../../lib/presented-context";

// =============================================================
// Funnel on-page payment
// =============================================================
//
// The browser never says what to charge. It names a package; the server
// resolves that package through the funnel's published paywall to a
// Stripe Price on the connected account and derives the amount from
// there. An `amount` in the request body is ignored — the request body
// schema below doesn't even have a field for it.
//
// Session identity is in the URL path because the public funnel CORS is
// `origin: "*"` and sends no credentials — a cookie would not survive.

const log = logger.child("route:funnel-payment");

const bodySchema = z.object({
  package_identifier: z.string().min(1),
  // zod's built-in `.email()` refuses single-letter TLDs (e.g. rejects
  // "a@b.c" as invalid), which is stricter than this endpoint needs — a
  // funnel visitor's real address should never be rejected on TLD length.
  // This just requires the shape local@domain.tld.
  email: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email"),
});

interface PaywallContext {
  productId: string;
  stripePriceId: string | null;
  presentedContext: PresentedContext;
}

/**
 * Resolve `packageIdentifier` through the funnel's published paywall:
 * load the current version, find its paywall page, load the referenced
 * paywall and its offering, then find the package by identifier. This is
 * what stops a client naming an arbitrary price — the identifier must
 * appear in the offering this funnel actually references, or the
 * request 400s before any Stripe call is made.
 */
async function resolvePaywallContext(
  session: { projectId: string; funnelVersionId: string },
  packageIdentifier: string,
): Promise<PaywallContext> {
  const version = await drizzle.funnelVersionRepo.findById(
    drizzle.db,
    session.funnelVersionId,
  );
  const pages = (version?.pagesJson as Array<Record<string, unknown>>) ?? [];
  const paywallPage = pages.find(
    (p) => p.type === "paywall" && typeof p.paywallId === "string" && p.paywallId,
  ) as { id: string; paywallId: string } | undefined;
  if (!paywallPage) {
    throw new HTTPException(400, { message: "Funnel has no paywall page" });
  }

  const paywall = await drizzle.paywallRepo.findPaywallById(
    drizzle.db,
    session.projectId,
    paywallPage.paywallId,
  );
  if (!paywall) {
    throw new HTTPException(400, { message: "Paywall not found" });
  }

  const offering = await drizzle.offeringRepo.findOfferingById(
    drizzle.db,
    session.projectId,
    paywall.offeringId,
  );
  if (!offering) {
    throw new HTTPException(400, { message: "Offering not found" });
  }

  const packageSlots = packagesSchema.safeParse(offering.packages);
  const slot = packageSlots.success
    ? packageSlots.data.find((p) => p.identifier === packageIdentifier)
    : undefined;
  if (!slot) {
    throw new HTTPException(400, { message: "Package has no usable price" });
  }

  const [product] = await drizzle.offeringRepo.findProductsByIds(
    drizzle.db,
    session.projectId,
    [slot.productId],
  );
  const stripePriceId = product
    ? (parseStoreIds(product.storeIds).stripe ?? null)
    : null;

  return {
    productId: slot.productId,
    stripePriceId,
    presentedContext: {
      // Funnel paywall pages aren't reached via a `placements` row, so
      // there is no real placement id to attribute to — the paywall
      // page itself is the closest analogue.
      placementId: paywallPage.id,
      paywallId: paywall.id,
    },
  };
}

export const funnelPaymentRoute = new Hono().post(
  "/funnel-sessions/:sessionId/payment-intent",
  endpointRateLimit({ name: "funnel:payment-intent", max: 30 }),
  async (c) => {
    const sid = c.req.param("sessionId");
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "Invalid payment request" });
    }
    const { package_identifier: packageIdentifier, email } = parsed.data;

    const session = await drizzle.funnelSessionRepo.findById(drizzle.db, sid);
    if (!session) throw new HTTPException(404, { message: "Session not found" });
    if (session.state !== "in_progress") {
      throw new HTTPException(409, { message: "Session is not payable" });
    }

    if (!(await chargesEnabled(session.projectId))) {
      throw new HTTPException(409, {
        message: JSON.stringify({ code: "STRIPE_NOT_CONNECTED" }),
      });
    }

    const context = await resolvePaywallContext(session, packageIdentifier);
    const prices = await resolvePricesForPackages(session.projectId, [
      { packageIdentifier, stripePriceId: context.stripePriceId },
    ]);
    const price = prices[packageIdentifier];
    if (!price) {
      throw new HTTPException(400, { message: "Package has no usable price" });
    }

    const { account, accountId } = await requireConnectedStripe(session.projectId);
    const customer = await account.customers.create({ email });

    const metadata = {
      rovenue_funnel_session_id: sid,
      rovenue_project_id: session.projectId,
      rovenue_funnel_id: session.funnelId,
      rovenue_presented_context: JSON.stringify(context.presentedContext),
    };

    let clientSecret: string | null;
    let mode: "payment" | "setup";
    let stripeSubscriptionId: string | null = null;
    let stripePaymentIntentId: string | null = null;

    if (price.interval) {
      const subscription = await account.subscriptions.create({
        customer: customer.id,
        items: [{ price: price.priceId }],
        payment_behavior: "default_incomplete",
        ...(price.trialDays ? { trial_period_days: price.trialDays } : {}),
        expand: ["latest_invoice.payment_intent", "pending_setup_intent"],
        metadata,
      });
      stripeSubscriptionId = subscription.id;
      const setup = subscription.pending_setup_intent as
        | { client_secret?: string | null }
        | null;
      const invoice = subscription.latest_invoice as
        | { payment_intent?: { id?: string; client_secret?: string | null } | null }
        | null;
      if (setup?.client_secret) {
        // A trial captures nothing now — the card is only stored.
        clientSecret = setup.client_secret;
        mode = "setup";
      } else {
        clientSecret = invoice?.payment_intent?.client_secret ?? null;
        stripePaymentIntentId = invoice?.payment_intent?.id ?? null;
        mode = "payment";
      }
    } else {
      const intent = await account.paymentIntents.create({
        amount: price.unitAmount,
        currency: price.currency,
        customer: customer.id,
        automatic_payment_methods: { enabled: true },
        metadata,
      });
      stripePaymentIntentId = intent.id;
      clientSecret = intent.client_secret;
      mode = "payment";
    }

    if (!clientSecret) {
      log.error("stripe returned no client secret", { sessionId: sid });
      throw new HTTPException(502, { message: "Stripe did not return a client secret" });
    }

    await drizzle.funnelPurchaseRepo.upsertPending(drizzle.db, {
      sessionId: sid,
      projectId: session.projectId,
      productId: context.productId,
      status: "pending",
      amountCents: price.unitAmount,
      currency: price.currency,
      stripeCustomerId: customer.id,
      stripeSubscriptionId,
      stripePaymentIntentId,
    });

    const publishableKey = env.STRIPE_PLATFORM_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new HTTPException(503, { message: "Stripe Connect is not configured" });
    }

    return c.json(
      ok({
        client_secret: clientSecret,
        mode,
        publishable_key: publishableKey,
        stripe_account: accountId,
      }),
    );
  },
);
