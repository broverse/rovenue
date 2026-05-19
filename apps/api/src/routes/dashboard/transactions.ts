import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import {
  __transactionsConstants,
  decodeCursor,
  listStoreBreakdown,
  listTransactions,
  listTransactionsVolume,
} from "../../services/metrics/transactions";

// =============================================================
// Dashboard: Transactions (Phase 3.2)
// =============================================================
//
//   GET /transactions               cursor-paginated list with
//                                   scope tab + free-text filter
//   GET /transactions/volume        daily stacked counts strip
//   GET /transactions/store-breakdown
//                                   per-store gross-USD share
//
// All three are project-scoped and require at least VIEWER. The
// list endpoint accepts an opaque `cursor` token issued by the
// previous page; the cursor is validated server-side so a stale
// or malformed token 400s rather than silently bypassing the
// page boundary.

const {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  VOLUME_WINDOW_DEFAULT_DAYS,
  VOLUME_WINDOW_MAX_DAYS,
  STORE_WINDOW_DEFAULT_DAYS,
  STORE_WINDOW_MAX_DAYS,
} = __transactionsConstants;

const transactionScopes = [
  "all",
  "purchase",
  "renewal",
  "refund",
  "trial",
  "failed",
] as const;

const listQuerySchema = z.object({
  scope: z.enum(transactionScopes).default("all"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
});

const volumeQuerySchema = z.object({
  windowDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(VOLUME_WINDOW_MAX_DAYS)
    .default(VOLUME_WINDOW_DEFAULT_DAYS),
});

const breakdownQuerySchema = z.object({
  windowDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(STORE_WINDOW_MAX_DAYS)
    .default(STORE_WINDOW_DEFAULT_DAYS),
});

export const transactionsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", zValidator("query", listQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const { scope, limit, cursor: rawCursor } = c.req.valid("query");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      throw new HTTPException(400, { message: "Invalid cursor" });
    }

    const payload = await listTransactions({
      projectId,
      scope,
      limit,
      cursor,
    });
    return c.json(ok(payload));
  })
  .get("/volume", zValidator("query", volumeQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const { windowDays } = c.req.valid("query");
    const payload = await listTransactionsVolume({ projectId, windowDays });
    return c.json(ok(payload));
  })
  .get(
    "/store-breakdown",
    zValidator("query", breakdownQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

      const { windowDays } = c.req.valid("query");
      const payload = await listStoreBreakdown({ projectId, windowDays });
      return c.json(ok(payload));
    },
  );
