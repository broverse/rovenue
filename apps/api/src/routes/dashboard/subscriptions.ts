import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole } from "@rovenue/db";
import {
  grantSubscriptionRequestSchema,
  scheduleActionRequestSchema,
  subscriptionSortKeys,
  subscriptionStoreCodes,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { grantComp } from "../../services/subscriptions/grant";
import {
  scheduleAction,
  listScheduledForProject,
  cancelScheduledAction,
} from "../../services/subscriptions/schedule";
import { streamSubscriptionsCsv } from "../../services/subscriptions/export-csv";
import { audit } from "../../lib/audit";
import {
  __subscriptionsConstants,
  decodeSubsCursor,
  listSubscriptions,
  readBillingIssues,
  readRenewalCalendar,
  readSubscriptionsComposition,
  readSubscriptionsKpis,
} from "../../services/metrics/subscriptions";

// =============================================================
// Dashboard: Subscriptions (Phase 3.3)
// =============================================================

const {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  CALENDAR_PAST_DEFAULT_DAYS,
  CALENDAR_FUTURE_DEFAULT_DAYS,
  CALENDAR_MAX_DAYS,
} = __subscriptionsConstants;

const subscriptionScopes = [
  "all",
  "active",
  "trial",
  "grace",
  "canceling",
  "issues",
  "churned",
] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PRODUCT_IDS = 50;

const csvList = <T extends string>(allowed: ReadonlyArray<T>) =>
  z
    .string()
    .min(1)
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return undefined;
      const seen = new Set<T>();
      for (const part of raw.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        if (!(allowed as ReadonlyArray<string>).includes(trimmed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown value: ${trimmed}`,
          });
          return z.NEVER;
        }
        seen.add(trimmed as T);
      }
      return seen.size > 0 ? (Array.from(seen) as ReadonlyArray<T>) : undefined;
    });

const csvIds = z
  .string()
  .min(1)
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined) return undefined;
    const ids = Array.from(
      new Set(
        raw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    );
    if (ids.length === 0) return undefined;
    if (ids.length > MAX_PRODUCT_IDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Too many ids (max ${MAX_PRODUCT_IDS})`,
      });
      return z.NEVER;
    }
    return ids as ReadonlyArray<string>;
  });

const boolish = z
  .enum(["true", "false"])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "true"));

const isoDate = z
  .string()
  .regex(ISO_DATE_RE, "expected YYYY-MM-DD")
  .optional();

// `subscriptionStoreCodes` + `subscriptionSortKeys` are exported from
// @rovenue/shared (added in Task 1). The Zod schema below pins to
// those tuples so the wire format and the shared type stay aligned.

