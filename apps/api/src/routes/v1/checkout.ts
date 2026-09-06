import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createId } from "@paralleldrive/cuid2";
import { drizzle } from "@rovenue/db";
import { ERROR_CODE } from "@rovenue/shared";
import { appUserContext } from "../../middleware/app-user-context";
import { validate } from "../../lib/validate";
import { ok, fail } from "../../lib/response";
import { StripeNotConnectedError } from "../../lib/stripe-platform";
import { createCheckoutSession } from "../../services/stripe/checkout-session";
import {
  assertRedirectUrlAllowed,
  RedirectUrlNotAllowedError,
} from "../../services/stripe/verified-return-url";

// =============================================================
// POST /v1/checkout — SDK-facing Stripe Checkout Session
// =============================================================
//
// Treat this as an auth surface, not a convenience endpoint: it starts a
// charge against a real customer. It mirrors /v1/billing-portal deliberately.
//
//   - Subscriber identity comes ONLY from `appUserContext` (the
//     `X-Rovenue-App-User-Id` header resolved server-side against the
//     authenticated project) — the same mechanism as `/v1/me`.
//   - The body schema is `.strict()` and has no price, amount or customer
//     field, so a client cannot smuggle one in even under a plausible name:
//     an unknown key 400s before the handler runs at all. That property is
//     what makes "the browser cannot decide what it pays" true rather than
//     merely intended, so the strictness is load-bearing, not stylistic.

const checkoutBodySchema = z
  .object({
    /** Offering the package must belong to; scoped to the project on read. */
    offeringId: z.string().min(1),
    packageIdentifier: z.string().min(1),
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
  })
  .strict();

export const checkoutRoute = new Hono()
  .use("*", appUserContext)
  .post("/", validate("json", checkoutBodySchema), async (c) => {
    const project = c.get("project");
    const subscriber = c.get("subscriber");
    const { offeringId, packageIdentifier, successUrl, cancelUrl } =
      c.req.valid("json");

    // An erased subject's next checkout attempt must never create a REAL
    // Stripe Checkout Session: createCheckoutSession stamps its metadata
    // with subscriber.rovenueId (see stripe-webhook's resolveSubscriber),
    // and a completed session would re-grant entitlements onto a row the
    // subject asked to be forgotten from -- un-erasing them through a
    // second path. Reported as accepted rather than refused, matching
    // /v1/me/attributes: a 4xx would tell a device-side caller this
    // subject was erased, a disclosure to a party not necessarily
    // entitled to it. Both redirect URLs still run through the SAME
    // verified-domain check the real path applies, so a caller cannot
    // erase themselves and then use this branch as an open-redirect
    // oracle by supplying an arbitrary URL -- a bad URL 400s identically
    // either way. The returned "url" is the verified cancelUrl rather
    // than a live Stripe URL, so following it behaves exactly like an
    // ordinary cancelled checkout.
    if (c.get("subscriberDeadEnded")) {
      try {
        await assertRedirectUrlAllowed(drizzle.db, project.id, successUrl);
        const safeCancelUrl = await assertRedirectUrlAllowed(
          drizzle.db,
          project.id,
          cancelUrl,
        );
        return c.json(ok({ sessionId: createId(), url: safeCancelUrl }));
      } catch (err) {
        if (err instanceof RedirectUrlNotAllowedError) {
          return c.json(fail(ERROR_CODE.VALIDATION_ERROR, err.message), 400);
        }
        throw err;
      }
    }

    try {
      const session = await createCheckoutSession({
        db: drizzle.db,
        projectId: project.id,
        subscriberId: subscriber.id,
        subscriberRovenueId: subscriber.rovenueId,
        offeringId,
        packageIdentifier,
        successUrl,
        cancelUrl,
        // Namespaced per project and subscriber before it reaches Stripe —
        // see createCheckoutSession. A double-submitted checkout must not
        // become two subscriptions, and Stripe's own idempotency is the
        // authority for that; but its key space is per connected ACCOUNT, so
        // a raw browser-supplied value would be shared across subscribers.
        idempotencyKey: c.req.header("Idempotency-Key") ?? undefined,
      });
      return c.json(ok(session));
    } catch (err) {
      if (err instanceof RedirectUrlNotAllowedError) {
        // 400 rather than 403: the caller supplied an unusable value, and the
        // fix is to verify the domain in the dashboard. The message names the
        // URL so a developer can see which of the two was refused.
        return c.json(
          fail(ERROR_CODE.VALIDATION_ERROR, err.message),
          400,
        );
      }
      if (err instanceof StripeNotConnectedError) {
        return c.json(
          fail(
            ERROR_CODE.VALIDATION_ERROR,
            "This project has no connected Stripe account",
          ),
          400,
        );
      }
      if (err instanceof HTTPException) throw err;
      throw err;
    }
  });
