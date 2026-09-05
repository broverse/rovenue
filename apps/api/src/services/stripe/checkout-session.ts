import { HTTPException } from "hono/http-exception";
import { drizzle } from "@rovenue/db";
import type { Db } from "@rovenue/db";
import { requireConnectedStripe } from "../../lib/stripe-platform";
import { packagesSchema, parseStoreIds } from "../../lib/offering-hydration";
import { assertRedirectUrlAllowed } from "./verified-return-url";
import { SUBSCRIBER_METADATA_KEY } from "./stripe-types";

// =============================================================
// SDK-facing Stripe Checkout Session
// =============================================================
//
// The web analogue of a native store purchase. Its security shape is copied
// from /v1/billing-portal, which is the surface in this codebase that has
// already been reasoned about as an auth boundary rather than a convenience:
//
//   - the subscriber comes ONLY from the authenticated request context, never
//     from the body;
//   - the browser names a PACKAGE, never a price and never an amount. The
//     amount is derived server-side from the offering the package belongs to,
//     so a client that lies about what something costs changes nothing;
//   - the success and cancel URLs are checked against the project's verified
//     domains before Stripe ever sees them.
//
// The subscription metadata below is what lets the EXISTING webhook resolve
// the resulting Stripe subscription back to this buyer. `resolveSubscriber`
// in ./stripe-webhook already reads `app_user_id` and then walks the merge
// chain, so the value is the subscriber's rovenueId — its database id would
// skip that walk. Stamped with a shared constant rather than a literal
// because the writer and the reader are different files.
//
// Without a match the subscription falls back to the `stripe:<customerId>`
// anchor, which creates a SYNTHETIC subscriber and grants the entitlement
// there — the buyer's real subscriber never receives it, and nothing fails
// loudly.

export interface CreateCheckoutSessionInput {
  db: Db;
  projectId: string;
  subscriberId: string;
  /** The buyer's rovenueId, stamped into Stripe metadata for the webhook. */
  subscriberRovenueId: string;
  /** Offering the package must belong to. Scoped to the project on read. */
  offeringId: string;
  packageIdentifier: string;
  successUrl: string;
  cancelUrl: string;
  /**
   * The client's `Idempotency-Key`, passed straight to Stripe when present.
   *
   * Stripe's own idempotency is used rather than a scheme of our own: it is
   * authoritative for the charge, and it survives this process restarting
   * mid-request, which a local record would not.
   */
  idempotencyKey?: string;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
}

/**
 * Resolve the named package to a Stripe price through the project's own
 * offering.
 *
 * This is what stops a client naming an arbitrary price: the identifier must
 * appear in an offering that belongs to the authenticated project, and the
 * price id comes from that product's stored store ids — never from the
 * request. Same rule the funnel payment path applies, reached from a
 * different entry point.
 */
async function resolvePackagePriceId(
  db: Db,
  projectId: string,
  offeringId: string,
  packageIdentifier: string,
): Promise<{ priceId: string; productType: string | null }> {
  const offering = await drizzle.offeringRepo.findOfferingById(
    db,
    projectId,
    offeringId,
  );
  if (!offering) {
    // Deliberately the same message as a package miss: telling an anonymous
    // caller which offering ids exist in a project serves nobody.
    throw new HTTPException(400, {
      message: "Package is not in this project's offering",
    });
  }

  const slots = packagesSchema.safeParse(offering.packages);
  const slot = slots.success
    ? slots.data.find((p) => p.identifier === packageIdentifier)
    : undefined;
  if (!slot) {
    throw new HTTPException(400, {
      message: "Package is not in this project's offering",
    });
  }

  const [product] = await drizzle.offeringRepo.findProductsByIds(
    db,
    projectId,
    [slot.productId],
  );
  const stripePriceId = product
    ? (parseStoreIds(product.storeIds).stripe ?? null)
    : null;
  if (!stripePriceId) {
    // Distinct from the miss above: the package exists but has no Stripe
    // price configured, which is a project configuration gap rather than a
    // client naming something it should not.
    throw new HTTPException(400, {
      message: "Package has no Stripe price configured",
    });
  }
  return { priceId: stripePriceId, productType: product?.type ?? null };
}

