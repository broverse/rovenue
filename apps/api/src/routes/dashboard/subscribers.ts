import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import type {
  SubscriberDetail,
  SubscriberListItem,
  SubscriberListResponse,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { encodeCursor, decodeCursor } from "../../lib/pagination";
import { extractRequestContext } from "../../lib/audit";
import { anonymizeSubscriber } from "../../services/gdpr/anonymize-subscriber";
import { exportSubscriber } from "../../services/gdpr/export-subscriber";

// =============================================================
// Dashboard: Subscribers list (Task A6)
// =============================================================
//
// GET /dashboard/projects/:projectId/subscribers
//   ?cursor=<opaque>&limit=<1..100>&q=<search>
//
// Cursor pagination keyed on (createdAt DESC, id DESC) so the same
// tuple serves as both sort key and tie-breaker. `q` does a simple
// case-insensitive substring match on appUserId — we stop there
// because JSON-column "contains anywhere" matching over the
// attributes blob isn't a portable filter.
//
// Detail endpoint lives in Task A7; this file is list-only.

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().min(1).max(200).optional(),
});

// POST /:id/anonymize — GDPR / KVKK right-to-erasure. The body is
// optional (default `gdpr_request`) so the dashboard can fire the
// request without having to infer the legal basis up front.
const anonymizeBodySchema = z.object({
  reason: z
    .enum(["gdpr_request", "kvkk_request", "retention_policy"])
    .default("gdpr_request"),
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

  // listSubscribers builds its own WHERE internally (projectId +
  // deletedAt IS NULL + optional text search + optional keyset
  // cursor) — see packages/db/src/drizzle/repositories/subscribers.ts.
  const fetchLimit = query.limit + 1;
  const rows = await drizzle.subscriberRepo.listSubscribers(drizzle.db, {
    projectId,
    cursor: cursor ?? undefined,
    limit: fetchLimit,
    q: query.q,
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
    purchaseCount: s.purchaseCount,
    activeEntitlementKeys: s.activeEntitlementKeys,
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

  const subscriber = await drizzle.subscriberRepo.findSubscriberById(
    drizzle.db,
    id,
  );
  if (!subscriber || subscriber.projectId !== projectId) {
    throw new HTTPException(404, { message: "Subscriber not found" });
  }

  const {
    access,
    purchases,
    latestBalance,
    ledger,
    assignments,
    outgoingWebhooks,
  } = await drizzle.subscriberDetailRepo.loadSubscriberDetail(
    drizzle.db,
    id,
  );

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
      productIdentifier: p.productIdentifier,
      store: p.store,
      status: p.status,
      priceAmount: p.priceAmount?.toString() ?? null,
      priceCurrency: p.priceCurrency,
      purchaseDate: p.purchaseDate.toISOString(),
      expiresDate: p.expiresDate?.toISOString() ?? null,
      autoRenewStatus: p.autoRenewStatus,
    })),
    creditBalance: String(latestBalance),
    creditLedger: ledger.map((l) => ({
      id: l.id,
      type: l.type,
      amount: String(l.amount),
      balance: String(l.balance),
      referenceType: l.referenceType,
      description: l.description,
      createdAt: l.createdAt.toISOString(),
    })),
    assignments: assignments.map((a) => ({
      experimentId: a.experimentId,
      experimentKey: a.experimentKey,
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
  })
  // =============================================================
  // Dashboard: Anonymize subscriber (Task 4.2 — GDPR / KVKK)
  // =============================================================
  //
  // POST /dashboard/projects/:projectId/subscribers/:id/anonymize
  //
  // ADMIN-and-above only. Delegates to the Task 4.1 service which
  // hard-replaces appUserId with a deterministic `anon_<hmac[:24]>`
  // token, clears attributes, stamps deletedAt, and writes a
  // tamper-evident audit entry inside a single transaction.
  .post("/:id/anonymize", async (c) => {
    const projectId = c.req.param("projectId");
    const subscriberId = c.req.param("id");
    if (!projectId || !subscriberId) {
      throw new HTTPException(400, { message: "Missing path parameters" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

    let body: z.infer<typeof anonymizeBodySchema>;
    try {
      body = anonymizeBodySchema.parse(
        await c.req.json().catch(() => ({})),
      );
    } catch {
      throw new HTTPException(400, { message: "Invalid body" });
    }

    const { ipAddress, userAgent } = extractRequestContext(c);

    const result = await anonymizeSubscriber({
      subscriberId,
      projectId,
      actorUserId: user.id,
      reason: body.reason,
      ipAddress,
      userAgent,
    });

    return c.json(ok(result));
  })
  // =============================================================
  // Dashboard: Export subscriber (Task 4.3 — GDPR Art. 15)
  // =============================================================
  //
  // GET /dashboard/projects/:projectId/subscribers/:id/export
  //
  // ADMIN-and-above only. Produces a JSON dump of every row we
  // hold for the subscriber (subscriber + purchases + access +
  // credit ledger) and writes a `subscriber.exported` audit
  // entry. `content-disposition: attachment` hints the browser
  // to save-as rather than render inline.
  .get("/:id/export", async (c) => {
    const projectId = c.req.param("projectId");
    const subscriberId = c.req.param("id");
    if (!projectId || !subscriberId) {
      throw new HTTPException(400, { message: "Missing path parameters" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

    const { ipAddress, userAgent } = extractRequestContext(c);

    const dump = await exportSubscriber({
      subscriberId,
      projectId,
      actorUserId: user.id,
      ipAddress,
      userAgent,
    });

    c.header(
      "content-disposition",
      `attachment; filename="subscriber-${subscriberId}.json"`,
    );
    return c.json(ok(dump));
  });
