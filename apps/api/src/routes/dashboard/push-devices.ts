// =============================================================
// /dashboard/push-devices — per-user push token registry
// =============================================================
//
// POST   /     upsert (transfers ownership on (platform, token)
//              collision per the repo's onConflictDoUpdate).
//              10 req/min/user — protects the push_devices unique
//              index from churn under a mis-firing client.
// GET    /     list active devices for the caller.
// DELETE /:id  soft-revoke (sets revokedAt) — scoped on userId
//              so a leaked id can't be revoked by another tenant.
//
// Auth + per-user rate limit are inherited from the dashboard
// tree; the POST-only endpointRateLimit adds the tighter 10/min
// bucket on top.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { validate } from "../../lib/validate";
import { drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { endpointRateLimit } from "../../middleware/rate-limit";
import { ok } from "../../lib/response";

const { pushDeviceRepo } = drizzle;

const upsertBodySchema = z
  .object({
    platform: z.enum(["ios", "android"]),
    token: z.string().min(8).max(2048),
    appBundleId: z.string().min(1).max(255),
    locale: z.string().min(2).max(10).default("en"),
    timezone: z.string().min(1).max(64).default("UTC"),
  })
  .strict();

export const pushDevicesRoute = new Hono()
  .use("*", requireDashboardAuth)

  // POST /
  .post(
    "/",
    endpointRateLimit({
      name: "push-devices-register",
      max: 10,
      identify: (c) => c.get("user")?.id ?? "anon",
    }),
    validate("json", upsertBodySchema),
    async (c) => {
      const user = c.get("user");
      const body = c.req.valid("json");
      const row = await pushDeviceRepo.upsertPushDeviceByToken(drizzle.db, {
        userId: user.id,
        platform: body.platform,
        token: body.token,
        appBundleId: body.appBundleId,
        locale: body.locale,
        timezone: body.timezone,
      });
      return c.json(
        ok({
          id: row.id,
          platform: row.platform,
          appBundleId: row.appBundleId,
          locale: row.locale,
          timezone: row.timezone,
          lastSeenAt: row.lastSeenAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        }),
      );
    },
  )

  // GET /
  .get("/", async (c) => {
    const user = c.get("user");
    const rows = await pushDeviceRepo.listActivePushDevicesForUser(
      drizzle.db,
      user.id,
    );
    return c.json(
      ok({
        items: rows.map((r) => ({
          id: r.id,
          platform: r.platform,
          appBundleId: r.appBundleId,
          locale: r.locale,
          timezone: r.timezone,
          lastSeenAt: r.lastSeenAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
        })),
      }),
    );
  })

  // DELETE /:id
  .delete("/:id", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    if (!id) throw new HTTPException(400, { message: "id required" });
    await pushDeviceRepo.revokePushDeviceById(drizzle.db, user.id, id);
    return c.body(null, 204);
  });
