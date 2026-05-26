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
import type { ScheduledActionRow } from "../../services/subscriptions/schedule";

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

async function seedManualPurchase({
  projectId,
  suffix = "",
  status = "ACTIVE" as "ACTIVE" | "EXPIRED" | "REVOKED" | "REFUNDED",
}: {
  projectId: string;
  suffix?: string;
  status?: "ACTIVE" | "EXPIRED" | "REVOKED" | "REFUNDED";
}) {
  const sub = await seedSubscriber({ projectId, suffix: `mp_${suffix}` });
  const prod = await seedProduct({ projectId, suffix: `mp_${suffix}` });
  const synth = `comp_${RUN_ID}_${suffix}_${Math.random().toString(36).slice(2, 8)}`;
  const [purchase] = await getDb()
    .insert(purchases)
    .values({
      projectId,
      subscriberId: sub.id,
      productId: prod.id,
      store: "MANUAL",
      storeTransactionId: synth,
      originalTransactionId: synth,
      status,
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      priceAmount: "0",
      priceCurrency: "USD",
      autoRenewStatus: false,
    })
    .returning();
  if (!purchase) throw new Error("seedManualPurchase: no row returned");
  return purchase;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  const db = getDb();
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}viewer`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}admin`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}schedviewer`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}schedadmin`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}scheddup`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}schedbad`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}listviewer`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}delviewer`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}deladmin`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}delmissing`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}csvviewer`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}csvviewerdata`));
  await db.delete(projects).where(eq(projects.id, `prj_routetest_${RUN_ID}csvbadscope`));
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

// ---------------------------------------------------------------------------
// POST /projects/:projectId/subscriptions/:purchaseId/schedule
// ---------------------------------------------------------------------------

