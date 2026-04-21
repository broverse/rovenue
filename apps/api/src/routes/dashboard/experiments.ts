import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import prisma, {
  ExperimentStatus,
  FeatureFlagType,
  MemberRole,
  Prisma,
  drizzle,
  type ExperimentType,
} from "@rovenue/db";
import {
  EXPERIMENT_TYPE,
  experimentObjectSchema,
  experimentSchema as sharedExperimentSchema,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { audit, extractRequestContext } from "../../lib/audit";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import {
  getExperimentResults,
  invalidateExperimentCache,
} from "../../services/experiment-engine";
import { invalidateFlagCache } from "../../services/flag-engine";

function inferPromotedFlagType(
  experimentType: ExperimentType,
  value: unknown,
): FeatureFlagType {
  if (experimentType === "FLAG") {
    if (typeof value === "boolean") return FeatureFlagType.BOOLEAN;
    if (typeof value === "string") return FeatureFlagType.STRING;
    if (typeof value === "number") return FeatureFlagType.NUMBER;
  }
  if (experimentType === "PRODUCT_GROUP" && typeof value === "string") {
    return FeatureFlagType.STRING;
  }
  return FeatureFlagType.JSON;
}

// =============================================================
// Dashboard: Experiments CRUD + state machine
// =============================================================
//
// Reuse the refined shared schema (variant weights must sum to 1,
// ids must be unique) when validating create/update payloads.
const variantsAndTypeSchema = sharedExperimentSchema;

export const createExperimentBodySchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum([
    EXPERIMENT_TYPE.FLAG,
    EXPERIMENT_TYPE.PRODUCT_GROUP,
    EXPERIMENT_TYPE.PAYWALL,
    EXPERIMENT_TYPE.ELEMENT,
  ]),
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-_]+$/i, "slug format: letters, digits, - or _"),
  audienceId: z.string().min(1),
  variants: experimentObjectSchema.shape.variants,
  metrics: z.array(z.string()).optional(),
  mutualExclusionGroup: z.string().optional(),
});

export const updateDraftExperimentBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  type: z
    .enum([
      EXPERIMENT_TYPE.FLAG,
      EXPERIMENT_TYPE.PRODUCT_GROUP,
      EXPERIMENT_TYPE.PAYWALL,
      EXPERIMENT_TYPE.ELEMENT,
    ])
    .optional(),
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-_]+$/i)
    .optional(),
  audienceId: z.string().min(1).optional(),
  variants: experimentObjectSchema.shape.variants.optional(),
  metrics: z.array(z.string()).nullable().optional(),
  mutualExclusionGroup: z.string().nullable().optional(),
});

export const updateRunningExperimentBodySchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  variants: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).optional(),
        weight: z.number().min(0).max(1),
      }),
    )
    .min(2)
    .optional(),
});

export const stopExperimentBodySchema = z.object({
  winnerVariantId: z.string().optional(),
  promoteToFlag: z.boolean().optional(),
});

