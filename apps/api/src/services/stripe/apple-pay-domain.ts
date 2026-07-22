import type Stripe from "stripe";
import { drizzle } from "@rovenue/db";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { getConnectPlatformStripe } from "../../lib/stripe-platform";
import { withAccount } from "../../lib/stripe-account-scoped";

// =============================================================
// Apple Pay domain registration for funnel paywalls
// =============================================================
//
// A funnel paywall is served from ONE Rovenue-controlled host and charges
// through each customer's OWN connected Stripe account (direct charges).
// Stripe only offers Apple Pay in that payment sheet when the host the
// page was served from is registered as a payment method domain **on the
// account taking the charge** — so this has to run once per connected
// account, not once per deployment.
//
// Two things about this are easy to get wrong, and both fail silently:
//
// 1. THE ACCOUNT. The client Rovenue holds is the platform client. A
//    `paymentMethodDomains.create` without the `Stripe-Account` header
//    returns 200 and registers the domain on ROVENUE's account, which
//    does nothing for the customer. Everything here therefore goes
//    through the `withAccount` facade (see lib/stripe-account-scoped.ts).
//
// 2. THE VERDICT. A 200 from Stripe does NOT mean Apple Pay works. The
//    response reports per-wallet eligibility, and `apple_pay.status` can
//    come back `inactive` — most often because domain verification has
//    not succeeded. We store Stripe's verdict, so the column answers
//    "will Apple Pay appear" rather than "did we call the API".
//
// Domain verification, and why there is a file in the dashboard's
// `public/.well-known/`:
//
//    Stripe's payment-method-domain guide lists registration as a single
//    API call and never mentions hosting anything — but the object model
//    has an explicit `apple_pay.status = inactive` +
//    `status_details.error_message` path and a `/validate` endpoint whose
//    stated purpose is "complete the required registration steps specific
//    to the payment method, and then validate". The required step for
//    Apple Pay is the domain association file: Stripe publishes it at
//    https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association
//    and Stripe's own payment hosts (checkout.stripe.com, buy.stripe.com)
//    serve it at /.well-known/apple-developer-merchantid-domain-association.
//    It is one platform-wide file, not a per-merchant one — so a single
//    copy served from the funnel host verifies that host for every
//    connected account. See docs/operations/deployment.md.

const log = logger.child("apple-pay-domain");

/**
 * `skipped` means nothing was attempted and nothing was recorded: no
 * domain configured, no live connection, or no platform key for the
 * connection's mode. The other three mirror what is written to
 * `project_stripe_connections.apple_pay_domain_status`.
 */
export type ApplePayDomainOutcome = "active" | "inactive" | "failed" | "skipped";

/**
 * Does Stripe consider Apple Pay usable on this domain object right now?
 *
 * `enabled` is checked as well as `apple_pay.status` because a disabled
 * domain suppresses every wallet on it regardless of per-wallet
 * eligibility — reporting `active` off the wallet field alone would be
 * the same lie in a different place.
 */
function applePayVerdict(
  domain: Stripe.PaymentMethodDomain,
): Extract<ApplePayDomainOutcome, "active" | "inactive"> {
  if (domain.enabled === false) return "inactive";
  return domain.apple_pay?.status === "active" ? "active" : "inactive";
}

function verdictDetail(domain: Stripe.PaymentMethodDomain): string | null {
  return domain.apple_pay?.status_details?.error_message ?? null;
}

/**
 * Register the funnel-serving host as a payment method domain on a
 * project's connected Stripe account and record whether Apple Pay is
 * actually live on it.
 *
 * **Never throws.** Its caller is the OAuth callback, mid-connect, with a
 * live Stripe authorization on the other end — a throw there would take
 * the deauthorize-and-report path and undo a connection the customer just
 * made. Apple Pay being unavailable must never cost someone their Stripe
 * connection.
 */
export async function registerApplePayDomain(projectId: string): Promise<ApplePayDomainOutcome> {
  const domainName = env.FUNNEL_PAYMENT_DOMAIN;
  if (!domainName) {
    // Deliberately not derived from DASHBOARD_URL. Registering a host the
    // paywall is not served from succeeds at the API level and then Apple
    // Pay silently never appears — the failure this whole path exists to
    // prevent. An operator names the host or nothing is registered.
    log.warn("FUNNEL_PAYMENT_DOMAIN is unset; skipping Apple Pay domain registration", {
      projectId,
    });
    return "skipped";
  }

  const connection = await drizzle.stripeConnectionRepo.findActiveByProject(drizzle.db, projectId);
  if (!connection) {
    // Nothing to register against, and nothing to record: no Stripe call.
    return "skipped";
  }

  const stripe = getConnectPlatformStripe(connection.livemode);
  if (!stripe) {
    log.error("connection exists but its platform key is unset; cannot register Apple Pay domain", {
      projectId,
      livemode: connection.livemode,
    });
    return "skipped";
  }

  const account = withAccount(stripe, connection.stripeAccountId);

  try {
    // List first so a reconnect (or a re-run of the backfill) does not
    // create a second domain object for the same host. Stripe filters
    // server-side, but the name is re-checked below because a filter that
    // silently stopped applying would otherwise make us adopt whatever
    // domain happened to be first.
    const existing = await account.paymentMethodDomains.list({
      domain_name: domainName,
      limit: 1,
    });
    const already = existing.data.find((d) => d.domain_name === domainName);

    const domain =
      already ?? (await account.paymentMethodDomains.create({ domain_name: domainName }));

    const status = applePayVerdict(domain);
    await drizzle.stripeConnectionRepo.updateApplePayDomainStatus(
      drizzle.db,
      connection.id,
      status,
    );

    if (status === "active") {
      log.info("apple pay domain active", {
        projectId,
        domainName,
        created: already === undefined,
      });
    } else {
      // Loud on purpose: registration "worked" and Apple Pay still will
      // not appear. Almost always the host is not serving Stripe's
      // verification file yet.
      log.warn("apple pay domain registered but INACTIVE", {
        projectId,
        domainName,
        created: already === undefined,
        enabled: domain.enabled,
        reason: verdictDetail(domain),
      });
    }
    return status;
  } catch (err) {
    log.error("apple pay domain registration failed", {
      projectId,
      domainName,
      err: err instanceof Error ? err.message : String(err),
    });
    try {
      await drizzle.stripeConnectionRepo.updateApplePayDomainStatus(
        drizzle.db,
        connection.id,
        "failed",
      );
    } catch (writeErr) {
      // The status write is itself best-effort — this function's promise
      // must resolve even if the database is the thing that is down.
      log.error("could not record the apple pay domain failure", {
        projectId,
        err: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
    }
    return "failed";
  }
}
