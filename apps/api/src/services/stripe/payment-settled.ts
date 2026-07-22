import type Stripe from "stripe";
import { STRIPE_SUBSCRIPTION_STATUS } from "./stripe-types";

// =============================================================
// "Has this buyer actually paid?" — one implementation, two callers
// =============================================================
//
// A funnel purchase can be completed from two places: the browser's
// `POST /public/funnel-sessions/:id/confirm`, and the Connect webhook's
// backstop for the buyer who closed the tab. Both mint the same claim
// token through the same service, so both must answer this question the
// same way — and the only way to guarantee that is for there to be one
// answer, computed here.
//
// It lives in its own module rather than in either caller because a
// predicate exported from one call site is a predicate the other call
// site is free to reimplement "just for now". This session has already
// produced three bugs of exactly that shape (a settings key renamed on
// one side, an email hash derived twice, a Postgres error shape matched
// twice). Anything that needs to know whether a funnel buyer has paid
// imports from here; nothing re-derives it.

/**
 * The parts of a subscription this answer depends on.
 *
 * Structural rather than `Stripe.Subscription` so the webhook (which has
 * the event's object) and `/confirm` (which has a
 * `Stripe.Response<Stripe.Subscription>` off the account-scoped facade)
 * can both pass what they already hold.
 */
export interface SettlementSubscription {
  status: Stripe.Subscription["status"];
  default_payment_method?: Stripe.Subscription["default_payment_method"];
}

/**
 * Has the buyer behind this subscription actually paid, or at least
 * handed over a card?
 *
 * This is the whole trap. The funnel creates subscriptions with
 * `payment_behavior: "default_incomplete"`, and when the package has a
 * trial Stripe puts the subscription straight into `trialing` with a
 * pending setup intent — so the subscription reads `trialing` from the
 * moment the visitor picks a package, BEFORE any card is entered, and
 * `customer.subscription.created` fires there too. Treating that as
 * proof of payment would mint a claim token and grant entitlements to
 * someone who never paid and never will. Both the webhook and `/confirm`
 * are reachable at that moment, and `/confirm` is anonymous and takes
 * nothing but a session id, so this must not be a judgement either
 * caller makes on its own.
 *
 * `active` means an invoice was actually paid (or a trial converted).
 * For `trialing` the money signal does not exist by design — the trial
 * captures nothing now — so the equivalent commitment is the card, which
 * Stripe records on the subscription as `default_payment_method` once
 * the pending setup intent succeeds.
 *
 * If Stripe ever stopped setting `default_payment_method` there, this
 * returns false: the webhook simply does not backstop the trial from a
 * subscription event, and `/confirm` answers 409. The buyer still
 * reaches their token from the `invoice.paid` at trial conversion.
 * Silence is the correct failure — a false positive here hands out
 * entitlements to a visitor who only reached the paywall.
 */
export function hasPaidOrAttachedACard(
  subscription: SettlementSubscription,
): boolean {
  if (subscription.status === STRIPE_SUBSCRIPTION_STATUS.ACTIVE) return true;
  if (subscription.status === STRIPE_SUBSCRIPTION_STATUS.TRIALING) {
    return subscription.default_payment_method != null;
  }
  // incomplete / incomplete_expired / past_due / unpaid / canceled /
  // paused: nothing here says this buyer paid for THIS session.
  return false;
}
