// =============================================================
// POST /projects/:projectId/subscriptions — route integration test
//
// Infrastructure notes (identical to grant.integration.test.ts):
//   - No withTestDb / buildTestApp helpers exist in this codebase.
//   - Uses Better Auth's email+password flow (enabled in non-production)
//     to mint a real session cookie so requireDashboardAuth is exercised
//     without mocks.
//   - Tests run against the dev Postgres configured in apps/api/tests/setup.ts
//     (docker-compose host port 5433).
//   - Each test run uses a unique RUN_ID to avoid collisions.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  getDb,
  projects,
  subscribers,
  products,
  purchases,
  drizzle,
} from "@rovenue/db";
import { auth } from "../../lib/auth";
import { subscriptionsRoute } from "./subscriptions";

// ---------------------------------------------------------------------------
// Unique run key so parallel re-runs never collide
// ---------------------------------------------------------------------------

const RUN_ID = Date.now();

// ---------------------------------------------------------------------------
// Minimal Hono test app — mirrors how dashboardRoute mounts subscriptionsRoute
// ---------------------------------------------------------------------------

function buildApp() {
  return new Hono().route(
    "/projects/:projectId/subscriptions",
    subscriptionsRoute,
  );
}

// ---------------------------------------------------------------------------
// Better Auth helpers — sign up a fresh user and return the session cookie
// ---------------------------------------------------------------------------

async function createUserAndSession(suffix: string): Promise<{ userId: string; cookie: string }> {
  const email = `testroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!routetest";
  const name = `Route Test User ${suffix}`;

  // Register via Better Auth (email+password, enabled in NODE_ENV=test)
  const signUpRes = await auth.api.signUpEmail({
    body: { email, password, name },
  });

  if (!signUpRes?.user) {
    throw new Error(`signUpEmail failed for ${suffix}`);
  }

  // Sign in to get a session cookie
  const signInRes = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });

  const setCookieHeader = signInRes.headers.get("set-cookie");
  if (!setCookieHeader) {
    throw new Error(`signInEmail did not return a set-cookie header for ${suffix}`);
  }

  // Extract the session cookie value
  const cookie = setCookieHeader.split(";")[0] ?? "";

  return { userId: signUpRes.user.id, cookie };
}

// ---------------------------------------------------------------------------
// Inline seed helpers (same pattern as grant.integration.test.ts)
// ---------------------------------------------------------------------------

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_routetest_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Route Test Project ${RUN_ID}${suffix}`,
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
  role: "OWNER" | "ADMIN" | "VIEWER";
}) {
  const db = getDb();
  await db.insert(drizzle.schema.projectMembers).values({
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
  const id = `sub_routetest_${RUN_ID}${suffix}`;
  await db.insert(subscribers).values({
    id,
    projectId,
    appUserId: `app_route_${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedProduct({
  projectId,
  suffix = "",
}: {
  projectId: string;
  suffix?: string;
}) {
  const db = getDb();
  const id = `prod_routetest_${RUN_ID}${suffix}`;
  await db.insert(products).values({
    id,
    projectId,
    identifier: `com.rovenue.routetest.product_${RUN_ID}${suffix}`,
    type: "SUBSCRIPTION",
    storeIds: {},
    displayName: `Route Test Product ${RUN_ID}${suffix}`,
    entitlementKeys: [`pro_route_${RUN_ID}${suffix}`],
  });
  return { id };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  const db = getDb();
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}viewer`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}admin`));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /projects/:projectId/subscriptions (grant)", () => {
  it("returns 403 when the authenticated user has VIEWER role", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("viewer");
    const project = await seedProject("viewer");
    await seedMember({ projectId: project.id, userId, role: "VIEWER" });
    const sub = await seedSubscriber({ projectId: project.id, suffix: "viewer" });
    const prod = await seedProduct({ projectId: project.id, suffix: "viewer" });

    const res = await app.request(
      `/projects/${project.id}/subscriptions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
        },
        body: JSON.stringify({
          subscriberId: sub.id,
          productId: prod.id,
          duration: { kind: "preset", preset: "1mo" },
        }),
      },
    );

    expect(res.status).toBe(403);
  });

  it("returns 200 with store=MANUAL when the authenticated user has ADMIN role", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("admin");
    const project = await seedProject("admin");
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const sub = await seedSubscriber({ projectId: project.id, suffix: "admin" });
    const prod = await seedProduct({ projectId: project.id, suffix: "admin" });

    const res = await app.request(
      `/projects/${project.id}/subscriptions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
        },
        body: JSON.stringify({
          subscriberId: sub.id,
          productId: prod.id,
          duration: { kind: "preset", preset: "1mo" },
          note: "route test comp",
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { store: string; id: string } };
    expect(body.data.store).toBe("MANUAL");

    // Verify the purchase row actually landed in the DB
    const db = getDb();
    const [row] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.id, body.data.id));
    expect(row?.store).toBe("MANUAL");
  });
});
