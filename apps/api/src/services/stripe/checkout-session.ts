import { HTTPException } from "hono/http-exception";
import { drizzle } from "@rovenue/db";
import type { Db } from "@rovenue/db";
import { requireConnectedStripe } from "../../lib/stripe-platform";
import { packagesSchema, parseStoreIds } from "../../lib/offering-hydration";
import { assertRedirectUrlAllowed } from "./verified-return-url";

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
// The metadata key below is what lets the existing subscription webhooks
// resolve the resulting Stripe subscription back to this subscriber — the SDK
// analogue of the funnel's own metadata binding. Without it a completed
// checkout arrives as an event about a customer we cannot attribute.

/** Metadata key carrying the Rovenue subscriber id into Stripe and back. */
export const ROVENUE_SUBSCRIBER_METADATA_KEY = "rovenue_subscriber_id";

export interface CreateCheckoutSessionInput {
  db: Db;
  projectId: string;
  subscriberId: string;
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
): Promise<string> {
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
  return stripePriceId;
}

export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
): Promise<CheckoutSession> {
  const {
    db,
    projectId,
    subscriberId,
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

  const priceId = await resolvePackagePriceId(
    db,
    projectId,
    offeringId,
    packageIdentifier,
  );

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
        [ROVENUE_SUBSCRIBER_METADATA_KEY]: subscriberId,
        package_identifier: packageIdentifier,
      },
      // Carried onto the subscription as well as the session: the webhooks
      // that matter (customer.subscription.*) see the subscription's
      // metadata, not the session's.
      subscription_data: {
        metadata: { [ROVENUE_SUBSCRIBER_METADATA_KEY]: subscriberId },
      },
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  );

  if (!session.url) {
    throw new HTTPException(502, {
      message: "Stripe returned a checkout session with no URL",
    });
  }

  return { sessionId: session.id, url: session.url };
}
