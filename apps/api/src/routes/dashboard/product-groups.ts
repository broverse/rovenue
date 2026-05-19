import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import type {
  DashboardProductGroupRow,
  DashboardProductGroupsListResponse,
  ProductGroupMembership,
} from "@rovenue/shared";

// =============================================================
// Dashboard: Product Groups CRUD (Phase 4.1)
// =============================================================

const membershipSchema = z.object({
  productId: z.string().min(1),
  order: z.number().int().min(0).max(10_000),
  isPromoted: z.boolean().default(false),
  metadata: z.record(z.unknown()).optional(),
});

const createBodySchema = z.object({
  identifier: z.string().trim().min(1).max(160),
  isDefault: z.boolean().optional(),
  products: z.array(membershipSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateBodySchema = z
  .object({
    identifier: z.string().trim().min(1).max(160).optional(),
    isDefault: z.boolean().optional(),
    products: z.array(membershipSchema).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    { message: "At least one field is required" },
  );

function parseMemberships(raw: unknown): ProductGroupMembership[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductGroupMembership[] = [];
  for (const item of raw) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as { productId?: unknown }).productId === "string" &&
      typeof (item as { order?: unknown }).order === "number" &&
      typeof (item as { isPromoted?: unknown }).isPromoted === "boolean"
    ) {
      const m = item as {
        productId: string;
        order: number;
        isPromoted: boolean;
        metadata?: Record<string, unknown>;
      };
      out.push({
        productId: m.productId,
        order: m.order,
        isPromoted: m.isPromoted,
        metadata: m.metadata,
      });
    }
  }
  return out;
}

function toWire(row: {
  id: string;
  identifier: string;
  isDefault: boolean;
  products: unknown;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): DashboardProductGroupRow {
  return {
    id: row.id,
    identifier: row.identifier,
    isDefault: row.isDefault,
    products: parseMemberships(row.products),
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertProductsExist(
  projectId: string,
  productIds: ReadonlyArray<string>,
): Promise<void> {
  if (productIds.length === 0) return;
  const rows = await drizzle.productRepo.findProductsByIds(
    drizzle.db,
    projectId,
    productIds,
  );
  const found = new Set(rows.map((r) => r.id));
  const missing = productIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new HTTPException(400, {
      message: `Unknown product ids: ${missing.join(", ")}`,
    });
  }
}

export const productGroupsDashboardRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const rows = await drizzle.productGroupRepo.listProductGroups(
      drizzle.db,
      projectId,
    );
    const payload: DashboardProductGroupsListResponse = {
      groups: rows.map(toWire),
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

    const existing = await drizzle.productGroupRepo.findProductGroupByIdentifier(
      drizzle.db,
      projectId,
      body.identifier,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: `Product group identifier already in use: ${body.identifier}`,
      });
    }
    if (body.products) {
      await assertProductsExist(
        projectId,
        body.products.map((p) => p.productId),
      );
    }

    const row = await drizzle.productGroupRepo.createProductGroup(drizzle.db, {
      projectId,
      identifier: body.identifier,
      isDefault: body.isDefault ?? false,
      products: body.products ?? [],
      metadata: body.metadata ?? {},
    });
    return c.json(ok({ group: toWire(row) }));
  })
  .get("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const row = await drizzle.productGroupRepo.findProductGroupById(
      drizzle.db,
      projectId,
      id,
    );
    if (!row) {
      throw new HTTPException(404, { message: "Product group not found" });
    }
    return c.json(ok({ group: toWire(row) }));
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
      const clash = await drizzle.productGroupRepo.findProductGroupByIdentifier(
        drizzle.db,
        projectId,
        body.identifier,
      );
      if (clash && clash.id !== id) {
        throw new HTTPException(409, {
          message: `Product group identifier already in use: ${body.identifier}`,
        });
      }
    }
    if (body.products) {
      await assertProductsExist(
        projectId,
        body.products.map((p) => p.productId),
      );
    }

    const row = await drizzle.productGroupRepo.updateProductGroup(
      drizzle.db,
      projectId,
      id,
      body,
    );
    if (!row) {
      throw new HTTPException(404, { message: "Product group not found" });
    }
    return c.json(ok({ group: toWire(row) }));
  })
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

    const removed = await drizzle.productGroupRepo.deleteProductGroup(
      drizzle.db,
      projectId,
      id,
    );
    if (!removed) {
      throw new HTTPException(404, { message: "Product group not found" });
    }
    return c.json(ok({ deleted: true }));
  });
