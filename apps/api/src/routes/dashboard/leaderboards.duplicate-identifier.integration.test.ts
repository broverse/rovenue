// =============================================================
// POST /dashboard/projects/:projectId/leaderboards — duplicate
// identifier -> 409, against REAL Postgres.
//
// Mirrors the pattern of virtual-currencies.integration.test.ts /
// offerings.integration.test.ts: minimal Hono app mounted on the same
// path the production tree uses, real Postgres seeded inline, real
// Better Auth session cookie so requireDashboardAuth runs unmocked.
//
// The leaderboards POST route has no findByIdentifier pre-check (unlike
// offerings.ts/virtual-currencies.ts): it relies entirely on catching the
// database's own `leaderboards_projectId_identifier_key` unique-index
// violation and turning it into a 409. That catch is exactly the trap
// documented in lib/pg-errors.ts -- Drizzle wraps the driver error as
// DrizzleQueryError, whose `.message` never contains the word "unique",
// so a message-text match against `err.message` never fires and a real
// duplicate silently falls through to a 500. Only a real Postgres insert
// can prove the fix (isUniqueViolationOf, matched on the real error's
// `.cause` chain) actually catches it -- a mocked-DB route test would
// have to fabricate the exact shape of DrizzleQueryError's `.cause` to
// mean anything, which is indistinguishable from asserting the test
// author's own assumption about the bug.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { leaderboardsRoute } from "./leaderboards";

const RUN_ID = Date.now();

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/leaderboards", leaderboardsRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `lbdup_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!lbdup";
  const name = `Leaderboard Dup User ${suffix}`;

  const signUp = await auth.api.signUpEmail({ body: { email, password, name } });
  if (!signUp?.user?.id) throw new Error("signUp failed");

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const rawCookie = signIn.headers.get("set-cookie") ?? "";
  const cookie = rawCookie.split(",").map((s) => s.trim().split(";")[0]).join("; ");

  return { userId: signUp.user.id, cookie };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_lbdup_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Leaderboard Dup Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedMember({
  projectId,
  userId,
  role,
}: {
  projectId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT";
}) {
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role,
  });
}

const seededProjectIds: string[] = [];
function trackProject(id: string) {
  seededProjectIds.push(id);
  return id;
}

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("POST /projects/:projectId/leaderboards — duplicate identifier", () => {
  it("409s on a duplicate (projectId, identifier) pair instead of 500ing", async () => {
    const { userId, cookie } = await createUserAndSession("dup");
    const project = await seedProject("dup");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "OWNER" });

    const app = buildApp();
    const body = JSON.stringify({
      identifier: "weekly-spenders",
      name: "Weekly Spenders",
      metric: "TOP_SPENDERS",
      cadence: "WEEKLY",
    });
    const headers = { "content-type": "application/json", cookie };

    const first = await app.request(`/projects/${project.id}/leaderboards`, {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(200);

    const second = await app.request(`/projects/${project.id}/leaderboards`, {
      method: "POST",
      headers,
      body,
    });
    // This is the assertion that actually exercises the bug: against the
    // message-matching version this comes back 500, because
    // DrizzleQueryError's `.message` never contains "unique".
    expect(second.status).toBe(409);
    const responseBody = (await second.json()) as { error: { message: string } };
    expect(responseBody.error.message).toMatch(/identifier already in use/i);
  });
});
