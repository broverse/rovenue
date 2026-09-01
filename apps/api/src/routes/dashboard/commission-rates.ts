// =============================================================
// /dashboard/projects/:projectId/commission-rates
// =============================================================
//
// GET    /            — any project member (capability "project:read")
//                        gets every configured (store, rate) pair. A
//                        store with no configured row is simply absent —
//                        never synthesized as 0%.
// PUT    /:store       — OWNER + ADMIN only (capability
//                        "project:settings:write"). Body is { rate }, a
//                        fraction in [0, 1]. Upserts — a second PUT for
//                        the same store overwrites, it never duplicates.
// DELETE /:store       — OWNER + ADMIN only. Reverts the store back to
//                        "no rate configured".
//
// The rate is the customer's own statement of their situation (see
// packages/db/src/drizzle/schema.ts's projectStoreCommissionRates comment
// and apps/api/src/services/metrics/proceeds.ts) — this route only
// stores what the customer enters. It never infers, defaults, or
// snaps a value to one of the published presets.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { validate } from "../../lib/validate";
import { Store, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectCapability } from "../../lib/capabilities";
import { ok } from "../../lib/response";

// `Store` is the top-level string-literal map, and `z.nativeEnum` takes
// exactly that — no tuple needed, so this does not have to reach for
// `drizzle.store.enumValues`.
//
// That distinction is load-bearing, not stylistic. This schema is built at
// MODULE scope, and the dashboard router imports this file, so reading
// `drizzle.<anything>` here executes on every import of the router. Many
// existing tests stub the db module (`vi.mock("@rovenue/db", () => ({ drizzle: {} }))`),
// which made `drizzle.store` undefined and crashed 21 unrelated test files
// at import time with "Cannot read properties of undefined (reading
// 'enumValues')". Keep module-scope code off the `drizzle` namespace.
const storeParamSchema = z.object({
  store: z.nativeEnum(Store),
});

const putBodySchema = z
  .object({
    // Fraction, not a percentage (0.15, not 15). Bounds mirror the
    // database CHECK constraint so a bad request 400s here instead of
    // round-tripping to Postgres first.
    rate: z.number().min(0).max(1),
  })
  .strict();

export const commissionRatesRoute = new Hono()
  .use("*", requireDashboardAuth)

  // GET /
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "projectId required" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "project:read");

    const rows = await drizzle.commissionRateRepo.listCommissionRates(
      drizzle.db,
      projectId,
    );
    return c.json(
      ok({
        rates: rows.map((r) => ({
          store: r.store,
          rate: Number(r.rate),
        })),
      }),
    );
  })

  // PUT /:store
  .put(
    "/:store",
    validate("param", storeParamSchema),
    validate("json", putBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) throw new HTTPException(400, { message: "projectId required" });
      const user = c.get("user");
      await assertProjectCapability(projectId, user.id, "project:settings:write");

      const { store } = c.req.valid("param");
      const { rate } = c.req.valid("json");

      const row = await drizzle.commissionRateRepo.upsertCommissionRate(
        drizzle.db,
        { projectId, store, rate: rate.toFixed(4) },
      );
      return c.json(ok({ store: row.store, rate: Number(row.rate) }));
    },
  )

  // DELETE /:store
  .delete("/:store", validate("param", storeParamSchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "projectId required" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "project:settings:write");

    const { store } = c.req.valid("param");
    await drizzle.commissionRateRepo.deleteCommissionRate(
      drizzle.db,
      projectId,
      store,
    );
    return c.json(ok({ ok: true }));
  });
