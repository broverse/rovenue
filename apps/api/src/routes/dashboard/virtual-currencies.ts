import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { MemberRole, drizzle } from "@rovenue/db";
import {
  createVirtualCurrencyRequestSchema,
  updateVirtualCurrencyRequestSchema,
  type VirtualCurrency,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
import { audit, extractRequestContext } from "../../lib/audit";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Virtual Currencies CRUD
// =============================================================

const MAX_ACTIVE_CURRENCIES = 50;

function requireProjectId(c: { req: { param: (k: string) => string | undefined } }) {
  const projectId = c.req.param("projectId");
  if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
  return projectId;
}

function toWire(row: {
  id: string;
  projectId: string;
  code: string;
  name: string;
  archivedAt: Date | null;
  createdAt: Date;
}): VirtualCurrency {
  return {
    id: row.id,
    projectId: row.projectId,
    code: row.code,
    name: row.name,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const virtualCurrenciesDashboardRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
    const projectId = requireProjectId(c);
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
    const rows = await drizzle.virtualCurrencyRepo.listVirtualCurrencies(
      drizzle.db,
      projectId,
      { includeArchived: true },
    );
    return c.json(ok({ currencies: rows.map(toWire) }));
  })
  .post(
    "/",
    validate("json", createVirtualCurrencyRequestSchema),
    async (c) => {
      const projectId = requireProjectId(c);
      const user = c.get("user");
      await assertProjectCapability(projectId, user.id, "credits:write");
      const body = c.req.valid("json");

      const existing = await drizzle.virtualCurrencyRepo.findVirtualCurrencyByCode(
        drizzle.db,
        projectId,
        body.code,
      );
      if (existing) {
        throw new HTTPException(409, {
          message: `Currency code already in use: ${body.code}`,
        });
      }
      const active = await drizzle.virtualCurrencyRepo.countActiveVirtualCurrencies(
        drizzle.db,
        projectId,
      );
      if (active >= MAX_ACTIVE_CURRENCIES) {
        throw new HTTPException(422, {
          message: `Maximum of ${MAX_ACTIVE_CURRENCIES} currencies per project`,
        });
      }

      const row = await drizzle.virtualCurrencyRepo.createVirtualCurrency(
        drizzle.db,
        { projectId, code: body.code, name: body.name },
      );
      const ctx = extractRequestContext(c);
      await audit({
        projectId,
        userId: user.id,
        action: "virtual_currency.created",
        resource: "virtual_currency",
        resourceId: row.id,
        before: null,
        after: { code: row.code, name: row.name },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      return c.json(ok({ currency: toWire(row) }));
    },
  )
  .patch(
    "/:id",
    validate("json", updateVirtualCurrencyRequestSchema),
    async (c) => {
      const projectId = requireProjectId(c);
      const id = c.req.param("id");
      if (!id) throw new HTTPException(400, { message: "Missing id" });
      const user = c.get("user");
      await assertProjectCapability(projectId, user.id, "credits:write");
      const body = c.req.valid("json");
      const existing = await drizzle.virtualCurrencyRepo.findVirtualCurrencyById(
        drizzle.db,
        projectId,
        id,
      );
      if (!existing) throw new HTTPException(404, { message: "Currency not found" });
      const row = await drizzle.virtualCurrencyRepo.renameVirtualCurrency(
        drizzle.db,
        projectId,
        id,
        body.name,
      );
      if (!row) throw new HTTPException(404, { message: "Currency not found" });
      const ctx = extractRequestContext(c);
      await audit({
        projectId,
        userId: user.id,
        action: "virtual_currency.renamed",
        resource: "virtual_currency",
        resourceId: row.id,
        before: { name: existing.name },
        after: { name: row.name },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      return c.json(ok({ currency: toWire(row) }));
    },
  )
  .delete("/:id", async (c) => {
    const projectId = requireProjectId(c);
    const id = c.req.param("id");
    if (!id) throw new HTTPException(400, { message: "Missing id" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "credits:write");
    const row = await drizzle.virtualCurrencyRepo.archiveVirtualCurrency(
      drizzle.db,
      projectId,
      id,
    );
    if (!row) throw new HTTPException(404, { message: "Currency not found" });
    const ctx = extractRequestContext(c);
    await audit({
      projectId,
      userId: user.id,
      action: "virtual_currency.archived",
      resource: "virtual_currency",
      resourceId: row.id,
      before: null,
      after: { archivedAt: row.archivedAt },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return c.json(ok({ currency: toWire(row) }));
  });
