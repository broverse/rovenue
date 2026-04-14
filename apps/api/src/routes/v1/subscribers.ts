import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma, {
  CreditLedgerType,
  Store,
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
import { requireSecretKey } from "../../middleware/api-key-auth";
import { idempotency } from "../../middleware/idempotency";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:v1:subscribers");

export const subscribersRoute = new Hono();

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

// =============================================================
// GET /:appUserId/access
// =============================================================

subscribersRoute.get("/:appUserId/access", async (c) => {
  const project = c.get("project");
  const appUserId = c.req.param("appUserId");
  const subscriber = await resolveSubscriber(project.id, appUserId);
  const access = await buildAccessResponse(subscriber.id);
  return c.json(ok({ access }));
});

// =============================================================
// POST /:appUserId/restore
// =============================================================

const restoreBodySchema = z
  .object({
    receipts: z
      .array(
        z.object({
          store: z.enum(["APP_STORE", "PLAY_STORE"]),
          receipt: z.string().min(1),
          productId: z.string().min(1),
        }),
      )
      .optional(),
  })
  .optional();

subscribersRoute.post("/:appUserId/restore", async (c) => {
  const project = c.get("project");
  const appUserId = c.req.param("appUserId");

  // Attempt to resolve, but also allow restore for a brand-new subscriber.
  let subscriber = await prisma.subscriber.findUnique({
    where: { projectId_appUserId: { projectId: project.id, appUserId } },
  });

  const rawBody = await c.req.json().catch(() => ({}));
  const body = restoreBodySchema.parse(rawBody);
  const restored: Array<{ productId: string; store: string }> = [];

  if (body?.receipts?.length) {
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
});

// =============================================================
// POST /:appUserId/attributes
// =============================================================

const attributesBodySchema = z.object({
  attributes: z.record(z.unknown()),
});

subscribersRoute.post("/:appUserId/attributes", async (c) => {
  const project = c.get("project");
  const appUserId = c.req.param("appUserId");
  const body = attributesBodySchema.parse(await c.req.json());

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
});

// =============================================================
// GET /:appUserId/credits
// =============================================================

subscribersRoute.get("/:appUserId/credits", async (c) => {
  const project = c.get("project");
  const appUserId = c.req.param("appUserId");
  const subscriber = await resolveSubscriber(project.id, appUserId);
  const balance = await getBalance(subscriber.id);
  return c.json(ok({ balance }));
});

// =============================================================
// POST /:appUserId/credits/spend
// =============================================================

const spendBodySchema = z.object({
  amount: z.number().int().positive(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

subscribersRoute.post(
  "/:appUserId/credits/spend",
  requireSecretKey,
  idempotency,
  async (c) => {
    const project = c.get("project");
    const appUserId = c.req.param("appUserId");
    const body = spendBodySchema.parse(await c.req.json());
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
});

// =============================================================
// POST /:appUserId/credits/add (server-side only — secret key required)
// =============================================================

const addBodySchema = z.object({
  amount: z.number().int().positive(),
  type: z
    .enum(["PURCHASE", "BONUS", "REFUND"])
    .optional(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

subscribersRoute.post(
  "/:appUserId/credits/add",
  requireSecretKey,
  idempotency,
  async (c) => {
    const project = c.get("project");
    const appUserId = c.req.param("appUserId");
    const body = addBodySchema.parse(await c.req.json());
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
);

// Silence unused import when Store is not referenced directly but kept
// for potential future expansion of the response shape.
void Store;
