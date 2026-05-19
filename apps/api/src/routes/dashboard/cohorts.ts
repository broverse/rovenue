import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { computeRetention } from "../../services/cohorts";
import type {
  CohortRow,
  CohortRule,
  CohortSyncDestination,
  CohortsListResponse,
} from "@rovenue/shared";

// =============================================================
// Dashboard: Cohorts (Phase 4.4)
// =============================================================
//
//   GET    /                 list (project-wide)
//   POST   /                 create (ADMIN+)
//   GET    /:id              single
//   PATCH  /:id              update (ADMIN+)
//   DELETE /:id              remove (ADMIN+)
//   GET    /:id/retention    retention from CH

const filterFieldSchema = z.enum([
  "country",
  "store",
  "productId",
  "purchaseType",
  "firstSeenAfter",
  "firstSeenBefore",
] as const);

const filterOperatorSchema = z.enum([
  "eq",
  "in",
  "gte",
  "lte",
  "between",
] as const);

const filterValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.number(),
  z.object({ min: z.number(), max: z.number() }),
]);

const cohortFilterSchema = z.object({
  field: filterFieldSchema,
  op: filterOperatorSchema,
  value: filterValueSchema,
});

const cohortRuleSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  filters: z.array(cohortFilterSchema).max(20),
});

const syncDestinationSchema = z.object({
  label: z.string().trim().min(1).max(120),
  url: z.string().url(),
  secret: z.string().min(8).max(200).nullable().optional(),
  format: z.literal("json").optional(),
});

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).nullable().optional(),
  rules: cohortRuleSchema,
  syncDestinations: z.array(syncDestinationSchema).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    rules: cohortRuleSchema.optional(),
    syncDestinations: z.array(syncDestinationSchema).max(20).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    { message: "At least one field is required" },
  );

const retentionQuerySchema = z.object({
  granularity: z.enum(["day", "week", "month"]).default("month"),
  periods: z.coerce.number().int().min(1).max(24).default(6),
});

function safeParseRule(raw: unknown): CohortRule {
  // Stored row may be from before the current schema — fall back
  // to an empty `all` rule if validation fails so the row stays
  // usable in the dashboard.
  const result = cohortRuleSchema.safeParse(raw);
  if (result.success) return result.data;
  return { match: "all", filters: [] };
}

function toWire(row: {
  id: string;
  projectId: string;
  userId: string | null;
  name: string;
  description: string | null;
  rules: unknown;
  syncDestinations: unknown;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): CohortRow {
  const destinations = Array.isArray(row.syncDestinations)
    ? (row.syncDestinations as CohortSyncDestination[])
    : [];
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    name: row.name,
    description: row.description,
    rules: safeParseRule(row.rules),
    syncDestinations: destinations,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const cohortsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const rows = await drizzle.cohortRepo.listCohorts(drizzle.db, projectId);
    const payload: CohortsListResponse = { cohorts: rows.map(toWire) };
    return c.json(ok(payload));
  })
  .post("/", zValidator("json", createBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
    const body = c.req.valid("json");

    const existing = await drizzle.cohortRepo.findCohortByName(
      drizzle.db,
      projectId,
      body.name,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: `Cohort name already in use: ${body.name}`,
      });
    }

    const row = await drizzle.cohortRepo.createCohort(drizzle.db, {
      projectId,
      userId: user.id,
      name: body.name,
      description: body.description ?? null,
      rules: body.rules,
      syncDestinations: body.syncDestinations ?? [],
      metadata: body.metadata ?? {},
    });
    return c.json(ok({ cohort: toWire(row) }));
  })
  .get("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const row = await drizzle.cohortRepo.findCohortById(
      drizzle.db,
      projectId,
      id,
    );
    if (!row) {
      throw new HTTPException(404, { message: "Cohort not found" });
    }
    return c.json(ok({ cohort: toWire(row) }));
  })
  .patch("/:id", zValidator("json", updateBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
    const body = c.req.valid("json");

    if (body.name) {
      const clash = await drizzle.cohortRepo.findCohortByName(
        drizzle.db,
        projectId,
        body.name,
      );
      if (clash && clash.id !== id) {
        throw new HTTPException(409, {
          message: `Cohort name already in use: ${body.name}`,
        });
      }
    }

    const row = await drizzle.cohortRepo.updateCohort(
      drizzle.db,
      projectId,
      id,
      body,
    );
    if (!row) {
      throw new HTTPException(404, { message: "Cohort not found" });
    }
    return c.json(ok({ cohort: toWire(row) }));
  })
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

    const removed = await drizzle.cohortRepo.deleteCohort(
      drizzle.db,
      projectId,
      id,
    );
    if (!removed) {
      throw new HTTPException(404, { message: "Cohort not found" });
    }
    return c.json(ok({ deleted: true }));
  })
  .get(
    "/:id/retention",
    zValidator("query", retentionQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const id = c.req.param("id");
      if (!projectId || !id) {
        throw new HTTPException(400, { message: "Missing identifier" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

      const cohort = await drizzle.cohortRepo.findCohortById(
        drizzle.db,
        projectId,
        id,
      );
      if (!cohort) {
        throw new HTTPException(404, { message: "Cohort not found" });
      }

      const { granularity, periods } = c.req.valid("query");
      const payload = await computeRetention({
        projectId,
        rule: safeParseRule(cohort.rules),
        granularity,
        periods,
      });
      return c.json(ok(payload));
    },
  );
