import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import {
  attributesBodySchema,
  normalizeStored,
  applyMutations,
  flattenAttributes,
  validateAttributeInput,
} from "@rovenue/shared";
import {
  getBalance,
  InsufficientCreditsError,
  spendCredits,
} from "../../services/credit-engine";
import { appUserContext } from "../../middleware/app-user-context";
import { idempotency } from "../../middleware/idempotency";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { buildAccessResponse } from "../../lib/access-response";
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

export const meSpendBodySchema = z.object({
  amount: z.number().int().positive(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Throttle spend per *subscriber* so a single user can't burn a
// project's spend budget for others. Buckets are keyed on the
// resolved subscriber id, set by `appUserContext`.
const meSpendEndpointLimit = endpointRateLimit({
  name: "me-credits-spend",
  max: 60,
  identify: (c) => {
    const projectId = c.get("project")?.id ?? "anon";
    const subscriberId = c.get("subscriber")?.id ?? "anon";
    return `${projectId}:${subscriberId}`;
  },
});

export const meRoute = new Hono()
  // Every /me endpoint requires the header → subscriber resolution.
  .use("*", appUserContext)
  // -------------------------------------------------------------
  // GET /me — subscriber profile + access + credit summary
  // -------------------------------------------------------------
  .get("/", async (c) => {
    const subscriber = c.get("subscriber");
    const [access, balance] = await Promise.all([
      buildAccessResponse(subscriber.id),
      getBalance(subscriber.id),
    ]);
    return c.json(
      ok({
        subscriber: {
          id: subscriber.id,
          appUserId: subscriber.appUserId,
          attributes: flattenAttributes(subscriber.attributes),
        },
        access,
        credits: { balance },
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
  // GET /me/credits
  // -------------------------------------------------------------
  .get("/credits", async (c) => {
    const subscriber = c.get("subscriber");
    const balance = await getBalance(subscriber.id);
    return c.json(ok({ balance }));
  })
  // -------------------------------------------------------------
  // POST /me/credits/spend — SDK-callable consume
  // -------------------------------------------------------------
  // Public key is accepted here (unlike `/subscribers/:id/credits/
  // spend`) because the subscriber is derived from the header set by
  // the client SDK, so the caller can only debit themselves.
  // Idempotency-Key required to make retries safe.
  .post(
    "/credits/spend",
    meSpendEndpointLimit,
    idempotency,
    zValidator("json", meSpendBodySchema),
    async (c) => {
      const subscriber = c.get("subscriber");
      const body = c.req.valid("json");

      try {
        const entry = await spendCredits({
          subscriberId: subscriber.id,
          amount: body.amount,
          description: body.description,
          metadata: body.metadata as Record<string, unknown> | undefined,
        });
        return c.json(
          ok({
            balance: entry.balance,
            ledgerEntry: {
              id: entry.id,
              amount: entry.amount,
              balance: entry.balance,
              type: entry.type,
              createdAt: entry.createdAt.toISOString(),
            },
          }),
        );
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          throw new HTTPException(402, {
            message: `Insufficient credits: ${err.balance} available, ${err.requested} requested`,
          });
        }
        throw err;
      }
    },
  )
  // -------------------------------------------------------------
  // POST /me/attributes — merge subscriber attributes
  // -------------------------------------------------------------
  .post(
    "/attributes",
    zValidator("json", meAttributesBodySchema),
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

      const updated = await drizzle.subscriberRepo.upsertSubscriber(
        drizzle.db,
        {
          projectId: project.id,
          rovenueId: subscriber.rovenueId,
          createAttributes: merged,
          updateAttributes: merged,
        },
      );

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
