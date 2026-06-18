import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
import { purgeProjectCatalogCache } from "../../lib/edge-cache";
import { ok } from "../../lib/response";
import type {
  DashboardOfferingRow,
  DashboardOfferingsListResponse,
  OfferingPackage,
} from "@rovenue/shared";

// =============================================================
// Dashboard: Offerings CRUD (renamed from product-groups)
// =============================================================

const PACKAGE_ID_RE =
  /^(\$rc_(weekly|monthly|annual|lifetime)|[a-z0-9][a-z0-9_-]*)$/;

const packageSchema = z.object({
  identifier: z.string().trim().min(1).max(160).regex(PACKAGE_ID_RE),
  productId: z.string().min(1),
  order: z.number().int().min(0).max(10_000),
  isPromoted: z.boolean().default(false),
  metadata: z.record(z.unknown()).optional(),
});

const createBodySchema = z.object({
  identifier: z.string().trim().min(1).max(160),
  isDefault: z.boolean().optional(),
  packages: z.array(packageSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateBodySchema = z
  .object({
    identifier: z.string().trim().min(1).max(160).optional(),
    isDefault: z.boolean().optional(),
    packages: z.array(packageSchema).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field is required",
  });

function parsePackages(raw: unknown): OfferingPackage[] {
  if (!Array.isArray(raw)) return [];
  const out: OfferingPackage[] = [];
  for (const item of raw) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as { identifier?: unknown }).identifier === "string" &&
      typeof (item as { productId?: unknown }).productId === "string" &&
      typeof (item as { order?: unknown }).order === "number" &&
      typeof (item as { isPromoted?: unknown }).isPromoted === "boolean"
    ) {
      const m = item as OfferingPackage;
      out.push({
        identifier: m.identifier,
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
  packages: unknown;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): DashboardOfferingRow {
  return {
    id: row.id,
    identifier: row.identifier,
    isDefault: row.isDefault,
    packages: parsePackages(row.packages),
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

export const offeringsDashboardRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const rows = await drizzle.offeringRepo.listOfferings(drizzle.db, projectId);
    const payload: DashboardOfferingsListResponse = {
      offerings: rows.map(toWire),
    };
    return c.json(ok(payload));
  })
  .post("/", zValidator("json", createBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");
    const body = c.req.valid("json");

    const existing = await drizzle.offeringRepo.findOfferingByIdentifier(
      drizzle.db,
      projectId,
      body.identifier,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: `Offering identifier already in use: ${body.identifier}`,
      });
    }
    if (body.packages) {
      await assertProductsExist(
        projectId,
        body.packages.map((p) => p.productId),
      );
    }

    const row = await drizzle.offeringRepo.createOffering(drizzle.db, {
      projectId,
      identifier: body.identifier,
      isDefault: body.isDefault ?? false,
      packages: body.packages ?? [],
      metadata: body.metadata ?? {},
    });
    purgeProjectCatalogCache(projectId);
    return c.json(ok({ offering: toWire(row) }));
  })
  .get("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const row = await drizzle.offeringRepo.findOfferingById(
      drizzle.db,
      projectId,
      id,
    );
    if (!row) {
      throw new HTTPException(404, { message: "Offering not found" });
    }
    return c.json(ok({ offering: toWire(row) }));
  })
  .patch("/:id", zValidator("json", updateBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");
    const body = c.req.valid("json");

    if (body.identifier) {
      const clash = await drizzle.offeringRepo.findOfferingByIdentifier(
        drizzle.db,
        projectId,
        body.identifier,
      );
      if (clash && clash.id !== id) {
        throw new HTTPException(409, {
          message: `Offering identifier already in use: ${body.identifier}`,
        });
      }
    }
    if (body.packages) {
      await assertProductsExist(
        projectId,
        body.packages.map((p) => p.productId),
      );
    }

    const row = await drizzle.offeringRepo.updateOffering(
      drizzle.db,
      projectId,
      id,
      body,
    );
    if (!row) {
      throw new HTTPException(404, { message: "Offering not found" });
    }
    purgeProjectCatalogCache(projectId);
    return c.json(ok({ offering: toWire(row) }));
  })
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");

    const removed = await drizzle.offeringRepo.deleteOffering(
      drizzle.db,
      projectId,
      id,
    );
    if (!removed) {
      throw new HTTPException(404, { message: "Offering not found" });
    }
    purgeProjectCatalogCache(projectId);
    return c.json(ok({ deleted: true }));
  });
