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
  /**
   * REQUIRED, deliberately. Both callers already hold this field — the
   * webhook has the whole subscription object and `/confirm` retrieves
   * it — and a missing one is indistinguishable from a null one at
   * runtime: the predicate would answer `false` and refuse a buyer who
   * paid, which reads exactly like a legitimate refusal. Making it
   * required moves that mistake from a silent 409 to a compile error.
   */
  default_payment_method: Stripe.Subscription["default_payment_method"];
  /**
   * Status of the subscription's `pending_setup_intent`, when the caller
   * has it expanded.
   *
   * OPTIONAL, and the asymmetry with the field above is deliberate. Only
   * `/confirm` can supply it: it makes a retrieve of its own, so it can
   * ask for `expand: ["pending_setup_intent"]` and pay nothing extra.
   * The webhook is handed the event's subscription object, where this is
   * a bare id — reading its status would mean a Stripe round-trip on
   * EVERY subscription event of every connected account, which would put
   * network I/O inside the one predicate that is currently pure. A pure
   * predicate is what makes it safe to share; the moment it does I/O the
   * two call sites start having reasons to fork it again.
   *
   * The asymmetry is safe because it can only ever ADD a true. Omitting
   * it never turns a settled subscription unsettled at the webhook: the
   * webhook's job is to backstop the buyer who left, and a trial it
   * cannot yet prove is left for the next event on that subscription (or
   * for `/confirm`, which CAN prove it). Omitting `default_payment_method`
   * by contrast would remove the only signal either caller has.
   */
  pendingSetupIntentStatus?: Stripe.SetupIntent.Status | null;
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
 * captures nothing now — so the equivalent commitment is the card, and
 * there are two independent records of it:
 *
 *   - `default_payment_method` on the subscription. Note this is NOT
 *     free: Stripe's `payment_settings.save_default_payment_method`
 *     defaults to `off`, so the funnel asks for `on_subscription` at
 *     create time. Even then the SDK's own wording is "when a
 *     subscription *payment* succeeds", which for a trial does not
 *     happen until conversion — so this field alone cannot be relied on
 *     at the moment the browser finishes.
 *   - the `pending_setup_intent` reaching `succeeded`. That is the very
 *     object the visitor just confirmed in the card form, so it is true
 *     the instant they finish and depends on nothing Stripe does later.
 *
 * Either one is a card. Requiring both would refuse real buyers; the
 * pair is what stops this gate being an assumption about Stripe's
 * timing.
 *
 * What still returns false, and must: a `trialing` subscription with
 * neither — no card, no confirmed setup intent. That is the state the
 * funnel puts a trial package into the moment a visitor picks it, before
 * the card form is touched, and treating it as proof of payment hands
 * entitlements to someone who never paid and never will.
 */
export function hasPaidOrAttachedACard(
  subscription: SettlementSubscription,
): boolean {
  if (subscription.status === STRIPE_SUBSCRIPTION_STATUS.ACTIVE) return true;
  if (subscription.status === STRIPE_SUBSCRIPTION_STATUS.TRIALING) {
    return (
      subscription.default_payment_method != null ||
      subscription.pendingSetupIntentStatus === "succeeded"
    );
  }
  // incomplete / incomplete_expired / past_due / unpaid / canceled /
  // paused: nothing here says this buyer paid for THIS session.
  return false;
}
