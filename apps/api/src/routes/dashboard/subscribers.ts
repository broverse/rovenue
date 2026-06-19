import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { MemberRole, drizzle } from "@rovenue/db";
import { assertProjectCapability } from "../../lib/capabilities";
import type {
  SubscriberDetail,
  SubscriberListItem,
  SubscriberListResponse,
} from "@rovenue/shared";
import { flattenAttributes, normalizeStored } from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { extractRequestContext } from "../../lib/audit";
import { anonymizeSubscriber } from "../../services/gdpr/anonymize-subscriber";
import { exportSubscriber } from "../../services/gdpr/export-subscriber";
import { listCreditHistory } from "../../services/credit-history";

const CREDIT_PREVIEW_LIMIT = 20;
const CREDIT_HISTORY_DEFAULT_LIMIT = 50;
const CREDIT_HISTORY_MAX_LIMIT = 100;

const creditHistoryQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CREDIT_HISTORY_MAX_LIMIT)
    .default(CREDIT_HISTORY_DEFAULT_LIMIT),
});

function decodeCreditHistoryCursor(
  raw: string | undefined,
): { createdAt: string; id: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as { createdAt?: unknown; id?: unknown };
    if (
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string"
    ) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function encodeCreditHistoryCursor(cursor: {
  createdAt: string;
  id: string;
}): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

// =============================================================
// Dashboard: Subscribers list (Task A6)
// =============================================================
//
// GET /dashboard/projects/:projectId/subscribers
//   ?cursor=<opaque>&limit=<1..100>&q=<search>
//
// Cursor pagination keyed on (createdAt DESC, id DESC) so the same
// tuple serves as both sort key and tie-breaker. `q` does a simple
// case-insensitive substring match on appUserId, rovenueId, and the
// subscriber id (surfaced as the "Rovenue ID" in the dashboard) — we
// stop there because JSON-column "contains anywhere" matching over the
// attributes blob isn't a portable filter.
//
// Detail endpoint lives in Task A7; this file is list-only.

// Recognise the `YYYY-MM-DD` calendar shape so it can be widened to
// the whole-day [00:00:00Z, 23:59:59.999Z] window on the way into the
// repo. Anything else (full ISO timestamp with time/zone) flows
// through unchanged.
const CALENDAR_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function widenLowerBound(parsed: Date, raw: string): Date {
  if (!CALENDAR_DAY_RE.test(raw)) return parsed;
  const widened = new Date(parsed);
  widened.setUTCHours(0, 0, 0, 0);
  return widened;
}

function widenUpperBound(parsed: Date, raw: string): Date {
  if (!CALENDAR_DAY_RE.test(raw)) return parsed;
  const widened = new Date(parsed);
  widened.setUTCHours(23, 59, 59, 999);
  return widened;
}

// Comma-separated platform list (`?platform=ios,android`) — kept as a
// single repeated key so the URL stays compact for shareable links.
const platformSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .transform((raw) =>
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  )
  .pipe(z.array(z.enum(["ios", "android", "web"])).min(1).max(3));

// Accepts either `YYYY-MM-DD` (treated as that day in UTC) or any
// ISO-8601 timestamp Date() can parse. Half-open dates (only `from`
// or only `to`) are supported so the popover can express "since X"
// or "until Y" without a fallback timestamp.
const dateBoundSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .transform((raw, ctx) => {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid date",
      });
      return z.NEVER;
    }
    return parsed;
  });

// Sort-aware cursor: `{ v: string, id: string }`. `v` is the raw
// SQL `text` representation of the previous page's last sort value
// (ISO timestamp for date sorts, decimal/integer for numeric ones).
// The repo casts it back to the column type per sort mode.
interface SubscribersCursor {
  v: string;
  id: string;
}

function decodeListCursor(raw: string | undefined): SubscribersCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as { v?: unknown; id?: unknown };
    if (typeof parsed.v !== "string" || typeof parsed.id !== "string") {
      return null;
    }
    return { v: parsed.v, id: parsed.id };
  } catch {
    return null;
  }
}

function encodeListCursor(cursor: SubscribersCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["active", "trial", "grace", "churned"]).optional(),
  access: z.string().trim().min(1).max(200).optional(),
  platform: platformSchema.optional(),
  // 2-letter country code; we upper-case both sides on the SQL side
  // so the input casing is forgiving.
  country: z.string().trim().length(2).optional(),
  ltvMin: z.coerce.number().min(0).max(1_000_000).optional(),
  // `lastSeenAt` range (inclusive). The route widens `from` to the
  // start of the day (UTC) and `to` to the end so a `YYYY-MM-DD`
  // pair behaves as the visible calendar range.
  from: dateBoundSchema.optional(),
  to: dateBoundSchema.optional(),
  // Sort key — default `last_activity` matches the toolbar control.
  // Each mode tiebreaks on `id DESC` so the keyset stays unique.
  sort: z
    .enum(["last_activity", "created", "ltv", "purchases"])
    .default("last_activity"),
});

// POST /:id/anonymize — GDPR / KVKK right-to-erasure. The body is
// optional (default `gdpr_request`) so the dashboard can fire the
// request without having to infer the legal basis up front.
const anonymizeBodySchema = z.object({
  reason: z
    .enum(["gdpr_request", "kvkk_request", "retention_policy"])
    .default("gdpr_request"),
});

// zValidator's default failure response is `{ success: false, error }`
// which doesn't go through our global error handler. Re-throwing as
// HTTPException routes the failure through `errorHandler` → the
// canonical `fail(VALIDATION_ERROR, message)` envelope.
function throwOnInvalid(
  result: { success: true } | { success: false; error: z.ZodError },
): void {
  if (!result.success) {
    throw new HTTPException(400, {
      message:
        result.error.errors[0]?.message ?? "Invalid query parameters",
    });
  }
}

