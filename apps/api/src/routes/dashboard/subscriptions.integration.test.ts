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
  role: "OWNER" | "ADMIN" | "CUSTOMER_SUPPORT";
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
    accessIds: [],
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
// Seed helper for the list/filter/sort tests below
// ---------------------------------------------------------------------------

const LIST_SUFFIXES = [
  "lst_store",
  "lst_prod",
  "lst_auto",
  "lst_trial",
  "lst_issue",
  "lst_price",
  "lst_renews",
  "lst_xsort",
  "lst_bad",
  "lst_badbool",
] as const;

async function seedListFixture(suffix: (typeof LIST_SUFFIXES)[number]) {
  const db = getDb();
  const { userId, cookie } = await createUserAndSession(suffix);
  const project = await seedProject(suffix);
  await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });

  const sub = await seedSubscriber({ projectId: project.id, suffix });
  const productA = await seedProduct({ projectId: project.id, suffix: `${suffix}_a` });
  const productB = await seedProduct({ projectId: project.id, suffix: `${suffix}_b` });

  // Six purchases spanning stores, expiry status, price tiers, and a
  // NULL-expires row so the renews_asc NULLS-LAST contract has signal.
  const now = Date.now();
  const day = 86_400_000;
  const purchasesSeed = [
    { idx: 1, store: "APP_STORE", price: "9.99", purchaseDate: new Date(now - 5 * day), expiresDate: new Date(now + 10 * day), autoRenew: true, isTrial: false, status: "ACTIVE", productId: productA.id },
    { idx: 2, store: "PLAY_STORE", price: "19.99", purchaseDate: new Date(now - 3 * day), expiresDate: new Date(now + 30 * day), autoRenew: false, isTrial: false, status: "ACTIVE", productId: productA.id },
    { idx: 3, store: "STRIPE", price: "4.99", purchaseDate: new Date(now - 4 * day), expiresDate: new Date(now + 2 * day), autoRenew: true, isTrial: false, status: "ACTIVE", productId: productB.id },
    { idx: 4, store: "STRIPE", price: "29.99", purchaseDate: new Date(now - 10 * day), expiresDate: new Date(now + 60 * day), autoRenew: true, isTrial: true, status: "TRIAL", productId: productA.id },
    { idx: 5, store: "MANUAL", price: "0", purchaseDate: new Date(now - 1 * day), expiresDate: null, autoRenew: false, isTrial: false, status: "ACTIVE", productId: productB.id },
    { idx: 6, store: "APP_STORE", price: "14.99", purchaseDate: new Date(now - 2 * day), expiresDate: new Date(now + 5 * day), autoRenew: true, isTrial: false, status: "GRACE_PERIOD", productId: productA.id },
  ];

  for (const row of purchasesSeed) {
    const synth = `tx_${RUN_ID}_${suffix}_${row.idx}`;
    await db.insert(purchases).values({
      projectId: project.id,
      subscriberId: sub.id,
      productId: row.productId,
      store: row.store as any,
      storeTransactionId: synth,
      originalTransactionId: synth,
      status: row.status as any,
      isTrial: row.isTrial,
      isIntroOffer: false,
      isSandbox: false,
      purchaseDate: row.purchaseDate,
      originalPurchaseDate: row.purchaseDate,
      expiresDate: row.expiresDate,
      priceAmount: row.price,
      priceCurrency: "USD",
      environment: "PRODUCTION",
      autoRenewStatus: row.autoRenew,
    });
  }

  return {
    userId,
    cookie,
    projectId: project.id,
    productId: productA.id,
    productB: productB.id,
  };
}

