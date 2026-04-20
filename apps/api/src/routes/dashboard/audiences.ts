import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import prisma, { MemberRole, type Prisma } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { audit, extractRequestContext } from "../../lib/audit";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { invalidateFlagCache } from "../../services/flag-engine";
import { invalidateExperimentCache } from "../../services/experiment-engine";
import { validateAudienceRules } from "../../lib/targeting";

// =============================================================
// Dashboard: Audiences CRUD
// =============================================================
//
// Audiences are shared between the feature-flag and experiment
// engines, so every mutation invalidates both Redis bundles.

const DEFAULT_AUDIENCE_NAME = "All Users";

async function ensureDefaultAudience(projectId: string): Promise<void> {
  const existing = await prisma.audience.findFirst({
    where: { projectId, isDefault: true },
    select: { id: true },
  });
  if (existing) return;
  await prisma.audience.create({
    data: {
      projectId,
      name: DEFAULT_AUDIENCE_NAME,
      description: "Matches every subscriber",
      rules: {},
      isDefault: true,
    },
  });
}

async function invalidateCaches(projectId: string): Promise<void> {
  await Promise.all([
    invalidateFlagCache(projectId),
    invalidateExperimentCache(projectId),
  ]);
}

export const createAudienceBodySchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  rules: z.record(z.unknown()).default({}),
});

export const updateAudienceBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  rules: z.record(z.unknown()).optional(),
});

export const audiencesRoute = new Hono()
  .use("*", requireDashboardAuth)
  // ----- GET /dashboard/audiences?projectId=... -----
  .get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "projectId query param required" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    await ensureDefaultAudience(projectId);

    const audiences = await prisma.audience.findMany({
      where: { projectId },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });

    return c.json(ok({ audiences }));
  })
  // ----- POST /dashboard/audiences -----
  .post("/", zValidator("json", createAudienceBodySchema), async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    await assertProjectAccess(body.projectId, user.id, MemberRole.ADMIN);

    try {
      validateAudienceRules(body.rules);
    } catch (err) {
      throw new HTTPException(400, {
        message: err instanceof Error ? err.message : "Invalid rules",
      });
    }

    await ensureDefaultAudience(body.projectId);

    const audience = await prisma.audience.create({
      data: {
        projectId: body.projectId,
        name: body.name,
        description: body.description,
        rules: body.rules as Prisma.InputJsonValue,
        isDefault: false,
      },
    });

    await invalidateCaches(body.projectId);
    await audit({
      projectId: body.projectId,
      userId: user.id,
      action: "create",
      resource: "audience",
      resourceId: audience.id,
      after: { name: audience.name, rules: body.rules },
      ...extractRequestContext(c),
    });

    return c.json(ok({ audience }));
  })
  // ----- GET /dashboard/audiences/:id -----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const audience = await prisma.audience.findUnique({ where: { id } });
    if (!audience) {
      throw new HTTPException(404, { message: "Audience not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(audience.projectId, user.id);

    return c.json(ok({ audience }));
  })
  // ----- PATCH /dashboard/audiences/:id -----
  .patch("/:id", zValidator("json", updateAudienceBodySchema), async (c) => {
    const id = c.req.param("id");
    const existing = await prisma.audience.findUnique({ where: { id } });
    if (!existing) {
      throw new HTTPException(404, { message: "Audience not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

    const body = c.req.valid("json");
    if (body.rules !== undefined) {
      try {
        validateAudienceRules(body.rules);
      } catch (err) {
        throw new HTTPException(400, {
          message: err instanceof Error ? err.message : "Invalid rules",
        });
      }
    }
    const updates: Prisma.AudienceUpdateInput = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.rules !== undefined) {
      updates.rules = body.rules as Prisma.InputJsonValue;
    }

    const audience = await prisma.audience.update({
      where: { id },
      data: updates,
    });

    await invalidateCaches(existing.projectId);
    await audit({
      projectId: existing.projectId,
      userId: user.id,
      action: "update",
      resource: "audience",
      resourceId: id,
      before: { name: existing.name, rules: existing.rules },
      after: body as Record<string, unknown>,
      ...extractRequestContext(c),
    });

    return c.json(ok({ audience }));
  })
  // ----- DELETE /dashboard/audiences/:id -----
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await prisma.audience.findUnique({ where: { id } });
    if (!existing) {
      throw new HTTPException(404, { message: "Audience not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

    if (existing.isDefault) {
      throw new HTTPException(400, {
        message: "Cannot delete the default All Users audience",
      });
    }

    const inUse = await prisma.experiment.findFirst({
      where: { audienceId: id },
      select: { id: true },
    });
    if (inUse) {
      throw new HTTPException(409, {
        message: "Audience is in use by at least one experiment",
      });
    }

    await prisma.audience.delete({ where: { id } });
    await invalidateCaches(existing.projectId);
    await audit({
      projectId: existing.projectId,
      userId: user.id,
      action: "delete",
      resource: "audience",
      resourceId: id,
      before: { name: existing.name, rules: existing.rules },
      ...extractRequestContext(c),
    });

    return c.json(ok({ deleted: true }));
  });
