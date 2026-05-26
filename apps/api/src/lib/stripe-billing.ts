import Stripe from "stripe";
import { env } from "./env";
import { isBillingEnabled } from "./billing-flags";
import { logger } from "./logger";

// =============================================================
// Platform-Stripe client (Rovenue's own billing)
// =============================================================
//
// Separate Stripe SDK instance from apps/api/src/services/stripe/* —
// that one talks to the **customer's** Stripe (their app users'
// subscriptions). This one talks to Rovenue's own Stripe account
// (the one we charge customers for using the cloud).
//
// Returns null when BILLING_ENABLED=false so callers can early-return
// without throwing. Self-host installs always see null.

const log = logger.child("stripe-billing");

let cached: Stripe | null = null;

export function getPlatformStripe(): Stripe | null {
  if (!isBillingEnabled()) return null;
  if (!env.STRIPE_BILLING_SECRET_KEY) {
    log.warn(
      "BILLING_ENABLED=true but STRIPE_BILLING_SECRET_KEY is missing — billing is inert",
    );
    return null;
  }
  if (cached) return cached;
  cached = new Stripe(env.STRIPE_BILLING_SECRET_KEY, {
    apiVersion: "2024-12-18.acacia" as Stripe.LatestApiVersion,
    typescript: true,
    appInfo: { name: "rovenue-platform-billing", version: "0.1.0" },
  });
  return cached;
}

// Test-only — clears the cached client so subsequent calls re-read env.
// Vitest fixtures call this between cases.
export function _resetPlatformStripeForTests(): void {
  cached = null;
}
