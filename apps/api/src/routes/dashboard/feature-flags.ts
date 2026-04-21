import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  FeatureFlagType,
  MemberRole,
  drizzle,
} from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { audit, extractRequestContext } from "../../lib/audit";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { invalidateFlagCache } from "../../services/flag-engine";

// =============================================================
// Dashboard: Feature Flags CRUD + toggle
// =============================================================
//
// Chained route surface so AppType carries body + response
// inference through to the dashboard SPA's RPC client:
//
//   await client.dashboard["feature-flags"].$post({ json: {…} })
//   await client.dashboard["feature-flags"][":id"].toggle.$post()

export const ruleSchema = z.object({
  audienceId: z.string().min(1),
  value: z.unknown(),
  rolloutPercentage: z.number().min(0).max(1).nullable().optional(),
});

export const createFlagBodySchema = z.object({
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

export const updateFlagBodySchema = z.object({
  defaultValue: z.unknown().optional(),
  rules: z.array(ruleSchema).optional(),
  isEnabled: z.boolean().optional(),
  description: z.string().nullable().optional(),
});

export const featureFlagsRoute = new Hono()
  .use("*", requireDashboardAuth)
  // ----- POST /dashboard/feature-flags -----
  .post("/", zValidator("json", createFlagBodySchema), async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    await assertProjectAccess(body.projectId, user.id, MemberRole.ADMIN);

    const flag = await drizzle.dashboardFeatureFlagRepo.createFeatureFlag(
      drizzle.db,
      {
        projectId: body.projectId,
        key: body.key,
        type: body.type,
        defaultValue: body.defaultValue,
        rules: body.rules,
        isEnabled: body.isEnabled,
        description: body.description,
      },
    );

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
  })
  // ----- GET /dashboard/feature-flags?projectId=... -----
  .get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "projectId query param required" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const flags = await drizzle.dashboardFeatureFlagRepo.listFeatureFlags(
      drizzle.db,
      projectId,
    );

    return c.json(ok({ flags }));
  })
  // ----- GET /dashboard/feature-flags/:id -----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const flag = await drizzle.dashboardFeatureFlagRepo.findFeatureFlagById(
      drizzle.db,
      id,
    );
    if (!flag) {
      throw new HTTPException(404, { message: "Feature flag not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(flag.projectId, user.id);

    return c.json(ok({ flag }));
  })
  // ----- PATCH /dashboard/feature-flags/:id -----
  .patch("/:id", zValidator("json", updateFlagBodySchema), async (c) => {
    const id = c.req.param("id");
    const existing = await drizzle.dashboardFeatureFlagRepo.findFeatureFlagById(
      drizzle.db,
      id,
    );
    if (!existing) {
      throw new HTTPException(404, { message: "Feature flag not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

    const body = c.req.valid("json");

    const flag = await drizzle.dashboardFeatureFlagRepo.updateFeatureFlag(
      drizzle.db,
      id,
      {
        ...(body.defaultValue !== undefined && {
          defaultValue: body.defaultValue,
        }),
        ...(body.rules !== undefined && { rules: body.rules }),
        ...(body.isEnabled !== undefined && { isEnabled: body.isEnabled }),
        ...(body.description !== undefined && {
          description: body.description,
        }),
      },
    );
    if (!flag) {
      throw new HTTPException(404, { message: "Feature flag not found" });
    }

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
  })
  // ----- POST /dashboard/feature-flags/:id/toggle -----
  .post("/:id/toggle", async (c) => {
    const id = c.req.param("id");
    const existing = await drizzle.dashboardFeatureFlagRepo.findFeatureFlagById(
      drizzle.db,
      id,
    );
    if (!existing) {
      throw new HTTPException(404, { message: "Feature flag not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

    const flag = await drizzle.dashboardFeatureFlagRepo.updateFeatureFlag(
      drizzle.db,
      id,
      { isEnabled: !existing.isEnabled },
    );
    if (!flag) {
      throw new HTTPException(404, { message: "Feature flag not found" });
    }

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
  })
  // ----- DELETE /dashboard/feature-flags/:id -----
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await drizzle.dashboardFeatureFlagRepo.findFeatureFlagById(
      drizzle.db,
      id,
    );
    if (!existing) {
      throw new HTTPException(404, { message: "Feature flag not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

    await drizzle.dashboardFeatureFlagRepo.deleteFeatureFlag(drizzle.db, id);
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
