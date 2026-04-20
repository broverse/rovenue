import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma, { MemberRole, type Prisma } from "@rovenue/db";
import type {
  SubscriberDetail,
  SubscriberListItem,
  SubscriberListResponse,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { encodeCursor, decodeCursor } from "../../lib/pagination";

// =============================================================
// Dashboard: Subscribers list (Task A6)
// =============================================================
//
// GET /dashboard/projects/:projectId/subscribers
//   ?cursor=<opaque>&limit=<1..100>&q=<search>
//
// Cursor pagination keyed on (createdAt DESC, id DESC) so the same
// tuple serves as both sort key and tie-breaker. `q` does a simple
// case-insensitive substring match on appUserId — we intentionally
// stop there because Prisma 6's JSON filter surface doesn't expose a
// portable "contains anywhere" over the attributes blob.
//
// Detail endpoint lives in Task A7; this file is list-only.

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().min(1).max(200).optional(),
});

export const subscribersRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
  const projectId = c.req.param("projectId");
  if (!projectId) {
    throw new HTTPException(400, { message: "Missing projectId" });
  }
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

  let query: z.infer<typeof listQuerySchema>;
  try {
    query = listQuerySchema.parse({
      cursor: c.req.query("cursor"),
      limit: c.req.query("limit"),
      q: c.req.query("q"),
    });
  } catch (err) {
    throw new HTTPException(400, {
      message:
        err instanceof z.ZodError
          ? err.errors[0]?.message ?? "Invalid query parameters"
          : "Invalid query parameters",
    });
  }

  const cursor = decodeCursor(query.cursor);

  // Compose the where clause as AND parts (text search + keyset
  // cursor) layered on top of the tenancy + soft-delete filters so
  // the shape stays flat when there are no optional predicates.
  const and: Prisma.SubscriberWhereInput[] = [];

  if (query.q) {
    and.push({
      appUserId: { contains: query.q, mode: "insensitive" },
    });
  }

  if (cursor) {
    and.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    });
  }

  const where: Prisma.SubscriberWhereInput = {
    projectId,
    deletedAt: null,
    ...(and.length > 0 && { AND: and }),
  };

  const rows = await prisma.subscriber.findMany({
    where,
    take: query.limit + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      _count: { select: { purchases: true } },
      access: {
        where: {
          isActive: true,
          OR: [{ expiresDate: null }, { expiresDate: { gt: new Date() } }],
        },
        select: { entitlementKey: true },
      },
    },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  const subscribers: SubscriberListItem[] = page.map((s) => ({
    id: s.id,
    appUserId: s.appUserId,
    attributes: (s.attributes as Record<string, unknown> | null) ?? {},
    firstSeenAt: s.firstSeenAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    purchaseCount: s._count.purchases,
    activeEntitlementKeys: [
      ...new Set(s.access.map((a: { entitlementKey: string }) => a.entitlementKey)),
    ],
  }));

    const response: SubscriberListResponse = { subscribers, nextCursor };
    return c.json(ok(response));
  })
  // =============================================================
  // Dashboard: Subscriber detail (Task A7)
  // =============================================================
  //
  // GET /dashboard/projects/:projectId/subscribers/:id
  //
  // Fans out via Promise.all to gather access, purchases (last 50),
  // credit balance + last 20 ledger entries, experiment assignments
  // (with experiment.key), and last 20 outgoing webhooks. Cross-
  // project lookups 404 explicitly. Response matches the
  // SubscriberDetail wire contract in @rovenue/shared.
  .get("/:id", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  if (!projectId || !id) {
    throw new HTTPException(400, { message: "Missing projectId or id" });
  }
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

  const subscriber = await prisma.subscriber.findUnique({
    where: { id },
    select: {
      id: true,
      projectId: true,
      appUserId: true,
      attributes: true,
      firstSeenAt: true,
      lastSeenAt: true,
      deletedAt: true,
      mergedInto: true,
    },
  });
  if (!subscriber || subscriber.projectId !== projectId) {
    throw new HTTPException(404, { message: "Subscriber not found" });
  }

  const [purchases, access, latestLedger, ledger, assignments, outgoingWebhooks] =
    await Promise.all([
      prisma.purchase.findMany({
        where: { subscriberId: id },
        orderBy: { purchaseDate: "desc" },
        take: 50,
        include: { product: { select: { identifier: true } } },
      }),
      prisma.subscriberAccess.findMany({
        where: { subscriberId: id },
        orderBy: { entitlementKey: "asc" },
      }),
      prisma.creditLedger.findFirst({
        where: { subscriberId: id },
        orderBy: { createdAt: "desc" },
        select: { balance: true },
      }),
      prisma.creditLedger.findMany({
        where: { subscriberId: id },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.experimentAssignment.findMany({
        where: { subscriberId: id },
        orderBy: { assignedAt: "desc" },
        include: { experiment: { select: { key: true } } },
      }),
      prisma.outgoingWebhook.findMany({
        where: { subscriberId: id },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);

  const payload: SubscriberDetail = {
    id: subscriber.id,
    appUserId: subscriber.appUserId,
    attributes: (subscriber.attributes as Record<string, unknown> | null) ?? {},
    firstSeenAt: subscriber.firstSeenAt.toISOString(),
    lastSeenAt: subscriber.lastSeenAt.toISOString(),
    deletedAt: subscriber.deletedAt?.toISOString() ?? null,
    mergedInto: subscriber.mergedInto,
    access: access.map((a) => ({
      entitlementKey: a.entitlementKey,
      isActive: a.isActive,
      expiresDate: a.expiresDate?.toISOString() ?? null,
      store: a.store,
      purchaseId: a.purchaseId,
    })),
    purchases: purchases.map((p) => ({
      id: p.id,
      productId: p.productId,
      productIdentifier: p.product.identifier,
      store: p.store,
      status: p.status,
      priceAmount: p.priceAmount?.toString() ?? null,
      priceCurrency: p.priceCurrency,
      purchaseDate: p.purchaseDate.toISOString(),
      expiresDate: p.expiresDate?.toISOString() ?? null,
      autoRenewStatus: p.autoRenewStatus,
    })),
    creditBalance: latestLedger?.balance.toString() ?? "0",
    creditLedger: ledger.map((l) => ({
      id: l.id,
      type: l.type,
      amount: l.amount.toString(),
      balance: l.balance.toString(),
      referenceType: l.referenceType,
      description: l.description,
      createdAt: l.createdAt.toISOString(),
    })),
    assignments: assignments.map((a) => ({
      experimentId: a.experimentId,
      experimentKey: a.experiment.key,
      variantId: a.variantId,
      assignedAt: a.assignedAt.toISOString(),
      convertedAt: a.convertedAt?.toISOString() ?? null,
      revenue: a.revenue?.toString() ?? null,
    })),
    outgoingWebhooks: outgoingWebhooks.map((w) => ({
      id: w.id,
      eventType: w.eventType,
      url: w.url,
      status: w.status,
      attempts: w.attempts,
      createdAt: w.createdAt.toISOString(),
      sentAt: w.sentAt?.toISOString() ?? null,
      lastErrorMessage: w.lastErrorMessage,
    })),
  };

    return c.json(ok({ subscriber: payload }));
  });
