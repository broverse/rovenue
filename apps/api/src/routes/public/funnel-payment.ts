import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { ok } from "../../lib/response";
import { withLock } from "../../lib/redis-lock";
import { chargesEnabled, requireConnectedStripe } from "../../lib/stripe-platform";
import { resolvePricesForPackages } from "../../services/stripe/price-resolver";
import { packagesSchema, parseStoreIds } from "../../lib/offering-hydration";
import type { AccountScopedStripe } from "../../lib/stripe-account-scoped";
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
  email: z.string().email(),
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
    // Distinct from the "no usable price" 400 below: this one means the
    // client named a package the funnel's offering does not contain,
    // which is the smuggling attempt, not a configuration gap.
    throw new HTTPException(400, {
      message: "Package is not in this funnel's offering",
    });
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

// A subscription created `default_incomplete` and never confirmed sits at
// `incomplete`. Every other status means money moved or is committed —
// `active`, `trialing`, `past_due` — and Stripe will cancel those just as
// happily, without refunding. So this is an allow-list of one.
const SUBSCRIPTION_CANCELLABLE = new Set(["incomplete"]);

// Statuses that need no cleanup and no follow-up: the object is already
// dead, so it is neither cancellable nor orphaned.
const SUBSCRIPTION_SETTLED = new Set(["canceled", "incomplete_expired"]);

// An unconfirmed PaymentIntent. Stripe refuses to cancel a `succeeded`
// or `processing` one anyway; checking first is about not making a call
// that is guaranteed to fail and log noise over item 2's real errors.
const PAYMENT_INTENT_CANCELLABLE = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

const PAYMENT_INTENT_SETTLED = new Set(["canceled"]);

/**
 * Cancel what a previous attempt on this session left on Stripe.
 *
 * A visitor who changes package posts here again, and `upsertPending`
 * overwrites the single row for the session — so without this the old
 * `default_incomplete` subscription or PaymentIntent stays confirmable
 * against a row that now records a different product and amount.
 *
 * Each object is retrieved before it is cancelled. The row's own
 * `status === "pending"` is not evidence that the object is still unpaid:
 * it is Task 7's webhook that flips it, and between the browser
 * confirming and that webhook landing (retry lag, plus the async
 * authentication `automatic_payment_methods` allows) the subscription is
 * `active` on Stripe while the row still reads `pending`. Cancelling
 * there destroys a subscription the visitor has already paid for, with no
 * refund — and this endpoint is anonymous, so anyone with the session id
 * could drive it.
 *
 * Best-effort by design for the request: the new client secret is already
 * valid and the visitor is waiting on it, so a cleanup failure never
 * fails the payment. It must still be *recoverable*, so every superseded
 * id that was not confirmed cancelled is returned for the caller to
 * record on the row — otherwise a still-confirmable object ends up
 * referenced by no row anywhere, and a later charge has no purchase
 * record, no entitlement, and nothing for Task 8's webhook to match.
 */
async function cancelSuperseded(
  account: AccountScopedStripe,
  previous: {
    stripeSubscriptionId: string | null;
    stripePaymentIntentId: string | null;
  },
  next: { subscriptionId: string | null; paymentIntentId: string | null },
  sessionId: string,
): Promise<string[]> {
  const staleSubscription =
    previous.stripeSubscriptionId &&
    previous.stripeSubscriptionId !== next.subscriptionId
      ? previous.stripeSubscriptionId
      : null;
  const stalePaymentIntent =
    previous.stripePaymentIntentId &&
    previous.stripePaymentIntentId !== next.paymentIntentId
      ? previous.stripePaymentIntentId
      : null;

  const orphaned: string[] = [];
  let subscriptionCancelled = false;

  if (staleSubscription) {
    try {
      const subscription = await account.subscriptions.retrieve(staleSubscription);
      if (SUBSCRIPTION_CANCELLABLE.has(subscription.status)) {
        await account.subscriptions.cancel(staleSubscription);
        subscriptionCancelled = true;
      } else {
        // Normal outcome, not a failure: the visitor confirmed before
        // re-posting, or the object had already lapsed.
        log.info("superseded subscription is no longer cancellable", {
          sessionId,
          subscriptionId: staleSubscription,
          status: subscription.status,
        });
        if (!SUBSCRIPTION_SETTLED.has(subscription.status)) {
          orphaned.push(staleSubscription);
        }
      }
    } catch (err) {
      // `error`, not `warn`: this is the case a human has to resolve.
      log.error("failed to cancel superseded subscription", {
        sessionId,
        subscriptionId: staleSubscription,
        error: err instanceof Error ? err.message : String(err),
      });
      orphaned.push(staleSubscription);
    }
  }

  // Cancelling an incomplete subscription voids its open invoice, which
  // cancels that invoice's PaymentIntent — which is the very id this row
  // holds. Retrying it here would throw on an already-cancelled object
  // and log a failure for the most ordinary case there is (a visitor
  // changing package), drowning out the real errors above.
  if (stalePaymentIntent && !subscriptionCancelled) {
    try {
      const intent = await account.paymentIntents.retrieve(stalePaymentIntent);
      if (PAYMENT_INTENT_CANCELLABLE.has(intent.status)) {
        await account.paymentIntents.cancel(stalePaymentIntent);
      } else {
        log.info("superseded payment intent is no longer cancellable", {
          sessionId,
          paymentIntentId: stalePaymentIntent,
          status: intent.status,
        });
        if (!PAYMENT_INTENT_SETTLED.has(intent.status)) {
          orphaned.push(stalePaymentIntent);
        }
      }
    } catch (err) {
      log.error("failed to cancel superseded payment intent", {
        sessionId,
        paymentIntentId: stalePaymentIntent,
        error: err instanceof Error ? err.message : String(err),
      });
      orphaned.push(stalePaymentIntent);
    }
  }

  return orphaned;
}

