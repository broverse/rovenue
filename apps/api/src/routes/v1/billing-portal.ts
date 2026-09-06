import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { ERROR_CODE } from "@rovenue/shared";
import { appUserContext } from "../../middleware/app-user-context";
import { validate } from "../../lib/validate";
import { ok } from "../../lib/response";
import { StripeNotConnectedError } from "../../lib/stripe-platform";
import {
  createBillingPortalSession,
  NoStripeCustomerError,
  ReturnUrlNotAllowedError,
} from "../../services/stripe/billing-portal";

// =============================================================
// POST /v1/billing-portal — SDK-facing Stripe billing-portal session
// =============================================================
//
// Treat this route as an auth surface, not a convenience endpoint: the
// URL it returns grants access to a customer's payment data on Stripe.
//
//   - Subscriber identity comes ONLY from `appUserContext` (the
//     `X-Rovenue-App-User-Id` header, resolved server-side against the
//     authenticated project) — same mechanism as `/v1/me`. The body
//     schema is `.strict()` with no customer-id field, so a client
//     cannot smuggle one in even by naming it something plausible; an
//     unknown body key 400s before the handler runs at all.
//   - The account is resolved exactly once, inside
//     `createBillingPortalSession`, via `requireConnectedStripe`. This
//     route introduces no second path to a Stripe account.
//   - Mounted on the v1 surface (`routes/v1/index.ts`), which already
//     applies `apiKeyAuth("any")` + `apiKeyRateLimit()` to every request
//     before it reaches here — an unauthenticated call never gets this
//     far.
//   - Deliberately NOT guarded against `c.get("subscriberDeadEnded")`,
//     unlike /v1/checkout. This handler never writes to Postgres and
//     never stamps Stripe metadata that a webhook resolves back onto the
//     subscriber row -- it only reads the subscriber's EXISTING Stripe
//     customer id (funnelPurchaseRepo) and asks Stripe for a portal URL
//     into that customer's own billing history. There is no write path
//     here for an erased subject to re-populate, and erasure already
//     cancels their live Stripe subscriptions (anonymizeSubscriber) --
//     so a dead-ended subscriber with a past Stripe customer can, at
//     most, view billing history Stripe itself already retains. Revisit
//     this if the handler ever starts writing to our own tables.

const bodySchema = z
  .object({
    returnUrl: z.string().url(),
  })
  .strict();

export const billingPortalRoute = new Hono()
  .use("*", appUserContext)
  .post("/", validate("json", bodySchema), async (c) => {
    const project = c.get("project");
    const subscriber = c.get("subscriber");
    const { returnUrl } = c.req.valid("json");

    try {
      const session = await createBillingPortalSession({
        db: drizzle.db,
        projectId: project.id,
        subscriberId: subscriber.id,
        returnUrl,
      });
      return c.json(ok(session));
    } catch (err) {
      if (err instanceof ReturnUrlNotAllowedError) {
        throw new HTTPException(400, {
          message:
            "returnUrl must be a project's verified custom domain over https",
          cause: ERROR_CODE.RETURN_URL_NOT_ALLOWED,
        });
      }
      // The normal case for a subscriber whose entitlements come from
      // Apple or Google only — a clean, typed failure, not a 500 and not
      // an empty portal session.
      if (err instanceof NoStripeCustomerError) {
        throw new HTTPException(404, {
          message: "This subscriber has no Stripe billing history",
          cause: ERROR_CODE.STRIPE_CUSTOMER_NOT_FOUND,
        });
      }
      if (err instanceof StripeNotConnectedError) {
        throw new HTTPException(503, {
          message: "Stripe is not connected for this project",
          cause: ERROR_CODE.STRIPE_NOT_CONNECTED,
        });
      }
      throw err;
    }
  });