async function listRequest(cookie: string, projectId: string, qs: string) {
  const app = buildApp();
  const res = await app.request(
    `/projects/${projectId}/subscriptions${qs ? `?${qs}` : ""}`,
    { headers: { cookie } },
  );
  expect(res.status).toBe(200);
  return (await res.json()).data as {
    rows: Array<{
      id: string;
      store: string;
      expiresDate: string | null;
      priceAmount: string | null;
      status: string;
    }>;
    nextCursor: string | null;
  };
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
  for (const suffix of LIST_SUFFIXES) {
    await db
      .delete(projects)
      .where(eq(projects.id, `prj_routetest_${RUN_ID}${suffix}`));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /projects/:projectId/subscriptions — filters + sort", () => {
  it("filters by store (multi-select)", async () => {
    const { cookie, projectId } = await seedListFixture("lst_store");
    const body = await listRequest(cookie, projectId, "store=STRIPE,MANUAL");
    expect(
      body.rows.every((r) => r.store === "STRIPE" || r.store === "MANUAL"),
    ).toBe(true);
    expect(body.rows.length).toBe(3);
  });

  it("filters by productId (CSV)", async () => {
    const { cookie, projectId, productB } = await seedListFixture("lst_prod");
    const body = await listRequest(cookie, projectId, `productId=${productB}`);
    expect(body.rows.length).toBe(2);
  });

  it("filters by autoRenew=false", async () => {
    const { cookie, projectId } = await seedListFixture("lst_auto");
    const body = await listRequest(cookie, projectId, "autoRenew=false");
    expect(body.rows.length).toBe(2);
  });

  it("filters by isTrial=true", async () => {
    const { cookie, projectId } = await seedListFixture("lst_trial");
    const body = await listRequest(cookie, projectId, "isTrial=true");
    expect(body.rows.length).toBe(1);
  });

  it("filters by hasIssue=true (grace + autorenew on)", async () => {
    const { cookie, projectId } = await seedListFixture("lst_issue");
    const body = await listRequest(cookie, projectId, "hasIssue=true");
    expect(body.rows.length).toBe(1);
    expect(body.rows[0]!.status).toBe("grace");
  });

  it("sort=price_desc with NULLS LAST and cursor walk", async () => {
    const { cookie, projectId } = await seedListFixture("lst_price");
    const first = await listRequest(cookie, projectId, "sort=price_desc&limit=4");
    // `priceAmount` is numeric(12,4) so Postgres returns 4-decimal strings.
    // We assert the numeric values, not the textual formatting.
    expect(first.rows.map((r) => Number(r.priceAmount))).toEqual([
      29.99, 19.99, 14.99, 9.99,
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listRequest(
      cookie,
      projectId,
      `sort=price_desc&limit=4&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.rows.map((r) => Number(r.priceAmount))).toEqual([4.99, 0]);
  });

  it("sort=renews_asc puts NULL expiresDate rows last", async () => {
    const { cookie, projectId } = await seedListFixture("lst_renews");
    const body = await listRequest(cookie, projectId, "sort=renews_asc&limit=10");
    const ids = body.rows.map((r) => r.expiresDate);
    // The single NULL row must be the last entry.
    expect(ids[ids.length - 1]).toBeNull();
    // Everything before it must be ASC and non-null.
    const nonNull = ids.slice(0, -1).filter((v): v is string => v !== null);
    expect([...nonNull].sort()).toEqual(nonNull);
  });

  it("rejects a cursor when sort changes", async () => {
    const { cookie, projectId } = await seedListFixture("lst_xsort");
    const first = await listRequest(cookie, projectId, "sort=price_desc&limit=2");
    expect(first.nextCursor).not.toBeNull();
    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/subscriptions?sort=started_desc&cursor=${encodeURIComponent(first.nextCursor!)}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown store value via Zod", async () => {
    const { cookie, projectId } = await seedListFixture("lst_bad");
    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/subscriptions?store=NOPE`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
  });

  it("rejects autoRenew=on (not a boolish enum)", async () => {
    const { cookie, projectId } = await seedListFixture("lst_badbool");
    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/subscriptions?autoRenew=on`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /projects/:projectId/subscriptions (grant)", () => {
  it("returns 403 when the authenticated user has VIEWER role", async () => {
    const app = buildApp();
    const { userId, cookie } = await createUserAndSession("viewer");
    const project = await seedProject("viewer");
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });
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
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });
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
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });

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
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });

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
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });

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
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });
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
    await seedMember({ projectId: project.id, userId, role: "CUSTOMER_SUPPORT" });

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
