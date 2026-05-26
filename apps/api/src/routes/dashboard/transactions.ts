import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole } from "@rovenue/db";
import type {
  TransactionStoreFilter,
  TransactionsListSort,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import {
  __transactionsConstants,
  decodeCursor,
  decodeOffsetCursor,
  exportTransactionsCsv,
  listStoreBreakdown,
  listTransactions,
  listTransactionsVolume,
  syncTransactions,
} from "../../services/metrics/transactions";

// =============================================================
// Dashboard: Transactions
// =============================================================

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

const storeFilters = ["ios", "play", "stripe", "web"] as const satisfies ReadonlyArray<TransactionStoreFilter>;
const listSorts = ["newest", "oldest", "amount_desc", "amount_asc"] as const satisfies ReadonlyArray<TransactionsListSort>;

const ISO_DATE_OR_DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** `?stores=ios&stores=play` and `?stores=ios,play` both decode to a list. */
function csvEnum<T extends string>(values: ReadonlyArray<T>) {
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((raw) => {
      if (raw === undefined) return undefined;
      const parts = (Array.isArray(raw) ? raw : raw.split(","))
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
      const allowed = new Set(values as ReadonlyArray<string>);
      const matched = parts.filter((p): p is T => allowed.has(p));
      return matched.length > 0 ? matched : undefined;
    });
}

function csvStrings() {
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((raw) => {
      if (raw === undefined) return undefined;
      const parts = (Array.isArray(raw) ? raw : raw.split(","))
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return parts.length > 0 ? parts : undefined;
    });
}

const filterShape = {
  q: z.string().trim().min(1).max(200).optional(),
  stores: csvEnum(storeFilters),
  currencies: csvStrings(),
  amountMin: z.coerce.number().min(0).optional(),
  from: z.string().regex(ISO_DATE_OR_DATETIME).optional(),
  to: z.string().regex(ISO_DATE_OR_DATETIME).optional(),
  sort: z.enum(listSorts).default("newest"),
};

const listQuerySchema = z.object({
  scope: z.enum(transactionScopes).default("all"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
  ...filterShape,
});

const exportQuerySchema = z.object({
  scope: z.enum(transactionScopes).default("all"),
  ...filterShape,
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

function parseDateBound(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

export const transactionsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", zValidator("query", listQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const q = c.req.valid("query");
    const useOffset = q.sort === "amount_desc" || q.sort === "amount_asc";
    let cursor = null;
    let offset = 0;

    if (q.cursor) {
      if (useOffset) {
        const decoded = decodeOffsetCursor(q.cursor);
        if (decoded === null) {
          throw new HTTPException(400, { message: "Invalid cursor" });
        }
        offset = decoded;
      } else {
        cursor = decodeCursor(q.cursor);
        if (!cursor) {
          throw new HTTPException(400, { message: "Invalid cursor" });
        }
      }
    }

    const payload = await listTransactions({
      projectId,
      scope: q.scope,
      limit: q.limit,
      cursor,
      offset,
      q: q.q,
      stores: q.stores,
      currencies: q.currencies,
      amountMin: q.amountMin,
      from: parseDateBound(q.from),
      to: parseDateBound(q.to),
      sort: q.sort,
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
  )
  .post("/sync", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const payload = await syncTransactions({ projectId });
    return c.json(ok(payload));
  })
  .get(
    "/export.csv",
    zValidator("query", exportQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

      const q = c.req.valid("query");
      const csv = await exportTransactionsCsv({
        projectId,
        scope: q.scope,
        q: q.q,
        stores: q.stores,
        currencies: q.currencies,
        amountMin: q.amountMin,
        from: parseDateBound(q.from),
        to: parseDateBound(q.to),
        sort: q.sort,
      });

      const filename = `transactions-${projectId}-${new Date().toISOString().slice(0, 10)}.csv`;
      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${filename}"`,
          "cache-control": "no-store",
        },
      });
    },
  );
