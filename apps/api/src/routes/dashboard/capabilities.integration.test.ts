// =============================================================
// Capability enforcement — integration tests
//
// Verifies that assertProjectCapability gates actually
// allow/deny requests based on the calling member's role.
//
// Three assertions:
//  1. CUSTOMER_SUPPORT can write credits (credits:write allowed)
//  2. CUSTOMER_SUPPORT cannot create feature flags (flags:write denied)
//  3. GROWTH can create feature flags but not write credits
//
// Pattern mirrors credits.integration.test.ts: real Postgres,
// real Better Auth sessions, no mocks.
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
import { featureFlagsRoute } from "./feature-flags";

const RUN_ID = Date.now();

function buildApp() {
  return new Hono()
    .route("/projects/:projectId/credits", creditsRoute)
    .route("/feature-flags", featureFlagsRoute);
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `capenforce_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!capenforce";
  const name = `Cap Enforce User ${suffix}`;

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
  const id = `prj_capenforce_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Cap Enforce Project ${RUN_ID}${suffix}`,
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

async function seedSubscriber({
  projectId,
  suffix = "",
}: {
  projectId: string;
  suffix?: string;
}) {
  const db = getDb();
  const id = `sub_capenforce_${RUN_ID}${suffix}`;
  await db.insert(subscribers).values({
    id,
    projectId,
    rovenueId: `app_capenforce_${RUN_ID}${suffix}`,
    appUserId: `app_capenforce_${RUN_ID}${suffix}`,
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

// ---------------------------------------------------------------
// 1. CUSTOMER_SUPPORT can write credits
// ---------------------------------------------------------------
describe("CUSTOMER_SUPPORT — credits:write allowed", () => {
  it("POST /projects/:projectId/credits returns 200 (not 403)", async () => {
    const { userId, cookie } = await createUserAndSession("cs_credits");
    const project = await seedProject("cs_credits");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });
    const sub = await seedSubscriber({ projectId: project.id, suffix: "cs" });

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/credits`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        subscriberId: sub.id,
        amount: 100,
        description: "support comp",
      }),
    });

    // The point of this assertion is that the capability check passes —
    // body/business-logic errors (400, 404) are acceptable, only 403 is not.
    expect(res.status).not.toBe(403);
  });
});

// ---------------------------------------------------------------
// 2. CUSTOMER_SUPPORT cannot create feature flags
// ---------------------------------------------------------------
describe("CUSTOMER_SUPPORT — flags:write denied", () => {
  it("POST /feature-flags returns 403", async () => {
    const { userId, cookie } = await createUserAndSession("cs_flags");
    const project = await seedProject("cs_flags");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });

    const app = buildApp();
    const res = await app.request("/feature-flags", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        key: "cs-test-flag",
        type: "BOOLEAN",
        defaultValue: false,
      }),
    });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------
// 3. GROWTH can create feature flags but NOT write credits
// ---------------------------------------------------------------
describe("GROWTH — flags:write allowed, credits:write denied", () => {
  it("POST /feature-flags returns not-403", async () => {
    const { userId, cookie } = await createUserAndSession("growth_flags");
    const project = await seedProject("growth_flags");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "GROWTH" });

    const app = buildApp();
    const res = await app.request("/feature-flags", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        projectId: project.id,
        key: "growth-test-flag",
        type: "BOOLEAN",
        defaultValue: false,
      }),
    });

    expect(res.status).not.toBe(403);
  });

  it("POST /projects/:projectId/credits returns 403", async () => {
    const { userId, cookie } = await createUserAndSession("growth_credits");
    const project = await seedProject("growth_credits");
    trackProject(project.id);
    await seedMember({ projectId: project.id, userId, role: "GROWTH" });
    const sub = await seedSubscriber({ projectId: project.id, suffix: "gr" });

    const app = buildApp();
    const res = await app.request(`/projects/${project.id}/credits`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        subscriberId: sub.id,
        amount: 50,
        description: "growth attempt",
      }),
    });

    expect(res.status).toBe(403);
  });
});
