import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma, { FeatureFlagType, MemberRole, type Prisma } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { audit, extractRequestContext } from "../../lib/audit";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { invalidateFlagCache } from "../../services/flag-engine";

// =============================================================
// Dashboard: Feature Flags CRUD + toggle
// =============================================================

const ruleSchema = z.object({
  audienceId: z.string().min(1),
  value: z.unknown(),
  rolloutPercentage: z.number().min(0).max(1).nullable().optional(),
});

const createSchema = z.object({
  projectId: z.string().min(1),
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]+$/i, "slug format: letters, digits, _ or -"),
  type: z.enum([
    FeatureFlagType.BOOLEAN,
    FeatureFlagType.STRING,
    FeatureFlagType.NUMBER,
    FeatureFlagType.JSON,
  ]),
  defaultValue: z.unknown(),
  rules: z.array(ruleSchema).default([]),
  isEnabled: z.boolean().default(true),
  description: z.string().optional(),
});

const updateSchema = z.object({
  defaultValue: z.unknown().optional(),
  rules: z.array(ruleSchema).optional(),
  isEnabled: z.boolean().optional(),
  description: z.string().nullable().optional(),
});

export const featureFlagsRoute = new Hono();

featureFlagsRoute.use("*", requireDashboardAuth);

// ----- POST /dashboard/feature-flags -----
featureFlagsRoute.post("/", async (c) => {
  const body = createSchema.parse(await c.req.json());
  const user = c.get("user");
  await assertProjectAccess(body.projectId, user.id, MemberRole.ADMIN);

  const flag = await prisma.featureFlag.create({
    data: {
      projectId: body.projectId,
      key: body.key,
      type: body.type,
      defaultValue: body.defaultValue as Prisma.InputJsonValue,
      rules: body.rules as unknown as Prisma.InputJsonValue,
      isEnabled: body.isEnabled,
      description: body.description,
    },
  });

  await invalidateFlagCache(body.projectId);
  await audit({
    projectId: body.projectId,
    userId: user.id,
    action: "create",
    resource: "feature_flag",
    resourceId: flag.id,
    after: { key: body.key, type: body.type },
    ...extractRequestContext(c),
  });

  return c.json(ok({ flag }));
});

// ----- GET /dashboard/feature-flags?projectId=... -----
featureFlagsRoute.get("/", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) {
    throw new HTTPException(400, { message: "projectId query param required" });
  }
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id);

  const flags = await prisma.featureFlag.findMany({
    where: { projectId },
    orderBy: { key: "asc" },
  });

  return c.json(ok({ flags }));
});

// ----- GET /dashboard/feature-flags/:id -----
featureFlagsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const flag = await prisma.featureFlag.findUnique({ where: { id } });
  if (!flag) {
    throw new HTTPException(404, { message: "Feature flag not found" });
  }
  const user = c.get("user");
  await assertProjectAccess(flag.projectId, user.id);

  return c.json(ok({ flag }));
});

// ----- PATCH /dashboard/feature-flags/:id -----
featureFlagsRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await prisma.featureFlag.findUnique({ where: { id } });
  if (!existing) {
    throw new HTTPException(404, { message: "Feature flag not found" });
  }
  const user = c.get("user");
  await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

  const body = updateSchema.parse(await c.req.json());
  const updates: Prisma.FeatureFlagUpdateInput = {};
  if (body.defaultValue !== undefined) {
    updates.defaultValue = body.defaultValue as Prisma.InputJsonValue;
  }
  if (body.rules !== undefined) {
    updates.rules = body.rules as unknown as Prisma.InputJsonValue;
  }
  if (body.isEnabled !== undefined) updates.isEnabled = body.isEnabled;
  if (body.description !== undefined) updates.description = body.description;

  const flag = await prisma.featureFlag.update({
    where: { id },
    data: updates,
  });

  await invalidateFlagCache(existing.projectId);
  await audit({
    projectId: existing.projectId,
    userId: user.id,
    action: "update",
    resource: "feature_flag",
    resourceId: id,
    before: {
      defaultValue: existing.defaultValue,
      rules: existing.rules,
      isEnabled: existing.isEnabled,
    },
    after: body as Record<string, unknown>,
    ...extractRequestContext(c),
  });

  return c.json(ok({ flag }));
});

// ----- POST /dashboard/feature-flags/:id/toggle -----
featureFlagsRoute.post("/:id/toggle", async (c) => {
  const id = c.req.param("id");
  const existing = await prisma.featureFlag.findUnique({ where: { id } });
  if (!existing) {
    throw new HTTPException(404, { message: "Feature flag not found" });
  }
  const user = c.get("user");
  await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

  const flag = await prisma.featureFlag.update({
    where: { id },
    data: { isEnabled: !existing.isEnabled },
  });

  await invalidateFlagCache(existing.projectId);
  await audit({
    projectId: existing.projectId,
    userId: user.id,
    action: "toggle",
    resource: "feature_flag",
    resourceId: id,
    before: { isEnabled: existing.isEnabled },
    after: { isEnabled: flag.isEnabled },
    ...extractRequestContext(c),
  });

  return c.json(ok({ flag }));
});

// ----- DELETE /dashboard/feature-flags/:id -----
featureFlagsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await prisma.featureFlag.findUnique({ where: { id } });
  if (!existing) {
    throw new HTTPException(404, { message: "Feature flag not found" });
  }
  const user = c.get("user");
  await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

  await prisma.featureFlag.delete({ where: { id } });
  await invalidateFlagCache(existing.projectId);
  await audit({
    projectId: existing.projectId,
    userId: user.id,
    action: "delete",
    resource: "feature_flag",
    resourceId: id,
    before: { key: existing.key, type: existing.type },
    ...extractRequestContext(c),
  });

  return c.json(ok({ deleted: true }));
});
