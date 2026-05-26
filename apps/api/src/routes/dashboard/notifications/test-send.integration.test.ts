// =============================================================
// /dashboard/notifications/test-send — integration tests
// =============================================================

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, drizzle, projects } from "@rovenue/db";
import { auth } from "../../../lib/auth";
import { errorHandler } from "../../../middleware/error";
import { env } from "../../../lib/env";
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
  const email = `tsroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!ts";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `ts-${suffix}` },
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
async function seedProject(suffix: string, ownerId: string) {
  const id = `prj_ts_${RUN_ID}_${suffix}`;
  await db.insert(projects).values({ id, name: id });
  await db
    .insert(schema.projectMembers)
    .values({ projectId: id, userId: ownerId, role: "OWNER" });
  seededProjectIds.push(id);
  return id;
}

afterAll(async () => {
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe.sequential("dashboard/notifications/test-send", () => {
  beforeEach(() => {
    // Defaults to "test" per tests/setup.ts; reset between cases
    // since the "404 in production" case mutates it.
    (env as { NODE_ENV: string }).NODE_ENV = "test";
  });

  it("OWNER → 200 + outbox row addressed to caller", async () => {
    const { userId, cookie } = await createUserAndSession("owner");
    await seedProject("owner", userId);

    const app = buildApp();
    const res = await app.request("/notifications/test-send", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { eventId: string } };

    const rows = await db
      .select()
      .from(schema.outboxEvents)
      .where(
        eq(schema.outboxEvents.eventType, "security.signin.new_device"),
      );
    const match = rows.find((r) => {
      const p = r.payload as { eventId?: string; recipients?: string[] };
      return p.eventId === body.data.eventId;
    });
    expect(match).toBeDefined();
    const payload = match!.payload as {
      recipients: string[];
      context: { userAgent: string };
    };
    expect(payload.recipients).toEqual([userId]);
    expect(payload.context.userAgent).toBeDefined();
  });

  it("user with no OWNER role → 403", async () => {
    const { userId, cookie } = await createUserAndSession("nonowner");
    const id = `prj_ts_${RUN_ID}_nonowner_member`;
    await db.insert(projects).values({ id, name: id });
    await db
      .insert(schema.projectMembers)
      .values({ projectId: id, userId, role: "DEVELOPER" });
    seededProjectIds.push(id);

    const app = buildApp();
    const res = await app.request("/notifications/test-send", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("user with no projects at all → 403", async () => {
    const { cookie } = await createUserAndSession("noproj");
    const app = buildApp();
    const res = await app.request("/notifications/test-send", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when NODE_ENV=production", async () => {
    const { userId, cookie } = await createUserAndSession("prod");
    await seedProject("prod", userId);

    (env as { NODE_ENV: string }).NODE_ENV = "production";
    const app = buildApp();
    const res = await app.request("/notifications/test-send", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("unauthenticated → 401", async () => {
    const app = buildApp();
    const res = await app.request("/notifications/test-send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect([401, 403]).toContain(res.status);
  });
});

// silence unused-import warning for vi when no spies are registered
void vi;
