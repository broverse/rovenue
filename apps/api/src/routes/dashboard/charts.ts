import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { assertProjectCapability } from "../../lib/capabilities";
import { ok } from "../../lib/response";
import { audit } from "../../lib/audit";
import {
  __chartsConstants,
  readChannels,
  readChartSeries,
  readFilterOptions,
  readFunnel,
  readHeatmap,
  readProceeds,
} from "../../services/metrics/charts";
import { streamMetricsExportCsv } from "../../services/metrics/export";
import {
  isSystemChartId,
  listSystemChartEntries,
} from "../../services/metrics/chart-catalog";
import type {
  ChartAnnotation,
  ChartAnnotationsResponse,
  ChartCatalogEntry,
  ChartCatalogResponse,
  ChartFilterOptionsResponse,
  SavedChartView,
  SavedChartViewsResponse,
} from "@rovenue/shared";

// =============================================================
// Dashboard: Charts (Phase 3.5)
// =============================================================
//
//   GET    /channels             store-share donut (CH)
//   GET    /proceeds             estimated proceeds per store, rate-labelled (CH + Postgres)
//   GET    /funnel               INITIAL → trial → paid → renewal
//   GET    /heatmap              DOW × hour grid
//   GET    /series/:chartId      chartId → { points, unit, supported }
//   GET    /export.csv           customer-BI export — streamed CSV built on the readers above
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

// =============================================================
// Catalog CRUD validators
// =============================================================

const chartCategorySchema = z.enum([
  "revenue",
  "growth",
  "retention",
  "conversion",
  "credits",
  "custom",
]);
const chartTypeSchema = z.enum(["line", "area", "bar"]);
const chartRangeSchema = z.enum(["1M", "3M", "6M", "12M", "YTD", "All"]);

const customChartCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: chartCategorySchema.default("custom"),
  chartType: chartTypeSchema.default("line"),
  range: chartRangeSchema.default("12M"),
  config: z.record(z.unknown()).default({}),
});

const customChartUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    category: chartCategorySchema.optional(),
    chartType: chartTypeSchema.optional(),
    range: chartRangeSchema.optional(),
    config: z.record(z.unknown()).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.category !== undefined ||
      v.chartType !== undefined ||
      v.range !== undefined ||
      v.config !== undefined,
    { message: "At least one field is required" },
  );

