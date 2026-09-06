import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { drizzle } from "@rovenue/db";
import {
  attributesBodySchema,
  normalizeStored,
  applyMutations,
  flattenAttributes,
  validateAttributeInput,
} from "@rovenue/shared";
import { appUserContext } from "../../middleware/app-user-context";
import { buildAccessResponse } from "../../lib/access-response";
import { publishSubscriberInvalidation } from "../../lib/config-invalidation";
import { ok } from "../../lib/response";

// =============================================================
// /v1/me — subscriber-scoped routes
// =============================================================
//
// Routes here resolve the subscriber from the
// `X-Rovenue-App-User-Id` header (set by `appUserContext`) instead
// of taking an appUserId path param. The SDK uses these endpoints
// so it does not have to repeat the user id in every URL. The
// equivalent `/v1/subscribers/:appUserId/*` family remains for
// server-to-server callers operating on behalf of a different user.

export const meAttributesBodySchema = attributesBodySchema;

export const meRoute = new Hono()
  // Every /me endpoint requires the header → subscriber resolution.
  .use("*", appUserContext)
  // -------------------------------------------------------------
  // GET /me — subscriber profile + access
  // -------------------------------------------------------------
  .get("/", async (c) => {
    const subscriber = c.get("subscriber");
    const access = await buildAccessResponse(subscriber.id);
    return c.json(
      ok({
        subscriber: {
          id: subscriber.id,
          appUserId: subscriber.appUserId,
          attributes: flattenAttributes(subscriber.attributes),
        },
        access,
      }),
    );
  })
  // -------------------------------------------------------------
  // GET /me/access
  // -------------------------------------------------------------
  .get("/access", async (c) => {
    const subscriber = c.get("subscriber");
    const access = await buildAccessResponse(subscriber.id);
    return c.json(ok({ access }));
  })
  // -------------------------------------------------------------
  // GET /me/entitlements — SDK entitlements contract
  // -------------------------------------------------------------
  // Same data as /me/access; reshaped to { data: { entitlements } } so the
  // SDK core (entitlements/reader.rs) deserializes it. AccessResponseEntry
  // is byte-identical to the SDK's EntitlementWire.
  .get("/entitlements", async (c) => {
    const subscriber = c.get("subscriber");
    const entitlements = await buildAccessResponse(subscriber.id);
    return c.json(ok({ entitlements }));
  })
  // -------------------------------------------------------------
  // POST /me/attributes — merge subscriber attributes
  // -------------------------------------------------------------
  .post(
    "/attributes",
    validate("json", meAttributesBodySchema),
    async (c) => {
      const project = c.get("project");
      const subscriber = c.get("subscriber");
      const body = c.req.valid("json");

      const current = normalizeStored(subscriber.attributes);
      const errors = validateAttributeInput(body.attributes, current);
      if (errors.length > 0) {
        throw new HTTPException(400, {
          message: errors.map((e) => `${e.key}: ${e.reason}`).join("; "),
        });
      }

      const now = new Date().toISOString();
      const merged = applyMutations(current, body.attributes, "sdk", now);

      // A dead-ended row (GDPR-erased, or retired by a transfer merge)
      // must never be re-populated; report it untouched instead of
      // resurrecting it. Mirrors routes/v1/subscribers.ts, deliberately
      // including the 200: a 4xx would tell a device-side SDK that this
      // subject was erased, which is a disclosure to a party that is not
      // necessarily entitled to it and that the subject never asked for.
      if (c.get("subscriberDeadEnded")) {
        return c.json(
          ok({
            subscriber: {
              id: subscriber.id,
              appUserId: subscriber.appUserId,
              attributes: flattenAttributes(subscriber.attributes),
            },
          }),
        );
      }

      const updated = await drizzle.subscriberRepo.upsertSubscriber(
        drizzle.db,
        {
          projectId: project.id,
          rovenueId: subscriber.rovenueId,
          createAttributes: merged,
          updateAttributes: merged,
        },
      );

      await publishSubscriberInvalidation(project.id, [updated.id]);

      return c.json(
        ok({
          subscriber: {
            id: updated.id,
            appUserId: updated.appUserId,
            attributes: flattenAttributes(updated.attributes),
          },
        }),
      );
    },
  );
