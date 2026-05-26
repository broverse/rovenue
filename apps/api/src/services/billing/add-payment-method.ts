import { drizzle, type Db } from "@rovenue/db";
import { env } from "../../lib/env";
import { getPlatformStripe } from "../../lib/stripe-billing";

// =============================================================
// startAddPaymentMethod
// =============================================================
// Mints a SetupIntent against an already-active project's Stripe
// customer so the dashboard can collect a second card. Used by the
// "Add payment method" affordance on the billing page — distinct
// from upgradeProject (T8), which lazy-creates the customer and
// drives the Free → Paid bootstrap.
//
// The SetupIntent's `metadata.rovenue_flow = "add_pm"` tells the
// setup_intent.succeeded webhook (T11) NOT to call
// subscriptions.create — this flow only attaches a payment method
// to an existing customer; the subscription already exists.
//
// Errors are typed via `code` so the HTTP route (T21) can map them
// to 404/409/503 without string-matching messages.

export interface StartAddPaymentMethodInput {
  db: Db;
  projectId: string;
}

export interface AddPmError extends Error {
  code: "no_customer" | "billing_disabled" | "config_missing";
}

function err(code: AddPmError["code"], message: string): AddPmError {
  const e = new Error(message) as AddPmError;
  e.code = code;
  return e;
}

export async function startAddPaymentMethod(
  input: StartAddPaymentMethodInput,
): Promise<{ clientSecret: string; publishableKey: string }> {
  const { db, projectId } = input;

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
  if (!sub || !sub.stripeCustomerId) {
    throw err("no_customer", "Project has no Stripe customer yet");
  }

  const setupIntent = await stripe.setupIntents.create({
    customer: sub.stripeCustomerId,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: {
      rovenue_project_id: projectId,
      rovenue_flow: "add_pm",
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
