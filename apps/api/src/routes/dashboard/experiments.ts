import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import {
  ExperimentStatus,
  ExperimentType,
  FeatureFlagType,
  drizzle,
} from "@rovenue/db";
import {
  EXPERIMENT_TYPE,
  experimentObjectSchema,
  experimentSchema as sharedExperimentSchema,
  placementRowsSchema,
  type PlacementRow,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { audit, extractRequestContext } from "../../lib/audit";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
import { purgeProjectCatalogCache } from "../../lib/edge-cache";
import { isUniqueViolationOf } from "../../lib/pg-errors";
import { ok } from "../../lib/response";
import {
  assertPaywallVariantsValid,
  createExperimentValidated,
} from "../../services/experiment-create";
import { invalidateExperimentCache } from "../../services/experiment-engine";
import { computeExperimentResults } from "../../services/experiment-results";
import { invalidateFlagCache } from "../../services/flag-engine";

/**
 * The unique index behind the backend-assigned experiment key —
 * `CREATE UNIQUE INDEX "experiments_projectId_key_key" ON "experiments"
 * ("projectId","key")`, migration 0000_flippant_ezekiel.sql.
 *
 * The retry loops below regenerate the key and try again, which only
 * helps for a collision on THIS index. Any other unique violation the
 * insert could raise would still be there on the next attempt, so
 * retrying it would just burn the attempt budget and report the wrong
 * error; those must surface immediately.
 */
const EXPERIMENT_KEY_UNIQUE = "experiments_projectId_key_key";

function inferPromotedFlagType(
  experimentType: ExperimentType,
  value: unknown,
): FeatureFlagType {
  if (experimentType === "FLAG") {
    if (typeof value === "boolean") return FeatureFlagType.BOOLEAN;
    if (typeof value === "string") return FeatureFlagType.STRING;
    if (typeof value === "number") return FeatureFlagType.NUMBER;
  }
  if (experimentType === "OFFERING" && typeof value === "string") {
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
    EXPERIMENT_TYPE.OFFERING,
    EXPERIMENT_TYPE.PAYWALL,
    EXPERIMENT_TYPE.ELEMENT,
  ]),
  // `key` is intentionally NOT accepted from the client — it is
  // backend-assigned (generateExperimentKey) and immutable thereafter.
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
      EXPERIMENT_TYPE.OFFERING,
      EXPERIMENT_TYPE.PAYWALL,
      EXPERIMENT_TYPE.ELEMENT,
    ])
    .optional(),
  // `key` is immutable — see createExperimentBodySchema. Not editable.
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
  .post("/", validate("json", createExperimentBodySchema), async (c) => {
    const body = c.req.valid("json");

    const user = c.get("user");
    await assertProjectCapability(body.projectId, user.id, "experiments:write");

    // Validation (shared schema + audience membership + paywall
    // variants), server-assigned key, and the insert itself all live
    // in createExperimentValidated — see apps/api/src/services/
    // experiment-create.ts for the precheck-then-insert key strategy.
    const experiment = await createExperimentValidated(drizzle.db, {
      projectId: body.projectId,
      name: body.name,
      description: body.description,
      type: body.type as ExperimentType,
      audienceId: body.audienceId,
      variants: body.variants,
      metrics: body.metrics,
      mutualExclusionGroup: body.mutualExclusionGroup,
    });

    await invalidateExperimentCache(body.projectId);
    await audit({
      projectId: body.projectId,
      userId: user.id,
      action: "create",
      resource: "experiment",
      resourceId: experiment.id,
      after: { key: experiment.key, type: body.type },
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
  // + variant weights. Since validate() is call-site we keep the
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
    await assertProjectCapability(existing.projectId, user.id, "experiments:write");

    const raw = await c.req.json();

    if (
      existing.status === ExperimentStatus.COMPLETED ||
      existing.status === ExperimentStatus.PAUSED
    ) {
      throw new HTTPException(400, {
        message: `Cannot edit experiment in status ${existing.status}`,
      });
    }

    let updates: Parameters<typeof drizzle.experimentRepo.updateExperiment>[2] =
      {};

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
          key: existing.key,
          variants: body.variants,
        });
      } else if (body.variants) {
        variantsAndTypeSchema.parse({
          type: existing.type,
          key: existing.key,
          variants: body.variants,
        });
      }

      if (body.variants) {
        const finalType = (body.type ?? existing.type) as ExperimentType;
        await assertPaywallVariantsValid(
          drizzle.db,
          existing.projectId,
          finalType,
          body.variants,
        );
      }

      updates = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.type !== undefined && { type: body.type as ExperimentType }),
        ...(body.audienceId !== undefined && { audienceId: body.audienceId }),
        ...(body.variants !== undefined && { variants: body.variants }),
        ...(body.metrics !== undefined && {
          // body.metrics === null clears the column via Drizzle NULL.
          metrics: body.metrics,
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

        updates.variants = updated;
      }
    }

    const experiment = await drizzle.experimentRepo.updateExperiment(
      drizzle.db,
      id,
      updates,
    );
    if (!experiment) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }

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
    await assertProjectCapability(existing.projectId, user.id, "experiments:write");

    if (existing.status !== ExperimentStatus.DRAFT) {
      throw new HTTPException(400, {
        message: `Can only start DRAFT experiments (current: ${existing.status})`,
      });
    }

    const experiment = await drizzle.experimentRepo.updateExperiment(
      drizzle.db,
      id,
      {
        status: ExperimentStatus.RUNNING,
        startedAt: new Date(),
      },
    );
    if (!experiment) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }

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
    await assertProjectCapability(existing.projectId, user.id, "experiments:write");

    if (existing.status !== ExperimentStatus.RUNNING) {
      throw new HTTPException(400, {
        message: `Can only pause RUNNING experiments (current: ${existing.status})`,
      });
    }

    const experiment = await drizzle.experimentRepo.updateExperiment(
      drizzle.db,
      id,
      { status: ExperimentStatus.PAUSED },
    );
    if (!experiment) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }

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
    await assertProjectCapability(existing.projectId, user.id, "experiments:write");

    if (existing.status !== ExperimentStatus.PAUSED) {
      throw new HTTPException(400, {
        message: `Can only resume PAUSED experiments (current: ${existing.status})`,
      });
    }

    const experiment = await drizzle.experimentRepo.updateExperiment(
      drizzle.db,
      id,
      { status: ExperimentStatus.RUNNING },
    );
    if (!experiment) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }

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
    await assertProjectCapability(existing.projectId, user.id, "experiments:write");

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
    // than validate() so an empty body gracefully defaults to {}.
    const raw = await c.req.json().catch(() => ({}));
    const body = stopExperimentBodySchema.parse(raw);

    const requestContext = extractRequestContext(c);

    // The status flip and the (optional) placement repoint must land
    // atomically: a stopped experiment whose placements still target it
    // would leave live traffic on a completed experiment forever. The
    // repoint itself is a resolve-then-skip-silently guard — an unknown
    // winner id or a winner with no paywallId (e.g. FLAG/OFFERING type)
    // just means there's nothing to repoint, mirroring the promoteToFlag
    // guard just below.
    const { experiment, repointedCount } = await drizzle.db.transaction(
      async (tx) => {
        const updated = await drizzle.experimentRepo.updateExperiment(
          tx,
          id,
          {
            status: ExperimentStatus.COMPLETED,
            completedAt: new Date(),
            winnerVariantId: body.winnerVariantId,
          },
        );
        if (!updated) {
          throw new HTTPException(404, { message: "Experiment not found" });
        }

        let changedPlacements = 0;
        if (existing.type === ExperimentType.PAYWALL && body.winnerVariantId) {
          const variants =
            (existing.variants as unknown as Array<{
              id: string;
              value: unknown;
            }>) ?? [];
          const winner = variants.find((v) => v.id === body.winnerVariantId);
          const winnerPaywallId =
            winner && typeof winner.value === "object" && winner.value !== null
              ? (winner.value as { paywallId?: unknown }).paywallId
              : undefined;

          if (typeof winnerPaywallId === "string" && winnerPaywallId.length > 0) {
            const allPlacements = await drizzle.placementRepo.listPlacements(
              tx,
              existing.projectId,
            );
            for (const placement of allPlacements) {
              const rows = placementRowsSchema.parse(placement.rows);
              let rowChanged = false;
              const nextRows: PlacementRow[] = rows.map((row) => {
                if (row.target.type === "experiment" && row.target.experimentId === id) {
                  rowChanged = true;
                  return {
                    ...row,
                    target: { type: "paywall" as const, paywallId: winnerPaywallId },
                  };
                }
                return row;
              });
              if (!rowChanged) continue;

              await drizzle.placementRepo.updatePlacement(
                tx,
                existing.projectId,
                placement.id,
                { rows: nextRows },
              );
              await audit(
                {
                  projectId: existing.projectId,
                  userId: user.id,
                  action: "update",
                  resource: "placement",
                  resourceId: placement.id,
                  before: { rows },
                  after: { rows: nextRows },
                  ...requestContext,
                },
                tx,
              );
              changedPlacements++;
            }
          }
        }

        return { experiment: updated, repointedCount: changedPlacements };
      },
    );

    if (repointedCount > 0) {
      purgeProjectCatalogCache(existing.projectId);
    }

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
        const flag = await drizzle.dashboardFeatureFlagRepo.createFeatureFlag(
          drizzle.db,
          {
            projectId: existing.projectId,
            key: `${existing.key}_winner`,
            type: flagType,
            defaultValue: winner.value,
            rules: [],
            isEnabled: true,
            description: `Promoted from experiment ${existing.key} (winner: ${winner.id})`,
          },
        );
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
      ...requestContext,
    });

    return c.json(ok({ experiment, promotedFlag }));
  })
  // ----- DELETE /dashboard/experiments/:id -----
  //
  // Hard-delete restricted to DRAFT. Anything that has been started
  // (RUNNING / PAUSED / COMPLETED) keeps its assignment + analytics
  // history; the user must complete or archive it via the lifecycle
  // endpoints instead.
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await drizzle.experimentRepo.findExperimentById(
      drizzle.db,
      id,
    );
    if (!existing) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }
    const user = c.get("user");
    await assertProjectCapability(existing.projectId, user.id, "experiments:write");

    if (existing.status !== ExperimentStatus.DRAFT) {
      throw new HTTPException(400, {
        message: `Cannot delete experiment in status ${existing.status} — only DRAFT can be deleted`,
      });
    }

    const deleted = await drizzle.experimentRepo.deleteExperiment(
      drizzle.db,
      id,
    );
    if (!deleted) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }

    await invalidateExperimentCache(existing.projectId);
    await audit({
      projectId: existing.projectId,
      userId: user.id,
      action: "delete",
      resource: "experiment",
      resourceId: id,
      before: { status: existing.status, name: existing.name, key: existing.key },
      ...extractRequestContext(c),
    });

    return c.json(ok({ id }));
  })
  // ----- POST /dashboard/experiments/:id/duplicate -----
  //
  // Clones an experiment as a new DRAFT, regardless of source status.
  // The clone gets its own backend-assigned opaque key (keys are
  // immutable and never copied). Name is suffixed with "(copy)" for
  // visual disambiguation in the list.
  .post("/:id/duplicate", async (c) => {
    const id = c.req.param("id");
    const source = await drizzle.experimentRepo.findExperimentById(
      drizzle.db,
      id,
    );
    if (!source) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }
    const user = c.get("user");
    await assertProjectCapability(source.projectId, user.id, "experiments:write");

    let duplicated;
    for (let attempt = 0; ; attempt += 1) {
      const key = drizzle.experimentRepo.generateExperimentKey();
      try {
        duplicated = await drizzle.experimentRepo.createExperiment(
          drizzle.db,
          {
            projectId: source.projectId,
            name: `${source.name} (copy)`,
            description: source.description,
            type: source.type,
            key,
            audienceId: source.audienceId,
            status: ExperimentStatus.DRAFT,
            variants: source.variants,
            metrics: source.metrics,
            mutualExclusionGroup: source.mutualExclusionGroup,
          },
        );
        break;
      } catch (err) {
        // Same wrapper, same consequence as on create: without the
        // cause-walk a genuine key clash 500s instead of regenerating.
        if (isUniqueViolationOf(err, EXPERIMENT_KEY_UNIQUE) && attempt < 4) {
          continue;
        }
        throw err;
      }
    }

    await invalidateExperimentCache(source.projectId);
    await audit({
      projectId: source.projectId,
      userId: user.id,
      action: "duplicate",
      resource: "experiment",
      resourceId: duplicated.id,
      after: { sourceId: id, key: duplicated.key },
      ...extractRequestContext(c),
    });

    return c.json(ok({ experiment: duplicated }));
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

    // Unified on the exposed-user, ClickHouse-backed results (same source as
    // the SDK /v1/experiments/:id/results) so the dashboard and SDK can never
    // report divergent sample sizes / conversion rates for one experiment.
    const results = await computeExperimentResults(id, experiment.projectId);
    return c.json(ok(results));
  });
