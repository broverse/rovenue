// =============================================================
// POST /projects/:projectId/credits — dashboard grant route
//
// Mirrors the pattern of subscriptions.integration.test.ts:
// minimal Hono app mounted on the same path the production tree
// uses, real Postgres seeded inline, real Better Auth session
// cookie so requireDashboardAuth runs unmocked.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  getDb,
  projects,
  subscribers,
  drizzle,
} from "@rovenue/db";
import { auth } from "../../lib/auth";
import { creditsRoute } from "./credits";

const RUN_ID = Date.now();

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/credits",
    creditsRoute,
  );
}

async function createUserAndSession(suffix: string): Promise<{ userId: string; cookie: string }> {
  const email = `creditsroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!creditsroute";
  const name = `Credits Route User ${suffix}`;

  const signUp = await auth.api.signUpEmail({ body: { email, password, name } });
  if (!signUp?.user) throw new Error(`signUpEmail failed for ${suffix}`);

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookieHeader = signIn.headers.get("set-cookie");
  if (!cookieHeader) throw new Error(`no set-cookie for ${suffix}`);
  const cookie = cookieHeader.split(";")[0] ?? "";

  return { userId: signUp.user.id, cookie };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_credroute_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Credits Route Project ${RUN_ID}${suffix}`,
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
  role: "OWNER" | "ADMIN" | "CUSTOMER_SUPPORT";
}) {
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role,
  });
}

async function seedSubscriber({
  projectId,
  suffix = "",
}: {
  projectId: string;
  suffix?: string;
}) {
  const db = getDb();
  const id = `sub_credroute_${RUN_ID}${suffix}`;
  await db.insert(subscribers).values({
    id,
    projectId,
    rovenueId: `app_cred_${RUN_ID}${suffix}`,
    appUserId: `app_cred_${RUN_ID}${suffix}`,
  });
  return { id };
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

describe("POST /projects/:projectId/credits — manual grant", () => {
  it("appends a BONUS ledger row and returns the new balance", async () => {
    const { userId, cookie } = await createUserAndSession("ok");
    const project = await seedProject("ok");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const sub = await seedSubscriber({ projectId: project.id });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/credits`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          subscriberId: sub.id,
          amount: 500,
          description: "support comp",
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { balance: number; entry: { type: string; amount: number } };
    };
    expect(body.data.balance).toBe(500);
    expect(body.data.entry.type).toBe("BONUS");
    expect(body.data.entry.amount).toBe(500);

    // ledger row exists in PG
    const cl = drizzle.schema.creditLedger;
    const rows = await getDb()
      .select()
      .from(cl)
      .where(eq(cl.subscriberId, sub.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("BONUS");
    expect(rows[0]?.balance).toBe(500);
  });

  it("403s when caller has VIEWER role", async () => {
    const { userId, cookie } = await createUserAndSession("viewer");
    const project = await seedProject("viewer");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });
    const sub = await seedSubscriber({ projectId: project.id, suffix: "v" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/credits`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ subscriberId: sub.id, amount: 100 }),
      },
    );

    expect(res.status).toBe(403);
  });

  it("404s when subscriber belongs to a different project", async () => {
    const { userId, cookie } = await createUserAndSession("crossproject");
    const projectA = await seedProject("crossA");
    const projectB = await seedProject("crossB");
    trackProject(projectA.id);
    trackProject(projectB.id);
    await seedMember({ projectId: projectA.id, userId, role: "ADMIN" });
    const subB = await seedSubscriber({ projectId: projectB.id, suffix: "B" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${projectA.id}/credits`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ subscriberId: subB.id, amount: 50 }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("400s on a non-positive amount", async () => {
    const { userId, cookie } = await createUserAndSession("badamount");
    const project = await seedProject("badamt");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const sub = await seedSubscriber({ projectId: project.id, suffix: "ba" });

    const app = buildApp();
    const res = await app.request(
      `/projects/${project.id}/credits`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ subscriberId: sub.id, amount: 0 }),
      },
    );

    expect(res.status).toBe(400);
  });
});