export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
): Promise<CheckoutSession> {
  const {
    db,
    projectId,
    subscriberId,
    subscriberRovenueId,
    offeringId,
    packageIdentifier,
    successUrl,
    cancelUrl,
    idempotencyKey,
  } = input;

  // Both URLs, not just the success one: a cancel URL is followed by a real
  // browser too, and an unchecked one is the same open redirect.
  const safeSuccessUrl = await assertRedirectUrlAllowed(
    db,
    projectId,
    successUrl,
  );
  const safeCancelUrl = await assertRedirectUrlAllowed(db, projectId, cancelUrl);

  const { priceId, productType } = await resolvePackagePriceId(
    db,
    projectId,
    offeringId,
    packageIdentifier,
  );

  // Stripe rejects a one-time price in subscription mode with an
  // InvalidRequestError, which would surface to the SDK caller as a 500 —
  // an unhandled server fault for what is really a mismatched request. Say
  // so as a 400 instead, and name the actual limitation rather than letting
  // it look like a bug.
  //
  // One-time web purchases are genuinely not supported yet: they need a
  // `mode: "payment"` path and a different completion story, since a
  // PaymentIntent produces no subscription for the webhook to bind.
  if (productType && productType !== "SUBSCRIPTION") {
    throw new HTTPException(400, {
      message:
        "Web checkout currently supports subscription packages only. This " +
        "package is a one-time product.",
    });
  }

  const { account } = await requireConnectedStripe(projectId);

  // Reuse the subscriber's existing Stripe customer when they have one.
  //
  // Stripe creates a Customer itself when a subscription-mode session
  // completes, so a first-time buyer needs nothing here. A RETURNING one does:
  // without this, a subscriber who already bought through a funnel gets a
  // second customer on their first web checkout, and the billing portal —
  // which resolves the latest — then shows them only one of the two.
  //
  // Passed only when present. Stripe rejects an explicit null for this field,
  // so the property must be absent rather than nulled.
  const existingCustomerId =
    await drizzle.funnelPurchaseRepo.findLatestStripeCustomerIdForSubscriber(
      db,
      subscriberId,
    );

  const session = await account.checkout.sessions.create(
    {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: safeSuccessUrl,
      cancel_url: safeCancelUrl,
      ...(existingCustomerId ? { customer: existingCustomerId } : {}),
      metadata: {
        [SUBSCRIBER_METADATA_KEY]: subscriberRovenueId,
        package_identifier: packageIdentifier,
      },
      // Carried onto the subscription as well as the session: the webhooks
      // that matter (customer.subscription.*) see the subscription's
      // metadata, not the session's.
      subscription_data: {
        metadata: { [SUBSCRIBER_METADATA_KEY]: subscriberRovenueId },
      },
    },
    // Namespaced, never forwarded verbatim. Stripe scopes idempotency to the
    // connected ACCOUNT, so a raw client-supplied key shares one space across
    // every subscriber of the project — and the value arrives from browser
    // JavaScript. Two buyers submitting the same key (a hardcoded one, a
    // low-entropy generator, or a deliberate collision) would get the SAME
    // session back: the second pays into the first's customer, and the
    // subscription metadata names the first subscriber, so the entitlement
    // lands on the wrong person.
    idempotencyKey
      ? { idempotencyKey: `${projectId}:${subscriberId}:${idempotencyKey}` }
      : undefined,
  );

  if (!session.url) {
    throw new HTTPException(502, {
      message: "Stripe returned a checkout session with no URL",
    });
  }

  return { sessionId: session.id, url: session.url };
}