export const experimentsRoute = new Hono()
  .use("*", requireDashboardAuth)
  // ----- POST /dashboard/experiments -----
  .post("/", zValidator("json", createExperimentBodySchema), async (c) => {
    const body = c.req.valid("json");

    // Revalidate variant weight sum + uniqueness via the shared schema.
    variantsAndTypeSchema.parse({
      type: body.type,
      key: body.key,
      variants: body.variants,
    });

    const user = c.get("user");
    await assertProjectAccess(body.projectId, user.id, MemberRole.ADMIN);

    const audience = await drizzle.audienceRepo.findAudienceInProject(
      drizzle.db,
      body.projectId,
      body.audienceId,
    );
    if (!audience) {
      throw new HTTPException(400, {
        message: "audienceId does not belong to this project",
      });
    }

    const experiment = await prisma.experiment.create({
      data: {
        projectId: body.projectId,
        name: body.name,
        description: body.description,
        type: body.type as ExperimentType,
        key: body.key,
        audienceId: body.audienceId,
        status: ExperimentStatus.DRAFT,
        variants: body.variants as unknown as Prisma.InputJsonValue,
        metrics: body.metrics as Prisma.InputJsonValue | undefined,
        mutualExclusionGroup: body.mutualExclusionGroup,
      },
    });

    await invalidateExperimentCache(body.projectId);
    await audit({
      projectId: body.projectId,
      userId: user.id,
      action: "create",
      resource: "experiment",
      resourceId: experiment.id,
      after: { key: body.key, type: body.type },
      ...extractRequestContext(c),
    });

    return c.json(ok({ experiment }));
  })
  // ----- GET /dashboard/experiments?projectId=&status=&type= -----
  .get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "projectId query param required" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const statusFilter = c.req.query("status");
    const typeFilter = c.req.query("type");

    const experiments = await drizzle.experimentRepo.findExperimentsByProject(
      drizzle.db,
      {
        projectId,
        status: statusFilter as ExperimentStatus | undefined,
        type: typeFilter as ExperimentType | undefined,
      },
    );

    return c.json(ok({ experiments }));
  })
  // ----- GET /dashboard/experiments/:id -----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const experiment = await drizzle.experimentRepo.findExperimentById(
      drizzle.db,
      id,
    );
    if (!experiment) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(experiment.projectId, user.id);

    const assignmentCount = await drizzle.experimentAssignmentRepo.countAssignments(
      drizzle.db,
      id,
    );
    const conversionCount =
      await drizzle.experimentAssignmentRepo.countConvertedAssignments(
        drizzle.db,
        id,
      );

    return c.json(
      ok({
        experiment,
        summary: {
          totalUsers: assignmentCount,
          conversions: conversionCount,
          conversionRate:
            assignmentCount === 0 ? 0 : conversionCount / assignmentCount,
        },
      }),
    );
  })
  // ----- PATCH /dashboard/experiments/:id -----
  //
  // Body shape depends on the current experiment status — DRAFT
  // accepts the full field set, RUNNING narrows to name/description
  // + variant weights. Since zValidator is static we keep the
  // discriminated validation inside the handler with the two
  // exported schemas as single source of truth.
  .patch("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await drizzle.experimentRepo.findExperimentById(
      drizzle.db,
      id,
    );
    if (!existing) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

    const raw = await c.req.json();

    if (
      existing.status === ExperimentStatus.COMPLETED ||
      existing.status === ExperimentStatus.PAUSED
    ) {
      throw new HTTPException(400, {
        message: `Cannot edit experiment in status ${existing.status}`,
      });
    }

    let updates: Prisma.ExperimentUpdateInput = {};

    if (existing.status === ExperimentStatus.DRAFT) {
      const body = updateDraftExperimentBodySchema.parse(raw);

      // Changing `type` requires re-supplying `variants` because each
      // type has a different variant-value shape (FLAG scalar vs
      // PAYWALL config object vs ELEMENT string, etc.). Without this,
      // a later /start would happily launch with mismatched shapes.
      if (body.type && body.type !== existing.type && !body.variants) {
        throw new HTTPException(400, {
          message: "Changing `type` requires supplying `variants`",
        });
      }

      if (body.variants && body.type) {
        variantsAndTypeSchema.parse({
          type: body.type,
          key: body.key ?? existing.key,
          variants: body.variants,
        });
      } else if (body.variants) {
        variantsAndTypeSchema.parse({
          type: existing.type,
          key: body.key ?? existing.key,
          variants: body.variants,
        });
      }

      updates = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.type !== undefined && { type: body.type as ExperimentType }),
        ...(body.key !== undefined && { key: body.key }),
        ...(body.audienceId !== undefined && { audienceId: body.audienceId }),
        ...(body.variants !== undefined && {
          variants: body.variants as unknown as Prisma.InputJsonValue,
        }),
        ...(body.metrics !== undefined && {
          metrics:
            body.metrics === null
              ? Prisma.JsonNull
              : (body.metrics as Prisma.InputJsonValue),
        }),
        ...(body.mutualExclusionGroup !== undefined && {
          mutualExclusionGroup: body.mutualExclusionGroup,
        }),
      };
    } else {
      // RUNNING — only name + variant weights (+ renaming) are editable.
      const body = updateRunningExperimentBodySchema.parse(raw);
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;

      if (body.variants) {
        const existingVariants =
          (existing.variants as unknown as Array<{
            id: string;
            name: string;
            value: unknown;
            weight: number;
          }>) ?? [];

        const newIds = new Set(body.variants.map((v) => v.id));
        const existingIds = new Set(existingVariants.map((v) => v.id));
        if (newIds.size !== existingIds.size) {
          throw new HTTPException(400, {
            message: "Cannot add/remove variants while RUNNING",
          });
        }
        for (const id of newIds) {
          if (!existingIds.has(id)) {
            throw new HTTPException(400, {
              message: `Unknown variant id ${id}`,
            });
          }
        }

        const updated = existingVariants.map((v) => {
          const patch = body.variants!.find((p) => p.id === v.id)!;
          return {
            ...v,
            name: patch.name ?? v.name,
            weight: patch.weight,
          };
        });

        const sum = updated.reduce((acc, v) => acc + v.weight, 0);
        if (Math.abs(sum - 1) > 1e-6) {
          throw new HTTPException(400, {
            message: `variant weights must sum to 1 (got ${sum})`,
          });
        }

        // Full-shape re-validation: catches dropped fields or type
        // mismatches introduced by the weight-only update path.
        try {
          variantsAndTypeSchema.parse({
            type: existing.type,
            key: existing.key,
            variants: updated,
          });
        } catch (err) {
          throw new HTTPException(400, {
            message:
              err instanceof Error
                ? `Invalid variant shape after update: ${err.message}`
                : "Invalid variant shape after update",
          });
        }

        updates.variants = updated as unknown as Prisma.InputJsonValue;
      }
    }

    const experiment = await prisma.experiment.update({
      where: { id },
      data: updates,
    });

    await invalidateExperimentCache(existing.projectId);
    await audit({
      projectId: existing.projectId,
      userId: user.id,
      action: "update",
      resource: "experiment",
      resourceId: id,
      before: { status: existing.status, name: existing.name },
      after: raw as Record<string, unknown>,
      ...extractRequestContext(c),
    });

    return c.json(ok({ experiment }));
  })
  // ----- POST /dashboard/experiments/:id/start -----
  .post("/:id/start", async (c) => {
    const id = c.req.param("id");
    const existing = await drizzle.experimentRepo.findExperimentById(
      drizzle.db,
      id,
    );
    if (!existing) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

    if (existing.status !== ExperimentStatus.DRAFT) {
      throw new HTTPException(400, {
        message: `Can only start DRAFT experiments (current: ${existing.status})`,
      });
    }

    const experiment = await prisma.experiment.update({
      where: { id },
      data: {
        status: ExperimentStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    await invalidateExperimentCache(existing.projectId);
    await audit({
      projectId: existing.projectId,
      userId: user.id,
      action: "experiment.started",
      resource: "experiment",
      resourceId: id,
      before: { status: existing.status },
      after: { status: "RUNNING" },
      ...extractRequestContext(c),
    });

    return c.json(ok({ experiment }));
  })
  // ----- POST /dashboard/experiments/:id/pause -----
  .post("/:id/pause", async (c) => {
    const id = c.req.param("id");
    const existing = await drizzle.experimentRepo.findExperimentById(
      drizzle.db,
      id,
    );
    if (!existing) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

    if (existing.status !== ExperimentStatus.RUNNING) {
      throw new HTTPException(400, {
        message: `Can only pause RUNNING experiments (current: ${existing.status})`,
      });
    }

    const experiment = await prisma.experiment.update({
      where: { id },
      data: { status: ExperimentStatus.PAUSED },
    });

    await invalidateExperimentCache(existing.projectId);
    await audit({
      projectId: existing.projectId,
      userId: user.id,
      action: "pause",
      resource: "experiment",
      resourceId: id,
      before: { status: existing.status },
      after: { status: "PAUSED" },
      ...extractRequestContext(c),
    });

    return c.json(ok({ experiment }));
  })
  // ----- POST /dashboard/experiments/:id/resume -----
  .post("/:id/resume", async (c) => {
    const id = c.req.param("id");
    const existing = await drizzle.experimentRepo.findExperimentById(
      drizzle.db,
      id,
    );
    if (!existing) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

    if (existing.status !== ExperimentStatus.PAUSED) {
      throw new HTTPException(400, {
        message: `Can only resume PAUSED experiments (current: ${existing.status})`,
      });
    }

    const experiment = await prisma.experiment.update({
      where: { id },
      data: { status: ExperimentStatus.RUNNING },
    });

    await invalidateExperimentCache(existing.projectId);
    await audit({
      projectId: existing.projectId,
      userId: user.id,
      action: "resume",
      resource: "experiment",
      resourceId: id,
      before: { status: existing.status },
      after: { status: "RUNNING" },
      ...extractRequestContext(c),
    });

    return c.json(ok({ experiment }));
  })
  // ----- POST /dashboard/experiments/:id/stop -----
  .post("/:id/stop", async (c) => {
    const id = c.req.param("id");
    const existing = await drizzle.experimentRepo.findExperimentById(
      drizzle.db,
      id,
    );
    if (!existing) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(existing.projectId, user.id, MemberRole.ADMIN);

    if (
      existing.status !== ExperimentStatus.RUNNING &&
      existing.status !== ExperimentStatus.PAUSED
    ) {
      throw new HTTPException(400, {
        message: `Can only stop RUNNING/PAUSED experiments (current: ${existing.status})`,
      });
    }

    // Stop accepts an optional body so clients that `.post()` without
    // a Content-Type still work. We hand-parse via safeParse rather
    // than zValidator so an empty body gracefully defaults to {}.
    const raw = await c.req.json().catch(() => ({}));
    const body = stopExperimentBodySchema.parse(raw);

    const experiment = await prisma.experiment.update({
      where: { id },
      data: {
        status: ExperimentStatus.COMPLETED,
        completedAt: new Date(),
        winnerVariantId: body.winnerVariantId,
      },
    });

    let promotedFlag: { id: string; key: string } | null = null;
    if (body.promoteToFlag && body.winnerVariantId) {
      const variants =
        (existing.variants as unknown as Array<{
          id: string;
          value: unknown;
        }>) ?? [];
      const winner = variants.find((v) => v.id === body.winnerVariantId);
      if (winner) {
        // Infer the flag type from the experiment type + winner value
        // so SDK consumers calling `useFlag<boolean>` don't get a
        // JSON-wrapped boolean back.
        const flagType = inferPromotedFlagType(existing.type, winner.value);
        const flag = await prisma.featureFlag.create({
          data: {
            projectId: existing.projectId,
            key: `${existing.key}_winner`,
            type: flagType,
            defaultValue: winner.value as Prisma.InputJsonValue,
            rules: [] as unknown as Prisma.InputJsonValue,
            isEnabled: true,
            description: `Promoted from experiment ${existing.key} (winner: ${winner.id})`,
          },
        });
        promotedFlag = { id: flag.id, key: flag.key };
        await invalidateFlagCache(existing.projectId);
      }
    }

    await invalidateExperimentCache(existing.projectId);
    await audit({
      projectId: existing.projectId,
      userId: user.id,
      action: "experiment.stopped",
      resource: "experiment",
      resourceId: id,
      before: { status: existing.status },
      after: {
        status: "COMPLETED",
        winnerVariantId: body.winnerVariantId,
        promotedFlagId: promotedFlag?.id,
      },
      ...extractRequestContext(c),
    });

    return c.json(ok({ experiment, promotedFlag }));
  })
  // ----- GET /dashboard/experiments/:id/results -----
  .get("/:id/results", async (c) => {
    const id = c.req.param("id");
    const experiment = await drizzle.experimentRepo.findExperimentById(
      drizzle.db,
      id,
    );
    if (!experiment) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }
    const user = c.get("user");
    await assertProjectAccess(experiment.projectId, user.id);

    const results = await getExperimentResults(id);
    return c.json(ok(results));
  });
