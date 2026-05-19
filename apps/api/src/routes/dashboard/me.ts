import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import type {
  CurrentUser,
  MeResponse,
  MySession,
  MySessionsResponse,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Authenticated user — /dashboard/me
// =============================================================
//
// Phase 2 — Account / Identity. The session middleware already
// validates and populates `c.get("user")`, so this endpoint is a
// thin Better Auth row passthrough with a narrow PATCH surface
// for the fields the dashboard owns (name + image + locale + tz).

function toCurrentUser(row: {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  locale: string;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}): CurrentUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    image: row.image,
    locale: row.locale,
    timezone: row.timezone,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// =============================================================
// Validation
// =============================================================
//
// We intentionally don't validate locale/timezone against a fixed
// whitelist here — the dashboard's select inputs source from
// IANA / BCP-47 lists that can grow without a backend rebuild.
// The repo treats them as opaque strings.

export const updateMeBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    image: z.string().url().nullable().optional(),
    locale: z.string().trim().min(2).max(35).optional(),
    timezone: z.string().trim().min(1).max(60).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.image !== undefined ||
      v.locale !== undefined ||
      v.timezone !== undefined,
    { message: "At least one field is required" },
  );

export const meRoute = new Hono()
  .use("*", requireDashboardAuth)
  // ----- GET /dashboard/me -----
  .get("/", async (c) => {
    const sessionUser = c.get("user");
    const row = await drizzle.userRepo.findUserById(drizzle.db, sessionUser.id);
    if (!row) {
      throw new HTTPException(404, { message: "User not found" });
    }
    const payload: MeResponse = { user: toCurrentUser(row) };
    return c.json(ok(payload));
  })
  // ----- PATCH /dashboard/me -----
  .patch("/", zValidator("json", updateMeBodySchema), async (c) => {
    const sessionUser = c.get("user");
    const body = c.req.valid("json");

    // NOTE: account-level mutations don't yet feed audit_logs.
    // The current `audit()` helper requires a projectId, and
    // widening it to project-less entries is a cross-cutting
    // change shared by every Phase 2 endpoint (sessions /
    // accounts / PATs / preferences / export). Lands in a
    // dedicated follow-up so the chain rules stay consistent.
    const after = await drizzle.userRepo.updateUserProfile(
      drizzle.db,
      sessionUser.id,
      body,
    );
    if (!after) {
      throw new HTTPException(404, { message: "User not found" });
    }

    const payload: MeResponse = { user: toCurrentUser(after) };
    return c.json(ok(payload));
  })
  // =============================================================
  // Sessions
  // =============================================================
  //
  // Lists every active session for the current user with the row
  // backing the live request flagged as `current: true` so the
  // dashboard can hide its own revoke button. Revoke (`DELETE`)
  // 400s on the current session — log out is the right path for
  // that and keeps Better Auth's cookie cleanup in sync.
  //
  // ----- GET /dashboard/me/sessions -----
  .get("/sessions", async (c) => {
    const sessionUser = c.get("user");
    const currentSession = c.get("session");

    const rows = await drizzle.sessionRepo.listSessionsByUser(
      drizzle.db,
      sessionUser.id,
    );

    const sessions: MySession[] = rows.map((row) => ({
      id: row.id,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      current: row.id === currentSession.id,
    }));

    const payload: MySessionsResponse = { sessions };
    return c.json(ok(payload));
  })
  // ----- DELETE /dashboard/me/sessions/:id -----
  .delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const sessionUser = c.get("user");
    const currentSession = c.get("session");

    if (id === currentSession.id) {
      throw new HTTPException(400, {
        message: "Cannot revoke the current session — sign out instead.",
      });
    }

    const owned = await drizzle.sessionRepo.isSessionOwnedBy(
      drizzle.db,
      id,
      sessionUser.id,
    );
    if (!owned) {
      throw new HTTPException(404, { message: "Session not found" });
    }

    await drizzle.sessionRepo.deleteSessionById(drizzle.db, id);
    return c.json(ok({ revoked: true }));
  });