function toWireCustomChart(row: {
  id: string;
  name: string;
  category: string;
  chartType: string;
  rangeOption: string;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}): ChartCatalogEntry {
  return {
    id: row.id,
    kind: "custom",
    category: row.category as ChartCatalogEntry["category"],
    name: row.name,
    chartType: row.chartType as ChartCatalogEntry["chartType"],
    range: row.rangeOption as ChartCatalogEntry["range"],
    config: row.config,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

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
  // Catalog — system defaults + custom rows
  // ------------------------------------------------------------
  .get("/catalog", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const customRows = await drizzle.customChartRepo.listCustomCharts(
      drizzle.db,
      projectId,
    );
    const entries: ChartCatalogEntry[] = [
      ...listSystemChartEntries(),
      ...customRows.map(toWireCustomChart),
    ];
    const payload: ChartCatalogResponse = { entries };
    return c.json(ok(payload));
  })
  .post(
    "/catalog",
    validate("json", customChartCreateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      // Creating a chart adds it to the project-shared library,
      // so writes are gated to ADMIN — viewers can only consume.
      await assertProjectCapability(projectId, user.id, "project:settings:write");
      const body = c.req.valid("json");

      const row = await drizzle.customChartRepo.createCustomChart(drizzle.db, {
        projectId,
        createdByUserId: user.id,
        name: body.name,
        category: body.category,
        chartType: body.chartType,
        rangeOption: body.range,
        config: body.config,
      });
      return c.json(ok({ entry: toWireCustomChart(row) }));
    },
  )
  .patch(
    "/catalog/:id",
    validate("json", customChartUpdateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const id = c.req.param("id");
      if (!projectId || !id) {
        throw new HTTPException(400, { message: "Missing identifier" });
      }
      // System entries live in code, not in `custom_charts` — reject
      // mutation attempts early so the SQL update doesn't silently
      // no-op against a missing row.
      if (isSystemChartId(id)) {
        throw new HTTPException(403, {
          message: "System charts are read-only",
        });
      }
      const user = c.get("user");
      await assertProjectCapability(projectId, user.id, "project:settings:write");
      const body = c.req.valid("json");

      const row = await drizzle.customChartRepo.updateCustomChart(
        drizzle.db,
        id,
        projectId,
        {
          name: body.name,
          category: body.category,
          chartType: body.chartType,
          rangeOption: body.range,
          config: body.config,
        },
      );
      if (!row) {
        throw new HTTPException(404, { message: "Chart not found" });
      }
      return c.json(ok({ entry: toWireCustomChart(row) }));
    },
  )
  .delete("/catalog/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    if (isSystemChartId(id)) {
      throw new HTTPException(403, {
        message: "System charts cannot be deleted",
      });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "project:settings:write");

    const removed = await drizzle.customChartRepo.deleteCustomChart(
      drizzle.db,
      id,
      projectId,
    );
    if (!removed) {
      throw new HTTPException(404, { message: "Chart not found" });
    }
    return c.json(ok({ deleted: true }));
  })
  // ------------------------------------------------------------
  // Filter options — distinct values from CH
  // ------------------------------------------------------------
  .get(
    "/filter-options",
    validate("query", windowQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
      const { windowDays } = c.req.valid("query");
      const payload: ChartFilterOptionsResponse = await readFilterOptions(
        projectId,
        windowDays,
      );
      return c.json(ok(payload));
    },
  )
  // ------------------------------------------------------------
  // Read-only chart data
  // ------------------------------------------------------------
  .get("/channels", validate("query", windowQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
    const { windowDays } = c.req.valid("query");
    return c.json(ok(await readChannels(projectId, windowDays)));
  })
  .get("/proceeds", validate("query", windowQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
    const { windowDays } = c.req.valid("query");
    return c.json(ok(await readProceeds(projectId, windowDays)));
  })
  .get("/funnel", validate("query", windowQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
    const { windowDays } = c.req.valid("query");
    return c.json(ok(await readFunnel(projectId, windowDays)));
  })
  .get("/heatmap", validate("query", windowQuerySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
    const { windowDays } = c.req.valid("query");
    return c.json(ok(await readHeatmap(projectId, windowDays)));
  })
  .get(
    "/series/:chartId",
    validate("query", windowQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const chartId = c.req.param("chartId");
      if (!chartId) {
        throw new HTTPException(400, { message: "Missing chartId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
      const { windowDays } = c.req.valid("query");
      return c.json(ok(await readChartSeries(projectId, chartId, windowDays)));
    },
  )
  // ------------------------------------------------------------
  // Metrics export — customer BI (Task 6, 2026-09-01 plan, spec §4.4)
  // ------------------------------------------------------------
  .get(
    "/export.csv",
    validate("query", windowQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      // Same role gate as every other read endpoint on this route —
      // this export carries aggregate metrics, not end-user PII, so
      // it does not warrant a stricter capability than the charts it
      // is built from.
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
      const { windowDays } = c.req.valid("query");

      const generator = streamMetricsExportCsv({ projectId, windowDays });

      const datePart = new Date()
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, "");
      const filename = `metrics-${projectId}-${datePart}.csv`;

      c.header("Content-Type", "text/csv; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="${filename}"`);

      // ERROR BEHAVIOUR — deliberate, and it is not a 5xx.
      //
      // The status line and headers above are flushed the moment the
      // stream starts producing, which is before the first ClickHouse
      // reader has necessarily finished. A reader that throws after that
      // point CANNOT change the status code: HTTP has no mechanism to
      // retract a 200 already on the wire. The options are to cut the
      // connection mid-body (the client sees a truncated CSV and cannot
      // tell it from a short one) or to say so in the body.
      //
      // So a mid-stream failure enqueues a final `# error: <message>`
      // line — `#` is a comment in every CSV reader we care about, and
      // an export that stops early always carries a marker saying why
      // (the row-cap path emits its own truncation marker for the same
      // reason: a silently truncated export is a lying export). The
      // rethrow after the enqueue is what stops the loop; the `finally`
      // has already closed the controller by the time it propagates, so
      // the client receives HTTP 200 with a body whose LAST LINE names
      // the failure. Callers must treat a `#`-prefixed final line as a
      // failed export, not as data.
      //
      // The audit row is written in the `finally` either way — a partial
      // export is still an export of real data and must be recorded.
      //
      // NOT YET PINNED BY A TEST: there is no HTTP-level test for this
      // route (nor for GET /proceeds). streamMetricsExportCsv's own
      // tests cover the generator, including the truncation marker, but
      // nothing exercises the 200-with-marker behaviour end to end.
      return c.body(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            let summary: { rowCount: number; truncated: boolean } = {
              rowCount: 0,
              truncated: false,
            };
            try {
              while (true) {
                const next = await generator.next();
                if (next.done) {
                  summary = next.value ?? summary;
                  break;
                }
                controller.enqueue(enc.encode(next.value));
              }
            } catch (err) {
              controller.enqueue(
                enc.encode(`# error: ${(err as Error).message}\n`),
              );
              throw err;
            } finally {
              controller.close();
              try {
                await audit({
                  projectId,
                  userId: user.id,
                  action: "metrics.exported",
                  resource: "project",
                  resourceId: projectId,
                  before: null,
                  after: {
                    windowDays,
                    rowCount: summary.rowCount,
                    truncated: summary.truncated,
                  },
                });
              } catch {
                // Audit failure must not poison the response.
              }
            }
          },
        }),
      );
    },
  )
  // ------------------------------------------------------------
  // Saved views CRUD (per-user)
  // ------------------------------------------------------------
  .get("/saved-views", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

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
  .post("/saved-views", validate("json", savedViewCreateSchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
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
    validate("json", savedViewUpdateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const id = c.req.param("id");
      if (!projectId || !id) {
        throw new HTTPException(400, { message: "Missing identifier" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
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
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

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
    validate("query", annotationsListSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
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
    validate("json", annotationCreateSchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      // Annotations affect the whole project, so writes require
      // at least ADMIN — viewers can read them.
      await assertProjectCapability(projectId, user.id, "project:settings:write");
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
    await assertProjectCapability(projectId, user.id, "project:settings:write");

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
