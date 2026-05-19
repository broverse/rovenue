import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import {
  __chartsConstants,
  readChannels,
  readFunnel,
  readHeatmap,
} from "../../services/metrics/charts";
import type {
  ChartAnnotation,
  ChartAnnotationsResponse,
  SavedChartView,
  SavedChartViewsResponse,
} from "@rovenue/shared";

// =============================================================
// Dashboard: Charts (Phase 3.5)
// =============================================================
//
//   GET    /channels             store-share donut (CH)
//   GET    /funnel               INITIAL → trial → paid → renewal
//   GET    /heatmap              DOW × hour grid
//
//   GET    /saved-views          list (per-user)
//   POST   /saved-views          create
//   PATCH  /saved-views/:id      update name / description / config
//   DELETE /saved-views/:id      remove
//
//   GET    /annotations          project-scoped, optional window
//   POST   /annotations          create
//   DELETE /annotations/:id      remove

const { WINDOW_DEFAULT_DAYS, WINDOW_MAX_DAYS } = __chartsConstants;

const windowQuerySchema = z.object({
  windowDays: z.coerce
    .number()
    .int()
    .min(1)
    .max(WINDOW_MAX_DAYS)
    .default(WINDOW_DEFAULT_DAYS),
});

const savedViewCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  config: z.record(z.unknown()).default({}),
});

const savedViewUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.config !== undefined,
    { message: "At least one field is required" },
  );

const annotationCreateSchema = z.object({
  occurredAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable().optional(),
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  color: z.string().trim().max(40).nullable().optional(),
  url: z.string().url().nullable().optional(),
});

const annotationsListSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

function toWireSavedView(row: {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}): SavedChartView {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    name: row.name,
    description: row.description,
    config: row.config,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWireAnnotation(row: {
  id: string;
  projectId: string;
  userId: string | null;
  occurredAt: Date;
  endsAt: Date | null;
  label: string;
  description: string | null;
  color: string | null;
  url: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ChartAnnotation {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    occurredAt: row.occurredAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    label: row.label,
    description: row.description,
    color: row.color,
    url: row.url,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const chartsRoute = new Hono()
  .use("*", requireDashboardAuth)
  // ------------------------------------------------------------
  // Read-only chart data
  // ------------------------------------------------------------
  .get("/channels", zValidator("query", windowQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);
    const { windowDays } = c.req.valid("query");
    return c.json(ok(await readChannels(projectId, windowDays)));
  })
  .get("/funnel", zValidator("query", windowQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);
    const { windowDays } = c.req.valid("query");
    return c.json(ok(await readFunnel(projectId, windowDays)));
  })
  .get("/heatmap", zValidator("query", windowQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);
    const { windowDays } = c.req.valid("query");
    return c.json(ok(await readHeatmap(projectId, windowDays)));
  })
  // ------------------------------------------------------------
  // Saved views CRUD (per-user)
  // ------------------------------------------------------------
  .get("/saved-views", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const rows = await drizzle.savedChartViewRepo.listSavedViews(
      drizzle.db,
      projectId,
      user.id,
    );
    const payload: SavedChartViewsResponse = {
      views: rows.map(toWireSavedView),
    };
    return c.json(ok(payload));
  })
  .post("/saved-views", zValidator("json", savedViewCreateSchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);
    const body = c.req.valid("json");

    const row = await drizzle.savedChartViewRepo.createSavedView(drizzle.db, {
      projectId,
      userId: user.id,
      name: body.name,
      description: body.description ?? null,
      config: body.config,
    });
    return c.json(ok({ view: toWireSavedView(row) }));
  })
  .patch(
    "/saved-views/:id",
    zValidator("json", savedViewUpdateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const id = c.req.param("id");
      if (!projectId || !id) {
        throw new HTTPException(400, { message: "Missing identifier" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);
      const body = c.req.valid("json");

      const row = await drizzle.savedChartViewRepo.updateSavedView(
        drizzle.db,
        id,
        projectId,
        user.id,
        body,
      );
      if (!row) {
        throw new HTTPException(404, { message: "View not found" });
      }
      return c.json(ok({ view: toWireSavedView(row) }));
    },
  )
  .delete("/saved-views/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

    const removed = await drizzle.savedChartViewRepo.deleteSavedView(
      drizzle.db,
      id,
      projectId,
      user.id,
    );
    if (!removed) {
      throw new HTTPException(404, { message: "View not found" });
    }
    return c.json(ok({ deleted: true }));
  })
  // ------------------------------------------------------------
  // Annotations CRUD (project-scoped)
  // ------------------------------------------------------------
  .get(
    "/annotations",
    zValidator("query", annotationsListSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);
      const { from, to, limit } = c.req.valid("query");

      const rows = await drizzle.chartAnnotationRepo.listAnnotations(
        drizzle.db,
        {
          projectId,
          from: from ? new Date(from) : undefined,
          to: to ? new Date(to) : undefined,
          limit,
        },
      );
      const payload: ChartAnnotationsResponse = {
        annotations: rows.map(toWireAnnotation),
      };
      return c.json(ok(payload));
    },
  )
  .post(
    "/annotations",
    zValidator("json", annotationCreateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      // Annotations affect the whole project, so writes require
      // at least ADMIN — viewers can read them.
      await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);
      const body = c.req.valid("json");

      const row = await drizzle.chartAnnotationRepo.createAnnotation(
        drizzle.db,
        {
          projectId,
          userId: user.id,
          occurredAt: new Date(body.occurredAt),
          endsAt: body.endsAt ? new Date(body.endsAt) : null,
          label: body.label,
          description: body.description ?? null,
          color: body.color ?? null,
          url: body.url ?? null,
        },
      );
      return c.json(ok({ annotation: toWireAnnotation(row) }));
    },
  )
  .delete("/annotations/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

    const removed = await drizzle.chartAnnotationRepo.deleteAnnotation(
      drizzle.db,
      id,
      projectId,
    );
    if (!removed) {
      throw new HTTPException(404, { message: "Annotation not found" });
    }
    return c.json(ok({ deleted: true }));
  });