describe("POST /projects/:projectId/subscriptions/:purchaseId/schedule", () => {
  it("returns 403 when the authenticated user has VIEWER role", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("schedviewer");
    const project = await seedProject("schedviewer");
    await seedMember({ projectId: project.id, userId, role: "VIEWER" });
    const purchase = await seedManualPurchase({ projectId: project.id, suffix: "sv" });

    const res = await app.request(
      `/projects/${project.id}/subscriptions/${purchase.id}/schedule`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          action: "CANCEL",
          dueAt: new Date(Date.now() + 3600_000).toISOString(),
          revokeImmediately: false,
        }),
      },
    );

    expect(res.status).toBe(403);
  });

  it("returns 200 with status PENDING when ADMIN schedules a future action", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("schedadmin");
    const project = await seedProject("schedadmin");
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const purchase = await seedManualPurchase({ projectId: project.id, suffix: "sa" });

    const res = await app.request(
      `/projects/${project.id}/subscriptions/${purchase.id}/schedule`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          action: "CANCEL",
          dueAt: new Date(Date.now() + 3600_000).toISOString(),
          revokeImmediately: false,
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { data: ScheduledActionRow };
    expect(body.data.status).toBe("PENDING");
  });

  it("returns 400 when dueAt is less than 60s in the future", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("schedbad");
    const project = await seedProject("schedbad");
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const purchase = await seedManualPurchase({ projectId: project.id, suffix: "sbad" });

    const res = await app.request(
      `/projects/${project.id}/subscriptions/${purchase.id}/schedule`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          action: "CANCEL",
          dueAt: new Date(Date.now() + 30_000).toISOString(),
          revokeImmediately: false,
        }),
      },
    );

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toMatch(/future/i);
  });

  it("returns 409 on duplicate PENDING scheduled action for same purchase", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("scheddup");
    const project = await seedProject("scheddup");
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const purchase = await seedManualPurchase({ projectId: project.id, suffix: "sdup" });
    const dueAt = new Date(Date.now() + 3600_000).toISOString();
    const payload = JSON.stringify({ action: "CANCEL", dueAt, revokeImmediately: false });

    // First call — should succeed
    const first = await app.request(
      `/projects/${project.id}/subscriptions/${purchase.id}/schedule`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: payload,
      },
    );
    expect(first.status).toBe(200);

    // Second call — should conflict
    const second = await app.request(
      `/projects/${project.id}/subscriptions/${purchase.id}/schedule`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: payload,
      },
    );
    expect(second.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// GET /projects/:projectId/subscriptions/scheduled
// ---------------------------------------------------------------------------

describe("GET /projects/:projectId/subscriptions/scheduled", () => {
  it("returns 200 with rows array for VIEWER role", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("listviewer");
    const project = await seedProject("listviewer");
    await seedMember({ projectId: project.id, userId, role: "VIEWER" });

    const res = await app.request(
      `/projects/${project.id}/subscriptions/scheduled`,
      {
        method: "GET",
        headers: { cookie },
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { rows: unknown[] } };
    expect(Array.isArray(body.data.rows)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DELETE /projects/:projectId/subscriptions/scheduled/:id
// ---------------------------------------------------------------------------

describe("DELETE /projects/:projectId/subscriptions/scheduled/:id", () => {
  it("returns 403 when the authenticated user has VIEWER role", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("delviewer");
    const project = await seedProject("delviewer");
    await seedMember({ projectId: project.id, userId, role: "VIEWER" });

    const res = await app.request(
      `/projects/${project.id}/subscriptions/scheduled/nonexistent-id`,
      {
        method: "DELETE",
        headers: { cookie },
      },
    );

    expect(res.status).toBe(403);
  });

  it("returns 200 with status CANCELED after canceling a PENDING action", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("deladmin");
    const project = await seedProject("deladmin");
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const purchase = await seedManualPurchase({ projectId: project.id, suffix: "da" });

    // Schedule an action first
    const schedRes = await app.request(
      `/projects/${project.id}/subscriptions/${purchase.id}/schedule`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          action: "CANCEL",
          dueAt: new Date(Date.now() + 3600_000).toISOString(),
          revokeImmediately: false,
        }),
      },
    );
    expect(schedRes.status).toBe(200);
    const schedBody = await schedRes.json() as { data: ScheduledActionRow };
    const actionId = schedBody.data.id;

    // Cancel it
    const delRes = await app.request(
      `/projects/${project.id}/subscriptions/scheduled/${actionId}`,
      {
        method: "DELETE",
        headers: { cookie },
      },
    );
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json() as { data: ScheduledActionRow };
    expect(delBody.data.status).toBe("CANCELED");
  });

  it("returns 409 when canceling a non-existent or already-canceled action", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("delmissing");
    const project = await seedProject("delmissing");
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });

    const res = await app.request(
      `/projects/${project.id}/subscriptions/scheduled/does-not-exist`,
      {
        method: "DELETE",
        headers: { cookie },
      },
    );

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// GET /projects/:projectId/subscriptions/export.csv
// ---------------------------------------------------------------------------

describe("GET /projects/:projectId/subscriptions/export.csv", () => {
  it("returns 200 with text/csv and header line when VIEWER has no subscriptions", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("csvviewer");
    const project = await seedProject("csvviewer");
    await seedMember({ projectId: project.id, userId, role: "VIEWER" });

    const res = await app.request(
      `/projects/${project.id}/subscriptions/export.csv?scope=all`,
      {
        method: "GET",
        headers: { cookie },
      },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment/);

    const body = await res.text();
    // Must start with the canonical header row
    expect(body).toMatch(/^id,subscriber_id,product,/);
  });

  it("includes seeded purchase row in CSV body", async () => {
    const app = buildApp();
    // Reuse the same user from the previous test by creating a fresh one
    const { userId, cookie } = await createUserAndSession("csvviewerdata");
    const project = await seedProject("csvviewerdata");
    await seedMember({ projectId: project.id, userId, role: "VIEWER" });
    await seedManualPurchase({ projectId: project.id, suffix: "csvrow" });

    const res = await app.request(
      `/projects/${project.id}/subscriptions/export.csv?scope=all`,
      {
        method: "GET",
        headers: { cookie },
      },
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^id,subscriber_id,product,/);
    // Body should have at least two lines (header + one data row)
    const lines = body.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("returns 400 when scope is invalid", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("csvbadscope");
    const project = await seedProject("csvbadscope");
    await seedMember({ projectId: project.id, userId, role: "VIEWER" });

    const res = await app.request(
      `/projects/${project.id}/subscriptions/export.csv?scope=notascope`,
      {
        method: "GET",
        headers: { cookie },
      },
    );

    expect(res.status).toBe(400);
  });
});
