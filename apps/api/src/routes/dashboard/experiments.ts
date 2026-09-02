import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import {
  ExperimentStatus,
  ExperimentType,
  FeatureFlagType,
  drizzle,
  type Experiment,
} from "@rovenue/db";
import {
  EXPERIMENT_PRIMARY_METRICS,
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
import { ok } from "../../lib/response";
import {
  assertElementVariantsValid,
  assertNoReservedVariantId,
  assertNoScheduleCycle,
  assertPaywallVariantsValid,
  assertValidScheduleWindow,
  computeSchedulingBlocked,
  createExperimentValidated,
  generateFreeExperimentKey,
} from "../../services/experiment-create";
import { MAXIMUM_DETECTABLE_EFFECT } from "../../lib/experiment-constants";
import { invalidateExperimentCache } from "../../services/experiment-engine";
import { computeExperimentResults } from "../../services/experiment-results";
import { invalidateFlagCache } from "../../services/flag-engine";

/** Parses an optional/nullable ISO-8601 body field into `Date | null |
 *  undefined`, preserving all three states: absent (no change), `null`
 *  (clear), and a value (set). Schemas validate the string shape with
 *  `z.string().datetime()` before this ever runs. */
function toNullableDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

/**
 * Merges an experiment row with its Task 9 "blocked successor" signal for
 * every response shape that exposes experiments to the dashboard —
 * blocked-but-silent scheduling is exactly the failure mode this exists to
 * prevent (spec §4.5).
 */
async function withSchedulingBlocked<T extends Experiment>(
  experiment: T,
): Promise<T & { schedulingBlocked: boolean; schedulingBlockedReason: string | null }> {
  const { blocked, reason } = await computeSchedulingBlocked(drizzle.db, experiment);
  return { ...experiment, schedulingBlocked: blocked, schedulingBlockedReason: reason };
}

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

/**
 * The decision engine's two experiment-level inputs (spec §4.1). Derived
 * from `EXPERIMENT_PRIMARY_METRICS` rather than re-listing the members, so
 * a metric added to the shared list is settable here without a second
 * edit.
 *
 * The MDE is a RELATIVE effect: 0.1 means "detect a 10% relative change".
 * Bounded strictly above 0 (a zero MDE demands an infinite sample) and at
 * `MAXIMUM_DETECTABLE_EFFECT`, which is also the widest value
 * `numeric(5, 4)` can hold in this range.
 */
const primaryMetricSchema = z.enum(EXPERIMENT_PRIMARY_METRICS);
const minimumDetectableEffectSchema = z
  .number()
  .gt(0)
  .max(MAXIMUM_DETECTABLE_EFFECT);

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
  // Decision-engine inputs. Both columns carry a DB default, so omitting
  // them keeps the pre-existing behaviour (CONVERSION at the default MDE)
  // — but without a write path the ARPU / PROCEEDS_PER_USER half of the
  // engine was unreachable by any user of the product.
  primaryMetric: primaryMetricSchema.optional(),
  minimumDetectableEffect: minimumDetectableEffectSchema.optional(),
  // Task 9 scheduling — all optional; a DRAFT experiment with none of
  // these set behaves exactly as before (manual start/stop only).
  scheduledStartAt: z.string().datetime().nullable().optional(),
  scheduledEndAt: z.string().datetime().nullable().optional(),
  startAfterExperimentId: z.string().min(1).nullable().optional(),
  autoWinnerOnStop: z.boolean().optional(),
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
  // Decision-engine inputs — DRAFT-only, like the scheduling fields
  // below: changing the metric or the MDE mid-flight would change what
  // the stopping rule means halfway through the run.
  primaryMetric: primaryMetricSchema.optional(),
  minimumDetectableEffect: minimumDetectableEffectSchema.optional(),
  // Task 9 scheduling — DRAFT-only, like every other field here. Once
  // RUNNING, `updateRunningExperimentBodySchema` below narrows to
  // name/description/variant weights; there is deliberately no path to
  // edit scheduling after start.
  scheduledStartAt: z.string().datetime().nullable().optional(),
  scheduledEndAt: z.string().datetime().nullable().optional(),
  startAfterExperimentId: z.string().min(1).nullable().optional(),
  autoWinnerOnStop: z.boolean().optional(),
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

export interface StopExperimentWithWinnerOpts {
  winnerVariantId?: string;
  promoteToFlag?: boolean;
  /** `"system"` for the scheduler (Task 9's `autoWinnerOnStop`); the
   *  dashboard session's user id for the manual `/stop` route — so the
   *  audit chain answers "who stopped this" truthfully either way. */
  userId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface StopExperimentWithWinnerResult {
  experiment: Experiment;
  promotedFlag: { id: string; key: string } | null;
  repointedCount: number;
}

/**
 * The ONE stop-with-winner transition. Manual `/stop` and the scheduler's
 * `autoWinnerOnStop` path both call this — a second implementation of the
 * same transition (placement healing, promoteToFlag, the audit entry) is
 * exactly the duplication Task 9 exists to avoid re-introducing. Extracted
 * from the pre-Task-9 `/stop` handler with zero behaviour change on the
 * manual path: same transaction shape, same repoint guard, same audit.
 */
export async function stopExperimentWithWinner(
  existing: Experiment,
  opts: StopExperimentWithWinnerOpts,
): Promise<StopExperimentWithWinnerResult> {
  const requestContext = { ipAddress: opts.ipAddress, userAgent: opts.userAgent };

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
        existing.id,
        {
          status: ExperimentStatus.COMPLETED,
          completedAt: new Date(),
          winnerVariantId: opts.winnerVariantId,
        },
      );
      if (!updated) {
        throw new HTTPException(404, { message: "Experiment not found" });
      }

      let changedPlacements = 0;
      if (existing.type === ExperimentType.PAYWALL && opts.winnerVariantId) {
        const variants =
          (existing.variants as unknown as Array<{
            id: string;
            value: unknown;
          }>) ?? [];
        const winner = variants.find((v) => v.id === opts.winnerVariantId);
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
              if (
                row.target.type === "experiment" &&
                row.target.experimentId === existing.id
              ) {
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
                userId: opts.userId,
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
  if (opts.promoteToFlag && opts.winnerVariantId) {
    const variants =
      (existing.variants as unknown as Array<{
        id: string;
        value: unknown;
      }>) ?? [];
    const winner = variants.find((v) => v.id === opts.winnerVariantId);
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
    userId: opts.userId,
    action: "experiment.stopped",
    resource: "experiment",
    resourceId: existing.id,
    before: { status: existing.status },
    after: {
      status: "COMPLETED",
      winnerVariantId: opts.winnerVariantId,
      promotedFlagId: promotedFlag?.id,
    },
    ...requestContext,
  });

  return { experiment, promotedFlag, repointedCount };
}

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
      primaryMetric: body.primaryMetric,
      minimumDetectableEffect: body.minimumDetectableEffect,
      scheduledStartAt: toNullableDate(body.scheduledStartAt),
      scheduledEndAt: toNullableDate(body.scheduledEndAt),
      startAfterExperimentId: body.startAfterExperimentId,
      autoWinnerOnStop: body.autoWinnerOnStop,
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

    const withBlocked = await Promise.all(experiments.map(withSchedulingBlocked));

    return c.json(ok({ experiments: withBlocked }));
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
        experiment: await withSchedulingBlocked(experiment),
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
        assertNoReservedVariantId(body.variants);
        const finalType = (body.type ?? existing.type) as ExperimentType;
        await assertPaywallVariantsValid(
          drizzle.db,
          existing.projectId,
          finalType,
          body.variants,
        );
        await assertElementVariantsValid(
          drizzle.db,
          existing.projectId,
          finalType,
          body.variants,
        );
      }

      // Task 9 — scheduling fields. Self-contained: independent of the
      // type/variants validation above, so it neither depends on nor
      // reorders it.
      const nextScheduledStartAt = toNullableDate(body.scheduledStartAt);
      const nextScheduledEndAt = toNullableDate(body.scheduledEndAt);
      assertValidScheduleWindow(
        nextScheduledStartAt !== undefined ? nextScheduledStartAt : existing.scheduledStartAt,
        nextScheduledEndAt !== undefined ? nextScheduledEndAt : existing.scheduledEndAt,
      );
      if (body.startAfterExperimentId !== undefined) {
        await assertNoScheduleCycle(
          drizzle.db,
          existing.projectId,
          existing.id,
          body.startAfterExperimentId,
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
        ...(body.primaryMetric !== undefined && {
          primaryMetric: body.primaryMetric,
        }),
        ...(body.minimumDetectableEffect !== undefined && {
          // `numeric` is string-mode in Drizzle — the house pattern is one
          // explicit conversion at the boundary (see `resolveCommissionRate`).
          minimumDetectableEffect: String(body.minimumDetectableEffect),
        }),
        ...(body.scheduledStartAt !== undefined && {
          scheduledStartAt: nextScheduledStartAt,
        }),
        ...(body.scheduledEndAt !== undefined && {
          scheduledEndAt: nextScheduledEndAt,
        }),
        ...(body.startAfterExperimentId !== undefined && {
          startAfterExperimentId: body.startAfterExperimentId,
        }),
        ...(body.autoWinnerOnStop !== undefined && {
          autoWinnerOnStop: body.autoWinnerOnStop,
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

    const { experiment, promotedFlag } = await stopExperimentWithWinner(existing, {
      winnerVariantId: body.winnerVariantId,
      promoteToFlag: body.promoteToFlag,
      userId: user.id,
      ipAddress: requestContext.ipAddress,
      userAgent: requestContext.userAgent,
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

    const requestContext = extractRequestContext(c);

    // Successors must be looked up and audited BEFORE the delete lands in
    // the same transaction: the FK's ON DELETE SET NULL clears their
    // `startAfterExperimentId` at the DB level with no application hook,
    // so this is the only chance to write a durable record of who used to
    // depend on this experiment — `computeSchedulingBlocked` reads it back
    // later to tell "predecessor deleted" apart from "never had one".
    const deleted = await drizzle.db.transaction(async (tx) => {
      const successors = await drizzle.experimentRepo.findSuccessors(tx, id);

      const didDelete = await drizzle.experimentRepo.deleteExperiment(tx, id);
      if (!didDelete) return false;

      for (const successor of successors) {
        await audit(
          {
            projectId: successor.projectId,
            userId: user.id,
            action: "experiment.predecessor_deleted",
            resource: "experiment",
            resourceId: successor.id,
            before: { startAfterExperimentId: id },
            after: { startAfterExperimentId: null },
            ...requestContext,
          },
          tx,
        );
      }

      await audit(
        {
          projectId: existing.projectId,
          userId: user.id,
          action: "delete",
          resource: "experiment",
          resourceId: id,
          before: { status: existing.status, name: existing.name, key: existing.key },
          ...requestContext,
        },
        tx,
      );

      return true;
    });
    if (!deleted) {
      throw new HTTPException(404, { message: "Experiment not found" });
    }

    await invalidateExperimentCache(existing.projectId);

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

    // Key strategy: see generateFreeExperimentKey — same generate →
    // SELECT-precheck helper createExperimentValidated uses, so the
    // duplicate route no longer needs its own insert-then-catch loop.
    const key = await generateFreeExperimentKey(drizzle.db, source.projectId);
    const duplicated = await drizzle.experimentRepo.createExperiment(
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
