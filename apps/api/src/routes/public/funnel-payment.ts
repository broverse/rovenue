import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { ok } from "../../lib/response";
import { LockUnavailableError, withLock } from "../../lib/redis-lock";
import { chargesEnabled, requireConnectedStripe } from "../../lib/stripe-platform";
import { resolvePricesForPackages } from "../../services/stripe/price-resolver";
import { buildClaimLinks } from "../../services/funnel/claim-links";
import { completeFunnelPurchase } from "../../services/funnel/complete-purchase";
import { hashEmail } from "../../services/funnel/token";
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

// Returned by the locked section when it finds it no longer holds the
// lock. A symbol so it can never collide with a value the section
// legitimately produces, and never with `withLock`'s own `null`.
const LOCK_LOST = Symbol("funnel-payment-lock-lost");

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

/**
 * Is a superseded subscription still safe to cancel?
 *
 * The rule this must never break: Stripe cancels a paid subscription just
 * as happily as an unpaid one, and does not refund. So the answer is yes
 * only where nothing has actually been paid, and an unreadable answer
 * counts as no.
 *
 * - `incomplete` — created `default_incomplete` and never confirmed.
 * - `trialing` — the trial path creates with `default_incomplete` *and*
 *   `trial_period_days`, and nothing is due, so Stripe never parks it at
 *   `incomplete`; it goes straight to `trialing`. (This route's own
 *   reliance on `pending_setup_intent` is the proof — that field exists
 *   precisely because there is nothing to charge.) A trial is the common
 *   funnel case, so excluding it would leave the first subscription live
 *   on the customer the second attempt reuses, free to bill at trial end
 *   once a payment method lands on that shared customer. Cancellable only
 *   while its invoice shows nothing collected: a `trialing` subscription
 *   whose latest invoice was paid has taken real money.
 *
 * Everything else — `active`, `past_due`, `unpaid`, or a `latest_invoice`
 * that came back as a bare id instead of the expanded object — is left
 * alone. Reading the trial case requires `expand: ["latest_invoice"]` on
 * the retrieve; without it this returns false and cancels nothing.
 */
function isSubscriptionCancellable(subscription: {
  status: string;
  latest_invoice?: unknown;
}): boolean {
  if (subscription.status === "incomplete") return true;
  if (subscription.status !== "trialing") return false;

  const invoice = subscription.latest_invoice;
  // No invoice at all: nothing was ever billed, so nothing was paid.
  if (invoice === null || invoice === undefined) return true;
  if (typeof invoice === "object" && "amount_paid" in invoice) {
    return (invoice as { amount_paid?: unknown }).amount_paid === 0;
  }
  // An unexpanded id, or a shape we do not recognise. We cannot prove it
  // is unpaid, so we must not cancel it.
  return false;
}

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

