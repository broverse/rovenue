import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  FeatureFlagEnv,
  FeatureFlagType,
  drizzle,
} from "@rovenue/db";
import { validateAudienceRules } from "@rovenue/shared/experiments";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { audit, extractRequestContext } from "../../lib/audit";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
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

// Inline targeting conditions are validated via the same
// `validateAudienceRules` allow-list the Audience model uses, so
// the rule engine never receives operators outside the supported
// set (e.g. `$regex`, `$where`).
export const ruleSchema = z
  .object({
    audienceId: z.string().min(1).optional(),
    conditions: z
      .record(z.string(), z.unknown())
      .optional()
      .superRefine((val, ctx) => {
        if (val === undefined) return;
        try {
          validateAudienceRules(val);
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: err instanceof Error ? err.message : "Invalid conditions",
          });
        }
      }),
    value: z.unknown(),
    rolloutPercentage: z.number().min(0).max(1).nullable().optional(),
  });

const envEnum = z.enum([
  FeatureFlagEnv.PROD,
  FeatureFlagEnv.STAGING,
  FeatureFlagEnv.DEVELOPMENT,
]);

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
  env: envEnum.default(FeatureFlagEnv.PROD),
  defaultValue: z.unknown(),
  rules: z.array(ruleSchema).default([]),
  isEnabled: z.boolean().default(true),
  description: z.string().optional(),
});

export const updateFlagBodySchema = z.object({
  env: envEnum.optional(),
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
    await assertProjectCapability(body.projectId, user.id, "flags:write");

    const flag = await drizzle.dashboardFeatureFlagRepo.createFeatureFlag(
      drizzle.db,
      {
        projectId: body.projectId,
        key: body.key,
        type: body.type,
        env: body.env,
        defaultValue: body.defaultValue,
        rules: body.rules,
        isEnabled: body.isEnabled,
        description: body.description,
      },
    );

    await invalidateFlagCache(body.projectId, body.env);
    await audit({
      projectId: body.projectId,
      userId: user.id,
      action: "create",
      resource: "feature_flag",
      resourceId: flag.id,
      after: { key: body.key, type: body.type, env: body.env },
      ...extractRequestContext(c),
    });

    return c.json(ok({ flag }));
  })
  // ----- GET /dashboard/feature-flags?projectId=...&env=... -----
  .get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "projectId query param required" });
    }
    const envParam = c.req.query("env");
    const envParsed = envParam ? envEnum.safeParse(envParam) : null;
    if (envParam && (!envParsed || !envParsed.success)) {
      throw new HTTPException(400, {
        message: "env must be one of PROD, STAGING, DEVELOPMENT",
      });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const flags = await drizzle.dashboardFeatureFlagRepo.listFeatureFlags(
      drizzle.db,
      projectId,
      envParsed?.success ? envParsed.data : undefined,
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
    await assertProjectCapability(existing.projectId, user.id, "flags:write");

    const body = c.req.valid("json");

    const flag = await drizzle.dashboardFeatureFlagRepo.updateFeatureFlag(
      drizzle.db,
      id,
      {
        ...(body.env !== undefined && { env: body.env }),
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

    // Invalidate the original env's bundle and — if the env was
    // changed — the new env's bundle too. Both directions must
    // forget the row so the SDK never serves a stale evaluation.
    await invalidateFlagCache(existing.projectId, existing.env);
    if (body.env !== undefined && body.env !== existing.env) {
      await invalidateFlagCache(existing.projectId, body.env);
    }
    await audit({
      projectId: existing.projectId,
      userId: user.id,
      action: "update",
      resource: "feature_flag",
      resourceId: id,
      before: {
        env: existing.env,
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
    await assertProjectCapability(existing.projectId, user.id, "flags:write");

    const flag = await drizzle.dashboardFeatureFlagRepo.updateFeatureFlag(
      drizzle.db,
      id,
      { isEnabled: !existing.isEnabled },
    );
    if (!flag) {
      throw new HTTPException(404, { message: "Feature flag not found" });
    }

    await invalidateFlagCache(existing.projectId, existing.env);
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
    await assertProjectCapability(existing.projectId, user.id, "flags:write");

    await drizzle.dashboardFeatureFlagRepo.deleteFeatureFlag(drizzle.db, id);
    await invalidateFlagCache(existing.projectId, existing.env);
    await audit({
      projectId: existing.projectId,
      userId: user.id,
      action: "delete",
      resource: "feature_flag",
      resourceId: id,
      before: { key: existing.key, type: existing.type, env: existing.env },
      ...extractRequestContext(c),
    });

    return c.json(ok({ deleted: true }));
  });