export const subscribersRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get(
    "/",
    zValidator("query", listQuerySchema, throwOnInvalid),
    async (c) => {
  const projectId = c.req.param("projectId");
  if (!projectId) {
    throw new HTTPException(400, { message: "Missing projectId" });
  }
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

  const query = c.req.valid("query");
  const cursor = decodeListCursor(query.cursor);

  // Widen calendar-day inputs (`YYYY-MM-DD`) to whole-day bounds so
  // the inclusive UI semantics match SQL. Full ISO timestamps with
  // time/zone information come through untouched.
  const lastSeenFrom = query.from
    ? widenLowerBound(query.from, c.req.query("from") ?? "")
    : undefined;
  const lastSeenTo = query.to
    ? widenUpperBound(query.to, c.req.query("to") ?? "")
    : undefined;
  if (lastSeenFrom && lastSeenTo && lastSeenFrom > lastSeenTo) {
    throw new HTTPException(400, {
      message: "`from` must be earlier than `to`",
    });
  }

  // listSubscribers builds its own WHERE internally (projectId +
  // deletedAt IS NULL + optional text search + structured filters +
  // optional keyset cursor) — see
  // packages/db/src/drizzle/repositories/subscribers.ts.
  const fetchLimit = query.limit + 1;
  const rows = await drizzle.subscriberRepo.listSubscribers(drizzle.db, {
    projectId,
    cursor: cursor ? { value: cursor.v, id: cursor.id } : undefined,
    sort: query.sort,
    limit: fetchLimit,
    q: query.q,
    status: query.status,
    accessId: query.access,
    platforms: query.platform,
    country: query.country,
    ltvMin: query.ltvMin,
    lastSeenFrom,
    lastSeenTo,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeListCursor({ v: last.sortValue, id: last.id })
      : null;

  const subscribers: SubscriberListItem[] = page.map((s) => ({
    id: s.id,
    appUserId: s.appUserId,
    attributes: flattenAttributes(s.attributes),
    firstSeenAt: s.firstSeenAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    purchaseCount: s.purchaseCount,
    activeAccessIds: s.activeAccessIds,
    ltvUsd: s.ltvUsd,
    platforms: s.platforms,
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
  await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

  const subscriber = await drizzle.subscriberRepo.findSubscriberById(
    drizzle.db,
    id,
  );
  if (!subscriber || subscriber.projectId !== projectId) {
    throw new HTTPException(404, { message: "Subscriber not found" });
  }

  const [
    { access, purchases, assignments, outgoingWebhooks },
    creditPreview,
  ] = await Promise.all([
    drizzle.subscriberDetailRepo.loadSubscriberDetail(drizzle.db, id),
    listCreditHistory({
      projectId,
      subscriberId: id,
      limit: CREDIT_PREVIEW_LIMIT,
    }),
  ]);

  // The CH preview is sorted createdAt DESC, so the head row is the
  // most recent ledger entry — its `balance` is the running balance
  // post-mutation. Falls back to "0" for greenfield subscribers.
  const creditBalance = creditPreview.entries[0]?.balance ?? "0";

  const payload: SubscriberDetail = {
    id: subscriber.id,
    appUserId: subscriber.appUserId,
    attributes: normalizeStored(subscriber.attributes),
    firstSeenAt: subscriber.firstSeenAt.toISOString(),
    lastSeenAt: subscriber.lastSeenAt.toISOString(),
    deletedAt: subscriber.deletedAt?.toISOString() ?? null,
    mergedInto: subscriber.mergedInto,
    access: access.map((a) => ({
      accessId: a.accessId,
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
    creditBalance,
    creditLedger: creditPreview.entries,
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
  // Dashboard: Subscriber credit history (Plan 3 §B.1)
  // =============================================================
  //
  // GET /dashboard/projects/:projectId/subscribers/:id/credit-history
  //   ?cursor=<opaque>&limit=<1..100>
  //
  // Paginated CH-backed read of `raw_credit_ledger`. Keyset on
  // (createdAt DESC, eventId DESC) — opaque cursor encodes both.
  // Eventual consistency: rows just inserted into Postgres
  // `credit_ledger` may not appear until the outbox dispatcher
  // publishes (≤2s p99). Documented in Plan 3 ADR / §B.1.
  .get(
    "/:id/credit-history",
    zValidator("query", creditHistoryQuerySchema, throwOnInvalid),
    async (c) => {
    const projectId = c.req.param("projectId");
    const subscriberId = c.req.param("id");
    if (!projectId || !subscriberId) {
      throw new HTTPException(400, { message: "Missing path parameters" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const query = c.req.valid("query");

    // Cross-project hardening: 404 if the subscriber lives in a
    // different project (matches the detail endpoint's behaviour).
    const subscriber = await drizzle.subscriberRepo.findSubscriberById(
      drizzle.db,
      subscriberId,
    );
    if (!subscriber || subscriber.projectId !== projectId) {
      throw new HTTPException(404, { message: "Subscriber not found" });
    }

    const { entries, nextCursor } = await listCreditHistory({
      projectId,
      subscriberId,
      limit: query.limit,
      cursor: decodeCreditHistoryCursor(query.cursor),
    });

    return c.json(
      ok({
        entries,
        nextCursor: nextCursor ? encodeCreditHistoryCursor(nextCursor) : null,
      }),
    );
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
    await assertProjectCapability(projectId, user.id, "subscribers:write");

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
    await assertProjectCapability(projectId, user.id, "subscribers:write");

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