// Only `canceled` is genuinely settled. A `succeeded` or `processing`
// intent therefore lands in the orphan list, which means "orphaned" covers
// two different situations: an object we could not kill, and an object
// that has already taken the visitor's money against a row that is about
// to describe a different product and amount. Both need a human and the
// second one needs one urgently — so they deliberately share a list, but a
// reader of that list must not assume every entry is merely stranded.
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
      const subscription = await account.subscriptions.retrieve(
        staleSubscription,
        // The trial case is decided on what the invoice collected, so the
        // invoice has to come back inline rather than as a bare id.
        { expand: ["latest_invoice"] },
      );
      if (isSubscriptionCancellable(subscription)) {
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
 * Cancel the Stripe objects *this request* created, moments ago, after it
 * discovered it no longer holds the lock.
 *
 * Abandoning them is not harmless. A `default_incomplete` subscription
 * created here is live on the connected account, usually on the very
 * Customer the request that won the lock is also building on — and once a
 * payment method lands on that shared customer, an abandoned trial bills
 * at period end. That is the same hazard `isSubscriptionCancellable`
 * exists to prevent, arriving by a different door.
 *
 * Why this needs no such guard, and must not borrow it: that guard answers
 * "has someone already paid for this object?", which is a real question
 * about a *previous attempt's* object and an unreadable answer there means
 * do not touch it. It does not arise here. These ids came back from
 * `subscriptions.create` / `paymentIntents.create` a few lines above; the
 * request is about to 409, so their `client_secret` was returned to
 * nobody; and no row references them, so no other request can reach them.
 * There is no way for one of these to be a payment that should stand.
 *
 * The Customer is deliberately untouched. On a repeat POST it is the
 * customer this request *reused*, which the lock holder is also using, so
 * it is the one object here that is not exclusively ours. An unreferenced
 * Customer bills nothing on its own.
 *
 * Best-effort: this request is failing either way, and a cancel that
 * fails leaves an id in the log for a human rather than a broken response
 * for the visitor.
 */
async function cancelOwnObjects(
  account: AccountScopedStripe,
  created: { subscriptionId: string | null; paymentIntentId: string | null },
  sessionId: string,
): Promise<void> {
  let subscriptionCancelled = false;

  if (created.subscriptionId) {
    try {
      await account.subscriptions.cancel(created.subscriptionId);
      subscriptionCancelled = true;
    } catch (err) {
      log.error("could not cancel the subscription this request created", {
        sessionId,
        subscriptionId: created.subscriptionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Cancelling the subscription voids its open invoice, which cancels
  // that invoice's PaymentIntent — the very id held here. Same reason as
  // in `cancelSuperseded`: retrying would throw on a dead object.
  if (created.paymentIntentId && !subscriptionCancelled) {
    try {
      await account.paymentIntents.cancel(created.paymentIntentId);
    } catch (err) {
      log.error("could not cancel the payment intent this request created", {
        sessionId,
        paymentIntentId: created.paymentIntentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
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

/**
 * Has the money actually moved?
 *
 * The browser calls `/confirm` after `stripe.confirmPayment` resolves,
 * but the endpoint is anonymous and takes nothing but a session id, so
 * the client's word is not evidence of anything. Stripe is asked instead.
 *
 * The subscription is authoritative whenever there is one: it is the
 * object that decides whether the buyer has access, and a recurring
 * purchase carries both ids. `trialing` counts — the trial path
 * deliberately captures nothing now, so waiting for a payment would mean
 * never issuing a token for a free trial at all.
 */
async function isSettled(
  account: AccountScopedStripe,
  purchase: {
    stripeSubscriptionId: string | null;
    stripePaymentIntentId: string | null;
  },
): Promise<boolean> {
  if (purchase.stripeSubscriptionId) {
    const subscription = await account.subscriptions.retrieve(
      purchase.stripeSubscriptionId,
    );
    return subscription.status === "active" || subscription.status === "trialing";
  }
  if (purchase.stripePaymentIntentId) {
    const intent = await account.paymentIntents.retrieve(
      purchase.stripePaymentIntentId,
    );
    return intent.status === "succeeded";
  }
  // A row with neither id records nothing that could have settled.
  return false;
}

export const funnelPaymentRoute = new Hono()
  .post(
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
    //
    // 60s rather than 30s is defence in depth only. The shared Connect
    // client sets no per-request timeout, so the SDK default is 80s plus
    // retries and this section makes up to six Stripe round-trips — no
    // fixed TTL survives that worst case. The ownership fence below, not
    // the number, is what makes this correct.
    const result = await withLock(`funnel:payment:${sid}`, 60_000, async (lock) => {
      // A repeat POST for this session is a visitor changing package.
      // Reuse the Customer that attempt created rather than stranding it —
      // but only while the row is still pending; a paid row is not ours to
      // touch. `findBySession` filters on sessionId alone, so the project
      // has to be checked here.
      const existing = await drizzle.funnelPurchaseRepo.findBySession(drizzle.db, sid);

      // A row that is not pending records a payment that actually
      // happened. Protecting it from reuse and from cancellation is not
      // enough on its own: `upsertPending` conflicts on `sessionId` and
      // forces `status: "pending"`, so driving this endpoint again would
      // reset that row and replace its Stripe ids, erasing the only
      // record of the charge and leaving no orphan entry behind. A paid
      // row is terminal for this endpoint — it is never re-driven, and
      // the visitor is told to stop rather than silently having the
      // record of what they bought overwritten.
      if (
        existing &&
        existing.projectId === session.projectId &&
        existing.status !== "pending"
      ) {
        throw new HTTPException(409, {
          message: JSON.stringify({
            code: "PAYMENT_ALREADY_RECORDED",
            message: "This session's payment is already recorded",
          }),
        });
      }

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

      // Everything above this line is additive: a Customer, and one
      // unconfirmed Stripe object nobody else references. Everything below
      // it destroys state — it cancels another attempt's objects and
      // overwrites the single row for this session. If our TTL expired
      // while we were waiting on Stripe, another request now holds the key
      // and is doing that same work from a *newer* `existing` read, so
      // continuing would cancel what it just created and overwrite its row
      // with our stale ids: precisely the race the lock exists to close.
      if (!(await lock.stillHeld())) {
        // There is nothing we can safely *write*. `upsertPending` is the
        // only write this endpoint has and it would clobber the current
        // holder's row, which is the thing being avoided — so the ids go
        // to the log instead, at error level.
        log.error("lock lost mid-flight; cancelling the stripe objects we created", {
          sessionId: sid,
          customerId,
          subscriptionId: stripeSubscriptionId,
          paymentIntentId: stripePaymentIntentId,
        });
        // Logging them is not enough on its own: an abandoned
        // `default_incomplete` subscription is live on a customer the
        // lock holder is usually sharing, and an abandoned trial bills at
        // period end. These two ids are exclusively ours and unreachable
        // by anyone else, so cancelling them cannot destroy a payment
        // that should stand — see `cancelOwnObjects`.
        await cancelOwnObjects(
          account,
          {
            subscriptionId: stripeSubscriptionId,
            paymentIntentId: stripePaymentIntentId,
          },
          sid,
        );
        return LOCK_LOST;
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
        // This is the only moment the buyer's address is in our hands:
        // `completeFunnelPurchase` is handed a session id and Stripe ids
        // and nothing else, and the row it reads has no email. Parking
        // the digest here lets that transaction copy it onto the claim
        // token without a Stripe round-trip inside a database
        // transaction — and the token's copy is what makes the
        // magic-link recovery path reachable for a buyer who installs
        // days later on another device with no session id.
        //
        // The digest only. `hashEmail` is the same derivation
        // `/v1/sdk/claim-via-email` looks up by, imported from the same
        // module so the two cannot drift; storing the plaintext would
        // defeat the point of the token table holding a hash.
        //
        // Re-derived on every attempt rather than carried from the
        // superseded row: a visitor who mistyped their address and
        // re-submits is correcting where the magic link goes, exactly as
        // `customers.update` above corrects where the receipt goes.
        emailHash: hashEmail(email),
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
    }).catch((err: unknown) => {
      // Failing closed on a Redis outage is deliberate and stays — this
      // endpoint strands live payment objects when it runs unserialized.
      // But a transient dependency being down is not an unexpected
      // internal bug, and presenting it as one (500 "unhandled error")
      // tells the visitor to give up and the operator to look in the
      // wrong place. Only the *acquisition* failure is remapped here;
      // anything `fn` threw keeps its own status.
      if (err instanceof LockUnavailableError) {
        log.error("could not take the funnel payment lock", {
          sessionId: sid,
          error: err.message,
        });
        throw new HTTPException(503, {
          message: JSON.stringify({
            code: "PAYMENT_TEMPORARILY_UNAVAILABLE",
            message: "Payment is temporarily unavailable, please try again",
          }),
        });
      }
      throw err;
    });

    // `null` = never acquired; LOCK_LOST = acquired, but expired before
    // the work was safe to commit. Same answer either way: another attempt
    // for this session is in flight, retry. The body carries a code
    // because the neighbouring 409s do, and a browser has no other way to
    // tell "retry in a moment" apart from "this session is done".
    if (result === null || result === LOCK_LOST) {
      throw new HTTPException(409, {
        message: JSON.stringify({
          code: "PAYMENT_IN_FLIGHT",
          message: "A payment attempt for this session is already in flight",
        }),
      });
    }

    return c.json(ok(result));
  },
  )

  // ---------------------------------------------------------------
  // POST /funnel-sessions/:sessionId/confirm
  //
  // The browser's half of the completion. The Connect webhook (Task 8)
  // performs the identical transition for the buyer who closed the tab,
  // so both call one shared service and either may win.
  // ---------------------------------------------------------------
  .post(
    "/funnel-sessions/:sessionId/confirm",
    endpointRateLimit({ name: "funnel:confirm", max: 30 }),
    async (c) => {
      const sid = c.req.param("sessionId");
      const session = await drizzle.funnelSessionRepo.findById(drizzle.db, sid);
      if (!session) throw new HTTPException(404, { message: "Session not found" });

      // Same key as the payment-intent endpoint, deliberately. That
      // endpoint's `upsertPending` conflicts on `sessionId` and forces
      // `status: "pending"`, so if it were allowed to finish its
      // read-modify-write against a row this handler is turning `paid`,
      // it would reset that row and replace its Stripe ids — erasing the
      // record of a charge that really happened. Sharing the key makes
      // the two mutually exclusive.
      //
      // NOT nested inside anything: `withLock` is not re-entrant, so this
      // is the outermost and only acquisition on this path.
      //
      // The 60s TTL deliberately matches the payment-intent endpoint's:
      // two holders of the SAME key must not be able to expire at
      // different times. This section also makes Stripe round-trips on a
      // client with no per-request timeout, so a shorter TTL here would
      // let a concurrent payment-intent POST take the key while this
      // handler is still mid-flight, read `pending`, and `upsertPending`
      // back over the row after this transaction turns it `paid` —
      // exactly the clobber the shared key exists to prevent.
      const result = await withLock(`funnel:payment:${sid}`, 60_000, async () => {
        const purchase = await drizzle.funnelPurchaseRepo.findBySession(
          drizzle.db,
          sid,
        );
        if (!purchase) {
          throw new HTTPException(409, { message: "No payment started" });
        }
        if (!purchase.stripeCustomerId) {
          // Only the dev-mode stub in routes/public/funnels.ts writes a
          // purchase with no customer, and that path mints its own token.
          throw new HTTPException(409, { message: "No payment started" });
        }

        // The browser's word is not evidence. Ask Stripe.
        const { account } = await requireConnectedStripe(session.projectId);
        if (!(await isSettled(account, purchase))) {
          throw new HTTPException(409, { message: "Payment is not complete" });
        }

        // No `stillHeld()` fence here, unlike the sibling endpoint. There
        // is nothing this can destroy: the transition is idempotent and
        // the real serializer is the unique index on
        // `funnel_claim_tokens.session_id`, which lets exactly one caller
        // mint. Bailing on a lost lock would 409 a visitor who has
        // demonstrably paid and withhold the token they need — strictly
        // worse than proceeding, which is safe.
        return completeFunnelPurchase({
          sessionId: sid,
          stripeCustomerId: purchase.stripeCustomerId,
          stripeSubscriptionId: purchase.stripeSubscriptionId,
          stripePaymentIntentId: purchase.stripePaymentIntentId,
        });
      }).catch((err: unknown) => {
        // Only the acquisition failure is remapped; anything the section
        // itself threw keeps its own status. See the sibling endpoint.
        if (err instanceof LockUnavailableError) {
          log.error("could not take the funnel payment lock", {
            sessionId: sid,
            error: err.message,
          });
          throw new HTTPException(503, {
            message: JSON.stringify({
              code: "PAYMENT_TEMPORARILY_UNAVAILABLE",
              message: "Payment is temporarily unavailable, please try again",
            }),
          });
        }
        throw err;
      });

      if (result === null) {
        throw new HTTPException(409, {
          message: JSON.stringify({
            code: "PAYMENT_IN_FLIGHT",
            message: "A payment attempt for this session is already in flight",
          }),
        });
      }

      // The plaintext exists exactly once. A repeat call says so plainly
      // rather than inventing a token the client cannot use.
      if (result.alreadyIssued) {
        return c.json(ok({ already_issued: true as const }));
      }

      return c.json(
        ok({
          already_issued: false as const,
          ...(await buildClaimLinks(session, result.token)),
        }),
      );
    },
  );
