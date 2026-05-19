import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "@rovenue/db";
import type { CurrentUser, MeResponse } from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Authenticated user — /dashboard/me
// =============================================================
//
// Phase 2 — Account / Identity. The session middleware already
// validates and populates `c.get("user")`, so this endpoint is a
// thin Better Auth row passthrough. PATCH lands in a follow-up
// once locale/timezone columns exist on the user table.

function toCurrentUser(row: {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}): CurrentUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    image: row.image,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const meRoute = new Hono()
  .use("*", requireDashboardAuth)
  // ----- GET /dashboard/me -----
  .get("/", async (c) => {
    const sessionUser = c.get("user");
    const row = await drizzle.userRepo.findUserById(drizzle.db, sessionUser.id);
    if (!row) {
      // The session middleware would normally guarantee the row
      // exists, so this is mostly a defensive 404 against the
      // (theoretical) "session valid, user row hard-deleted by an
      // admin task between auth and read" race.
      throw new HTTPException(404, { message: "User not found" });
    }
    const payload: MeResponse = { user: toCurrentUser(row) };
    return c.json(ok(payload));
  });
