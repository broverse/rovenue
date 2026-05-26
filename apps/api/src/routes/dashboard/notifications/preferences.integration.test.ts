// =============================================================
// /dashboard/notifications/preferences — integration tests
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, drizzle, projects } from "@rovenue/db";
import { auth } from "../../../lib/auth";
import { errorHandler } from "../../../middleware/error";
import { notificationsRoute } from "./index";

const RUN_ID = Date.now();
const db = getDb();
const schema = drizzle.schema;

function buildApp() {
  const app = new Hono();
  app.route("/notifications", notificationsRoute);
  app.onError(errorHandler);
  return app;
}

async function createUserAndSession(suffix: string) {
  const email = `prefroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!pref";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `p-${suffix}` },
  });
  if (!signUp?.user) throw new Error("signUp failed");
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookieHeader = signIn.headers.get("set-cookie");
  if (!cookieHeader) throw new Error("no set-cookie");
  return { userId: signUp.user.id, cookie: cookieHeader.split(";")[0] ?? "" };
}

const seededProjectIds: string[] = [];
async function seedProject(suffix: string) {
  const id = `prj_prefroute_${RUN_ID}_${suffix}`;
  await db.insert(projects).values({ id, name: id });
  seededProjectIds.push(id);
  return id;
}

afterAll(async () => {
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe.sequential("dashboard/notifications/preferences", () => {
  it("GET returns sensible defaults when no row exists", async () => {
    const { cookie } = await createUserAndSession("defaults");
    const app = buildApp();
    const res = await app.request("/notifications/preferences", {
      method: "GET",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        channels: { email: boolean; push: boolean };
        projectId: string | null;
      };
    };
    expect(body.data.channels.email).toBe(true);
    expect(body.data.channels.push).toBe(true);
    expect(body.data.projectId).toBeNull();
  });

  it("PATCH scope=global flips the user channel master switch", async () => {
    const { userId, cookie } = await createUserAndSession("global");
    const app = buildApp();
    const res = await app.request("/notifications/preferences", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        channels: { push: false },
        timezone: "Europe/Istanbul",
      }),
    });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(schema.userPreferences)
      .where(eq(schema.userPreferences.userId, userId));
    expect(rows[0]?.timezone).toBe("Europe/Istanbul");
    const notif = rows[0]?.notifications as { channels?: Record<string, boolean> };
    expect(notif.channels?.push).toBe(false);
    // email unchanged (defaulted true elsewhere; here the JSONB
    // just shouldn't carry an explicit false).
    expect(notif.channels?.email).not.toBe(false);
  });

  it("PATCH scope=project merges overrides without clobbering existing keys", async () => {
    const { userId, cookie } = await createUserAndSession("proj");
    const projectId = await seedProject("proj");

    // Seed an existing override for a different event so we can
    // verify the second PATCH preserves it.
    await drizzle.notificationPreferencesRepo.upsertUserProjectOverrides(
      db,
      userId,
      projectId,
      { "billing.refund.detected": false },
    );

    const app = buildApp();
    const res = await app.request("/notifications/preferences", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        projectId,
        overrides: { "revenue.digest.daily": false },
      }),
    });
    expect(res.status).toBe(200);

    const merged = await drizzle.notificationPreferencesRepo.getUserProjectOverrides(
      db,
      userId,
      projectId,
    );
    expect(merged["revenue.digest.daily"]).toBe(false);
    expect(merged["billing.refund.detected"]).toBe(false);
  });

  it("PATCH scope=project rejects a forced-channel event with 400", async () => {
    const { cookie } = await createUserAndSession("forced");
    const projectId = await seedProject("forced");
    const app = buildApp();
    const res = await app.request("/notifications/preferences", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        projectId,
        // team.member.invited has forcedChannels:["email"]
        overrides: { "team.member.invited": false },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
    };
    expect(body.error?.message).toMatch(/forced channels/i);
  });

  it("PATCH scope=project rejects unknown event keys with 400", async () => {
    const { cookie } = await createUserAndSession("unknown");
    const projectId = await seedProject("unknown");
    const app = buildApp();
    const res = await app.request("/notifications/preferences", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        projectId,
        overrides: { "not.a.real.event": false },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("GET with projectId returns the resolved view including overrides", async () => {
    const { userId, cookie } = await createUserAndSession("getproj");
    const projectId = await seedProject("getproj");
    await drizzle.notificationPreferencesRepo.upsertProjectDefaults(
      db,
      projectId,
      { "revenue.digest.daily": true },
    );
    await drizzle.notificationPreferencesRepo.upsertUserProjectOverrides(
      db,
      userId,
      projectId,
      { "revenue.digest.daily": false },
    );

    const app = buildApp();
    const res = await app.request(
      `/notifications/preferences?projectId=${projectId}`,
      { method: "GET", headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        projectId: string;
        projectDefaults: Record<string, boolean>;
        userOverrides: Record<string, boolean>;
      };
    };
    expect(body.data.projectId).toBe(projectId);
    expect(body.data.projectDefaults["revenue.digest.daily"]).toBe(true);
    expect(body.data.userOverrides["revenue.digest.daily"]).toBe(false);
  });
});
