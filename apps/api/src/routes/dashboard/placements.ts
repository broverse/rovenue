import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { placementRowsSchema, type PlacementRows } from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
import { purgeProjectCatalogCache } from "../../lib/edge-cache";
import { ok } from "../../lib/response";
import { computePlacementMetrics } from "../../services/placement-metrics";

// =============================================================
// Dashboard: Placements CRUD
// =============================================================
//
// A placement is an ordered list of audience-targeted rows the SDK
// evaluates to resolve which paywall (or experiment, or nothing) a
// subscriber sees (see /v1/placements). Mirrors offerings.ts: same
// auth (requireDashboardAuth + assertProjectAccess /
// assertProjectCapability("products:write")), validate()/ok()
// envelope, and purgeProjectCatalogCache on every mutation.
//
// PATCH additionally enforces that every row reference (audienceId /
// target.paywallId / target.experimentId) belongs to the project, and
// that experiment targets point at a type=PAYWALL experiment — a
// dangling/foreign reference is rejected up-front with 400
// INVALID_ROW_REF rather than silently skipped at resolve-time.

const createBodySchema = z.object({
  identifier: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(200),
  rows: placementRowsSchema.optional(),
  isActive: z.boolean().optional(),
});

const updateBodySchema = z
  .object({
    identifier: z.string().trim().min(1).max(160).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    rows: placementRowsSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "At least one field is required",
  });

function invalidRowRef(message: string): never {
  throw new HTTPException(400, {
    message: JSON.stringify({ code: "INVALID_ROW_REF", message }),
  });
}

/**
 * Validates that every row's audienceId / paywallId / experimentId
 * belongs to the project, and that experiment targets reference a
 * type=PAYWALL experiment. Batches lookups rather than querying per
 * row.
 */
async function assertRowRefsOwnedByProject(
  projectId: string,
  rows: PlacementRows,
): Promise<void> {
  if (rows.length === 0) return;

  const audienceIds = [
    ...new Set(rows.map((r) => r.audienceId).filter((x): x is string => x !== null)),
  ];
  const paywallIds = [
    ...new Set(
      rows
        .map((r) => (r.target.type === "paywall" ? r.target.paywallId : null))
        .filter((x): x is string => x !== null),
    ),
  ];
  const experimentIds = [
    ...new Set(
      rows
        .map((r) => (r.target.type === "experiment" ? r.target.experimentId : null))
        .filter((x): x is string => x !== null),
    ),
  ];

  if (audienceIds.length > 0) {
    const found = await drizzle.audienceRepo.findByIds(
      drizzle.db,
      projectId,
      audienceIds,
    );
    const foundIds = new Set(found.map((a) => a.id));
    const missing = audienceIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      invalidRowRef(`Unknown audienceId(s): ${missing.join(", ")}`);
    }
  }

  if (paywallIds.length > 0) {
    const found = await drizzle.paywallRepo.findPaywallsByIds(
      drizzle.db,
      projectId,
      paywallIds,
    );
    const foundIds = new Set(found.map((p) => p.id));
    const missing = paywallIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      invalidRowRef(`Unknown paywallId(s): ${missing.join(", ")}`);
    }
  }

  for (const experimentId of experimentIds) {
    const experiment = await drizzle.experimentRepo.findByIdInProject(
      drizzle.db,
      experimentId,
      projectId,
    );
    if (!experiment) {
      invalidRowRef(`Unknown experimentId: ${experimentId}`);
    }
    if (experiment.type !== "PAYWALL") {
      invalidRowRef(
        `experimentId ${experimentId} must reference a PAYWALL experiment (got ${experiment.type})`,
      );
    }
  }
}

export const placementsDashboardRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const rows = await drizzle.placementRepo.listPlacements(drizzle.db, projectId);
    return c.json(ok({ placements: rows }));
  })
  .post("/", validate("json", createBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");
    const body = c.req.valid("json");

    const existing = await drizzle.placementRepo.findPlacementByIdentifier(
      drizzle.db,
      projectId,
      body.identifier,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: `Placement identifier already in use: ${body.identifier}`,
      });
    }
    if (body.rows) {
      await assertRowRefsOwnedByProject(projectId, body.rows);
    }

    const row = await drizzle.placementRepo.createPlacement(drizzle.db, {
      projectId,
      identifier: body.identifier,
      name: body.name,
      rows: body.rows ?? [],
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    });
    purgeProjectCatalogCache(projectId);
    return c.json(ok({ placement: row }));
  })
  .get("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const row = await drizzle.placementRepo.findPlacementById(
      drizzle.db,
      projectId,
      id,
    );
    if (!row) {
      throw new HTTPException(404, { message: "Placement not found" });
    }
    return c.json(ok({ placement: row }));
  })
  // ----- GET /dashboard/projects/:projectId/placements/:id/metrics -----
  //
  // Views/unique-views (mv_paywall_daily_target) + a query-time purchase
  // join — see services/placement-metrics.ts. Degrades to all-zero (not
  // a 5xx) when ClickHouse is unconfigured, matching the analytics-router
  // convention local dev relies on.
  .get("/:id/metrics", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const placement = await drizzle.placementRepo.findPlacementById(
      drizzle.db,
      projectId,
      id,
    );
    if (!placement) {
      throw new HTTPException(404, { message: "Placement not found" });
    }

    // ClickHouse rows key on the placement's business identifier (the SDK's
    // presentedContext carries placement.identifier, not the DB id) — passing
    // the route's DB id here would match zero rows forever.
    const metrics = await computePlacementMetrics(placement.identifier, projectId);
    return c.json(ok(metrics));
  })
  .patch("/:id", validate("json", updateBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");
    const body = c.req.valid("json");

    const existingPlacement = await drizzle.placementRepo.findPlacementById(
      drizzle.db,
      projectId,
      id,
    );
    if (!existingPlacement) {
      throw new HTTPException(404, { message: "Placement not found" });
    }

    if (body.identifier && body.identifier !== existingPlacement.identifier) {
      throw new HTTPException(400, {
        message: "identifier is immutable once set",
      });
    }
    if (body.rows) {
      await assertRowRefsOwnedByProject(projectId, body.rows);
    }

    const row = await drizzle.placementRepo.updatePlacement(
      drizzle.db,
      projectId,
      id,
      {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.rows !== undefined && { rows: body.rows }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
      },
    );
    if (!row) {
      throw new HTTPException(404, { message: "Placement not found" });
    }
    purgeProjectCatalogCache(projectId);
    return c.json(ok({ placement: row }));
  })
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");

    const removed = await drizzle.placementRepo.deletePlacement(
      drizzle.db,
      projectId,
      id,
    );
    if (!removed) {
      throw new HTTPException(404, { message: "Placement not found" });
    }
    purgeProjectCatalogCache(projectId);
    return c.json(ok({ deleted: true }));
  });
