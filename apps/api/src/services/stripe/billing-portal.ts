import { drizzle, type Db } from "@rovenue/db";
import { requireConnectedStripe, StripeNotConnectedError } from "../../lib/stripe-platform";

// =============================================================
// createBillingPortalSession
// =============================================================
//
// Backs the SDK-facing POST /v1/billing-portal endpoint. Treat every
// change here as touching an auth surface: the URL this returns grants
// access to a customer's payment data on Stripe.
//
//   1. The Stripe customer is resolved server-side from `subscriberId`
//      only — this function's signature has no field for a caller-
//      supplied customer id, so there is no argument that could smuggle
//      one in.
//   2. The session is created on the project's CONNECTED account via
//      `requireConnectedStripe` — the one account-resolution path this
//      codebase has (see `routes/public/funnel-payment.ts`). No second
//      path is introduced here.
//   3. `returnUrl` is checked against the project's verified custom
//      domains rather than trusted as-is, for the same reason the
//      outbound-webhook SSRF guard exists: a URL under attacker control
//      that this service happily redirects users to is a phishing
//      primitive wearing a convenience feature's clothes.

export class NoStripeCustomerError extends Error {
  constructor(subscriberId: string) {
    super(`Subscriber ${subscriberId} has no known Stripe customer`);
    this.name = "NoStripeCustomerError";
  }
}

export class ReturnUrlNotAllowedError extends Error {
  constructor(rawUrl: string) {
    super(`Return URL is not one of the project's verified domains: ${rawUrl}`);
    this.name = "ReturnUrlNotAllowedError";
  }
}

export interface CreateBillingPortalSessionInput {
  db: Db;
  projectId: string;
  subscriberId: string;
  /**
   * Raw, client-supplied return URL. Validated against the project's
   * verified custom domains below — never forwarded to Stripe unchecked.
   */
  returnUrl: string;
}

export interface BillingPortalSession {
  url: string;
}

/**
 * The project's own domain allow-list, expressed via `custom_domains` —
 * the only place a project has an admin-verified domain on record (host
 * ownership is proven there via CNAME + TXT challenge for funnel serving).
 * There is no separate "allowed return domains" setting to reuse instead,
 * so this reuses that verified-ownership record rather than inventing a
 * second, unverified one.
 */
async function assertReturnUrlAllowed(
  db: Db,
  projectId: string,
  rawUrl: string,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ReturnUrlNotAllowedError(rawUrl);
  }
  // https-only: a portal return is a browser redirect back into the
  // developer's own app/site, and the developer's own domain record
  // (custom_domains) exists specifically to serve funnels over https.
  if (parsed.protocol !== "https:") {
    throw new ReturnUrlNotAllowedError(rawUrl);
  }

  const domains = await drizzle.customDomainRepo.listByProject(db, projectId);
  const verifiedHosts = new Set(
    domains
      .filter((d) => d.verifiedAt !== null)
      .map((d) => d.hostname.toLowerCase()),
  );
  if (!verifiedHosts.has(parsed.hostname.toLowerCase())) {
    throw new ReturnUrlNotAllowedError(rawUrl);
  }
  return parsed.toString();
}

export async function createBillingPortalSession(
  input: CreateBillingPortalSessionInput,
): Promise<BillingPortalSession> {
  const { db, projectId, subscriberId, returnUrl } = input;

  const safeReturnUrl = await assertReturnUrlAllowed(db, projectId, returnUrl);

  const stripeCustomerId =
    await drizzle.funnelPurchaseRepo.findLatestStripeCustomerIdForSubscriber(
      db,
      subscriberId,
    );
  if (!stripeCustomerId) {
    throw new NoStripeCustomerError(subscriberId);
  }

  const { account } = await requireConnectedStripe(projectId);
  const session = await account.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: safeReturnUrl,
  });

  return { url: session.url };
}

export { StripeNotConnectedError };
