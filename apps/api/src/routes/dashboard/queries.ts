import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { logger } from "../../lib/logger";
import { ok } from "../../lib/response";
import {
  QueryValidationError,
  executePlaygroundQuery,
  readPlaygroundSchema,
} from "../../services/queries-playground";
import type {
  DashboardSavedQueriesListResponse,
  DashboardSavedQuery,
} from "@rovenue/shared";

const log = logger.child("dashboard.queries");

// =============================================================
// Dashboard: Queries playground (Phase 4.5)
// =============================================================
//
//   GET    /                  list saved queries (per-user)
//   POST   /                  create saved query
//   GET    /:id               single
//   PATCH  /:id               update
//   DELETE /:id               remove
//   POST   /execute           run a SQL body against the sandbox
//   GET    /schema            CH schema introspection

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).nullable().optional(),
  sql: z.string().trim().min(1).max(16_000),
  mode: z.enum(["sql", "builder"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    sql: z.string().trim().min(1).max(16_000).optional(),
    mode: z.enum(["sql", "builder"]).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    { message: "At least one field is required" },
  );

const executeBodySchema = z.object({
  sql: z.string().trim().min(1).max(16_000),
});

function toWire(row: {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  description: string | null;
  sql: string;
  mode: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}): DashboardSavedQuery {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    name: row.name,
    description: row.description,
    sql: row.sql,
    mode: row.mode,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const queriesRoute = new Hono()
  .use("*", requireDashboardAuth)
  // ----- CRUD: saved queries (per-user) -----
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const rows = await drizzle.savedQueryRepo.listSavedQueries(
      drizzle.db,
      projectId,
      user.id,
    );
    const payload: DashboardSavedQueriesListResponse = {
      queries: rows.map(toWire),
    };
    return c.json(ok(payload));
  })
  .post("/", validate("json", createBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
    const body = c.req.valid("json");

    const row = await drizzle.savedQueryRepo.createSavedQuery(drizzle.db, {
      projectId,
      userId: user.id,
      name: body.name,
      description: body.description ?? null,
      sql: body.sql,
      mode: body.mode ?? "sql",
      metadata: body.metadata ?? {},
    });
    return c.json(ok({ query: toWire(row) }));
  })
  // ----- Schema introspection -----
  // Registered before "/:id" so a request to "/schema" is not
  // captured by the param route (Hono matches in registration order).
  .get("/schema", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    return c.json(ok(await readPlaygroundSchema(projectId)));
  })
  .get("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const row = await drizzle.savedQueryRepo.findSavedQueryById(
      drizzle.db,
      id,
      projectId,
      user.id,
    );
    if (!row) {
      throw new HTTPException(404, { message: "Query not found" });
    }
    return c.json(ok({ query: toWire(row) }));
  })
  .patch("/:id", validate("json", updateBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
    const body = c.req.valid("json");

    const row = await drizzle.savedQueryRepo.updateSavedQuery(
      drizzle.db,
      id,
      projectId,
      user.id,
      body,
    );
    if (!row) {
      throw new HTTPException(404, { message: "Query not found" });
    }
    return c.json(ok({ query: toWire(row) }));
  })
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const removed = await drizzle.savedQueryRepo.deleteSavedQuery(
      drizzle.db,
      id,
      projectId,
      user.id,
    );
    if (!removed) {
      throw new HTTPException(404, { message: "Query not found" });
    }
    return c.json(ok({ deleted: true }));
  })
  // ----- Execute (sandboxed) -----
  .post("/execute", validate("json", executeBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    try {
      const payload = await executePlaygroundQuery({
        projectId,
        sql: c.req.valid("json").sql,
      });
      // Best-effort usage metering. Never let a logging failure break the query.
      try {
        await drizzle.warehouseQueryRunRepo.recordQueryRun(drizzle.db, {
          projectId,
          userId: user.id,
          durationMs: payload.durationMs ?? null,
          rowCount: payload.rows?.length ?? null,
        });
      } catch (err) {
        log.warn("failed to record warehouse query run", { err });
      }
      return c.json(ok(payload));
    } catch (err) {
      if (err instanceof QueryValidationError) {
        throw new HTTPException(400, { message: err.message });
      }
      // ClickHouse errors come back with a `code` and `message` —
      // surface the message to the user verbatim so the editor
      // can show the parse / type error next to the offending
      // token. Stripped to a single line so the wire envelope
      // stays compact.
      if (err instanceof Error) {
        const msg = err.message.split("\n")[0]?.slice(0, 500) ?? err.message;
        throw new HTTPException(400, { message: msg });
      }
      throw err;
    }
  });
