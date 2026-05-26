import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import type {
  DashboardProductImportResponse,
  DashboardProductImportResultRow,
  DashboardProductRow,
  DashboardProductsListResponse,
  ProductTypeName,
} from "@rovenue/shared";

// =============================================================
// Dashboard: Products CRUD (Phase 4.1)
// =============================================================
//
//   GET    /                list (search + cursor + active flag)
//   POST   /                create  (ADMIN+)
//   GET    /:id             single
//   PATCH  /:id             update  (ADMIN+)
//   DELETE /:id             delete  (ADMIN+, fails if any purchase
//                                    references the product)
//
// Cursor format: opaque base64url of `${createdAtIso}|${id}`.
// Page boundaries are stable across new rows because we sort by
// (createdAt DESC, id DESC) and over-fetch by 1 to settle
// `nextCursor` without a second roundtrip.

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;
const CURSOR_VERSION = "v1";

interface ParsedProductsCursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(c: ParsedProductsCursor): string {
  const raw = `${CURSOR_VERSION}|${c.createdAt.toISOString()}|${c.id}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): ParsedProductsCursor | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [v, dateStr, id] = raw.split("|");
    if (v !== CURSOR_VERSION || !dateStr || !id) return null;
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return null;
    return { createdAt: d, id };
  } catch {
    return null;
  }
}

const productType = z.enum([
  "SUBSCRIPTION",
  "CONSUMABLE",
  "NON_CONSUMABLE",
] as const);

const storeKey = z.enum(["ios", "android", "web"] as const);

const storeIdsSchema = z.record(z.string().min(1).max(200));

/** `type=A&type=B` and `type=A,B` both decode to `["A","B"]`. */
function csvList<T extends z.ZodTypeAny>(item: T) {
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((raw) => {
      if (raw === undefined) return undefined;
      const parts = (Array.isArray(raw) ? raw : raw.split(","))
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return parts.length > 0 ? parts : undefined;
    })
    .pipe(z.array(item).optional());
}

const listQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  includeInactive: z.coerce.boolean().default(true),
  type: csvList(productType),
  store: csvList(storeKey),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
});

const createBodySchema = z.object({
  identifier: z.string().trim().min(1).max(160),
  type: productType,
  displayName: z.string().trim().min(1).max(200),
  storeIds: storeIdsSchema.optional(),
  entitlementKeys: z.array(z.string().trim().min(1).max(120)).optional(),
  creditAmount: z.number().int().nullable().optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const importItemSchema = z.object({
  storeId: z.string().trim().min(1).max(200),
  identifier: z.string().trim().min(1).max(160).optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  type: productType,
  entitlementKeys: z.array(z.string().trim().min(1).max(120)).optional(),
  creditAmount: z.number().int().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const importBodySchema = z.object({
  store: storeKey,
  items: z.array(importItemSchema).min(1).max(500),
});

const updateBodySchema = z
  .object({
    identifier: z.string().trim().min(1).max(160).optional(),
    type: productType.optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    storeIds: storeIdsSchema.optional(),
    entitlementKeys: z.array(z.string().trim().min(1).max(120)).optional(),
    creditAmount: z.number().int().nullable().optional(),
    isActive: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    { message: "At least one field is required" },
  );

function toWire(row: {
  id: string;
  identifier: string;
  type: string;
  displayName: string;
  storeIds: unknown;
  entitlementKeys: string[];
  creditAmount: number | null;
  isActive: boolean;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): DashboardProductRow {
  return {
    id: row.id,
    identifier: row.identifier,
    type: row.type as ProductTypeName,
    displayName: row.displayName,
    storeIds: (row.storeIds as Record<string, string> | null) ?? {},
    entitlementKeys: row.entitlementKeys,
    creditAmount: row.creditAmount,
    isActive: row.isActive,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const productsDashboardRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", zValidator("query", listQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const {
      search,
      includeInactive,
      type: types,
      store: stores,
      limit,
      cursor: rawCursor,
    } = c.req.valid("query");
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    if (rawCursor && !cursor) {
      throw new HTTPException(400, { message: "Invalid cursor" });
    }

    const rows = await drizzle.productRepo.listProducts(drizzle.db, {
      projectId,
      includeInactive,
      search: search ?? null,
      types: types ?? null,
      stores: stores ?? null,
      cursor,
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null;

    const payload: DashboardProductsListResponse = {
      products: page.map(toWire),
      nextCursor,
    };
    return c.json(ok(payload));
  })
  .post("/", zValidator("json", createBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
    const body = c.req.valid("json");

    const existing = await drizzle.productRepo.findProductByIdentifier(
      drizzle.db,
      projectId,
      body.identifier,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: `Product identifier already in use: ${body.identifier}`,
      });
    }

    const row = await drizzle.productRepo.createProduct(drizzle.db, {
      projectId,
      identifier: body.identifier,
      type: body.type,
      displayName: body.displayName,
      storeIds: body.storeIds ?? {},
      entitlementKeys: body.entitlementKeys ?? [],
      creditAmount: body.creditAmount ?? null,
      isActive: body.isActive ?? true,
      metadata: body.metadata ?? {},
    });
    return c.json(ok({ product: toWire(row) }));
  })
  .post("/import", zValidator("json", importBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
    const body = c.req.valid("json");

    const normalised = body.items.map((item) => {
      const identifier = (item.identifier ?? item.storeId).trim();
      const displayName = (item.displayName ?? item.storeId).trim();
      return {
        identifier,
        displayName,
        type: item.type,
        storeId: item.storeId,
        entitlementKeys: item.entitlementKeys ?? [],
        creditAmount: item.creditAmount ?? null,
        metadata: item.metadata ?? {},
      };
    });

    const { created, skipped } = await drizzle.productRepo.bulkCreateProducts(
      drizzle.db,
      { projectId, store: body.store, items: normalised },
    );

    const results: DashboardProductImportResultRow[] = [
      ...created.map((row): DashboardProductImportResultRow => ({
        storeId: (row.storeIds as Record<string, string>)[body.store] ?? "",
        identifier: row.identifier,
        status: "created" as const,
        productId: row.id,
      })),
      ...skipped.map((row): DashboardProductImportResultRow => ({
        storeId: row.storeId,
        identifier: row.identifier,
        status: "skipped" as const,
        reason: row.reason,
      })),
    ];

    const payload: DashboardProductImportResponse = {
      created: created.length,
      skipped: skipped.length,
      results,
    };
    return c.json(ok(payload));
  })
  .get("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const row = await drizzle.productRepo.findProductById(
      drizzle.db,
      projectId,
      id,
    );
    if (!row) {
      throw new HTTPException(404, { message: "Product not found" });
    }
    return c.json(ok({ product: toWire(row) }));
  })
  .patch("/:id", zValidator("json", updateBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
    const body = c.req.valid("json");

    if (body.identifier) {
      const clash = await drizzle.productRepo.findProductByIdentifier(
        drizzle.db,
        projectId,
        body.identifier,
      );
      if (clash && clash.id !== id) {
        throw new HTTPException(409, {
          message: `Product identifier already in use: ${body.identifier}`,
        });
      }
    }

    const row = await drizzle.productRepo.updateProduct(
      drizzle.db,
      projectId,
      id,
      body,
    );
    if (!row) {
      throw new HTTPException(404, { message: "Product not found" });
    }
    return c.json(ok({ product: toWire(row) }));
  })
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

    try {
      const removed = await drizzle.productRepo.deleteProduct(
        drizzle.db,
        projectId,
        id,
      );
      if (!removed) {
        throw new HTTPException(404, { message: "Product not found" });
      }
      return c.json(ok({ deleted: true }));
    } catch (err) {
      // FK violation when historical purchases still reference
      // the product. Soft-delete via PATCH isActive=false instead.
      if (err instanceof Error && /foreign key/i.test(err.message)) {
        throw new HTTPException(409, {
          message:
            "Product has purchase history. Archive it via PATCH { isActive: false } instead.",
        });
      }
      throw err;
    }
  });
