// =============================================================
// /dashboard/notifications/test-send
// =============================================================
//
// Synthetic notification emitter for dashboard QA. POSTs a
// "security.signin.new_device" outbox row addressed to the
// caller; the notifier worker fans it out the same way it would
// for a real event so the operator can verify the full pipeline
// (email render + send-email worker + SES + in-app feed) without
// staging a real sign-in.
//
// Auth: Better Auth session (inherited from the dashboard tree)
// + the caller must own at least one project. The OWNER check
// stops dashboard newcomers from spamming the pipeline before
// they've actually set anything up.
//
// Availability: NODE_ENV must NOT be "production". In prod the
// route returns 404 — never surface the existence of a test
// emitter to anyone walking the API. The plan calls this
// "/v1/internal/notification-test"; mounting under
// /dashboard/notifications/test-send instead because the auth
// model is dashboard-session (not API key), which is where
// `requireDashboardAuth` lives.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createId } from "@paralleldrive/cuid2";
import { drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { env } from "../../../lib/env";
import { ok } from "../../../lib/response";
import { emitNotification } from "../../../services/notifications/emit";

export const notificationTestSendRoute = new Hono()
  .use("*", requireDashboardAuth)
  .post("/", async (c) => {
    if (env.NODE_ENV === "production") {
      throw new HTTPException(404, { message: "Not found" });
    }
    const user = c.get("user");
    const memberships = await drizzle.projectRepo.findMembershipsForUser(
      drizzle.db,
      user.id,
    );
    const ownsAtLeastOne = memberships.some((m) => m.role === "OWNER");
    if (!ownsAtLeastOne) {
      throw new HTTPException(403, {
        message: "Test send requires OWNER role on at least one project",
      });
    }

    const userAgent = c.req.header("user-agent") ?? "unknown";
    const ipAddress =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "127.0.0.1";

    const eventId = createId();
    await drizzle.db.transaction(async (tx) => {
      await emitNotification(tx, {
        eventKey: "security.signin.new_device",
        eventId,
        recipients: [user.id],
        context: {
          userAgent,
          ipAddress,
          whenIso: new Date().toISOString(),
        },
      });
    });
    return c.json(ok({ ok: true, eventId }));
  });
