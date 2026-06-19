import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle, type Subscriber } from "@rovenue/db";
import {
  attributesBodySchema,
  normalizeStored,
  applyMutations,
  flattenAttributes,
  validateAttributeInput,
} from "@rovenue/shared";
import { syncAccess } from "../../services/access-engine";
import { verifyReceipt } from "../../services/receipt-verify";
import { transferSubscriber } from "../../services/subscriber-transfer";
import { requireSecretKey } from "../../middleware/api-key-auth";
import { buildAccessResponse } from "../../lib/access-response";
import { resolveSubscriber } from "../../lib/resolve-subscriber";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

// =============================================================
// /v1/subscribers — SDK + server-side subscriber operations
// =============================================================
//
// Chained handlers surface every body schema through AppType so
// RPC consumers (dashboard, SDK, admin tooling) get compile-time
// body validation + response typing. `requireSecretKey` gates
// mutations that only a server-to-server caller should perform
// (add/transfer); public SDK keys can read access + spend credits.

const log = logger.child("route:v1:subscribers");

// =============================================================
// Body schemas (exported so tests / shared packages can reuse)
// =============================================================

export const restoreBodySchema = z.object({
  receipts: z
    .array(
      z.object({
        store: z.enum(["APP_STORE", "PLAY_STORE"]),
        receipt: z.string().min(1),
        productId: z.string().min(1),
      }),
    )
    .optional(),
});

export const transferBodySchema = z.object({
  fromAppUserId: z.string().min(1),
  toAppUserId: z.string().min(1),
});

// =============================================================
// Route chain
// =============================================================

export const subscribersRoute = new Hono()
  // -------------------------------------------------------------
  // GET /:appUserId/access
  // -------------------------------------------------------------
  .get("/:appUserId/access", async (c) => {
    const project = c.get("project");
    const appUserId = c.req.param("appUserId");
    const subscriber = await resolveSubscriber(project.id, appUserId);
    const access = await buildAccessResponse(subscriber.id);
    return c.json(ok({ access }));
  })
  // -------------------------------------------------------------
  // POST /:appUserId/restore
  // -------------------------------------------------------------
  // Restore is permissive on the body because the SDK may call it
  // with no receipts (e.g. just to sync a previously-known account).
  // zValidator keeps the shape correct but we drive downstream
  // logic off the optional `receipts` array directly.
  .post("/:appUserId/restore", zValidator("json", restoreBodySchema), async (c) => {
    const project = c.get("project");
    const appUserId = c.req.param("appUserId");
    const body = c.req.valid("json");

    // The path param is the device key (rovenueId in the new model),
    // so resolve by rovenueId (following any merge redirect) rather
    // than by appUserId.
    let subscriber =
      (await drizzle.subscriberRepo.resolveSubscriberByRovenueId(
        drizzle.db,
        { projectId: project.id, rovenueId: appUserId },
      )) as Subscriber | null;

    const restored: Array<{ productId: string; store: string }> = [];

    if (body.receipts?.length) {
      for (const entry of body.receipts) {
        try {
          const result = await verifyReceipt({
            projectId: project.id,
            store: entry.store,
            receipt: entry.receipt,
            productId: entry.productId,
            appUserId,
          });
          subscriber = result.subscriber;
          restored.push({ productId: entry.productId, store: entry.store });
        } catch (err) {
          log.warn("restore: receipt verify failed", {
            projectId: project.id,
            appUserId,
            productId: entry.productId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (!subscriber) {
      throw new HTTPException(404, {
        message: `Subscriber ${appUserId} not found and no receipts provided`,
      });
    }

    await syncAccess(subscriber.id);

    const access = await buildAccessResponse(subscriber.id);
    return c.json(ok({ access, restored }));
  })
  // -------------------------------------------------------------
  // POST /:appUserId/attributes
  // -------------------------------------------------------------
  .post(
    "/:appUserId/attributes",
    zValidator("json", attributesBodySchema),
    async (c) => {
      const project = c.get("project");
      const appUserId = c.req.param("appUserId");
      const body = c.req.valid("json");

      // Read existing attributes so we can compute the merge. The path
      // param is the device key (rovenueId); read the merge base from
      // the rovenueId-keyed row so it matches the upsert target below.
      // A missing subscriber is treated as "no attributes yet".
      const existing =
        await drizzle.subscriberRepo.findSubscriberAttributesByRovenueId(
          drizzle.db,
          { projectId: project.id, rovenueId: appUserId },
        );
      const current = normalizeStored(existing?.attributes);
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
          rovenueId: appUserId,
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
  )
  // -------------------------------------------------------------
  // POST /transfer — account merge (server-side only)
  // -------------------------------------------------------------
  .post(
    "/transfer",
    requireSecretKey,
    zValidator("json", transferBodySchema),
    async (c) => {
      const project = c.get("project");
      const body = c.req.valid("json");

      try {
        const result = await transferSubscriber(
          project.id,
          body.fromAppUserId,
          body.toAppUserId,
        );

        log.info("subscriber transfer completed", {
          projectId: project.id,
          ...result,
        });

        return c.json(ok(result));
      } catch (err) {
        if (err instanceof Error) {
          throw new HTTPException(400, { message: err.message });
        }
        throw err;
      }
    },
  );
