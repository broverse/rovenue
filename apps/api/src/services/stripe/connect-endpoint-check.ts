import type Stripe from "stripe";
import { logger } from "../../lib/logger";
import {
  type ConnectMode,
  getConnectPlatformStripe,
  isConnectConfiguredForMode,
} from "../../lib/stripe-platform";
import { STRIPE_EVENT_TYPE } from "./stripe-types";

// =============================================================
// Startup check: is the Connect endpoint subscribed to the events
// the funnel backstop depends on?
// =============================================================
//
// The one-time funnel path is completed for a tab-closing buyer by
// `payment_intent.succeeded` and nothing else — a bare PaymentIntent
// carries no subscription and no invoice, so it is the only object in
// that flow holding `rovenue_funnel_session_id`. If the operator's
// platform Connect endpoint does not have that event type selected, the
// backstop is simply never invoked and the failure is completely silent:
// the buyer is charged, no token is minted, and no code path anywhere
// notices. This turns that into one loud line at boot.
//
// Deliberately advisory. It logs and returns; it never throws, never
// blocks the listener, and no-ops entirely when Connect is unconfigured
// (plenty of self-hosted deployments never register a platform).
//
// PLATFORM call, not a connected-account one. `webhookEndpoints.list()`
// enumerates the endpoints on Rovenue's own platform account — passing
// `{ stripeAccount }` would ask a *customer's* account which endpoints
// it has registered, which is a different question with a different (and
// useless) answer. This is the one place in the funnel code that uses the
// raw platform client rather than lib/stripe-account-scoped.ts, and the
// facade is deliberately not extended to cover it: adding a method there
// would mean adding an account-scoped call nobody should make.

const log = logger.child("stripe-connect-endpoint-check");

/** The path this deployment serves the Connect webhook on. */
const CONNECT_WEBHOOK_PATH = "/webhooks/stripe/connect";

/**
 * Events the endpoint must carry. Everything else the pipeline handles
 * is a nice-to-have from the funnel's point of view; without these a
 * buyer who closes the tab is left with a charge and no entitlement.
 */
const REQUIRED_EVENTS: readonly string[] = [
  STRIPE_EVENT_TYPE.PAYMENT_INTENT_SUCCEEDED,
];

/** Stripe's "everything" selector counts as having any given event. */
const WILDCARD = "*";

function coversEvent(endpoint: Stripe.WebhookEndpoint, event: string): boolean {
  return (
    endpoint.enabled_events.includes(event) ||
    endpoint.enabled_events.includes(WILDCARD)
  );
}

async function checkMode(mode: ConnectMode): Promise<void> {
  if (!isConnectConfiguredForMode(mode)) return;
  const stripe = getConnectPlatformStripe(mode === "live");
  if (!stripe) return;

  // Paginated, not a single page. A platform with more than one page of
  // endpoints would otherwise have the Connect one fall off the end of
  // `limit: 100` and be reported missing — or, worse under the old
  // fallback, have some unrelated endpoint answer for it.
  const all = await stripe.webhookEndpoints
    .list({ limit: 100 })
    .autoPagingToArray({ limit: 1000 });
  const enabled = all.filter((e) => e.status === "enabled");

  // Only the endpoints that are unmistakably ours count. Stripe does not
  // report on a retrieved endpoint whether it was created with
  // `connect: true`, so the URL is the only discriminator available.
  const candidates = enabled.filter((e) => e.url.includes(CONNECT_WEBHOOK_PATH));

  if (candidates.length === 0) {
    // Deliberately NOT "fall back to every enabled endpoint". That
    // fallback could PASS on the wrong endpoint entirely: a platform
    // billing endpoint subscribed to `payment_intent.succeeded` for
    // Rovenue's own subscriptions would satisfy a check the actual
    // Connect endpoint fails, and the silent gap this whole module
    // exists to surface would stay silent — while looking verified.
    // "Could not verify" is the only honest answer, and it is a
    // different line from "verified and missing" so an operator behind
    // a path-rewriting proxy can tell the two apart.
    log.warn(
      "could not identify the platform's Connect webhook endpoint by URL; funnel backstop coverage is UNVERIFIED",
      {
        mode,
        expectedPath: CONNECT_WEBHOOK_PATH,
        requiredEvents: REQUIRED_EVENTS,
        enabledEndpoints: enabled.map((e) => e.url),
      },
    );
    return;
  }

  for (const event of REQUIRED_EVENTS) {
    if (candidates.some((e) => coversEvent(e, event))) continue;
    log.error(
      "platform Connect webhook endpoint is not subscribed to a required event; buyers who close the tab will never be completed",
      {
        mode,
        missingEvent: event,
        endpoints: candidates.map((e) => e.url),
      },
    );
  }
}

/**
 * Verify both configured modes. Resolves even when Stripe is
 * unreachable — a startup check that can fail the boot is worse than the
 * gap it reports.
 */
export async function checkConnectWebhookEvents(): Promise<void> {
  for (const mode of ["live", "test"] as const) {
    try {
      await checkMode(mode);
    } catch (err) {
      log.warn("could not read the platform's webhook endpoints", {
        mode,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
