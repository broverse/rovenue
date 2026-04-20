import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import prisma, {
  CreditLedgerType,
  type Prisma,
  type Subscriber,
} from "@rovenue/db";
import {
  addCredits,
  getBalance,
  InsufficientCreditsError,
  spendCredits,
} from "../../services/credit-engine";
import {
  getActiveAccess,
  syncAccess,
} from "../../services/access-engine";
import { verifyReceipt } from "../../services/receipt-verify";
import { transferSubscriber } from "../../services/subscriber-transfer";
import { requireSecretKey } from "../../middleware/api-key-auth";
import { idempotency } from "../../middleware/idempotency";
import { endpointRateLimit } from "../../middleware/rate-limit";
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

export const attributesBodySchema = z.object({
  attributes: z.record(z.unknown()),
});

export const spendBodySchema = z.object({
  amount: z.number().int().positive(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const addBodySchema = z.object({
  amount: z.number().int().positive(),
  type: z.enum(["PURCHASE", "BONUS", "REFUND"]).optional(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const transferBodySchema = z.object({
  fromAppUserId: z.string().min(1),
  toAppUserId: z.string().min(1),
});

// =============================================================
// Helpers
// =============================================================

async function resolveSubscriber(
  projectId: string,
  appUserId: string,
): Promise<Subscriber> {
  const subscriber = await prisma.subscriber.findUnique({
    where: { projectId_appUserId: { projectId, appUserId } },
  });
  if (!subscriber) {
    throw new HTTPException(404, {
      message: `Subscriber ${appUserId} not found`,
    });
  }
  return subscriber;
}

async function buildAccessResponse(subscriberId: string) {
  const raw = await getActiveAccess(subscriberId);
  const purchaseIds = Array.from(
    new Set(Object.values(raw).map((entry) => entry.purchaseId)),
  );
  const purchases = purchaseIds.length
    ? await prisma.purchase.findMany({
        where: { id: { in: purchaseIds } },
        include: { product: { select: { identifier: true } } },
      })
    : [];
  const productByPurchase = new Map(
    purchases.map((p) => [p.id, p.product.identifier] as const),
  );

  const access: Record<
    string,
    {
      isActive: boolean;
      expiresDate: string | null;
      store: string;
      productIdentifier: string;
    }
  > = {};
  for (const [key, entry] of Object.entries(raw)) {
    access[key] = {
      isActive: entry.isActive,
      expiresDate: entry.expiresDate ? entry.expiresDate.toISOString() : null,
      store: entry.store,
      productIdentifier:
        productByPurchase.get(entry.purchaseId) ?? "unknown",
    };
  }
  return access;
}

// Throttle spend per *subscriber*, not per API key, so one noisy
// user can't DoS another's credits but multiple users share the
// ceiling.
const spendEndpointLimit = endpointRateLimit({
  name: "credits-spend",
  max: 60,
  identify: (c) => {
    const projectId = c.get("project")?.id ?? "anon";
    const appUserId = c.req.param("appUserId") ?? "anon";
    return `${projectId}:${appUserId}`;
  },
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

    let subscriber = await prisma.subscriber.findUnique({
      where: { projectId_appUserId: { projectId: project.id, appUserId } },
    });

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

      const subscriber = await prisma.subscriber.upsert({
        where: { projectId_appUserId: { projectId: project.id, appUserId } },
        create: {
          projectId: project.id,
          appUserId,
          attributes: body.attributes as Prisma.InputJsonValue,
        },
        update: {},
      });

      const currentAttributes =
        (subscriber.attributes as Record<string, unknown> | null) ?? {};
      const merged: Record<string, unknown> = {
        ...currentAttributes,
        ...body.attributes,
      };

      const updated = await prisma.subscriber.update({
        where: { id: subscriber.id },
        data: {
          attributes: merged as Prisma.InputJsonValue,
          lastSeenAt: new Date(),
        },
      });

      return c.json(
        ok({
          subscriber: {
            id: updated.id,
            appUserId: updated.appUserId,
            attributes: updated.attributes,
          },
        }),
      );
    },
  )
  // -------------------------------------------------------------
  // GET /:appUserId/credits
  // -------------------------------------------------------------
  .get("/:appUserId/credits", async (c) => {
    const project = c.get("project");
    const appUserId = c.req.param("appUserId");
    const subscriber = await resolveSubscriber(project.id, appUserId);
    const balance = await getBalance(subscriber.id);
    return c.json(ok({ balance }));
  })
  // -------------------------------------------------------------
  // POST /:appUserId/credits/spend
  // -------------------------------------------------------------
  // Requires a secret key — clients can't debit themselves.
  .post(
    "/:appUserId/credits/spend",
    requireSecretKey,
    spendEndpointLimit,
    idempotency,
    zValidator("json", spendBodySchema),
    async (c) => {
      const project = c.get("project");
      const appUserId = c.req.param("appUserId");
      const body = c.req.valid("json");
      const subscriber = await resolveSubscriber(project.id, appUserId);

      try {
        const entry = await spendCredits({
          subscriberId: subscriber.id,
          amount: body.amount,
          description: body.description,
          metadata: body.metadata as Prisma.InputJsonValue | undefined,
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
  // POST /:appUserId/credits/add (server-side only)
  // -------------------------------------------------------------
  .post(
    "/:appUserId/credits/add",
    requireSecretKey,
    idempotency,
    zValidator("json", addBodySchema),
    async (c) => {
      const project = c.get("project");
      const appUserId = c.req.param("appUserId");
      const body = c.req.valid("json");
      const subscriber = await resolveSubscriber(project.id, appUserId);

      const entry = await addCredits({
        subscriberId: subscriber.id,
        amount: body.amount,
        type: body.type
          ? (body.type as keyof typeof CreditLedgerType as CreditLedgerType)
          : undefined,
        referenceType: body.referenceType,
        referenceId: body.referenceId,
        description: body.description,
        metadata: body.metadata as Prisma.InputJsonValue | undefined,
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