const listQuerySchema = z.object({
  scope: z.enum(subscriptionScopes).default("all"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
  search: z.string().trim().min(1).optional(),
  store: csvList(subscriptionStoreCodes),
  productId: csvIds,
  autoRenew: boolish,
  isTrial: boolish,
  isIntro: boolish,
  hasIssue: z
    .enum(["true"])
    .optional()
    .transform((v) => v === "true"),
  purchasedFrom: isoDate,
  purchasedTo: isoDate,
  expiresFrom: isoDate,
  expiresTo: isoDate,
  sort: z.enum(subscriptionSortKeys).default("started_desc"),
});

const calendarQuerySchema = z.object({
  pastDays: z.coerce
    .number()
    .int()
    .min(0)
    .max(CALENDAR_MAX_DAYS)
    .default(CALENDAR_PAST_DEFAULT_DAYS),
  futureDays: z.coerce
    .number()
    .int()
    .min(0)
    .max(CALENDAR_MAX_DAYS)
    .default(CALENDAR_FUTURE_DEFAULT_DAYS),
});

const issuesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const exportQuerySchema = z.object({
  scope: z.enum(subscriptionScopes).default("all"),
  search: z.string().trim().min(1).optional(),
});

export const subscriptionsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", zValidator("query", listQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const q = c.req.valid("query");
    const cursor = q.cursor ? decodeSubsCursor(q.cursor, q.sort) : null;
    if (q.cursor && !cursor) {
      throw new HTTPException(400, { message: "Invalid cursor" });
    }

    const payload = await listSubscriptions({
      projectId,
      scope: q.scope,
      limit: q.limit,
      cursor,
      sort: q.sort,
      search: q.search ?? null,
      store: q.store ?? null,
      productId: q.productId ?? null,
      autoRenew: q.autoRenew ?? null,
      isTrial: q.isTrial ?? null,
      isIntro: q.isIntro ?? null,
      hasIssue: q.hasIssue,
      purchasedFrom: q.purchasedFrom ?? null,
      purchasedTo: q.purchasedTo ?? null,
      expiresFrom: q.expiresFrom ?? null,
      expiresTo: q.expiresTo ?? null,
    });
    return c.json(ok(payload));
  })
  .get("/kpis", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const payload = await readSubscriptionsKpis(projectId);
    return c.json(ok(payload));
  })
  .get("/composition", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const payload = await readSubscriptionsComposition(projectId);
    return c.json(ok(payload));
  })
  .get(
    "/renewal-calendar",
    zValidator("query", calendarQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

      const { pastDays, futureDays } = c.req.valid("query");
      const payload = await readRenewalCalendar({
        projectId,
        pastDays,
        futureDays,
      });
      return c.json(ok(payload));
    },
  )
  .get(
    "/billing-issues",
    zValidator("query", issuesQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

      const { limit } = c.req.valid("query");
      const payload = await readBillingIssues(projectId, limit);
      return c.json(ok(payload));
    },
  )
  .get(
    "/export.csv",
    zValidator("query", exportQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

      const { scope, search } = c.req.valid("query");
      const generator = streamSubscriptionsCsv({
        projectId,
        scope,
        search: search ?? null,
      });

      const datePart = new Date()
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, "");
      const filename = `subscriptions-${projectId}-${datePart}.csv`;

      c.header("Content-Type", "text/csv; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="${filename}"`);

      return c.body(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            let summary: { rowCount: number; truncated: boolean } = {
              rowCount: 0,
              truncated: false,
            };
            try {
              while (true) {
                const next = await generator.next();
                if (next.done) {
                  summary = next.value ?? summary;
                  break;
                }
                controller.enqueue(enc.encode(next.value));
              }
            } catch (err) {
              controller.enqueue(
                enc.encode(`# error: ${(err as Error).message}\n`),
              );
              throw err;
            } finally {
              controller.close();
              try {
                await audit({
                  projectId,
                  userId: user.id,
                  action: "subscriptions.exported",
                  resource: "project",
                  resourceId: projectId,
                  before: null,
                  after: {
                    scope,
                    search: search ?? null,
                    rowCount: summary.rowCount,
                    truncated: summary.truncated,
                  },
                });
              } catch {
                // Audit failure must not poison the response.
              }
            }
          },
        }),
      );
    },
  )
  .post(
    "/",
    zValidator("json", grantSubscriptionRequestSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
      const purchase = await grantComp({
        projectId,
        actorUserId: user.id,
        input: c.req.valid("json"),
      });
      return c.json(ok(purchase));
    },
  )
  .post(
    "/:purchaseId/schedule",
    zValidator("json", scheduleActionRequestSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const purchaseId = c.req.param("purchaseId");
      if (!projectId || !purchaseId) {
        throw new HTTPException(400, { message: "Missing projectId/purchaseId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
      const row = await scheduleAction({
        projectId,
        actorUserId: user.id,
        purchaseId,
        input: c.req.valid("json"),
      });
      return c.json(ok(row));
    },
  )
  .get("/scheduled", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
    const rows = await listScheduledForProject(projectId, 100);
    return c.json(ok({ rows }));
  })
  .delete("/scheduled/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) throw new HTTPException(400, { message: "Missing param" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
    const row = await cancelScheduledAction({
      projectId,
      actorUserId: user.id,
      id,
    });
    return c.json(ok(row));
  });