/**
 * Merge newly orphaned ids into the row's existing `rawPayload`, keeping
 * anything a previous attempt recorded. Never overwrite the array: each
 * entry is a Stripe object nobody else references, and dropping one loses
 * the only pointer to it.
 */
function mergeOrphaned(
  rawPayload: unknown,
  orphaned: string[],
): Record<string, unknown> {
  const base =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {};
  const existing = Array.isArray(base.orphaned_stripe_objects)
    ? base.orphaned_stripe_objects.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  const merged = [...existing];
  for (const id of orphaned) if (!merged.includes(id)) merged.push(id);
  return { ...base, orphaned_stripe_objects: merged };
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

    // Checked before anything exists on Stripe. Left at the end it would
    // 503 only after a Customer, a subscription/PaymentIntent and a
    // purchase row had already been created and orphaned.
    const publishableKey = env.STRIPE_PLATFORM_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new HTTPException(503, { message: "Stripe Connect is not configured" });
    }

    const { account, accountId } = await requireConnectedStripe(session.projectId);

    // Everything from the `findBySession` read to the `upsertPending`
    // write is one read-modify-write with Stripe round-trips in the
    // middle. Two concurrent POSTs for this session would otherwise both
    // read the same `existing`, both create on Stripe, both try to cancel
    // the same old object and both upsert — last write wins, and the
    // loser's live confirmable intent is stranded, which is exactly the
    // state cancelSuperseded exists to prevent.
    const result = await withLock(`funnel:payment:${sid}`, 30_000, async () => {
      // A repeat POST for this session is a visitor changing package.
      // Reuse the Customer that attempt created rather than stranding it —
      // but only while the row is still pending; a paid row is not ours to
      // touch. `findBySession` filters on sessionId alone, so the project
      // has to be checked here.
      const existing = await drizzle.funnelPurchaseRepo.findBySession(drizzle.db, sid);
      const superseded =
        existing &&
        existing.status === "pending" &&
        existing.projectId === session.projectId
          ? existing
          : null;

      // One call does two jobs. It pushes the freshly submitted address
      // onto the reused Customer — a visitor who mistyped and re-submits
      // must be able to correct where the receipt goes, and that address
      // is the whole reason the email is validated strictly. And it proves
      // the Customer still exists on the account connected *now*: if the
      // project reconnected a different Stripe account between attempts
      // the id is meaningless there, and this fails cleanly instead of
      // `subscriptions.create` failing with "No such customer" and leaving
      // the visitor unable to pay at all until the row is cleared.
      let customerId: string | null = null;
      if (superseded?.stripeCustomerId) {
        try {
          await account.customers.update(superseded.stripeCustomerId, { email });
          customerId = superseded.stripeCustomerId;
        } catch (err) {
          // Belongs to another account, or was deleted — either way it
          // must not be reused. Creating a fresh Customer is what this
          // path did before the reuse optimisation, so the fallback
          // cannot make anything worse.
          log.warn("could not reuse the previous attempt's customer", {
            sessionId: sid,
            customerId: superseded.stripeCustomerId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!customerId) {
        customerId = (await account.customers.create({ email })).id;
      }

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
          customer: customerId,
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
          customer: customerId,
          automatic_payment_methods: { enabled: true },
          metadata,
        });
        stripePaymentIntentId = intent.id;
        clientSecret = intent.client_secret;
        mode = "payment";
      }

      if (!clientSecret) {
        log.error("stripe returned no client secret", { sessionId: sid });
        throw new HTTPException(502, {
          message: "Stripe did not return a client secret",
        });
      }

      // The new secret is valid from here on, so the old one must stop
      // being confirmable before the row that describes it is overwritten.
      const orphaned = superseded
        ? await cancelSuperseded(
            account,
            superseded,
            {
              subscriptionId: stripeSubscriptionId,
              paymentIntentId: stripePaymentIntentId,
            },
            sid,
          )
        : [];

      await drizzle.funnelPurchaseRepo.upsertPending(drizzle.db, {
        sessionId: sid,
        projectId: session.projectId,
        productId: context.productId,
        amountCents: price.unitAmount,
        currency: price.currency,
        stripeCustomerId: customerId,
        stripeSubscriptionId,
        stripePaymentIntentId,
        // Written only when there is something to record, so the column
        // keeps whatever it already held on the ordinary path.
        ...(orphaned.length > 0
          ? { rawPayload: mergeOrphaned(superseded?.rawPayload, orphaned) }
          : {}),
      });

      return {
        client_secret: clientSecret,
        mode,
        publishable_key: publishableKey,
        stripe_account: accountId,
      };
    });

    if (result === null) {
      throw new HTTPException(409, {
        message: "A payment attempt for this session is already in flight",
      });
    }

    return c.json(ok(result));
  },
);
