import { drizzle, type Db } from "@rovenue/db";
import { env } from "../../lib/env";
import { getPlatformStripe } from "../../lib/stripe-billing";

// =============================================================
// upgradeProject
// =============================================================
// Starts a Free → Paid project upgrade by:
//   1. ensuring a Stripe customer exists for the project (lazy create
//      on first attempt, reuse on retry — keeps test-account clutter
//      to one customer per project even across abandoned flows),
//   2. minting a SetupIntent the dashboard collects card details
//      against.
//
// The SetupIntent's `metadata.rovenue_flow = "upgrade"` is the signal
// the setup_intent.succeeded webhook (T11) uses to decide whether to
// bootstrap the actual Stripe subscription — anything else (e.g. a
// later "add a card" flow from T9) deliberately omits this flag.
//
// Errors are typed via `code` so the HTTP route (T20) can map them to
// 404/409/503 without string-matching messages.

export interface UpgradeProjectInput {
  db: Db;
  projectId: string;
  // P2 ships monthly only — annual unlocks in P6 once the price ids exist.
  cycle: "monthly";
}

export interface UpgradeError extends Error {
  code: "already_active" | "billing_disabled" | "config_missing";
}

function err(code: UpgradeError["code"], message: string): UpgradeError {
  const e = new Error(message) as UpgradeError;
  e.code = code;
  return e;
}

export async function upgradeProject(input: UpgradeProjectInput): Promise<{
  clientSecret: string;
  publishableKey: string;
}> {
  const { db, projectId, cycle } = input;

  const stripe = getPlatformStripe();
  if (!stripe) {
    throw err("billing_disabled", "Billing disabled");
  }

  const publishableKey = env.STRIPE_BILLING_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw err("config_missing", "Missing STRIPE_BILLING_PUBLISHABLE_KEY");
  }

  const sub = await drizzle.billingSubscriptionRepo.findBillingSubscriptionByProject(
    db,
    projectId,
  );
  if (!sub) {
    throw err("config_missing", "No billing_subscriptions row");
  }
  if (sub.state !== "free") {
    throw err("already_active", `state=${sub.state}`);
  }

  let customerId = sub.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { rovenue_project_id: projectId },
    });
    customerId = customer.id;
    await drizzle.billingSubscriptionRepo.setStripeCustomerId(
      db,
      projectId,
      customerId,
    );
  }

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: {
      rovenue_project_id: projectId,
      rovenue_flow: "upgrade",
      rovenue_target_tier: "indie",
      rovenue_target_cycle: cycle,
    },
  });

  if (!setupIntent.client_secret) {
    throw err("config_missing", "SetupIntent missing client_secret");
  }

  return {
    clientSecret: setupIntent.client_secret,
    publishableKey,
  };
}
