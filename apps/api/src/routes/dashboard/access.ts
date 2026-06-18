import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole, drizzle, type AccessRow } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
import { ok } from "../../lib/response";
import type {
  DashboardAccessRow,
  DashboardAccessListResponse,
} from "@rovenue/shared";

// =============================================================
// Dashboard: Access catalog CRUD
// =============================================================
//
//   GET    /     list (project-wide, members+)
//   POST   /     create (admins/devs)
//   GET    /:id  single
//   PATCH  /:id  update
//   DELETE /:id  remove (FK ON DELETE RESTRICT — 23503 if in use)

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "identifier must be slug-like");

const createBodySchema = z.object({
  identifier: identifierSchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateBodySchema = createBodySchema.partial();

async function rowToDashboard(row: AccessRow): Promise<DashboardAccessRow> {
  return {
    id: row.id,
    identifier: row.identifier,
    displayName: row.displayName,
    description: row.description ?? null,
    productCount: await drizzle.accessCatalogRepo.countProducts(
      drizzle.db,
      row.id,
    ),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const accessRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const rows = await drizzle.accessCatalogRepo.list(drizzle.db, projectId);
    const mapped = await Promise.all(rows.map(rowToDashboard));
    const payload: DashboardAccessListResponse = { rows: mapped };
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
    const existing = await drizzle.accessCatalogRepo.findByIdentifier(
      drizzle.db,
      projectId,
      body.identifier,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: `Access identifier '${body.identifier}' already exists`,
      });
    }
    const row = await drizzle.accessCatalogRepo.create(drizzle.db, {
      projectId,
      identifier: body.identifier,
      displayName: body.displayName,
      description: body.description ?? null,
      metadata: body.metadata ?? {},
    });
    return c.json(ok(await rowToDashboard(row)), 201);
  })
  .get("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const row = await drizzle.accessCatalogRepo.findById(drizzle.db, id);
    if (!row || row.projectId !== projectId) {
      throw new HTTPException(404, { message: "Access not found" });
    }
    return c.json(ok(await rowToDashboard(row)));
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
    const existing = await drizzle.accessCatalogRepo.findById(drizzle.db, id);
    if (!existing || existing.projectId !== projectId) {
      throw new HTTPException(404, { message: "Access not found" });
    }
    if (body.identifier && body.identifier !== existing.identifier) {
      throw new HTTPException(400, {
        message: "identifier is immutable once set",
      });
    }
    await drizzle.accessCatalogRepo.update(drizzle.db, id, body);
    const refetched = await drizzle.accessCatalogRepo.findById(drizzle.db, id);
    if (!refetched) {
      throw new HTTPException(404, { message: "Access not found" });
    }
    return c.json(ok(await rowToDashboard(refetched)));
  })
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");

    const existing = await drizzle.accessCatalogRepo.findById(drizzle.db, id);
    if (!existing || existing.projectId !== projectId) {
      throw new HTTPException(404, { message: "Access not found" });
    }
    try {
      await drizzle.accessCatalogRepo.deleteById(drizzle.db, id);
    } catch (err) {
      // FK from subscriber_access.accessId is ON DELETE RESTRICT.
      // Surface a friendly 409 instead of a 500 when in-use.
      const code = (err as { code?: string }).code;
      if (code === "23503") {
        throw new HTTPException(409, {
          message: "Access is in use by existing subscriber_access rows",
        });
      }
      throw err;
    }
    return c.body(null, 204);
  });
