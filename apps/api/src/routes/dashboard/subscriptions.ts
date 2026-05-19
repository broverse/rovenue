import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
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

export const subscriptionsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", zValidator("query", listQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const { scope, limit, cursor: rawCursor, search } = c.req.valid("query");
    const cursor = rawCursor ? decodeSubsCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      throw new HTTPException(400, { message: "Invalid cursor" });
    }

    const payload = await listSubscriptions({
      projectId,
      scope,
      limit,
      cursor,
      search: search ?? null,
    });
    return c.json(ok(payload));
  })
  .get("/kpis", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const payload = await readSubscriptionsKpis(projectId);
    return c.json(ok(payload));
  })
  .get("/composition", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

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
      await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

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
      await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

      const { limit } = c.req.valid("query");
      const payload = await readBillingIssues(projectId, limit);
      return c.json(ok(payload));
    },
  );
