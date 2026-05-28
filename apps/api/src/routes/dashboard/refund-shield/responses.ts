import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq, lt, gte, lte } from "drizzle-orm";
import { MemberRole, drizzle, getDb } from "@rovenue/db";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../../lib/project-access";
import { ok } from "../../../lib/response";

// =============================================================
// Dashboard: Refund Shield — responses list + detail (T17)
// =============================================================
//
//   GET /dashboard/projects/:projectId/refund-shield/responses
//     ?status=PENDING|SENT|FAILED|SKIPPED_DISABLED|SKIPPED_NOT_FOUND
//     &outcome=REFUND_APPROVED|REFUND_DECLINED|REFUND_REVERSED
//     &since=ISO8601 &until=ISO8601
//     &limit=1..100 (default 50) &cursor=ISO8601 (detectedAt of last row)
//
//   GET /dashboard/projects/:projectId/refund-shield/responses/:rid
//
// Read-only — viewer (CUSTOMER_SUPPORT) and above. Cursor pagination
// keyed on `detectedAt` (matches the dashboard index ordering).

const { refundShieldResponses } = drizzle.schema;

const STATUSES = [
  "PENDING",
  "SENT",
  "FAILED",
  "SKIPPED_DISABLED",
  "SKIPPED_NOT_FOUND",
] as const;
const OUTCOMES = [
  "REFUND_APPROVED",
  "REFUND_DECLINED",
  "REFUND_REVERSED",
] as const;

const listQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  outcome: z.enum(OUTCOMES).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().datetime().optional(),
});

interface ResponseWire {
  id: string;
  projectId: string;
  subscriberId: string | null;
  appleNotificationUuid: string;
  appleOriginalTransactionId: string;
  appleTransactionId: string;
  detectedAt: string;
  scheduledFor: string;
  sentAt: string | null;
  status: string;
  outcome: string | null;
  outcomeReceivedAt: string | null;
  appleHttpStatus: number | null;
  error: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}

function toListWire(row: typeof refundShieldResponses.$inferSelect): ResponseWire {
  return {
    id: row.id,
    projectId: row.projectId,
    subscriberId: row.subscriberId,
    appleNotificationUuid: row.appleNotificationUuid,
    appleOriginalTransactionId: row.appleOriginalTransactionId,
    appleTransactionId: row.appleTransactionId,
    detectedAt: row.detectedAt.toISOString(),
    scheduledFor: row.scheduledFor.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    status: row.status,
    outcome: row.outcome,
    outcomeReceivedAt: row.outcomeReceivedAt?.toISOString() ?? null,
    appleHttpStatus: row.appleHttpStatus,
    error: row.error,
    retryCount: row.retryCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetailWire(
  row: typeof refundShieldResponses.$inferSelect,
): ResponseWire & {
  requestPayload: unknown;
  appleResponseBody: string | null;
} {
  return {
    ...toListWire(row),
    requestPayload: row.requestPayload,
    appleResponseBody: row.appleResponseBody,
  };
}

export const refundShieldResponsesRoute = new Hono()
  .use("*", requireDashboardAuth)
  // ----- GET /responses -----
  .get("/", zValidator("query", listQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const q = c.req.valid("query");
    const db = getDb();

    const wheres = [eq(refundShieldResponses.projectId, projectId)];
    if (q.status) wheres.push(eq(refundShieldResponses.status, q.status));
    if (q.outcome) wheres.push(eq(refundShieldResponses.outcome, q.outcome));
    if (q.since)
      wheres.push(gte(refundShieldResponses.detectedAt, new Date(q.since)));
    if (q.until)
      wheres.push(lte(refundShieldResponses.detectedAt, new Date(q.until)));
    if (q.cursor)
      wheres.push(lt(refundShieldResponses.detectedAt, new Date(q.cursor)));

    // limit + 1 to detect a next page without a separate count query.
    const rows = await db
      .select()
      .from(refundShieldResponses)
      .where(and(...wheres))
      .orderBy(desc(refundShieldResponses.detectedAt))
      .limit(q.limit + 1);

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const nextCursor =
      hasMore && page.length > 0
        ? page[page.length - 1]!.detectedAt.toISOString()
        : null;

    return c.json(
      ok({
        responses: page.map(toListWire),
        nextCursor,
      }),
    );
  })
  // ----- GET /responses/:rid -----
  .get("/:rid", async (c) => {
    const projectId = c.req.param("projectId");
    const rid = c.req.param("rid");
    if (!projectId || !rid) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const db = getDb();
    const rows = await db
      .select()
      .from(refundShieldResponses)
      .where(
        and(
          eq(refundShieldResponses.id, rid),
          eq(refundShieldResponses.projectId, projectId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new HTTPException(404, { message: "Response not found" });
    }
    return c.json(ok({ response: toDetailWire(row) }));
  });
