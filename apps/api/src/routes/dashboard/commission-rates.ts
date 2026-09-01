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
//
// AUDIT: both writes go through the append-only chain. This is a config
// UPSERT — a change overwrites the previous rate and no other table
// remembers it — while every "estimated at X%" figure in the project is
// derived from it. The chain entry is therefore the only thing that can
// answer "who moved the rate, and from what to what" after every proceeds
// number in the project shifts. The write and the audit share ONE
// transaction (audit() accepts a caller tx for exactly this), so a
// rollback cannot leave a chain entry claiming a change that did not
// happen, nor a change with no entry.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { validate } from "../../lib/validate";
import { Store, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectCapability } from "../../lib/capabilities";
import { ok } from "../../lib/response";
import { audit, extractRequestContext } from "../../lib/audit";

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

// `project_store_commission_rates.rate` is numeric(5,4) — a rate is
// stored to four decimal places (0.1500). Formatting to fewer would
// silently round the customer's configured figure.
const RATE_DECIMAL_PLACES = 4;

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

      const row = await drizzle.db.transaction(async (tx) => {
        // Read the previous rate INSIDE the tx so the "from" recorded in
        // the chain is the value this write actually replaced, not one a
        // concurrent PUT already overwrote.
        const previous =
          await drizzle.commissionRateRepo.getCommissionRate(
            tx,
            projectId,
            store,
          );
        const updated =
          await drizzle.commissionRateRepo.upsertCommissionRate(tx, {
            projectId,
            store,
            rate: rate.toFixed(RATE_DECIMAL_PLACES),
          });
        await audit(
          {
            projectId,
            userId: user.id,
            action: "commission_rate.updated",
            resource: "commission_rate",
            resourceId: store,
            // `null` for a first-time configuration — "there was no rate",
            // which is the same distinction the rest of this feature
            // preserves: never a stand-in 0%.
            before: { store, rate: previous ? Number(previous.rate) : null },
            after: { store, rate: Number(updated.rate) },
            ...extractRequestContext(c),
          },
          tx,
        );
        return updated;
      });
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
    await drizzle.db.transaction(async (tx) => {
      const previous = await drizzle.commissionRateRepo.getCommissionRate(
        tx,
        projectId,
        store,
      );
      // Nothing configured: the DELETE is a no-op, so there is no change
      // to record. An audit row here would assert a state transition that
      // never occurred.
      if (!previous) return;

      await drizzle.commissionRateRepo.deleteCommissionRate(
        tx,
        projectId,
        store,
      );
      await audit(
        {
          projectId,
          userId: user.id,
          action: "commission_rate.deleted",
          resource: "commission_rate",
          resourceId: store,
          before: { store, rate: Number(previous.rate) },
          after: null,
          ...extractRequestContext(c),
        },
        tx,
      );
    });
    return c.json(ok({ ok: true }));
  });
